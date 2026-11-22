/**
 * 自动回信服务：模板渲染 + 发送 + 防轰炸。
 *
 * 防轰炸（ARCHITECTURE §2.6）：
 *  - 同一 (account_id, thread_key) 只回一次（DB 唯一索引 + 内存记账）
 *  - 跳过 Auto-Submitted 自动回复 / mailer-daemon、no-reply、自己发给自己
 *  - 全部 required 投递成功才回（optional 失败不阻塞）
 *  - 日上限 300 封；连续 3 次失败熔断 30 分钟
 *  - 每账户发送频率 ≤1 封/2s（replyDelaySec 之外再兜底）
 */
import type { Account, MainEvent, ReplyStatus, Settings } from '@shared/types'
import * as repos from './repos'
import type { MessageRow } from './repos'
import {
  buildReplyVars, composeReply, ReplySendError, sendReply, type ReplyRequest, type SendReplyResult, type SmtpConfig
} from './smtp'
import { createLogger, type Logger } from './log'

export type Emit = (e: MainEvent) => void

export const DAILY_REPLY_CAP = 300
export const CIRCUIT_FAILURE_THRESHOLD = 3
export const CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000
/** 每账户最小发送间隔（防止服务商风控） */
export const MIN_SEND_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// 决策（纯函数，便于单测）
// ---------------------------------------------------------------------------
export type ReplyAction = 'send' | 'wait' | 'suppress'

export interface ReplyDecisionInput {
  replyStatus: ReplyStatus
  /** 是否命中规则且规则 autoReply=true（兜底路径按全局开关） */
  autoReply: boolean
  globalEnabled: boolean
  requiredAllDone: boolean
  alreadySentThread: boolean
  fromAddr: string
  selfAddresses: string[]
  autoSubmitted: boolean
  dailyCount: number
  /** 最近一小时已回信数 */
  hourlyCount?: number
  /** 同线程只回一次（默认 true） */
  threadOnce?: boolean
  /** 每小时回信上限（不传则用默认 60） */
  hourlyCap?: number
  circuitOpen: boolean
}

export interface ReplyDecision {
  action: ReplyAction
  /** 需要落库的新 reply_status（不变则 undefined） */
  replyStatus?: ReplyStatus
  reason: string
}

const NOREPLY = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/i

/** 回信决策：先安全后业务。所有分支都有可读 reason（写日志用，不含密码） */
export function decideReply(i: ReplyDecisionInput): ReplyDecision {
  if (i.replyStatus === 'sent') return { action: 'wait', reason: '该邮件已回过信' }
  if (i.replyStatus === 'suppressed') return { action: 'wait', reason: '该邮件已被抑制回信' }
  if (i.replyStatus === 'disabled') return { action: 'wait', reason: '回信已关闭（规则或全局开关）' }
  if (!i.globalEnabled) return { action: 'wait', replyStatus: 'disabled', reason: '设置中关闭了自动回信' }
  if (!i.autoReply) return { action: 'wait', replyStatus: 'disabled', reason: '该规则未开启自动回信' }
  if (i.autoSubmitted) return { action: 'suppress', replyStatus: 'suppressed', reason: '自动回复类邮件（Auto-Submitted），不再回信' }
  const from = (i.fromAddr ?? '').trim().toLowerCase()
  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return { action: 'suppress', replyStatus: 'suppressed', reason: '发件人地址无效，无法回信' }
  }
  if (i.selfAddresses.map((a) => a.trim().toLowerCase()).includes(from)) {
    return { action: 'suppress', replyStatus: 'suppressed', reason: '发件人就是本账户自己（避免循环回信）' }
  }
  if (NOREPLY.test(from)) return { action: 'suppress', replyStatus: 'suppressed', reason: '系统退信 / no-reply 地址，不回信' }
  if (i.threadOnce !== false && i.alreadySentThread) {
    return { action: 'suppress', replyStatus: 'suppressed', reason: '同一线程已经回过信' }
  }
  if (!i.requiredAllDone) return { action: 'wait', reason: '等待必达路径全部完成' }
  if ((i.hourlyCount ?? 0) >= (i.hourlyCap ?? 60)) {
    return {
      action: 'suppress',
      replyStatus: 'suppressed',
      reason: `本小时回信已达上限（${i.hourlyCap ?? 60} 封），下小时自动恢复`
    }
  }
  if (i.circuitOpen) return { action: 'wait', reason: '连续发送失败熔断中（30 分钟）' }
  return { action: 'send', reason: '全部必达路径成功，发送回信' }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
export interface ReplyServiceDeps {
  emit: Emit
  getSetting: <T = unknown>(key: string) => T
  getSecrets: (accountId: number) => { imapPass: string; smtpPass: string }
  now?: () => number
  logger?: Logger
  /** 便于单测注入；生产用 smtp.sendReply */
  send?: (cfg: SmtpConfig, req: ReplyRequest) => Promise<SendReplyResult>
}

interface CircuitState {
  failures: number
  lastFailureAt: number
  openedAt: number | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

export class ReplyService {
  private deps: ReplyServiceDeps
  private log: Logger
  private inflight = new Set<string>()
  private circuits = new Map<number, CircuitState>()
  private lastSentAt = new Map<number, number>()
  private disposed = false

  constructor(deps: ReplyServiceDeps) {
    this.deps = deps
    this.log = deps.logger ?? createLogger('reply')
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private settings(): Settings {
    const keys = [
      'replyEnabled', 'replyDelaySec', 'replySubjectZh', 'replyBodyZh', 'replySubjectEn', 'replyBodyEn',
      'replyLanguage', 'replyThreadOnce', 'replyHourlyCap', 'logLevel'
    ] as const
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = this.deps.getSetting(k)
    return out as unknown as Settings
  }

  dispose(): void {
    this.disposed = true
    this.inflight.clear()
  }

  private circuitOf(accountId: number): CircuitState {
    const existing = this.circuits.get(accountId)
    if (existing) return existing
    const fresh: CircuitState = { failures: 0, lastFailureAt: 0, openedAt: null }
    this.circuits.set(accountId, fresh)
    return fresh
  }

  private isCircuitOpen(accountId: number): boolean {
    const st = this.circuitOf(accountId)
    if (!st.openedAt) return false
    if (this.now() - st.openedAt >= CIRCUIT_COOLDOWN_MS) {
      st.openedAt = null
      st.failures = 0
      return false
    }
    return true
  }

  /**
   * 由 pipeline 在一封邮件的全部 delivery 进入终态后调用。
   * 幂等：已 sent/suppressed/disabled 的邮件直接返回。
   */
  async maybeReply(messageId: number): Promise<void> {
    const msg = repos.getMessage(messageId)
    if (!msg) return
    if (msg.reply_status !== 'pending') return

    const account = repos.getAccount(msg.account_id)
    if (!account) return
    if (!account.enabled) {
      repos.updateMessageReplyStatus(messageId, 'disabled', '账户已停用，不回信')
      return
    }
    const rule = msg.matched_rule_id ? repos.getRule(msg.matched_rule_id) : null
    const agg = repos.deliveryAggregate(messageId)
    const threadKey = msg.thread_key ?? msg.rfc_message_id ?? `mid:${messageId}`
    const settings = this.settings()
    const dailyCount = repos.repliesTodayCount(account.id)
    const hourlyCount = repos.repliesLastHourCount(account.id)
    const circuitOpen = this.isCircuitOpen(account.id)
    const alreadySentThread = repos.hasSentThread(account.id, threadKey)

    const decision = decideReply({
      replyStatus: msg.reply_status,
      autoReply: rule ? rule.autoReply : true,
      globalEnabled: settings.replyEnabled !== false,
      requiredAllDone: agg.requiredAllDone,
      alreadySentThread,
      fromAddr: msg.from_addr ?? '',
      selfAddresses: [account.email, account.imapUser, account.smtpUser],
      // Auto-Submitted 在 pipeline 阶段已抑制；这里按「未抑制即不自动回复」处理
      autoSubmitted: false,
      dailyCount,
      hourlyCount,
      threadOnce: settings.replyThreadOnce !== false,
      hourlyCap: Number(settings.replyHourlyCap) || 60,
      circuitOpen
    })

    if (decision.action === 'wait') {
      if (decision.replyStatus && decision.replyStatus !== msg.reply_status) {
        repos.updateMessageReplyStatus(messageId, decision.replyStatus, decision.reason)
        this.emitRecord(messageId)
      }
      return
    }
    if (decision.action === 'suppress') {
      this.log.info(`回信抑制（邮件 #${messageId}）：${decision.reason}`)
      repos.updateMessageReplyStatus(messageId, decision.replyStatus ?? 'suppressed', decision.reason)
      repos.insertReply({
        accountId: account.id,
        messageId,
        threadKey,
        toAddr: msg.from_addr ?? '',
        subject: msg.subject,
        status: 'suppressed',
        error: decision.reason
      })
      this.emitRecord(messageId)
      return
    }

    // decision.action === 'send'
    const guard = `${account.id}:${threadKey}`
    if (this.inflight.has(guard)) return
    this.inflight.add(guard)
    try {
      const delaySec = Math.min(Math.max(Number(settings.replyDelaySec) || 0, 0), 300)
      if (delaySec > 0) {
        this.log.info(`回信延迟 ${delaySec}s 后发送（邮件 #${messageId}）`)
        await sleep(delaySec * 1000)
      }
      if (this.disposed) return
      // 延迟期间可能已被另一轮处理过
      const latest = repos.getMessage(messageId)
      if (!latest || latest.reply_status !== 'pending') return
      if (repos.hasSentThread(account.id, threadKey)) {
        repos.updateMessageReplyStatus(messageId, 'suppressed', '同一线程已经回过信')
        this.emitRecord(messageId)
        return
      }
      // 频率限制：同账户两封回信至少间隔 2s
      const last = this.lastSentAt.get(account.id) ?? 0
      const wait = MIN_SEND_INTERVAL_MS - (this.now() - last)
      if (wait > 0) await sleep(wait)
      if (this.disposed) return

      const secrets = this.deps.getSecrets(account.id)
      const cfg: SmtpConfig = {
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        user: account.smtpUser,
        pass: secrets.smtpPass
      }
      const request = this.buildRequest(account, msg, settings)
      if (!request) {
        repos.updateMessageReplyStatus(messageId, 'suppressed', '找不到可回信的发件人地址')
        this.emitRecord(messageId)
        return
      }

      try {
        const result = await (this.deps.send ?? sendReply)(cfg, request)
        this.lastSentAt.set(account.id, this.now())
        repos.insertReply({
          accountId: account.id,
          messageId,
          threadKey,
          toAddr: request.to.address,
          subject: request.subject,
          bodyPreview: request.body.slice(0, 500),
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: this.now()
        })
        repos.updateMessageReplyStatus(messageId, 'sent')
        const st = this.circuitOf(account.id)
        st.failures = 0
        st.openedAt = null
        this.log.info(`回信已发送（邮件 #${messageId} → ${request.to.address}）`)
        this.emitRecord(messageId)
        this.deps.emit({ type: 'toast', level: 'success', title: '已自动回信', body: `已回复 ${request.to.address}` })
      } catch (e) {
        this.onSendFailed(account, msg, threadKey, e)
      }
    } finally {
      this.inflight.delete(guard)
    }
  }

  private buildRequest(account: Account, msg: MessageRow, settings: Settings): ReplyRequest | null {
    const toAddr = (msg.from_addr ?? '').trim()
    if (!toAddr) return null
    const record = repos.getRecordById(msg.id)
    const filenames = (record?.attachments ?? [])
      .filter((a) => a.deliveries.some((d) => d.state === 'done'))
      .map((a) => a.filename)
    const vars = buildReplyVars({
      filenames,
      keyword: msg.matched_keyword,
      sentAt: this.now(),
      factoryName: account.smtpFromName || account.displayName || account.email
    })
    const rendered = composeReply(
      {
        replySubjectZh: String(settings.replySubjectZh ?? ''),
        replyBodyZh: String(settings.replyBodyZh ?? ''),
        replySubjectEn: String(settings.replySubjectEn ?? ''),
        replyBodyEn: String(settings.replyBodyEn ?? ''),
        replyLanguage: settings.replyLanguage
      },
      vars
    )
    const body =
      rendered.body ||
      `已收到您的图稿（${vars['数量']} 个文件）：${vars['文件名']}\n\n— MailHarbor`
    const references: string[] = []
    if (msg.thread_key && msg.thread_key !== msg.rfc_message_id) references.push(msg.thread_key)
    return {
      from: { address: account.email, name: account.smtpFromName || account.displayName || account.email },
      to: { address: toAddr, name: msg.from_name ?? '' },
      subject: rendered.subject,
      body,
      inReplyTo: msg.rfc_message_id,
      references
    }
  }

  private onSendFailed(account: Account, msg: MessageRow, threadKey: string, e: unknown): void {
    const code = e instanceof ReplySendError ? e.code : 'UNKNOWN'
    const message = e instanceof Error ? e.message : String(e)
    this.log.warn(`回信失败（邮件 #${msg.id}）[${code}]`, message)
    repos.insertReply({
      accountId: account.id,
      messageId: msg.id,
      threadKey,
      toAddr: msg.from_addr ?? '',
      subject: msg.subject,
      status: 'failed',
      error: `[${code}] ${message}`.slice(0, 1000)
    })
    repos.updateMessageReplyStatus(msg.id, 'failed', `回信失败：[${code}] ${message}`.slice(0, 500))
    this.emitRecord(msg.id)

    if (code === 'SMTP_AUTH_FAILED') {
      // 密码失效 / SMTP 被关闭：账户置为认证失败，避免持续无效重试
      repos.setAccountStatus(account.id, 'auth_failed', {
        errorCode: code,
        error: message,
        checked: true
      })
      const fresh = repos.getAccount(account.id)
      if (fresh) this.deps.emit({ type: 'account:changed', account: fresh })
      this.deps.emit({
        type: 'toast',
        level: 'error',
        title: '回信失败：邮箱需要重新设置密码',
        body: 'SMTP 登录被拒绝，请到「邮箱账户」重新填写应用专用密码 / 授权码'
      })
      return
    }

    const st = this.circuitOf(account.id)
    if (this.now() - st.lastFailureAt > CIRCUIT_COOLDOWN_MS) st.failures = 0
    st.failures++
    st.lastFailureAt = this.now()
    if (st.failures >= CIRCUIT_FAILURE_THRESHOLD && !st.openedAt) {
      st.openedAt = this.now()
      this.deps.emit({
        type: 'toast',
        level: 'warn',
        title: '自动回信已暂停 30 分钟',
        body: `连续 ${CIRCUIT_FAILURE_THRESHOLD} 次发送失败（${code}），稍后自动恢复`
      })
    }
  }

  private emitRecord(messageId: number): void {
    const record = repos.getRecordById(messageId)
    if (record) this.deps.emit({ type: 'message:upserted', record })
    this.deps.emit({ type: 'dashboard:changed' })
  }
}
