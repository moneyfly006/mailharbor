/**
 * IPC 入口：渲染层 → 主进程。所有 handler 做参数校验、错误兜底，并统一返回可序列化结构。
 * 账户/规则/记录等 CRUD 直接走 repos；网络类操作（测试连接、立即检查）走 backend。
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  Account, AccountInput, DashboardData, ListRecordsQuery, ListRecordsResult,
  MainEvent, Rule, RuleInput, Settings, TestResult
} from '@shared/types'
import * as repos from './repos'
import type { Backend } from './services'
import { getDb, getSetting, setSetting, DEFAULT_SETTINGS } from './db'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isBigAttachmentLink } from './pipeline'
import { downloadLinkedFile } from './link-download'
import { downloadControl } from './download-control'
import { extractDriveFileIds } from './gmail/drive'
import { openQqLogin } from './qq-web'

export interface IpcContext {
  getBackend: () => Backend | null
  getWindow: () => BrowserWindow | null
  broadcast: (e: MainEvent) => void
  updater?: {
    check(manual?: boolean): Promise<import('@shared/types').UpdateState>
    installNow(): void
    state: () => import('@shared/types').UpdateState
  }
}

let ctx: IpcContext | null = null
const linkArchives = new Set<number>()

function requireBackend(): Backend {
  const b = ctx?.getBackend()
  if (!b) throw new Error('后端尚未启动完成，请稍后再试')
  return b
}

function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  throw new Error(msg)
}

/**
 * 补扫历史邮件：新增/启用规则后，把之前"未命中关键词"的邮件按 UID 重新跑一遍流水线。
 * 不动收信游标（避免和在途轮询互相覆盖）。
 */
async function rescanHistory(reason: string): Promise<void> {
  console.log(`[rescan] 开始：${reason}`)
  const backend = requireBackend()
  const accountIds = repos.listAccountsForRescan()
  console.log(`[rescan] 启用账户 ${accountIds.length} 个`)

  let processed = 0
  for (const accountId of accountIds) {
    const uids = repos.listIgnoredMessageUids(accountId, 200)
    console.log(`[rescan] 账户 #${accountId} 待补扫 UID: ${uids.length} 个`)
    if (uids.length === 0) continue
    try {
      const r = await backend.scheduler.reprocess(accountId, uids)
      console.log(`[rescan] 账户 #${accountId} 补扫结果 processed=${r.processed} errors=${r.errors}`)
      processed += r.processed
    } catch (e) {
      console.error('[rescan] 补扫失败:', e instanceof Error ? e.message : String(e))
    }
  }
  ctx?.broadcast({ type: 'rules:changed' })
  ctx?.broadcast({ type: 'dashboard:changed' })
  if (processed > 0) {
    ctx?.broadcast({
      type: 'toast',
      level: 'success',
      title: '已补扫历史邮件',
      body: `${reason} · 重新处理 ${processed} 封，之前未命中的现在会入库`
    })
  }
}

export function registerIpc(context: IpcContext): void {
  ctx = context

  // ---------------- 账户 ----------------
  ipcMain.handle(IPC.accountList, (): Account[] => repos.listAccounts())

  ipcMain.handle(IPC.accountCreate, async (_e, input: AccountInput): Promise<Account> => {
    try {
      const acc = repos.createAccount(input)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      ctx?.broadcast({ type: 'dashboard:changed' })
      return acc
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountUpdate, async (_e, id: number, input: AccountInput): Promise<Account> => {
    try {
      const acc = repos.updateAccount(id, input)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      return acc
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountDelete, async (_e, id: number): Promise<void> => {
    try {
      repos.deleteAccount(id)
      ctx?.broadcast({ type: 'dashboard:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountTest, async (_e, input: AccountInput): Promise<TestResult> => {
    try {
      return await requireBackend().testAccount(input)
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountTestSaved, async (_e, id: number): Promise<TestResult> => {
    try {
      return await requireBackend().testSavedAccount(id)
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountQqLogin, async (event, id: number): Promise<{ ok: boolean; message?: string }> => {
    const parent = context.getWindow()
    if (!parent || event.sender !== parent.webContents || event.senderFrame !== parent.webContents.mainFrame) {
      return { ok: false, message: '请从邮箱账户页打开 QQ 登录' }
    }
    if (!Number.isSafeInteger(id) || id <= 0 || repos.getAccount(id)?.preset !== 'qq') {
      return { ok: false, message: '找不到 QQ 邮箱账户' }
    }
    try {
      await openQqLogin(id, parent)
      setSetting(`qqWebEnabled:${id}`, true)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'QQ 登录窗口打开失败' }
    }
  })

  ipcMain.handle(IPC.accountToggle, async (_e, id: number, enabled: boolean): Promise<Account> => {
    try {
      const acc = repos.setAccountEnabled(id, enabled)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      if (enabled) void requireBackend().scheduler.resume()
      return acc
    } catch (e) { fail(e) }
  })

  // ---------------- 规则 ----------------
  ipcMain.handle(IPC.ruleList, (): Rule[] => repos.listRules())

  ipcMain.handle(IPC.ruleCreate, async (_e, input: RuleInput): Promise<Rule> => {
    try {
      const rule = repos.createRule(input)
      ctx?.broadcast({ type: 'rules:changed' })
      void rescanHistory(`新增规则「${rule.keyword}」`).catch(() => {})
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleUpdate, async (_e, id: number, input: RuleInput): Promise<Rule> => {
    try {
      const rule = repos.updateRule(id, input)
      ctx?.broadcast({ type: 'rules:changed' })
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleDelete, async (_e, id: number): Promise<void> => {
    try {
      repos.deleteRule(id)
      ctx?.broadcast({ type: 'rules:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleToggle, async (_e, id: number, enabled: boolean): Promise<Rule> => {
    try {
      const rule = repos.setRuleEnabled(id, enabled)
      ctx?.broadcast({ type: 'rules:changed' })
      if (enabled) void rescanHistory(`启用规则「${rule.keyword}」`).catch(() => {})
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleReorder, async (_e, ids: number[]): Promise<void> => {
    try {
      repos.reorderRules(ids)
      ctx?.broadcast({ type: 'rules:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleTargetsHealth, (): Rule[] => repos.listRulesWithHealth())

  // ---------------- 记录 ----------------
  ipcMain.handle(IPC.recordsList, (_e, q: ListRecordsQuery): ListRecordsResult => repos.listRecords(q))

  ipcMain.handle(IPC.recordsRetry, async (_e, messageId: number, deliveryId?: number): Promise<void> => {
    try {
      await requireBackend().retryMessage(messageId, deliveryId)
      ctx?.broadcast({ type: 'dashboard:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.recordsRetryDownload, async (_e, messageId: number): Promise<{ ok: boolean; message?: string }> => {
    try {
      const r = await requireBackend().retryDownload(messageId)
      ctx?.broadcast({ type: 'dashboard:changed' })
      return r
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.gmailStatus, () => requireBackend().gmail.status())

  ipcMain.handle(IPC.gmailAuthStart, async (_e, accountId: number, clientId: string, clientSecret: string) => {
    const session = await requireBackend().gmail.startAuth(Number(accountId), String(clientId ?? '').trim(), String(clientSecret ?? '').trim())
    await shell.openExternal(session.authUrl)
    return { authUrl: session.authUrl }
  })

  ipcMain.handle(IPC.gmailReauthorize, async (_e, accountId: number) => {
    const r = await requireBackend().gmail.reauthorize(Number(accountId))
    await shell.openExternal(r.authUrl)
    return r
  })

  ipcMain.handle(IPC.gmailRevoke, (_e, accountId: number) => {
    requireBackend().gmail.revoke(Number(accountId))
    ctx?.broadcast({ type: 'gmail:auth', accountId: Number(accountId), authorized: false })
  })

  ipcMain.handle(IPC.gmailTest, (_e, accountId: number) => requireBackend().gmail.test(Number(accountId)))

  ipcMain.handle(IPC.downloadPause, (_e, messageId: number) => {
    requireBackend().downloads.pause(Number(messageId))
  })
  ipcMain.handle(IPC.downloadResume, (_e, messageId: number) => {
    requireBackend().downloads.resume(Number(messageId))
  })
  ipcMain.handle(IPC.downloadCancel, (_e, messageId: number) => {
    requireBackend().downloads.cancel(Number(messageId))
  })

  ipcMain.handle(IPC.gmailFetchDrive, async (_e, messageId: number) => {
    const r = await requireBackend().gmail.fetchDriveAndArchive(Number(messageId))
    ctx?.broadcast({ type: 'dashboard:changed' })
    return r
  })

  ipcMain.handle(IPC.rulesTestSubject, async (_e, subject: string, body?: string) => {
    return requireBackend().testSubject(String(subject ?? ''), body)
  })

  ipcMain.handle(IPC.recordsOpenLink, async (_e, messageId: number): Promise<{ ok: boolean; message?: string }> => {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return { ok: false, message: '无效的邮件记录' }
    const url = repos.getRecordById(messageId)?.links.find(isBigAttachmentLink)
    if (!url) return { ok: false, message: '找不到文件下载链接' }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    IPC.recordsDownloadLink,
    async (event, messageId: number): ReturnType<Backend['archiveManualFiles']> => {
      const window = context.getWindow()
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return { ok: false, message: '请从下载记录发起下载' }
      }
      if (!Number.isSafeInteger(messageId) || messageId <= 0) return { ok: false, message: '无效的邮件记录' }
      const record = repos.getRecordById(messageId)
      const url = record?.links.find(isBigAttachmentLink)
      if (!record || record.status !== 'manual_needed' || !url) return { ok: false, message: '找不到待下载文件' }
      // Google Drive 链接：直接走 Drive API 后台下载（比打开网页点下载更可靠），下载后自动归档
      if (extractDriveFileIds(record.links).length > 0) {
        const r = await requireBackend().gmail.fetchDriveAndArchive(messageId)
        ctx?.broadcast({ type: 'dashboard:changed' })
        return r
      }
      if (linkArchives.has(messageId)) return { ok: false, message: '这封邮件正在下载或归档' }
      linkArchives.add(messageId)
      try {
        // 后台静默下载（不弹窗）：登录态已在「登录 QQ 网页」时保存；登录过期会返回明确错误
        const settings = readSettings()
        const file = await downloadLinkedFile({
          url,
          parent: window,
          accountId: record.accountId,
          messageId,
          background: {
            dest: join(app.getPath('temp'), 'mailharbor', `qq-link-${messageId}.part`),
            timeoutMs: Math.max(60, Number(settings.downloadTimeoutSec) || 900) * 1000
          },
          connections: Math.max(2, Math.min(32, Number(settings.downloadConnections) || 8)),
          isPaused: () => downloadControl.isPaused(messageId),
          isCancelled: () => downloadControl.isCancelled(messageId),
          onProgress: (progress) => context.broadcast({ type: 'download:progress', progress })
        })
        if (!file) return { ok: false, message: '已取消' }
        const result = await requireBackend().archiveManualFiles(messageId, [file.path])
        if (!result.ok) {
          return { ...result, message: `${result.message ?? '归档未完成'}。原件已保存至系统下载目录的 MailHarbor 文件夹。` }
        }
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // QQ 登录过期：自动打开登录窗口，用户扫码后点「重试」即可继续（下载全程后台，不弹空白页）
        if (/登录已过期|登录QQ邮箱|请先登录/.test(msg)) {
          const qq = repos.listAccounts().find((a) => a.preset === 'qq' && a.enabled)
          if (qq) {
            try {
              await openQqLogin(qq.id, window)
            } catch {
              /* ignore */
            }
            return { ok: false, message: 'QQ 网页登录已过期，已打开登录窗口；扫码登录后点「重试」继续下载' }
          }
        }
        return { ok: false, message: msg }
      } finally {
        linkArchives.delete(messageId)
      }
    }
  )

  ipcMain.handle(
    IPC.recordsArchiveManual,
    async (_e, messageId: number): Promise<{ ok: boolean; message?: string; archived?: number; extracted?: number }> => {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) return { ok: false, message: '无效的邮件记录' }
      if (linkArchives.has(messageId)) return { ok: false, message: '这封邮件正在下载或归档' }
      linkArchives.add(messageId)
      try {
        const picked = await dialog.showOpenDialog({
          title: '选择从超大附件/网盘下载好的文件',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '压缩包/图稿', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'tif', 'tiff', 'jpg', 'jpeg', 'png', 'pdf', 'psd', 'ai'] }]
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: false, message: '已取消' }
        const r = await requireBackend().archiveManualFiles(messageId, picked.filePaths)
        ctx?.broadcast({ type: 'dashboard:changed' })
        return r
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      } finally {
        linkArchives.delete(messageId)
      }
    }
  )

  ipcMain.handle(IPC.recordsReprocess, async (_e, messageId: number): Promise<{ ok: boolean; message?: string }> => {
    try {
      const r = await requireBackend().reprocessMessage(messageId)
      ctx?.broadcast({ type: 'dashboard:changed' })
      return r
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.recordsOpenFolder, async (_e, messageId: number, deliveryId?: number): Promise<void> => {
    const dir = repos.folderOfRecord(messageId, deliveryId)
    if (!dir) throw new Error('没有可打开的文件夹')
    await shell.openPath(dir)
  })

  ipcMain.handle(IPC.recordsExport, async (_e, q: ListRecordsQuery): Promise<{ path: string } | null> => {
    const win = ctx?.getWindow()
    const res = await dialog.showSaveDialog(win!, {
      title: '导出下载记录',
      defaultPath: join(app.getPath('downloads'), `mailharbor-records-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    const all = repos.listRecords({ ...q, page: 1, pageSize: 100000 })
    const csv = repos.recordsToCsv(all.rows)
    await writeFile(res.filePath, '\ufeff' + csv, 'utf8') // BOM 便于 Excel 打开中文
    return { path: res.filePath }
  })

  ipcMain.handle(IPC.recordsClear, async (): Promise<void> => {
    getDb().prepare('DELETE FROM messages').run()
    ctx?.broadcast({ type: 'dashboard:changed' })
  })

  // ---------------- 自动回复测试信 ----------------
  ipcMain.handle(
    IPC.replyTest,
    async (_e, to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }> => {
      try {
        return await requireBackend().testReply(to)
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // ---------------- 概览 / 运行控制 ----------------
  ipcMain.handle(IPC.dashboard, (): DashboardData => buildDashboard())

  ipcMain.handle(IPC.listeningSet, async (_e, on: boolean): Promise<boolean> => {
    const b = requireBackend()
    if (on) {
      await b.scheduler.resume()
      b.bus.emit('event', { type: 'listening:changed', listening: true } satisfies MainEvent)
    } else {
      b.scheduler.pause()
      b.bus.emit('event', { type: 'listening:changed', listening: false } satisfies MainEvent)
    }
    return on
  })

  ipcMain.handle(IPC.checkNow, async (): Promise<void> => {
    await requireBackend().scheduler.checkNow()
  })

  // 补扫历史邮件：新增/启用规则后，让之前"未命中关键词"的邮件重新走一遍流水线
  ipcMain.handle(IPC.rescan, async (): Promise<void> => {
    await rescanHistory('手动补扫')
  })

  // ---------------- 设置 ----------------
  ipcMain.handle(IPC.settingsGet, (): Settings => readSettings())

  ipcMain.handle(
    IPC.proxyTest,
    async (_e, proxy: { mode: 'none' | 'system' | 'socks5' | 'http'; host: string; port: number }) => {
      const { resolveProxy, testProxy } = await import('./net/proxy')
      if (proxy.mode === 'none') return { ok: true, latencyMs: 0, message: '当前为「不使用代理」：直连邮件服务器（国内访问 Gmail 通常不通）' }
      const resolved = await resolveProxy(proxy)
      if (!resolved) {
        return {
          ok: false,
          latencyMs: 0,
          message:
            proxy.mode === 'system'
              ? '没有检测到系统代理：请先打开代理软件（Clash/V2Ray 等），或改成「自定义」手动填 SOCKS5/HTTP 地址'
              : '代理地址或端口为空'
        }
      }
      const r = await testProxy(resolved)
      return { ...r, message: `${r.message}（来源：${resolved.source}）` }
    }
  )

  ipcMain.handle(IPC.settingsSave, async (_e, s: Settings): Promise<Settings> => {
    for (const [k, v] of Object.entries(s)) setSetting(k, v)
    setSetting('pollIntervalSec', Math.max(15, Math.min(3600, Number(s.pollIntervalSec) || 30)))
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!s.autostart, args: ['--autostart'] })
    }
    ctx?.broadcast({ type: 'dashboard:changed' })
    return readSettings()
  })

  // ---------------- 通用 ----------------
  ipcMain.handle(IPC.pickFolder, async (): Promise<string | null> => {
    const win = ctx?.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: '选择存储文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.openPath, async (_e, p: string): Promise<void> => {
    await shell.openPath(p)
  })

  ipcMain.handle(IPC.updateCheck, async () => ctx?.updater?.check(true) ?? null)
  ipcMain.handle(IPC.updateInstall, async (): Promise<void> => {
    ctx?.updater?.installNow()
  })
  ipcMain.handle(IPC.updateState, () => ctx?.updater?.state() ?? null)

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    listening: ctx?.getBackend()?.scheduler.isListening() ?? false
  }))
}

export function readSettings(): Settings {
  const out = {} as Settings
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    ;(out as unknown as Record<string, unknown>)[key] = getSetting(key)
  }
  return out
}

export function buildDashboard(): DashboardData {
  const db = getDb()
  const dashboard = repos.dashboardStats()
  const accounts = repos.listAccounts()
  const recent = repos.listRecords({ page: 1, pageSize: 8 }).rows
  const b = ctx?.getBackend()
  const startedAt = (globalThis as Record<string, unknown>).__mhStartedAt as number | undefined
  void db
  return {
    listening: b?.scheduler.isListening() ?? false,
    accounts,
    todayMessages: dashboard.todayMessages,
    todayMatched: dashboard.todayMatched,
    todayFiles: dashboard.todayFiles,
    todayFailed: dashboard.todayFailed,
    pendingRetry: dashboard.pendingRetry,
    retryItems: repos.listRetryDeliveries(8),
    disks: repos.listDisks(),
    rulePaths: repos.rulePathSummary(),
    recent,
    pollIntervalSec: getSetting<number>('pollIntervalSec') ?? 30,
    nextCheckAt: b?.scheduler.nextCheckAt() ?? null,
    checking: b?.scheduler.isChecking() ?? false,
    lastCheckAt: b?.scheduler.lastCheckAt() ?? null,
    uptimeMs: startedAt ? Date.now() - startedAt : 0
  }
}

export function disposeIpc(): void {
  for (const ch of Object.values(IPC)) ipcMain.removeHandler(ch)
}
