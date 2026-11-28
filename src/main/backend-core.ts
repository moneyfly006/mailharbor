/**
 * 后端装配核心（不依赖 electron，可被单测直接组装）。
 *
 * 生产入口 backend-impl.ts 注入 db.ts 的 openDb/加密实现；单测注入 :memory: 数据库 +
 * 假 Provider / 假 SMTP 发送函数，从而端到端验证「收信 → 匹配 → 下载 → 扇出 → 记录 → 回信」。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { copyIntoDir } from './file-writer'
import { extractArchiveTo, isArchiveFile } from './archive'
import type { Account, AccountInput, MainEvent, TestResult } from '@shared/types'
import type { DB } from './db'
import * as repos from './repos'
import type { SecretsCodec } from './repos'
import { configureRepos } from './repos'
import { Dispatcher } from './dispatcher'
import { MailPipeline, type PipelineDeps } from './pipeline'
import { ReplyService } from './reply-service'
import { Scheduler, type SchedulerProvider } from './scheduler'
import {
  providerConfigFromAccount, providerConfigFromInput, testConnection, type ProviderConfig
} from './providers/imap'
import { testSmtpConnection } from './smtp'
import { GmailApiClient } from './gmail/client'
import { DriveDownloader, extractDriveFileIds } from './gmail/drive'
import { downloadControl } from './download-control'
import { startGmailAuth } from './gmail/oauth'
import { resolveProxy } from './net/proxy'
import type { TestResultLine } from '@shared/types'
import { sendReply as smtpSendReply, buildReplyVars, renderTemplate, type ReplyRequest, type SendReplyResult } from './smtp'
import { createLogger, setLogLevel } from './log'
import { stat } from 'node:fs/promises'
import type { Backend } from './services'
import { matchRules, normalize, stripSubjectPrefix } from './rule-engine'

export interface BackendCoreDeps {
  db: DB
  bus: EventEmitter
  codec: SecretsCodec
  getSetting: <T = unknown>(key: string) => T
  tmpDir: string
  linkedFiles?: PipelineDeps['linkedFiles']
  now?: () => number
  /** 单测注入假 provider（生产不传 → 真实 IMAP/SMTP） */
  createProvider?: (account: import('@shared/types').Account, cfg: ProviderConfig) => SchedulerProvider
  /** 单测注入假发信（生产不传 → 真实 SMTP） */
  sendReply?: (cfg: import('./smtp').SmtpConfig, req: ReplyRequest) => Promise<SendReplyResult>
}

function failedTest(message: string, protocol: 'imap' | 'smtp' = 'imap', input?: AccountInput): TestResult {
  return {
    ok: false,
    lines: [
      {
        protocol: 'imap',
        ok: false,
        latencyMs: 0,
        host: input?.imapHost ?? '',
        port: input?.imapPort ?? 0,
        errorCode: 'UNKNOWN',
        message: protocol === 'imap' ? message : '跳过 IMAP 测试'
      },
      {
        protocol: 'smtp',
        ok: false,
        latencyMs: 0,
        host: input?.smtpHost ?? '',
        port: input?.smtpPort ?? 0,
        errorCode: 'UNKNOWN',
        message: protocol === 'smtp' ? message : '跳过 SMTP 测试'
      }
    ],
    testedAt: Date.now()
  }
}

/** 仅发件账户：只测 SMTP，IMAP 行标记为"跳过" */
async function testSendOnly(cfg: ProviderConfig): Promise<TestResult> {
  const smtpLine = await testSmtpConnection({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    user: cfg.smtpUser,
    pass: cfg.smtpPass,
    allowSelfSigned: cfg.allowSelfSigned,
    proxy: cfg.proxy
  }).catch(
    (e): TestResultLine => ({
      protocol: 'smtp',
      ok: false,
      latencyMs: 0,
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      errorCode: 'UNKNOWN',
      message: e instanceof Error ? e.message : String(e)
    })
  )
  return {
    ok: smtpLine.ok,
    lines: [
      {
        protocol: 'imap',
        ok: true,
        latencyMs: 0,
        host: '',
        port: 0,
        message: '该账户设为「仅发件」，跳过收件测试（收件请另配邮箱）'
      },
      smtpLine
    ],
    testedAt: Date.now()
  }
}

export function createBackendWith(deps: BackendCoreDeps): Backend {
  const emit = (e: MainEvent): void => {
    try {
      deps.bus.emit('event', e)
    } catch {
      /* 渲染层未就绪不影响主流程 */
    }
  }
  const now = deps.now ?? ((): number => Date.now())
  /** 设置里的代理（IMAP/SMTP 都是裸 TCP，必须通过本地转发桥走代理） */
  const proxyOf = (): ProviderConfig['proxy'] => {
    const raw = deps.getSetting<{ mode?: string; host?: string; port?: number }>('proxy')
    if (!raw || typeof raw !== 'object') return { mode: 'system', host: '127.0.0.1', port: 7890 }
    const mode = (raw.mode ?? 'system') as 'none' | 'system' | 'socks5' | 'http'
    return { mode, host: String(raw.host ?? '127.0.0.1'), port: Number(raw.port ?? 7890) }
  }
  /** 账户状态变化后推给 UI（列表/概览都靠它刷新） */
  const emitAccountChanged = (id: number): void => {
    try {
      const acc = repos.getAccount(id)
      if (acc) emit({ type: 'account:changed', account: acc })
    } catch {
      /* ignore */
    }
  }

  configureRepos({ db: deps.db, codec: deps.codec })
  try {
    setLogLevel(String(deps.getSetting('logLevel') ?? 'info'))
  } catch {
    /* ignore */
  }
  mkdirSync(deps.tmpDir, { recursive: true })

  const dispatcher = new Dispatcher({
    emit,
    getSetting: deps.getSetting,
    tmpDir: deps.tmpDir,
    now
  })
  const replyService = new ReplyService({
    emit,
    getSetting: deps.getSetting,
    getSecrets: (id) => repos.getAccountSecrets(id),
    now,
    send: deps.sendReply ?? smtpSendReply
  })
  // ---------------------------------------------------------------------------
  // Gmail API 加速（混合模式：收信仍走 IMAP，附件下载优先走 HTTPS API）
  // ---------------------------------------------------------------------------
  const gmailClients = new Map<number, GmailApiClient>()
  const gmailClientFor = async (accountId: number): Promise<GmailApiClient | null> => {
    const row = repos.getOAuthToken(accountId)
    if (!row) return null
    const cached = gmailClients.get(accountId)
    if (cached) return cached
    const secrets = repos.getOAuthSecrets(accountId)
    if (!secrets.refreshToken) return null
    let proxy = null
    try {
      proxy = await resolveProxy(deps.getSetting('proxy'))
    } catch {
      proxy = null
    }
    const client = new GmailApiClient({
      clientId: row.client_id,
      clientSecret: secrets.clientSecret,
      refreshToken: secrets.refreshToken,
      proxy,
      logger: createLogger('gmail-api')
    })
    gmailClients.set(accountId, client)
    return client
  }

  const gmailDownloader = {
    async download(opts: {
      account: Account
      rfcMessageId: string
      filename: string
      declaredSize: number
      destPath: string
      onProgress: (received: number, total: number) => void
      timeoutMs: number
    }): Promise<{ size: number; sha256: string; tmpPath: string } | null> {
      if (deps.getSetting<boolean>('gmailApiAccel') === false) return null
      const client = await gmailClientFor(opts.account.id)
      if (!client) return null
      try {
        const r = await client.downloadAttachmentByRfc822({
          rfcMessageId: opts.rfcMessageId,
          filename: opts.filename,
          declaredSize: opts.declaredSize,
          destPath: opts.destPath,
          onProgress: opts.onProgress,
          timeoutMs: opts.timeoutMs
        })
        repos.markOAuthError(opts.account.id, null)
        return r
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // refresh_token 失效（测试模式 7 天）时记录下来，UI 会提示重新授权
        if (/invalid_grant|授权已过期|refresh_token/i.test(msg)) {
          repos.markOAuthError(opts.account.id, msg)
          emit({ type: 'gmail:auth', accountId: opts.account.id, authorized: false, error: msg })
        }
        throw e
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Google Drive 超大附件（Gmail >25MB 的附件会放在 Drive，邮件里只有链接）
  // ---------------------------------------------------------------------------
  const driveClients = new Map<number, DriveDownloader>()
  const driveClientFor = async (accountId: number): Promise<DriveDownloader | null> => {
    const cached = driveClients.get(accountId)
    if (cached) return cached
    const row = repos.getOAuthToken(accountId)
    if (!row) return null
    const secrets = repos.getOAuthSecrets(accountId)
    if (!secrets.refreshToken) return null
    let proxy = null
    try {
      proxy = await resolveProxy(deps.getSetting('proxy'))
    } catch {
      proxy = null
    }
    const client = new DriveDownloader({
      clientId: row.client_id,
      clientSecret: secrets.clientSecret,
      refreshToken: secrets.refreshToken,
      proxy
    })
    driveClients.set(accountId, client)
    return client
  }
  let archiveManualRef: ((messageId: number, files: string[]) => Promise<{ ok: boolean; archived?: number; extracted?: number; message?: string }>) | null = null
  const gdrive = {
    canHandle: (links: string[]): boolean => extractDriveFileIds(links).length > 0,
    fetchAndArchive: async (messageId: number, links: string[]): Promise<{ ok: boolean; files?: number; message?: string }> => {
      const msg = repos.getMessage(messageId)
      if (!msg) return { ok: false, message: '找不到这封邮件' }
      const account = repos.getAccount(msg.account_id)
      if (!account) return { ok: false, message: '找不到对应邮箱账户' }
      if (msg.status === 'done') {
        return { ok: true, files: 0, message: '这封邮件已经归档完成，无需重复下载' }
      }
      const client = await driveClientFor(account.id)
      if (!client) return { ok: false, message: 'Gmail 尚未授权；请到「邮箱账户」页点「重新授权」（需包含 Drive 只读权限）' }
      const ids = extractDriveFileIds(links)
      const files: string[] = []
      downloadControl.begin(messageId)
      // 重试复用：上次已经下载好、文件还在本地 → 直接归档，不再重新下载（200MB 不用重拉）
      // 只复用 Drive 下载产生的记录（partId 形如 drive:<id>），且每个文件只取一份，避免把历史重复记录复制成多份
      const cached = repos
        .listAttachmentsByMessage(messageId)
        .filter((a) => a.status === 'downloaded' && a.tmp_path && a.part_id?.startsWith('drive:'))
      const usable: string[] = []
      const seenNames = new Set<string>()
      for (const a of cached) {
        if (a.filename && seenNames.has(a.filename)) continue
        try {
          if ((await stat(a.tmp_path!)).isFile()) {
            usable.push(a.tmp_path!)
            if (a.filename) seenNames.add(a.filename)
          }
        } catch {
          /* 文件已被清理则忽略 */
        }
      }
      if (usable.length > 0 && usable.length >= ids.length) {
        emit({
          type: 'download:progress',
          progress: {
            messageId,
            attachmentId: -messageId,
            filename: '已下载，正在归档…',
            received: 1,
            total: 1,
            percent: 100,
            state: 'active',
            attempt: 1,
            bytesPerSec: 0,
            message: '复用本地已下载文件',
            updatedAt: Date.now()
          }
        })
        const res = await archiveManualRef!(messageId, usable)
        downloadControl.clear(messageId)
        return { ok: res.ok, files: usable.length, message: res.message }
      }
      for (const [index, id] of ids.entries()) {
        const dest = join(deps.tmpDir, `drive-${messageId}-${index}.part`)
        try {
          const conns = Math.max(2, Math.min(32, Number(deps.getSetting<number>('downloadConnections') ?? 8)))
          const r = await client.downloadParallel(id, dest, {
            connections: conns,
            chunkBytes: Math.floor(64 * 1024 * 1024 / conns),
            isPaused: () => downloadControl.isPaused(messageId),
            isCancelled: () => downloadControl.isCancelled(messageId),
            onProgress: (received, total) => {
            emit({
              type: 'download:progress',
              progress: {
                messageId,
                attachmentId: -(messageId * 100 + index),
                filename: `Google Drive 文件 ${index + 1}`,
                received,
                total,
                percent: total > 0 ? Math.min(100, Math.round((received / total) * 1000) / 10) : null,
                state: 'active',
                attempt: 1,
                bytesPerSec: 0,
                message: 'Google Drive（HTTPS）',
                updatedAt: Date.now()
              }
            })
          } })
          files.push(r.path)
          // 记下已下载附件，之后「重试」可直接复用，不再重下
          try {
            const att = repos.upsertAttachment(messageId, {
              partId: `drive:${id}`,
              filename: r.filename || `drive-${index + 1}.bin`,
              mimeType: null,
              declaredSize: r.size
            })
            repos.setAttachmentDownloaded(att.id, { tmpPath: r.path, size: r.size, sha256: '' })
          } catch {
            /* 记录失败不影响归档 */
          }
          emit({
            type: 'download:progress',
            progress: {
              messageId,
              attachmentId: -(messageId * 100 + index),
              filename: r.filename,
              received: r.size,
              total: r.size,
              percent: 100,
              state: 'active',
              attempt: 1,
              bytesPerSec: 0,
              message: '下载完成，正在归档/解压…',
              updatedAt: Date.now()
            }
          })
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          downloadControl.clear(messageId)
          if (/取消/.test(m)) return { ok: false, message: '已取消下载' }
          emit({ type: 'download:progress', progress: { messageId, attachmentId: -(messageId * 100 + index), filename: `Google Drive 文件 ${index + 1}`, received: 0, total: 0, percent: null, state: 'failed', attempt: 1, bytesPerSec: 0, message: m, updatedAt: Date.now() } })
          return { ok: false, message: `Drive 下载失败：${m}` }
        }
      }
      if (files.length === 0) return { ok: false, message: '没有可下载的 Drive 文件' }
      if (!archiveManualRef) return { ok: false, message: '归档服务未就绪' }
      const res = await archiveManualRef(messageId, files)
      emit({
        type: 'download:progress',
        progress: {
          messageId,
          attachmentId: -messageId,
          filename: '归档完成',
          received: 1,
          total: 1,
          percent: 100,
          state: res.ok ? 'done' : 'failed',
          attempt: 1,
          bytesPerSec: 0,
          message: res.message ?? (res.ok ? '已归档' : '归档失败'),
          updatedAt: Date.now()
        }
      })
      downloadControl.clear(messageId)
      return { ok: res.ok, files: files.length, message: res.message }
    }
  }

  const pipeline = new MailPipeline({
    emit,
    getSetting: deps.getSetting,
    dispatcher,
    replyService,
    tmpDir: deps.tmpDir,
    linkedFiles: deps.linkedFiles,
    gmail: gmailDownloader,
    gdrive,
    now
  })
  dispatcher.onSettled = (messageId) => pipeline.onDeliveriesSettled(messageId)

  const scheduler = new Scheduler({
    emit,
    getSetting: deps.getSetting,
    pipeline: {
      process: (account, provider, msg, mailbox) => pipeline.process(account, provider as never, msg, mailbox)
    },
    now,
    createProvider: deps.createProvider
  })

  // ---------------------------------------------------------------------------
  // 失败自动重试：每 30 秒扫一次 partial/failed 邮件，按退避时间自动重新下载；
  // 正在下载（有 pending 附件）的邮件跳过，避免重复触发。
  // ---------------------------------------------------------------------------
  const autoRetryDelays = (): number[] => {
    const base = Math.max(1000, Number(deps.getSetting<number>('autoRetryBaseMs') ?? 60_000))
    return [base, base * 5, base * 15, base * 30, base * 60, base * 60]
  }
  let autoRetryTimer: NodeJS.Timeout | null = null
  const autoRetrying = new Set<number>()

  async function runAutoRetryOnce(): Promise<number> {
    let count = 0
    {
      if (disposed) return count
      if (deps.getSetting<boolean>('autoRetryFailed') === false) return count
      if (!scheduler.isListening()) return count
      let rows: Array<{ id: number; account_id: number; imap_uid: number }> = []
      try {
        rows = repos.listAutoRetryMessages(Date.now(), 8)
      } catch {
        return count
      }
      for (const row of rows) {
        if (autoRetrying.has(row.id)) continue
        autoRetrying.add(row.id)
        try {
          const before = repos.getMessage(row.id)
          if (!before) continue
          // 双保险：正在下载的不要再触发
          const downloading = repos
            .listAttachmentsByMessage(row.id)
            .some((a) => a.status === 'pending' && Date.now() - a.updated_at < 120_000)
          if (downloading) continue
          repos.resetDeliveriesForAutoRetry(row.id)
          const target = repos.resetMessageForDownloadRetry(row.id)
          if (!target) continue
          const delays = autoRetryDelays()
          const attempt = repos.bumpMessageAutoRetry(
            row.id,
            Date.now() + delays[Math.min(before.auto_retry_count, delays.length - 1)]!
          )
          count++
          emit({ type: 'message:upserted', record: repos.getRecordById(row.id)! })
          emit({ type: 'dashboard:changed' })
          const r = await scheduler.reprocess(row.account_id, [row.imap_uid])
          dispatcher.schedule()
          console.log(
            `[auto-retry] 邮件 #${row.id}（${before.subject?.slice(0, 24) ?? ''}）第 ${attempt} 次自动重试，processed=${r.processed}`
          )
        } catch (e) {
          console.warn('[auto-retry] 异常', e instanceof Error ? e.message : String(e))
        } finally {
          autoRetrying.delete(row.id)
        }
      }
    }
    return count
  }

  function startAutoRetry(): void {
    if (autoRetryTimer) return
    autoRetryTimer = setInterval(() => {
      void runAutoRetryOnce().catch(() => {})
      void retryBigAttachments().catch(() => {})
    }, 30_000)
    autoRetryTimer.unref?.()
    void runAutoRetryOnce().catch(() => {})
    void retryBigAttachments().catch(() => {})
  }

  /**
   * 超大附件自动重试：QQ 网页登录完成后 / Drive 权限就绪后，
   * 自动把「超大附件·待下载」的邮件下载并归档，无需用户逐条点。
   */
  const bigAttachmentInFlight = new Set<number>()

  async function retryBigAttachments(): Promise<number> {
    if (disposed) return 0
    if (deps.getSetting<boolean>('autoRetryFailed') === false) return 0
    let count = 0
    const rows = repos.listManualNeededForRetry(2)
    for (const row of rows) {
      // 防重入：同一封邮件在下载中时不要再触发（否则每 30 秒开一个新下载，互相抢带宽）
      if (bigAttachmentInFlight.has(row.id)) continue
      bigAttachmentInFlight.add(row.id)
      try {
      const msg = repos.getMessage(row.id)
      if (!msg) continue
      const account = repos.getAccount(row.account_id)
      if (!account) continue
      let links: string[] = []
      try {
        links = JSON.parse(row.links ?? '[]') as string[]
      } catch {
        links = []
      }
      if (links.length === 0) continue
      // 1) Google Drive 链接：Gmail/Drive 已授权时自动下载
      if (gdrive.canHandle(links)) {
        try {
          const r = await gdrive.fetchAndArchive(row.id, links)
          if (r.ok) {
            repos.clearMessageAutoRetry(row.id)
            repos.markOAuthError(row.account_id, null)
            count++
            emit({ type: 'toast', level: 'success', title: '超大附件已自动下载', body: '来自 Google Drive，已归档并回信' })
            emit({ type: 'dashboard:changed' })
            continue
          }
          repos.bumpMessageAutoRetry(row.id, Date.now() + 30 * 60_000)
          console.log(`[big-attachment] Drive 自动下载未完成 #${row.id}: ${r.message ?? ''}`)
          continue
        } catch (e) {
          repos.bumpMessageAutoRetry(row.id, Date.now() + 30 * 60_000)
          console.warn('[big-attachment] Drive 自动下载异常', e instanceof Error ? e.message : String(e))
          continue
        }
      }
      // 2) QQ 超大附件：需要 QQ 网页登录会话（qqWebEnabled），登录后自动下载
      const linkedFiles = deps.linkedFiles
      if (!linkedFiles) continue
      const supported = links.filter((url) => linkedFiles.supports(account, url))
      if (supported.length === 0) continue
      try {
        const files: string[] = []
        for (const url of supported) {
          const key = require('node:crypto').createHash('sha256').update(url).digest('hex').slice(0, 16)
          const dest = `${deps.tmpDir}/qq-big-${row.id}-${key}.part`
          const file = await linkedFiles.download(account.id, row.id, url, dest)
          if (file?.path) files.push(file.path)
        }
        if (files.length === 0) {
          repos.bumpMessageAutoRetry(row.id, Date.now() + 30 * 60_000)
          continue
        }
        const res = await archiveManualRef?.(row.id, files)
        if (res?.ok) {
          repos.clearMessageAutoRetry(row.id)
          count++
          emit({ type: 'toast', level: 'success', title: '超大附件已自动下载', body: '来自 QQ 文件中转站，已归档并回信' })
          emit({ type: 'dashboard:changed' })
        } else {
          repos.bumpMessageAutoRetry(row.id, Date.now() + 30 * 60_000)
          console.log(`[big-attachment] QQ 自动归档未完成 #${row.id}: ${res?.message ?? ''}`)
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        // QQ 登录失效/链接失效：不要每 30 分钟重试一次，标记失败并提示用户重新登录
        if (/登录|未发起下载|文件云盘|失效|过期/.test(m)) {
          repos.updateMessageStatus(row.id, 'failed', `超大附件下载失败：${m}。请到「邮箱账户」页重新登录 QQ 网页后点「重试下载」`)
          repos.bumpMessageAutoRetry(row.id, Date.now() + 24 * 3600_000)
          emit({ type: 'toast', level: 'warn', title: 'QQ 网页登录可能已过期', body: '请到「邮箱账户」页点「登录 QQ 网页」重新扫码，然后点「重试下载」' })
        } else {
          repos.bumpMessageAutoRetry(row.id, Date.now() + 30 * 60_000)
        }
        console.warn('[big-attachment] QQ 自动下载异常', m)
      }
      } finally {
        bigAttachmentInFlight.delete(row.id)
      }
    }
    return count
  }

  /** 启动时清理 24 小时前的下载临时文件（.part/.eml），避免磁盘越占越多 */
  function cleanTempFiles(): void {
    try {
      const { readdirSync, statSync, rmSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      const cutoff = Date.now() - 24 * 3600_000
      let removed = 0
      for (const name of readdirSync(deps.tmpDir)) {
        if (!/\.(part|eml|zip|rar|7z)$/i.test(name)) continue
        const full = join(deps.tmpDir, name)
        try {
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full, { force: true })
            removed++
          }
        } catch {
          /* ignore */
        }
      }
      if (removed > 0) console.log(`[backend] 已清理 ${removed} 个过期临时文件`)
    } catch {
      /* ignore */
    }
  }

  let disposed = false
  const backend: Backend = {
    bus: deps.bus,
    scheduler: {
      startAll: () => scheduler.startAll(),
      stopAll: () => scheduler.stopAll(),
      pause: () => scheduler.pause(),
      resume: async () => {
        await scheduler.resume()
        emit({ type: 'dashboard:changed' })
      },
      isListening: () => scheduler.isListening(),
      checkNow: async () => {
        await scheduler.checkNow()
      },
      reprocess: (accountId: number, uids: number[]) => scheduler.reprocess(accountId, uids),
      runAutoRetryOnce,
      nextCheckAt: () => scheduler.nextCheckAt(),
      isChecking: () => scheduler.isChecking(),
      lastCheckAt: () => scheduler.lastCheckAt()
    },
    gmail: {
      status: (): Array<{
        accountId: number
        email: string
        provider: string
        expiry: number | null
        daysLeft: number | null
        needsReauth: boolean
        lastError: string | null
      }> =>
        repos.listOAuthTokens().map((r) => ({
          accountId: r.account_id,
          email: r.email,
          provider: r.provider,
          expiry: r.expiry,
          // 测试模式下 refresh_token 7 天过期，按授权时间（updated_at）计算剩余天数
          daysLeft: Math.max(0, Math.ceil(7 - (Date.now() - r.updated_at) / 86400_000)),
          needsReauth: Boolean(r.last_error),
          lastError: r.last_error
        })),
      startAuth: async (accountId: number, clientId: string, clientSecret: string) => {
        const account = repos.getAccount(accountId)
        if (!account) throw new Error('账户不存在')
        if (account.preset !== 'gmail' && account.preset !== 'google_workspace') {
          throw new Error('Gmail 加速仅适用于 Gmail / Google Workspace 账户')
        }
        let proxy = null
        try {
          proxy = await resolveProxy(deps.getSetting('proxy'))
        } catch {
          proxy = null
        }
        const session = await startGmailAuth({ clientId, clientSecret, proxy })
        void session.wait
          .then((tokens) => {
            repos.saveOAuthToken({
              accountId,
              provider: 'gmail',
              email: account.email,
              clientId,
              clientSecret,
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              expiry: tokens.expiry
            })
            gmailClients.delete(accountId)
            emit({ type: 'gmail:auth', accountId, authorized: true })
            emit({ type: 'toast', level: 'success', title: 'Gmail 加速已授权', body: '附件将优先走 Gmail API 下载' })
            emit({ type: 'dashboard:changed' })
          })
          .catch((e) => {
            emit({ type: 'gmail:auth', accountId, authorized: false, error: e instanceof Error ? e.message : String(e) })
            emit({ type: 'toast', level: 'error', title: 'Gmail 授权失败', body: e instanceof Error ? e.message : String(e) })
          })
        return { authUrl: session.authUrl, cancel: session.cancel }
      },
      reauthorize: async (accountId: number) => {
        const account = repos.getAccount(accountId)
        const row = repos.getOAuthToken(accountId)
        if (!account || !row) throw new Error('还没有授权记录，请先用客户端 ID / 密钥授权')
        const secrets = repos.getOAuthSecrets(accountId)
        if (!secrets.clientSecret) throw new Error('本机保存的客户端密钥不可用，请重新填写并授权')
        let proxy = null
        try {
          proxy = await resolveProxy(deps.getSetting('proxy'))
        } catch {
          proxy = null
        }
        const session = await startGmailAuth({ clientId: row.client_id, clientSecret: secrets.clientSecret, proxy })
        void session.wait
          .then((tokens) => {
            repos.saveOAuthToken({
              accountId,
              provider: 'gmail',
              email: account.email,
              clientId: row.client_id,
              clientSecret: secrets.clientSecret,
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              expiry: tokens.expiry
            })
            gmailClients.delete(accountId)
            driveClients.delete(accountId)
            const scope = tokens.scope ?? ''
            if (!/drive\.readonly|drive\.file|drive\b/.test(scope)) {
              emit({
                type: 'toast',
                level: 'warn',
                title: '重新授权完成，但未获得 Drive 权限',
                body: '请再点一次「重新授权」，在 Google 页面勾选「查看你的 Google 云端硬盘文件」后点允许'
              })
            } else {
              emit({ type: 'toast', level: 'success', title: '重新授权成功', body: 'Gmail 与 Drive 权限已更新' })
            }
            emit({ type: 'gmail:auth', accountId, authorized: true })
            emit({ type: 'dashboard:changed' })
          })
          .catch((e) => {
            emit({ type: 'gmail:auth', accountId, authorized: false, error: e instanceof Error ? e.message : String(e) })
            emit({ type: 'toast', level: 'error', title: '重新授权失败', body: e instanceof Error ? e.message : String(e) })
          })
        return { authUrl: session.authUrl }
      },
      revoke: (accountId: number) => {
        repos.deleteOAuthToken(accountId)
        gmailClients.delete(accountId)
        emit({ type: 'gmail:auth', accountId, authorized: false })
        emit({ type: 'dashboard:changed' })
      },
      fetchDriveAndArchive: async (messageId: number) => {
        const msg = repos.getMessage(messageId)
        if (!msg) return { ok: false, message: '找不到这封邮件' }
        const links = (() => {
          try {
            return JSON.parse(msg.links ?? '[]') as string[]
          } catch {
            return [] as string[]
          }
        })()
        return gdrive.fetchAndArchive(messageId, links)
      },
      test: async (accountId: number) => {
        const client = await gmailClientFor(accountId)
        if (!client) return { ok: false, message: '尚未授权 Gmail API' }
        const g = await client.test()
        if (!g.ok) return g
        const drive = await driveClientFor(accountId)
        if (!drive) return { ...g, message: 'Gmail 正常；但尚无 Drive 授权（超大附件无法自动下载，请点「重新授权」）' }
        const d = await drive.ping()
        return d.ok
          ? { ...g, message: 'Gmail + Drive（超大附件）均正常' }
          : { ...g, message: `Gmail 正常；Drive：${d.message ?? '不可用'}` }
      }
    },
    downloads: {
      pause: (messageId: number) => downloadControl.pause(messageId),
      resume: (messageId: number) => downloadControl.resume(messageId),
      cancel: (messageId: number) => downloadControl.cancel(messageId)
    },
    async testAccount(input: AccountInput): Promise<TestResult> {
      if (!input?.password) return failedTest('请填写应用专用密码 / 授权码后再测试连接', 'imap', input)
      if (!input.smtpSameAsImap && !input.smtpPassword) {
        return failedTest('请填写 SMTP 密码（未勾选「与收件使用同一密码」时必填）', 'smtp', input)
      }
      try {
        const cfg = providerConfigFromInput(input, proxyOf())
        // 仅发件账户（阿里云 DirectMail 等）没有 IMAP，只测 SMTP
        return input.sendOnly ? await testSendOnly(cfg) : await testConnection(cfg)
      } catch (e) {
        return failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, 'imap', input)
      }
    },
    async testSavedAccount(id: number): Promise<TestResult> {
      const account = repos.getAccount(id)
      if (!account) throw new Error('账户不存在或已被删除')
      if (!account.hasPassword) {
        repos.setAccountStatus(id, 'auth_failed', { errorCode: 'PASSWORD_MISSING', error: '尚未保存密码' })
        emitAccountChanged(id)
        return failedTest('该账户尚未保存密码，请编辑账户重新填写', 'imap')
      }
      const secrets = repos.getAccountSecrets(id)
      const cfg = providerConfigFromAccount(account, secrets, proxyOf())
      let result: TestResult
      try {
        result = account.sendOnly ? await testSendOnly(cfg) : await testConnection(cfg)
      } catch (e) {
        result = failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, 'imap')
      }
      // 测试结果直接反映到账户状态：全绿 = 可收信；认证类失败 = auth_failed；网络类 = conn_failed
      const errLine = result.lines.find((l) => !l.ok && !(account.sendOnly && l.protocol === 'imap'))
      if (result.ok) {
        repos.setAccountStatus(id, account.enabled ? 'enabled' : 'pending_test', {
          checked: true,
          ok: true,
          errorCode: null,
          error: null
        })
      } else {
        const authFailed = errLine?.errorCode === 'IMAP_AUTH_FAILED' || errLine?.errorCode === 'SMTP_AUTH_FAILED'
        repos.setAccountStatus(id, authFailed ? 'auth_failed' : 'conn_failed', {
          checked: true,
          ok: false,
          errorCode: errLine?.errorCode ?? 'UNKNOWN',
          error: errLine?.message ?? '测试连接失败'
        })
      }
      emitAccountChanged(id)
      return result
    },
    async testReply(to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }> {
      const target = (to ?? '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
        return { ok: false, message: '收件邮箱格式不正确' }
      }
      const accounts = repos.listAccounts().filter((a) => a.enabled && a.hasPassword)
      const account = accounts[0]
      if (!account) return { ok: false, message: '没有已启用且配置了密码的账户，请先在「邮箱账户」里添加并测试通过' }
      const secrets = repos.getAccountSecrets(account.id)
      const cfg = providerConfigFromAccount(account, secrets, proxyOf())
      const smtpCfg = {
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure,
        user: cfg.smtpUser,
        pass: cfg.smtpPass
      }
      const settings = deps.getSetting as <T>(k: string) => T
      const lang = String(settings('replyLanguage') ?? 'en')
      const subjectTpl = String(
        lang === 'zh' ? settings('replySubjectZh') : settings('replySubjectEn')
      )
      const bodyTpl = String(lang === 'zh' ? settings('replyBodyZh') : settings('replyBodyEn'))
      const vars = buildReplyVars({
        filenames: ['POD_ORDER_TEST.zip', '设计图_测试.tif'],
        keyword: '原图+卡套',
        sentAt: Date.now(),
        factoryName: account.smtpFromName || 'MailHarbor'
      })
      try {
        const res = await (deps.sendReply ?? smtpSendReply)(smtpCfg as never, {
          from: { name: account.smtpFromName || 'MailHarbor', address: account.email },
          to: { address: target },
          subject: renderTemplate(subjectTpl, vars),
          body: renderTemplate(bodyTpl, vars)
        })
        emit({ type: 'toast', level: 'success', title: '测试信已发送', body: `收件人 ${target}` })
        return { ok: true, message: `测试信已发送到 ${target}`, providerMessageId: res.providerMessageId }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit({ type: 'toast', level: 'error', title: '测试信发送失败', body: msg })
        return { ok: false, message: msg }
      }
    },
    async reconcile(): Promise<void> {
      const r = await dispatcher.reconcile()
      if (r.adopted + r.reset + r.tmpCleaned > 0) {
        emit({ type: 'dashboard:changed' })
        emit({ type: 'toast', level: 'success', title: '启动对账完成', body: `认领 ${r.adopted} · 重做 ${r.reset} · 清理临时文件 ${r.tmpCleaned}` })
      }
    },
    async testSubject(
      subject: string,
      body?: string
    ): Promise<{ normalized: string; hits: Array<{ ruleId: number; keyword: string; source: 'subject' | 'body' }> }> {
      const rules = repos.listRules().filter((r) => r.enabled)
      const strategy = deps.getSetting<'all' | 'priority'>('multiRuleStrategy') === 'priority' ? 'priority' : 'all'
      const hits = matchRules(rules, { subject, body }, strategy)
      return {
        normalized: normalize(stripSubjectPrefix(subject)),
        hits: hits.map((h) => ({
          ruleId: h.ruleId,
          keyword: rules.find((r) => r.id === h.ruleId)?.keyword ?? '',
          source: h.source
        }))
      }
    },
    async archiveManualFiles(
      messageId: number,
      files: string[],
      onPhase?: (phase: string) => void
    ): Promise<{ ok: boolean; message?: string; archived?: number; extracted?: number }> {
      const row = repos.getMessage(messageId)
      if (!row) return { ok: false, message: '找不到这封邮件' }
      const rule = row.matched_rule_id ? repos.getRule(row.matched_rule_id) : null
      if (!rule) return { ok: false, message: '这封邮件没有匹配到规则，无法确定归档路径' }
      const targets = rule.targets.filter((t) => t.enabled)
      if (targets.length === 0) return { ok: false, message: '规则里没有启用的目标路径' }
      if (files.length === 0) return { ok: false, message: '没有选择文件' }
      const extract = deps.getSetting<boolean>('extractArchives') !== false
      let archived = 0
      let extracted = 0
      const errors: string[] = []
      const phase = (text: string): void => {
        try {
          onPhase?.(text)
        } catch {
          /* ignore */
        }
      }
      phase(`正在复制到目标文件夹（${files.length} 个文件）…`)
      for (const file of files) {
        try {
          const st = statSync(file)
          const name = basename(file)
          const att = repos.upsertAttachment(messageId, {
            partId: `manual:${name}:${st.size}:${st.mtimeMs}`,
            filename: name,
            mimeType: null,
            declaredSize: st.size
          })
          repos.setAttachmentDownloaded(att.id, { tmpPath: file, size: st.size, sha256: '' })
          for (const target of targets) {
            try {
              const copied = await copyIntoDir(file, target.path, name)
              const [delivery] = repos.createDeliveries([
                { messageId, attachmentId: att.id, targetId: target.id, targetPath: target.path, required: target.required }
              ])
              if (delivery) {
                repos.markDeliveryDone(delivery.id, {
                  savedPath: copied.savedPath,
                  savedName: copied.savedName,
                  size: copied.size,
                  sha256: ''
                })
              }
              archived++
              if (extract && isArchiveFile(name)) {
                try {
                  const res = await extractArchiveTo(copied.savedPath, dirname(copied.savedPath))
                  extracted += res?.extracted ?? 0
                } catch (e) {
                  errors.push(`${name} 解压失败：${e instanceof Error ? e.message : String(e)}`)
                }
              }
            } catch (e) {
              errors.push(`${target.path} 写入失败：${e instanceof Error ? e.message : String(e)}`)
            }
          }
        } catch (e) {
          errors.push(`${file} 读取失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (archived > 0) {
        phase('已完成归档，正在回信…')
        repos.updateMessageStatus(messageId, archived > 0 ? 'done' : 'failed', errors.length ? errors.join('；') : null)
        repos.updateMessageReplyStatus(messageId, 'pending', null)
        emit({ type: 'delivery:changed', messageId })
        emit({ type: 'dashboard:changed' })
        if (rule.autoReply) {
          try {
            await replyService.maybeReply(messageId)
          } catch {
            /* 回信失败由 reply-service 记录 */
          }
        }
      }
      return {
        ok: archived > 0,
        archived,
        extracted,
        message: errors.length ? errors.slice(0, 3).join('；') : undefined
      }
    },
    async reprocessMessage(messageId: number): Promise<{ ok: boolean; message?: string }> {
      const row = repos.getMessage(messageId)
      if (!row) return { ok: false, message: '找不到这封邮件' }
      const r = await scheduler.reprocess(row.account_id, [row.imap_uid])
      return { ok: r.processed > 0, message: r.processed > 0 ? undefined : '重新识别失败，请稍后再试' }
    },
    async retryDownload(messageId: number): Promise<{ ok: boolean; message?: string }> {
      const target = repos.resetMessageForDownloadRetry(messageId)
      if (!target) return { ok: false, message: '找不到这封邮件' }
      emit({ type: 'dashboard:changed' })
      const r = await scheduler.reprocess(target.accountId, [target.imapUid])
      return { ok: r.processed > 0, message: r.processed > 0 ? undefined : '重新下载失败，请稍后再试' }
    },
    async retryMessage(messageId: number, deliveryId?: number): Promise<void> {
      await dispatcher.retryDelivery(messageId, deliveryId)
    },
    async init(): Promise<void> {
      dispatcher.start()
      startAutoRetry()
      cleanTempFiles()
      // 上次运行被强行关闭/断网时，邮件会停在「处理中」：启动后标记为失败，让用户能点「重试下载」
      try {
        const stuck = repos.listStuckQueuedMessages(5 * 60_000)
        for (const m of stuck) {
          repos.updateMessageStatus(
            m.id,
            'failed',
            '上次下载被中断（软件关闭或网络断开）。可点行内「重试下载」重新拉取'
          )
        }
        if (stuck.length > 0) console.log(`[backend] 恢复 ${stuck.length} 封卡在「处理中」的邮件 → 可重试`)
      } catch {
        /* ignore */
      }
      emit({ type: 'dashboard:changed' })
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      if (autoRetryTimer) {
        clearInterval(autoRetryTimer)
        autoRetryTimer = null
      }
      scheduler.stopAll()
      dispatcher.stop()
      replyService.dispose()
    }
  }
  archiveManualRef = (messageId, files) => backend.archiveManualFiles(messageId, files)
  return backend
}

/** 生产用的默认临时目录（backend-impl 会传 app.getPath('temp')） */
export function defaultTmpDir(baseTmp: string): string {
  return join(baseTmp, 'mailharbor')
}
