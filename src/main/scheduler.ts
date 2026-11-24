/**
 * 账户级收信调度器。
 *
 * - 每个启用账户一个 worker：串行、无重入；全局 tick 每 3s 检查一次
 * - poll()：增量 UID 扫描（provider.fetchNewMessages）→ 逐封交给 pipeline
 * - 网络/服务器异常：账户 status=offline，指数退避 5s→10s→30s→1m→5m
 * - 认证失败（密码/授权码失效、IMAP 被关）：status=auth_failed，30 分钟后再试
 * - IDLE 收到新信 → 立即触发该账户 poll；不支持 IDLE 由 provider 降级 30s 轮询
 * - 启动后 startAll()；pause()/resume()/checkNow()/stopAll()；isListening()/nextCheckAt()
 */
import type { Account, MainEvent } from '@shared/types'
import * as repos from './repos'
import { createLogger, type Logger } from './log'
import {
  ImapSmtpProvider, ProviderError, providerConfigFromAccount,
  type InboundAttachment, type InboundMessage, type ProviderConfig, type SyncState
} from './providers/imap'
import { classifyMailError, FIX_HINTS, type MailErrorCode } from './providers/errors'

export type Emit = (e: MainEvent) => void

/** scheduler 需要的最小 Provider 接口（单测可注入假实现，不连网） */
export interface SchedulerProvider {
  connect(): Promise<SyncState>
  fetchNewMessages(opts: { lastUid: number; uidValidity?: string | null; maxMessages?: number }): Promise<InboundMessage[]>
  fetchJunkMessages?(opts: {
    lastUid: number
    uidValidity?: string | null
    maxMessages?: number
  }): Promise<{ messages: InboundMessage[]; uidValidity: string | null }>
  selectMailbox?(folder: string): Promise<void>
  downloadAttachment(
    uid: number,
    part: InboundAttachment,
    destTmpPath: string,
    onProgress?: (received: number, total: number) => void,
    timeoutMs?: number,
    chunkSize?: number,
    parallel?: { enabled: boolean; connections: number; thresholdBytes: number }
  ): Promise<{ size: number; sha256: string; tmpPath: string }>
  /** 可选：按 UID 精确补扫（新增/启用规则后重跑历史邮件） */
  fetchByUids?(uids: number[]): Promise<InboundMessage[]>
  startIdle(onMail: () => void): Promise<void>
  stopPolling?(): void
  stopIdle(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
}

export interface SchedulerPipeline {
  process(
    account: Account,
    provider: unknown,
    msg: InboundMessage,
    mailbox?: string
  ): Promise<{ messageId: number; status: string }>
}

export interface SchedulerDeps {
  emit: Emit
  getSetting: <T = unknown>(key: string) => T
  pipeline: SchedulerPipeline
  logger?: Logger
  now?: () => number
  /** 单测注入假 Provider；生产用 ImapSmtpProvider */
  createProvider?: (account: Account, cfg: ProviderConfig) => SchedulerProvider
}

export const SCHED_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 5 * 60_000]
export const AUTH_RETRY_MS = 30 * 60_000
export const TICK_MS = 3_000
export const MIN_POLL_INTERVAL_SEC = 15

const AUTH_CODES = new Set<MailErrorCode>([
  'IMAP_AUTH_FAILED',
  'IMAP_APP_PASSWORD_REQUIRED',
  'IMAP_DISABLED',
  'SMTP_AUTH_FAILED'
])

interface Worker {
  accountId: number
  provider: SchedulerProvider | null
  signature: string
  failures: number
  nextAttemptAt: number
  lastPollAt: number
  busy: boolean
  idleStarted: boolean
  missingPasswordLogged: boolean
  /** 垃圾邮件文件夹游标（与 INBOX 游标分开） */
  spamLastUid: number
  spamUidValidity: string | null
}

export class Scheduler {
  private deps: SchedulerDeps
  private log: Logger
  private timer: NodeJS.Timeout | null = null
  private workers = new Map<number, Worker>()
  private started = false
  private paused = true
  private ticking = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
    this.log = deps.logger ?? createLogger('scheduler')
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private pollIntervalMs(): number {
    const sec = Number(this.deps.getSetting<number>('pollIntervalSec') ?? 30)
    return Math.max(MIN_POLL_INTERVAL_SEC, Number.isFinite(sec) ? sec : 30) * 1000
  }

  // ---------------- 生命周期 ----------------
  startAll(): void {
    if (this.started) return
    this.started = true
    this.paused = false
    this.syncWorkers()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.deps.emit({ type: 'listening:changed', listening: true })
    this.log.info('调度器已启动（监听中）')
    void this.tick()
  }

  stopAll(): void {
    this.paused = true
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const worker of this.workers.values()) {
      void this.disposeWorker(worker)
    }
    this.workers.clear()
    this.deps.emit({ type: 'listening:changed', listening: false })
    this.log.info('调度器已停止（所有 IMAP 连接已断开）')
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    for (const worker of this.workers.values()) {
      if (worker.provider) void worker.provider.stopIdle()
      worker.idleStarted = false
    }
    this.deps.emit({ type: 'listening:changed', listening: false })
    this.log.info('已暂停监听')
  }

  async resume(): Promise<void> {
    if (!this.started) {
      this.startAll()
      return
    }
    if (!this.paused) {
      await this.checkNow()
      return
    }
    this.paused = false
    for (const worker of this.workers.values()) {
      worker.nextAttemptAt = 0
      worker.lastPollAt = 0
    }
    this.deps.emit({ type: 'listening:changed', listening: true })
    this.log.info('已恢复监听')
    void this.tick()
  }

  isListening(): boolean {
    return this.started && !this.paused
  }

  /** 最近一次 tick 后，下一次任一账户被检查的时间 */
  nextCheckAt(): number | null {
    if (this.paused || this.workers.size === 0) return null
    const interval = this.pollIntervalMs()
    let min: number | null = null
    for (const worker of this.workers.values()) {
      // 注意：这里不能因为 busy 就返回 now，否则大附件下载期间会一直显示「即将检查」、进度条卡在 100%
      const at = Math.max(worker.lastPollAt + interval, worker.nextAttemptAt || 0)
      if (min === null || at < min) min = at
    }
    return min
  }

  /** 是否正在执行一轮检查（任一账户 busy） */
  isChecking(): boolean {
    for (const worker of this.workers.values()) if (worker.busy) return true
    return false
  }

  /** 最近一次检查完成时间（各账户取最大） */
  lastCheckAt(): number | null {
    let max: number | null = null
    for (const worker of this.workers.values()) {
      if (worker.lastPollAt > 0 && (max === null || worker.lastPollAt > max)) max = worker.lastPollAt
    }
    return max
  }

  /**
   * 补扫指定 UID 的邮件（新增/启用规则后调用）。
   * 不走游标、不改游标，只把这几封重新喂给 pipeline；已完成的会被 pipeline 去重跳过。
   */
  async reprocess(accountId: number, uids: number[]): Promise<{ processed: number; errors: number }> {
    if (!this.started) return { processed: 0, errors: 0 }
    this.syncWorkers()
    const worker = this.workers.get(accountId)
    const account = repos.getAccount(accountId)
    if (!worker || !account) return { processed: 0, errors: 0 }
    const provider = await this.getProvider(worker, account)
    if (!provider) {
      this.log.warn(`补扫跳过：账户 #${accountId} 没有可用连接`)
      return { processed: 0, errors: 0 }
    }
    if (!provider.fetchByUids) {
      this.log.warn(`补扫跳过：当前收信实现不支持按 UID 取信`)
      return { processed: 0, errors: 0 }
    }
    await provider.connect()
    let messages: InboundMessage[] = []
    try {
      messages = await provider.fetchByUids(uids)
    } catch (e) {
      this.log.warn(`补扫取信失败（账户 #${accountId}）`, e instanceof Error ? e.message : String(e))
      return { processed: 0, errors: uids.length }
    }
    let processed = 0
    let errors = 0
    for (const msg of messages) {
      try {
        await this.deps.pipeline.process(repos.getAccount(accountId) ?? account, provider, msg)
        processed++
      } catch (e) {
        errors++
        this.log.error(`补扫处理失败 UID=${msg.uid}`, e instanceof Error ? e.message : String(e))
      }
    }
    if (processed > 0) this.deps.emit({ type: 'dashboard:changed' })
    return { processed, errors }
  }

  /** 立即检查所有账户（按钮「立即检查」/ 休眠恢复） */
  async checkNow(): Promise<void> {
    if (!this.started) return
    this.syncWorkers()
    const wasPaused = this.paused
    const tasks: Array<Promise<void>> = []
    for (const worker of this.workers.values()) {
      worker.nextAttemptAt = 0
      // 同样不阻塞：立即返回，让 UI 保持可用；进度通过事件推送
      const p = this.pollWorker(worker, true)
      tasks.push(p)
      void p.catch((e) => this.log.warn('手动检查异常', e instanceof Error ? e.message : String(e)))
    }
    if (wasPaused) {
      // 暂停状态下手动检查：不改变 listening 状态，但连一次后立即断开
      for (const worker of this.workers.values()) {
        if (worker.provider) await worker.provider.stopIdle().catch(() => {})
        worker.idleStarted = false
      }
    }
    this.deps.emit({ type: 'dashboard:changed' })
  }

  // ---------------- 内部 ----------------
  private syncWorkers(): void {
    // 「仅发件」账户（如阿里云 DirectMail）没有收件箱，不参与收信调度
    const accounts = repos.listAccounts().filter((a) => a.enabled && a.status !== 'disabled' && !a.sendOnly)
    const alive = new Set(accounts.map((a) => a.id))
    for (const [id, worker] of this.workers) {
      if (!alive.has(id)) {
        void this.disposeWorker(worker)
        this.workers.delete(id)
      }
    }
    for (const account of accounts) {
      if (!this.workers.has(account.id)) {
        this.workers.set(account.id, {
          accountId: account.id,
          provider: null,
          signature: '',
          failures: 0,
          nextAttemptAt: 0,
          lastPollAt: 0,
          busy: false,
          idleStarted: false,
          missingPasswordLogged: false,
          spamLastUid: repos.getAccountSpamState(account.id)?.lastUid ?? 0,
          spamUidValidity: repos.getAccountSpamState(account.id)?.uidValidity ?? null
        })
      }
    }
  }

  private async disposeWorker(worker: Worker): Promise<void> {
    const provider = worker.provider
    worker.provider = null
    worker.idleStarted = false
    if (provider) {
      try {
        await provider.disconnect()
      } catch {
        /* ignore */
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.paused || !this.started) return
    this.ticking = true
    try {
      this.syncWorkers()
      const interval = this.pollIntervalMs()
      const at = this.now()
      const due: Array<Promise<void>> = []
      for (const worker of this.workers.values()) {
        if (worker.busy) continue
        if (worker.nextAttemptAt > at) continue
        if (at - worker.lastPollAt < interval) continue
        due.push(this.pollWorker(worker))
      }
      if (due.length > 0) {
        // 关键：不要 await！大附件下载可能持续几分钟到几十分钟，
        // 一旦 await 整个 tick 会被卡住，其它账户/后续轮询全部停摆（表现为"新邮件不进来"）。
        for (const task of due) {
          void task.catch((e) => this.log.warn('轮询异常', e instanceof Error ? e.message : String(e)))
        }
        this.deps.emit({ type: 'dashboard:changed' })
      }
    } finally {
      this.ticking = false
    }
  }

  /** IDLE 收到新邮件：尽快轮询该账户（≤3s），但不会打断正在进行的 poll */
  private onIdleMail(worker: Worker): void {
    if (this.paused) return
    worker.lastPollAt = 0
    if (!worker.busy) void this.pollWorker(worker)
  }

  private createProviderFor(account: Account): SchedulerProvider {
    const secrets = repos.getAccountSecrets(account.id)
    const rawProxy = this.deps.getSetting<{ mode?: string; host?: string; port?: number }>('proxy')
    const proxy = {
      mode: ((rawProxy?.mode ?? 'system') as 'none' | 'system' | 'socks5' | 'http'),
      host: String(rawProxy?.host ?? '127.0.0.1'),
      port: Number(rawProxy?.port ?? 7890)
    }
    const cfg = providerConfigFromAccount(account, secrets, proxy)
    if (this.deps.createProvider) return this.deps.createProvider(account, cfg)
    const provider = new ImapSmtpProvider(cfg, {
      logger: createLogger(`imap:${account.email}`),
      onStateChange: (s) => {
        const current = repos.getAccountRow(account.id)
        if (!current) return
        if (s.connected) {
          if (current.status !== 'enabled') this.applyStatus(account.id, 'enabled', { ok: true })
        } else if (s.errorCode) {
          const status = AUTH_CODES.has(s.errorCode) ? 'auth_failed' : 'offline'
          this.applyStatus(account.id, status, { errorCode: s.errorCode, error: s.message ?? FIX_HINTS[s.errorCode] })
          if (status === 'auth_failed') this.notifyAuthFailed(account)
        }
      }
    })
    return provider
  }

  private async getProvider(worker: Worker, account: Account): Promise<SchedulerProvider | null> {
    // updatedAt 只在用户保存账户配置时变化（同步游标/健康状态不会改它）
    const signature = `${account.id}:${account.updatedAt}:${account.imapHost}:${account.imapPort}:${account.imapUser}:${account.hasPassword}`
    if (worker.provider && worker.signature === signature) return worker.provider
    if (worker.provider) await this.disposeWorker(worker)
    if (!account.hasPassword) {
      if (!worker.missingPasswordLogged) {
        this.log.warn(`账户 #${account.id} 未保存密码，跳过收信`)
        worker.missingPasswordLogged = true
      }
      return null
    }
    worker.provider = this.createProviderFor(account)
    worker.signature = signature
    return worker.provider
  }

  private applyStatus(
    accountId: number,
    status: Account['status'],
    opts: { errorCode?: string | null; error?: string | null; ok?: boolean; checked?: boolean } = {}
  ): void {
    const before = repos.getAccountRow(accountId)
    repos.setAccountStatus(accountId, status, { checked: true, ...opts })
    const after = repos.getAccount(accountId)
    if (after && (!before || before.status !== status || opts.errorCode)) {
      this.deps.emit({ type: 'account:changed', account: after })
    }
  }

  private notifyAuthFailed(account: Account): void {
    this.deps.emit({
      type: 'toast',
      level: 'error',
      title: '邮箱需要重新设置密码',
      body: `${account.email} 登录被拒绝，请检查应用专用密码 / 授权码或 IMAP 服务是否开启`
    })
  }

  private backoffMs(failures: number): number {
    const idx = Math.min(Math.max(failures - 1, 0), SCHED_BACKOFF_MS.length - 1)
    return SCHED_BACKOFF_MS[idx]!
  }

  /**
   * 单账户一轮：连接 → 增量拉取 → 逐封处理 → 更新游标/状态 → 首次成功后进入 IDLE。
   * 单账户串行（worker.busy 防重入）。
   */
  private async pollWorker(worker: Worker, force = false): Promise<void> {
    if (worker.busy) return
    if (this.paused && !force) return
    worker.busy = true
    const accountId = worker.accountId
    try {
      const account = repos.getAccount(accountId)
      if (!account || !account.enabled || account.status === 'disabled') {
        await this.disposeWorker(worker)
        return
      }
      const provider = await this.getProvider(worker, account)
      if (!provider) {
        worker.lastPollAt = this.now()
        worker.nextAttemptAt = this.now() + 5 * 60_000
        return
      }

      const sync = await provider.connect()
      if (account.status !== 'enabled') this.applyStatus(accountId, 'enabled', { ok: true })
      else repos.updateAccountSyncState(accountId, { lastOkAt: this.now() })

      // 首次接入新账户：从"当前最新"开始收，不回溯历史。
      // 否则一个已有几千封邮件的邮箱会被全量扫描，还可能给旧客户误发回信。
      // 小邮箱（新账号/测试）直接全量处理；大邮箱（几千封历史）从最新开始，避免扫历史+误回旧邮件
      const mailboxSize = Number(sync.exists ?? 0)
      if (!account.lastUid && sync.uidNext && sync.uidNext > 1 && mailboxSize > 50) {
        const baseline = Number(sync.uidNext) - 1
        repos.updateAccountSyncState(accountId, {
          lastUid: baseline,
          uidValidity: String(sync.uidValidity ?? ''),
          lastCheckAt: this.now(),
          lastOkAt: this.now()
        })
        this.log.info(`首次接入：游标设为当前最新 UID ${baseline}（不回溯历史邮件；需要旧邮件请用「补扫历史」）`)
        this.deps.emit({ type: 'dashboard:changed' })
        return
      }

      const messages = await provider.fetchNewMessages({
        lastUid: account.lastUid,
        uidValidity: account.uidValidity,
        maxMessages: 25
      })
      this.log.info(`[debug] 拉取完成：lastUid=${account.lastUid} 新邮件 ${messages.length} 封（UID: ${messages.map((m) => m.uid).join(',') || '-'}）`)

      let lastUid = account.lastUid
      for (const msg of messages) {
        try {
          await this.deps.pipeline.process(repos.getAccount(accountId) ?? account, provider, msg)
        } catch (e) {
          this.log.error(`处理邮件失败 UID=${msg.uid}`, e instanceof Error ? e.message : String(e))
        }
        if (msg.uid > lastUid) {
          lastUid = msg.uid
          // 每封处理完就落游标：崩溃后从下一封继续，幂等兜底
          repos.updateAccountSyncState(accountId, {
            lastUid,
            uidValidity: sync.uidValidity,
            lastCheckAt: this.now(),
            lastOkAt: this.now()
          })
        }
      }
      if (messages.length === 0) {
        repos.updateAccountSyncState(accountId, {
          uidValidity: sync.uidValidity,
          lastCheckAt: this.now(),
          lastOkAt: this.now()
        })
      }

      // 垃圾邮件文件夹扫描（Gmail 会把 QQ 发来的大附件判垃圾）
      if (
        this.deps.getSetting<boolean>('scanSpam') !== false &&
        typeof provider.fetchJunkMessages === 'function'
      ) {
        try {
          const junk = await provider.fetchJunkMessages({
            lastUid: worker.spamLastUid,
            uidValidity: worker.spamUidValidity,
            maxMessages: 20
          })
          worker.spamUidValidity = junk.uidValidity
          if (junk.messages.length > 0) {
            this.log.info(`垃圾邮件中发现 ${junk.messages.length} 封，按规则处理（不自动回信）`)
          }
          for (const msg of junk.messages) {
            try {
              await this.deps.pipeline.process(repos.getAccount(accountId) ?? account, provider, msg, 'Junk')
            } catch (e) {
              this.log.warn(`处理垃圾邮件 UID=${msg.uid} 失败`, e instanceof Error ? e.message : String(e))
            }
            if (msg.uid > worker.spamLastUid) worker.spamLastUid = msg.uid
          }
          repos.updateAccountSpamState(accountId, worker.spamLastUid, worker.spamUidValidity)
        } catch (e) {
          this.log.warn('垃圾邮件扫描异常', e instanceof Error ? e.message : String(e))
        } finally {
          // 无论成功失败都切回 INBOX，保证后续轮询/IDLE 正常
          try {
            await provider.selectMailbox?.('INBOX')
          } catch {
            /* ignore */
          }
        }
      }

      worker.failures = 0
      worker.nextAttemptAt = 0
      worker.lastPollAt = this.now()

      if (!worker.idleStarted && this.isListening()) {
        worker.idleStarted = true
        void provider
          .startIdle(() => this.onIdleMail(worker))
          .catch((e) => {
            worker.idleStarted = false
            this.log.warn('进入 IDLE 失败，继续兜底轮询', e instanceof Error ? e.message : String(e))
          })
      }
    } catch (e) {
      const classified =
        e instanceof ProviderError
          ? { code: (e.mailCode ?? 'UNKNOWN') as MailErrorCode, message: e.message, detail: undefined }
          : classifyMailError(e, 'imap')
      const auth = AUTH_CODES.has(classified.code)
      const status: Account['status'] = auth ? 'auth_failed' : 'offline'
      this.applyStatus(accountId, status, { errorCode: classified.code, error: classified.message })
      worker.failures++
      worker.lastPollAt = this.now()
      worker.nextAttemptAt = this.now() + (auth ? AUTH_RETRY_MS : this.backoffMs(worker.failures))
      this.log.warn(
        `账户 #${accountId} 收信失败 [${classified.code}]，${auth ? '30 分钟' : `${Math.round(this.backoffMs(worker.failures) / 1000)}s`}后重试`,
        classified.detail ?? classified.message
      )
      if (auth) {
        const fresh = repos.getAccount(accountId)
        if (fresh) this.notifyAuthFailed(fresh)
        worker.nextAttemptAt = this.now() + AUTH_RETRY_MS
      }
      // 认证/连接失败后断开连接，避免僵尸连接
      await this.disposeWorker(worker)
    } finally {
      worker.busy = false
      // 检查结束后刷新一次概览：左下角「检查中/下次检查」和进度条依赖这个字段
      this.deps.emit({ type: 'dashboard:changed' })
    }
  }


}
