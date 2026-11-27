/**
 * 演示用 Api 实现（纯浏览器预览 / preload 不可用时降级）。
 * 行为尽量贴近主进程：有延迟、有失败态，但数据只存在内存里。
 */
import type { Api } from '@shared/ipc'
import type {
  Account, AccountInput, DashboardData, ListRecordsQuery, ListRecordsResult, MainEvent, Rule, RuleInput,
  Settings, TargetHealth, TestResult
} from '@shared/types'
import {
  DEMO_ACCOUNTS, DEMO_RECORDS, DEMO_RULES, DEMO_SETTINGS, buildDemoDashboard, demoTestResult
} from './demo-data'

const GB = 1024 ** 3
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function clone<T>(v: T): T {
  return structuredClone(v)
}

function splitPathDrive(path: string): string {
  return path.slice(0, 1).toUpperCase()
}

function healthOf(path: string): { health: TargetHealth; freeBytes: number | null; totalBytes: number | null } {
  switch (splitPathDrive(path)) {
    case 'D':
      return { health: 'ok', freeBytes: 178 * GB, totalBytes: 512 * GB }
    case 'E':
      return { health: 'low_space', freeBytes: 46 * GB, totalBytes: 1024 * GB }
    case 'F':
      return { health: 'unavailable', freeBytes: null, totalBytes: null }
    default:
      return { health: 'unknown', freeBytes: null, totalBytes: null }
  }
}

interface DemoState {
  accounts: Account[]
  rules: Rule[]
  records: typeof DEMO_RECORDS
  settings: Settings
  listening: boolean
  nextCheckAt: number | null
}

function maxId<T extends { id: number }>(items: T[]): number {
  return items.reduce((m, i) => Math.max(m, i.id), 0)
}

const listeners = new Set<(e: MainEvent) => void>()
let progressSimulated = false
function emitDemoEvent(e: MainEvent): void {
  for (const cb of listeners) cb(e)
}
/** 演示模式：造一条"大附件下载中"的进度事件，让预览/截图能看到进度条 */
function simulateDownloadProgress(): void {
  if (progressSimulated) return
  progressSimulated = true
  const messageId = 9001
  const attachmentId = 9001
  const filename = 'POD_ORDER_20511.zip'
  const total = 24 * 1024 * 1024
  let received = 0
  // 延迟 700ms：React 父组件的 onEvent 订阅晚于子组件的加载 effect，太早发会丢
  setTimeout(() => {
    const timer = setInterval(() => {
      received += Math.round(total * 0.12)
      const done = received >= total
      if (done) clearInterval(timer)
      emitDemoEvent({
        type: 'download:progress',
        progress: {
          messageId,
          attachmentId,
          filename,
          received: done ? total : received,
          total,
          percent: done ? 100 : Math.round((received / total) * 100),
          state: done ? 'done' : 'active',
          attempt: 1,
          bytesPerSec: 2.4 * 1024 * 1024,
          updatedAt: Date.now()
        }
      })
    }, 320)
  }, 700)
}

export function createDemoApi(): Api {
  const state: DemoState = {
    accounts: clone(DEMO_ACCOUNTS),
    rules: clone(DEMO_RULES),
    records: clone(DEMO_RECORDS),
    settings: clone(DEMO_SETTINGS),
    listening: true,
    nextCheckAt: Date.now() + 12_000
  }

  const accountInputToAccount = (input: AccountInput, prev?: Account): Account => {
    const now = Date.now()
    const id = prev?.id ?? maxId(state.accounts) + 1
    return {
      id,
      preset: input.preset,
      email: input.email,
      displayName: input.displayName?.trim() || prev?.displayName || '邮箱账号',
      status: 'pending_test',
      enabled: prev?.enabled ?? false,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      imapUser: input.imapUser,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      smtpUser: input.smtpUser,
      smtpFromName: input.smtpFromName ?? prev?.smtpFromName ?? 'Haiyin POD · Prepress',
      smtpSameAsImap: input.smtpSameAsImap,
    allowSelfSigned: !!input.allowSelfSigned,
    sendOnly: !!input.sendOnly,
      hasPassword: !!input.password || !!prev?.hasPassword,
      lastCheckAt: prev?.lastCheckAt ?? null,
      lastOkAt: prev?.lastOkAt ?? null,
      lastErrorCode: null,
      lastError: null,
      lastUid: prev?.lastUid ?? 0,
      uidValidity: prev?.uidValidity ?? null,
      todayCount: prev?.todayCount ?? 0,
      totalFiles: prev?.totalFiles ?? 0,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
  }

  const findAccount = (id: number): Account => {
    const acc = state.accounts.find((a) => a.id === id)
    if (!acc) throw new Error('账户不存在')
    return acc
  }

  const findRule = (id: number): Rule => {
    const rule = state.rules.find((r) => r.id === id)
    if (!rule) throw new Error('规则不存在')
    return rule
  }

  let folderPick = 0
  const FOLDER_CANDIDATES = [
    'D:\\POD\\生产\\卡套',
    'E:\\POD\\备份\\卡套',
    'D:\\POD\\生产\\手机壳',
    'F:\\POD\\归档\\卡套'
  ]

  const recomputeRecordStatus = (recordId: number): void => {
    const rec = state.records.find((r) => r.id === recordId)
    if (!rec) return
    const deliveries = rec.attachments.flatMap((a) => a.deliveries)
    if (deliveries.length === 0) return
    if (deliveries.some((d) => d.state === 'failed')) {
      rec.status = 'failed'
    } else if (deliveries.some((d) => d.state === 'copying' || d.state === 'pending')) {
      rec.status = 'queued'
    } else if (deliveries.some((d) => d.state === 'retry_wait')) {
      rec.status = 'partial'
    } else {
      rec.status = 'done'
      if (rec.replyStatus === 'pending') rec.replyStatus = 'sent'
    }
  }

  let demoUpdate: import('@shared/types').UpdateState = {
    status: 'idle',
    currentVersion: '0.1.0',
    availableVersion: null,
    progressPercent: null,
    message: '演示模式：不检查更新',
    checkedAt: null
  }

  const api: Api = {
    update: {
      check: async () => {
        await delay(600)
        demoUpdate = { ...demoUpdate, status: 'up-to-date', message: '已是最新版本（演示）', checkedAt: Date.now() }
        return demoUpdate
      },
      install: async () => {},
      state: async () => demoUpdate
    },
    reply: {
      test: async (to: string) => {
        await delay(700)
        if (!/@/.test(to)) return { ok: false, message: '收件邮箱格式不正确' }
        return { ok: true, message: `测试信已发送到 ${to}（演示模式）` }
      }
    },
    accounts: {
      list: async () => clone(state.accounts),
      create: async (input) => {
        await delay(240)
        const acc = accountInputToAccount(input)
        state.accounts.push(acc)
        return clone(acc)
      },
      update: async (id, input) => {
        await delay(240)
        const prev = findAccount(id)
        const next = accountInputToAccount(input, prev)
        const idx = state.accounts.findIndex((a) => a.id === id)
        state.accounts[idx] = next
        return clone(next)
      },
      remove: async (id) => {
        await delay(180)
        state.accounts = state.accounts.filter((a) => a.id !== id)
      },
      test: async (input) => {
        await delay(520)
        const existing = state.accounts.find((a) => a.email === input.email && a.hasPassword)
        const hasCredential = !!input.password || !!existing?.hasPassword
        return demoTestResult(
          input.preset,
          input.imapHost,
          input.imapPort,
          input.smtpHost,
          input.smtpPort,
          hasCredential
        )
      },
      qqLogin: async () => ({ ok: false, message: '请在桌面应用登录 QQ 邮箱' }),
      testSaved: async (id) => {
        await delay(520)
        const acc = findAccount(id)
        const result = demoTestResult(
          acc.preset,
          acc.imapHost,
          acc.imapPort,
          acc.smtpHost,
          acc.smtpPort,
          acc.hasPassword
        )
        acc.lastCheckAt = result.testedAt
        acc.status = result.ok ? 'enabled' : 'auth_failed'
        if (result.ok) {
          acc.lastOkAt = result.testedAt
          acc.lastError = null
          acc.lastErrorCode = null
        } else {
          const bad = result.lines.find((l) => !l.ok)
          acc.lastError = bad?.message ?? '连接失败'
          acc.lastErrorCode = bad?.errorCode ?? null
        }
        acc.updatedAt = result.testedAt
        return result
      },
      toggle: async (id, enabled) => {
        await delay(180)
        const acc = findAccount(id)
        acc.enabled = enabled
        acc.status = enabled ? 'enabled' : 'disabled'
        acc.updatedAt = Date.now()
        if (!enabled) acc.lastCheckAt = acc.lastCheckAt
        return clone(acc)
      }
    },

    rules: {
      testSubject: async (subject: string) => {
        await delay(200)
        const hits = state.rules
          .filter((r) => r.enabled && subject.includes(r.keyword))
          .map((r) => ({ ruleId: r.id, keyword: r.keyword, source: 'subject' as const }))
        return { normalized: subject.toLowerCase().replace(/\s+/g, ''), hits }
      },
      list: async () => clone(state.rules).sort((a, b) => a.priority - b.priority),
      create: async (input) => {
        await delay(260)
        const now = Date.now()
        const id = maxId(state.rules) + 1
        let targetId = maxId(state.rules.flatMap((r) => r.targets)) + 1
        const rule: Rule = {
          id,
          keyword: input.keyword,
          enabled: input.enabled,
          scope: input.scope,
          mode: input.mode,
          priority: input.priority ?? maxId(state.rules) + 1,
          fileTypes: input.fileTypes,
          autoReply: input.autoReply,
          hitMessages: 0,
          hitFiles: 0,
          lastHitAt: null,
          targets: input.targets.map((t, i) => {
            const h = healthOf(t.path)
            return {
              id: targetId++,
              ruleId: id,
              path: t.path,
              required: t.required,
              sortOrder: i,
              enabled: true,
              lastHealth: h.health,
              freeBytes: h.freeBytes,
              totalBytes: h.totalBytes
            }
          }),
          createdAt: now,
          updatedAt: now
        }
        state.rules.push(rule)
        return clone(rule)
      },
      update: async (id, input) => {
        await delay(260)
        const rule = findRule(id)
        let targetId = maxId(state.rules.flatMap((r) => r.targets)) + 1
        rule.keyword = input.keyword
        rule.enabled = input.enabled
        rule.scope = input.scope
        rule.mode = input.mode
        rule.priority = input.priority ?? rule.priority
        rule.fileTypes = input.fileTypes
        rule.autoReply = input.autoReply
        rule.targets = input.targets.map((t, i) => {
          const prev = t.id != null ? rule.targets.find((x) => x.id === t.id) : undefined
          const h = healthOf(t.path)
          return {
            id: prev?.id ?? targetId++,
            ruleId: id,
            path: t.path,
            required: t.required,
            sortOrder: i,
            enabled: true,
            lastHealth: h.health,
            freeBytes: h.freeBytes,
            totalBytes: h.totalBytes
          }
        })
        rule.updatedAt = Date.now()
        return clone(rule)
      },
      remove: async (id) => {
        await delay(220)
        state.rules = state.rules.filter((r) => r.id !== id)
      },
      toggle: async (id, enabled) => {
        await delay(160)
        const rule = findRule(id)
        rule.enabled = enabled
        rule.updatedAt = Date.now()
        return clone(rule)
      },
      reorder: async (ids) => {
        await delay(160)
        ids.forEach((id, index) => {
          const rule = state.rules.find((r) => r.id === id)
          if (rule) rule.priority = index + 1
        })
        state.rules.sort((a, b) => a.priority - b.priority)
      },
      targetsHealth: async () => {
        await delay(420)
        for (const rule of state.rules) {
          for (const t of rule.targets) {
            const h = healthOf(t.path)
            t.lastHealth = h.health
            t.freeBytes = h.freeBytes
            t.totalBytes = h.totalBytes
          }
        }
        return clone(state.rules).sort((a, b) => a.priority - b.priority)
      }
    },

    gmail: {
    status: async () => [{ accountId: 1, email: 'demo@gmail.com', provider: 'gmail', expiry: Date.now() + 6 * 86400_000, daysLeft: 6, needsReauth: false, lastError: null }],
    startAuth: async () => ({ authUrl: 'https://accounts.google.com/' }),
    reauthorize: async () => ({ authUrl: 'https://accounts.google.com/' }),
    revoke: async () => {},
    test: async () => ({ ok: true, email: 'demo@gmail.com' })
  },
  records: {
      list: async (q: ListRecordsQuery): Promise<ListRecordsResult> => {
        simulateDownloadProgress()
        await delay(160)
        let rows = state.records.slice()
        if (q.status && q.status !== 'all') rows = rows.filter((r) => r.status === q.status)
        if (q.accountId != null) rows = rows.filter((r) => r.accountId === q.accountId)
        if (q.keyword) rows = rows.filter((r) => (r.matchedKeyword ?? '').includes(q.keyword as string))
        if (q.search) {
          const s = q.search.trim().toLowerCase()
          rows = rows.filter((r) => {
            if (r.subject.toLowerCase().includes(s)) return true
            if (r.fromAddr.toLowerCase().includes(s) || r.fromName.toLowerCase().includes(s)) return true
            if ((r.matchedKeyword ?? '').toLowerCase().includes(s)) return true
            return r.attachments.some((a) => a.filename.toLowerCase().includes(s))
          })
        }
        if (q.from != null) rows = rows.filter((r) => r.receivedAt >= (q.from as number))
        if (q.to != null) rows = rows.filter((r) => r.receivedAt <= (q.to as number))
        rows.sort((a, b) => b.receivedAt - a.receivedAt)
        const page = Math.max(1, q.page ?? 1)
        const pageSize = Math.max(1, q.pageSize ?? 50)
        const start = (page - 1) * pageSize
        return { total: rows.length, page, pageSize, rows: clone(rows.slice(start, start + pageSize)) }
      },
    openLink: async (messageId: number) => {
      await delay(120)
      const rec = state.records.find((r) => r.id === messageId)
      return rec?.links.length ? { ok: true } : { ok: false, message: '找不到文件下载链接' }
    },
    downloadLink: async (messageId: number) => {
      await delay(900)
      const rec = state.records.find((r) => r.id === messageId)
      if (!rec?.links.length) return { ok: false, message: '找不到文件下载链接' }
      rec.status = 'done'
      return { ok: true, archived: 2 }
    },
    archiveManual: async (messageId: number) => {
      await delay(900)
      const rec = state.records.find((r) => r.id === messageId)
      if (!rec) return { ok: false, message: '找不到这封邮件' }
      rec.status = 'done'
      return { ok: true, archived: 2 }
    },
    reprocess: async (messageId: number) => {
      await delay(700)
      const rec = state.records.find((r) => r.id === messageId)
      if (!rec) return { ok: false, message: '找不到这封邮件' }
      rec.status = 'done'
      return { ok: true }
    },
    retryDownload: async (messageId: number) => {
      await delay(900)
      const rec = state.records.find((r) => r.id === messageId)
      if (!rec) return { ok: false, message: '找不到这封邮件' }
      rec.status = 'done'
      for (const a of rec.attachments) {
        a.state = 'downloaded'
        for (const d of a.deliveries) {
          if (d.state === 'failed' || d.state === 'retry_wait') {
            d.state = 'done'
            d.errorCode = null
            d.error = null
          }
        }
      }
      return { ok: true }
    },
    retry: async (messageId, deliveryId) => {
        await delay(600)
        const rec = state.records.find((r) => r.id === messageId)
        if (!rec) throw new Error('记录不存在')
        for (const att of rec.attachments) {
          for (const d of att.deliveries) {
            const target = deliveryId != null ? d.id === deliveryId : d.state === 'failed' || d.state === 'retry_wait'
            if (!target) continue
            d.state = 'done'
            d.attempts += 1
            d.savedPath = `${d.targetPath}\\${att.filename}`
            d.savedName = att.filename
            d.size = att.size
            d.error = null
            d.errorCode = null
            d.nextRetryAt = null
            d.finishedAt = Date.now()
          }
        }
        recomputeRecordStatus(messageId)
      },
      openFolder: async (messageId, deliveryId) => {
        await delay(180)
        const rec = state.records.find((r) => r.id === messageId)
        if (!rec) throw new Error('记录不存在')
        const deliveries = rec.attachments.flatMap((a) => a.deliveries)
        const target = deliveryId != null ? deliveries.find((d) => d.id === deliveryId) : deliveries.find((d) => d.savedPath)
        if (!target?.savedPath) throw new Error('还没有成功写入的文件夹')
      },
      exportCsv: async (q) => {
        await delay(420)
        const stamp = new Date().toISOString().slice(0, 10)
        return { path: `C:\\Users\\demo\\Downloads\\mailharbor-records-${stamp}.csv` }
      },
      clear: async () => {
        await delay(200)
        state.records = []
      }
    },

    dashboard: async (): Promise<DashboardData> =>
      buildDemoDashboard(clone(state.accounts), clone(state.rules), clone(state.records), state.listening, state.nextCheckAt),

    setListening: async (on) => {
      await delay(160)
      state.listening = on
      state.nextCheckAt = on ? Date.now() + state.settings.pollIntervalSec * 1000 : null
      return on
    },

    checkNow: async () => {
      await delay(650)
      state.nextCheckAt = Date.now() + state.settings.pollIntervalSec * 1000
    },
    rescan: async () => {
      await delay(900)
      state.nextCheckAt = Date.now() + state.settings.pollIntervalSec * 1000
    },

    settings: {
      get: async () => clone(state.settings),
      save: async (s) => {
        await delay(260)
        state.settings = clone(s)
        return clone(state.settings)
      },
      testProxy: async (p) => {
        await delay(450)
        if (p.mode === 'none') {
          return { ok: true, latencyMs: 4, message: '当前为「不使用代理」：直连邮件服务器（国内访问 Gmail 通常不通）' }
        }
        if (!p.host || !p.port) return { ok: false, latencyMs: 0, message: '代理地址或端口为空' }
        return {
          ok: true,
          latencyMs: 180,
          message: `代理可用：${p.mode.toUpperCase()} ${p.host}:${p.port} → imap.gmail.com:993（演示数据）`
        }
      }
    },

    pickFolder: async () => {
      await delay(260)
      const picked = FOLDER_CANDIDATES[folderPick % FOLDER_CANDIDATES.length]
      folderPick += 1
      return picked
    },

    openPath: async () => {
      await delay(120)
    },

    appInfo: async () => ({
      version: '0.1.0 (demo)',
      userData: 'C:\\Users\\demo\\AppData\\Roaming\\MailHarbor',
      listening: state.listening
    }),

    onEvent: (cb: (e: MainEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }

  return api
}
