/**
 * 单封邮件状态机：
 *   fetchMessage → matchRules → 无命中(ignored_no_keyword / 兜底路径) → 附件白名单
 *   → 下载到 tmp → 每个命中规则 × 每个 target 生成 delivery → dispatcher 扇出
 *   → 全部 required 成功后 replyService 回信 → 聚合 messages.status → 托盘/事件
 */
import type { Account, MainEvent, MessageStatus, ReplyStatus, Rule } from '@shared/types'
import * as repos from './repos'
import type { AttachmentRow, MessageRow } from './repos'
import { isAllowedAttachment, matchRules } from './rule-engine'
import { pathExists, sanitizeFilename } from './file-writer'
import type { InboundAttachment, InboundMessage } from './providers/imap'
import { createLogger, type Logger } from './log'
import { join } from 'node:path'

export type Emit = (e: MainEvent) => void

/** pipeline 只依赖 provider 的下载能力，便于单测注入假 provider */
export interface AttachmentDownloader {
  downloadAttachment(
    uid: number,
    part: InboundAttachment,
    destTmpPath: string
  ): Promise<{ size: number; sha256: string; tmpPath: string }>
}

export interface DeliveryQueue {
  schedule(): void
}

export interface ReplySink {
  maybeReply(messageId: number): Promise<void>
}

export interface PipelineDeps {
  emit: Emit
  getSetting: <T = unknown>(key: string) => T
  dispatcher: DeliveryQueue
  replyService: ReplySink
  tmpDir: string
  now?: () => number
  logger?: Logger
}

export interface ProcessOutcome {
  messageId: number
  status: MessageStatus
  matchedRuleIds: number[]
  deliveryCount: number
  skipped: boolean
}

export const DEFAULT_FALLBACK_TYPES = ['zip', 'tif', 'tiff']

export class MailPipeline {
  private deps: PipelineDeps
  private log: Logger

  constructor(deps: PipelineDeps) {
    this.deps = deps
    this.log = deps.logger ?? createLogger('pipeline')
  }

  private setting<T>(key: string): T {
    return this.deps.getSetting<T>(key)
  }

  /**
   * 处理一封新邮件（按 account 串行调用；内部 catch 掉业务错误并写状态，避免整批中断）。
   */
  async process(account: Account, provider: AttachmentDownloader, msg: InboundMessage): Promise<ProcessOutcome> {
    const fallbackOutcome = (messageId: number, status: MessageStatus, skipped = false): ProcessOutcome => ({
      messageId,
      status,
      matchedRuleIds: [],
      deliveryCount: 0,
      skipped
    })

    // 已处理过的邮件（UID 重扫 / 重启）：忽略状态可重试，其余跳过，保证不重复下载/回信
    const existing = repos.getMessageByUid(account.id, msg.uid)
    if (existing && existing.status !== 'ignored_no_keyword' && existing.status !== 'ignored_type') {
      this.log.debug(`邮件 UID=${msg.uid} 已处理过（#${existing.id} ${existing.status}），跳过`)
      return fallbackOutcome(existing.id, existing.status, true)
    }

    const rules = repos.listRules().filter((r) => r.enabled)
    const strategy = this.setting<'all' | 'priority'>('multiRuleStrategy') === 'priority' ? 'priority' : 'all'
    const hits = matchRules(rules, { subject: msg.subject, body: msg.bodyText }, strategy)
    const hitRules = hits
      .map((h) => ({ hit: h, rule: rules.find((r) => r.id === h.ruleId)! }))
      .filter((x) => !!x.rule)

    const rfcId = (msg.rfcMessageId || '').trim() || `uid:${account.uidValidity ?? ''}:${msg.uid}`
    const up = repos.upsertMessage({
      accountId: account.id,
      imapUid: msg.uid,
      rfcMessageId: msg.rfcMessageId || null,
      providerMessageId: rfcId,
      threadKey: msg.threadKey,
      subject: msg.subject,
      fromAddr: msg.fromAddr,
      fromName: msg.fromName,
      receivedAt: msg.receivedAt,
      status: 'queued'
    })
    const messageId = up.id

    // ---------------- 无命中 ----------------
    if (hitRules.length === 0) {
      const fallbackEnabled = !!this.setting<boolean>('defaultPathEnabled')
      const fallbackPath = String(this.setting<string>('defaultPath') ?? '').trim()
      const allowed = fallbackEnabled && fallbackPath
        ? msg.parts.filter((p) => isAllowedAttachment(p.filename, p.mimeType, this.fallbackTypes(rules)))
        : []
      if (allowed.length === 0) {
        repos.updateMessageStatus(messageId, 'ignored_no_keyword')
        repos.updateMessageReplyStatus(messageId, 'disabled', '未命中关键词，不自动回信')
        this.log.info(`未命中关键词：${msg.subject || '(无主题)'} → ignored_no_keyword`)
        this.emitRecord(messageId)
        return fallbackOutcome(messageId, 'ignored_no_keyword')
      }
      this.log.info(`未命中关键词，但命中兜底路径：${fallbackPath}（${allowed.length} 个附件）`)
      const downloaded = await this.downloadAll(account, provider, messageId, msg, allowed)
      if (!downloaded) return fallbackOutcome(messageId, 'failed')
      repos.createDeliveries(
        downloaded.map((a) => ({
          messageId,
          attachmentId: a.attachmentId,
          targetId: 0,
          targetPath: fallbackPath,
          required: true
        }))
      )
      repos.updateMessageStatus(messageId, 'queued')
      repos.updateMessageReplyStatus(messageId, 'disabled', '兜底路径不入回信流程')
      this.emitRecord(messageId)
      this.deps.emit({ type: 'delivery:changed', messageId })
      this.deps.emit({ type: 'dashboard:changed' })
      this.deps.dispatcher.schedule()
      return { messageId, status: 'queued', matchedRuleIds: [], deliveryCount: downloaded.length, skipped: false }
    }

    // ---------------- 附件类型白名单 ----------------
    const allowedParts = msg.parts.filter((p) =>
      hitRules.some(({ rule }) => isAllowedAttachment(p.filename, p.mimeType, rule.fileTypes))
    )
    if (allowedParts.length === 0) {
      repos.updateMessageMatch(messageId, {
        matchedRuleId: hitRules[0]!.rule.id,
        matchedKeyword: hitRules[0]!.rule.keyword,
        matchSource: hitRules[0]!.hit.source
      })
      repos.updateMessageStatus(messageId, 'ignored_type')
      repos.updateMessageReplyStatus(messageId, 'disabled', '附件类型不在白名单，不自动回信')
      this.log.info(`命中规则但附件类型不符：${msg.subject}（附件 ${msg.parts.length} 个）→ ignored_type`)
      this.emitRecord(messageId)
      return fallbackOutcome(messageId, 'ignored_type')
    }

    // ---------------- 下载附件 ----------------
    const downloaded = await this.downloadAll(account, provider, messageId, msg, allowedParts)
    if (!downloaded) {
      repos.updateMessageReplyStatus(messageId, 'disabled', '附件下载失败，不自动回信')
      this.emitRecord(messageId)
      return fallbackOutcome(messageId, 'failed')
    }

    // ---------------- 生成 deliveries（规则 × target × 附件） ----------------
    const items: Array<{ messageId: number; attachmentId: number; targetId: number; targetPath: string; required: boolean }> = []
    for (const { rule } of hitRules) {
      const ruleAttachments = downloaded.filter((d) => isAllowedAttachment(d.part.filename, d.part.mimeType, rule.fileTypes))
      if (ruleAttachments.length === 0) continue
      for (const target of rule.targets) {
        if (!target.enabled) continue
        for (const att of ruleAttachments) {
          items.push({
            messageId,
            attachmentId: att.attachmentId,
            targetId: target.id,
            targetPath: target.path,
            required: target.required
          })
        }
      }
    }
    if (items.length === 0) {
      // 规则没有可用 target（被停用/删除）：不阻塞，记录为类型/配置问题
      repos.updateMessageStatus(messageId, 'ignored_type', '命中的规则没有可用的目标文件夹')
      repos.updateMessageReplyStatus(messageId, 'disabled', '规则没有可用目标文件夹，不自动回信')
      this.emitRecord(messageId)
      return fallbackOutcome(messageId, 'ignored_type')
    }
    repos.createDeliveries(items)

    // ---------------- 命中计数 / 匹配快照 / 回信状态 ----------------
    repos.updateMessageMatch(messageId, {
      matchedRuleId: hitRules[0]!.rule.id,
      matchedKeyword: hitRules[0]!.rule.keyword,
      matchSource: hitRules[0]!.hit.source
    })
    if (up.inserted) {
      for (const { rule } of hitRules) {
        const files = downloaded.filter((d) => isAllowedAttachment(d.part.filename, d.part.mimeType, rule.fileTypes)).length
        repos.hitIncrement(rule.id, { messages: 1, files })
      }
    }
    const replyStatus = this.initialReplyStatus(account, msg, hitRules.map((h) => h.rule))
    repos.updateMessageReplyStatus(messageId, replyStatus)
    repos.updateMessageStatus(messageId, 'queued')

    this.log.info(
      `命中 ${hitRules.map((h) => h.rule.keyword).join('、')}：邮件 #${messageId}，附件 ${downloaded.length} 个，投递 ${items.length} 条`
    )
    this.emitRecord(messageId)
    this.deps.emit({ type: 'delivery:changed', messageId })
    this.deps.emit({ type: 'dashboard:changed' })
    this.deps.dispatcher.schedule()

    return {
      messageId,
      status: 'queued',
      matchedRuleIds: hitRules.map((h) => h.rule.id),
      deliveryCount: items.length,
      skipped: false
    }
  }

  /** 下载（或复用已下载）附件；失败时把消息标记 failed 并返回 null */
  private async downloadAll(
    account: Account,
    provider: AttachmentDownloader,
    messageId: number,
    msg: InboundMessage,
    parts: InboundAttachment[]
  ): Promise<Array<{ attachmentId: number; part: InboundAttachment }> | null> {
    const out: Array<{ attachmentId: number; part: InboundAttachment }> = []
    for (const part of parts) {
      const row = repos.upsertAttachment(messageId, {
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        declaredSize: part.size
      })
      if (row.status === 'downloaded' && row.tmp_path && (await pathExists(row.tmp_path))) {
        out.push({ attachmentId: row.id, part })
        continue
      }
      const safePart = sanitizeFilename(part.partId || 'attachment', 'attachment').replace(/[^\w.-]/g, '_')
      const dest = join(
        this.deps.tmpDir,
        `${account.id}-${account.uidValidity ?? 'na'}-${msg.uid}-${safePart}.part`
      )
      try {
        const res = await provider.downloadAttachment(msg.uid, part, dest)
        repos.setAttachmentDownloaded(row.id, { tmpPath: res.tmpPath || dest, size: res.size, sha256: res.sha256 })
        out.push({ attachmentId: row.id, part })
        this.log.info(`附件已下载：${part.filename}（${Math.round(res.size / 1024)}KB）`)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const code = (e as { code?: string }).code ?? 'DOWNLOAD_FAILED'
        repos.setAttachmentStatus(row.id, 'failed', message)
        repos.updateMessageStatus(messageId, 'failed', `[${code}] ${message}`)
        this.log.error(`附件下载失败 #${messageId} ${part.filename} [${code}]`, message)
        this.deps.emit({
          type: 'toast',
          level: 'error',
          title: '附件下载失败，邮件未归档',
          body: `${part.filename}：${message}`
        })
        return null
      }
    }
    return out
  }

  private fallbackTypes(rules: Rule[]): string[] {
    const set = new Set<string>(DEFAULT_FALLBACK_TYPES)
    for (const r of rules) for (const t of r.fileTypes) set.add(t)
    return [...set]
  }

  private initialReplyStatus(account: Account, msg: InboundMessage, rules: Rule[]): ReplyStatus {
    if (!this.setting<boolean>('replyEnabled')) return 'disabled'
    if (rules.every((r) => !r.autoReply)) return 'disabled'
    if (msg.autoSubmitted) return 'suppressed'
    return 'pending'
  }

  private emitRecord(messageId: number): void {
    const record = repos.getRecordById(messageId)
    if (record) this.deps.emit({ type: 'message:upserted', record })
  }

  /**
   * dispatcher 在所有 delivery 进入终态时回调：聚合最终状态 → 回信 → 通知。
   * 幂等（重复调用不会重复回信：reply-service 检查 thread_key）。
   */
  async onDeliveriesSettled(messageId: number): Promise<void> {
    const msg = repos.getMessage(messageId)
    if (!msg) return
    const agg = repos.deliveryAggregate(messageId)
    if (!agg.allTerminal) return
    const next: MessageStatus =
      agg.requiredFailed > 0 || (agg.failed > 0 && agg.done === 0) ? 'failed' : 'done'
    if (msg.status !== next) repos.updateMessageStatus(messageId, next, next === 'failed' ? msg.error : null)

    if (next === 'done') {
      try {
        await this.deps.replyService.maybeReply(messageId)
      } catch (e) {
        this.log.warn(`回信流程异常 #${messageId}`, e instanceof Error ? e.message : String(e))
      }
    }

    const record = repos.getRecordById(messageId)
    if (record) this.deps.emit({ type: 'message:upserted', record })
    this.deps.emit({ type: 'dashboard:changed' })

    const fileCount = new Set(record?.attachments.filter((a) => a.deliveries.some((d) => d.state === 'done')).map((a) => a.id)).size
    if (next === 'done') {
      this.log.info(`归档完成 #${messageId}：${fileCount} 个文件`)
      this.deps.emit({
        type: 'toast',
        level: 'success',
        title: '图稿已归档',
        body: `${record?.fromName || record?.fromAddr || '客户'} · ${record?.matchedKeyword ?? ''} · ${fileCount} 个文件`
      })
    } else if (next === 'failed') {
      this.deps.emit({
        type: 'toast',
        level: 'error',
        title: '归档失败，需要人工处理',
        body: `${record?.subject ?? ''}：${record?.error ?? '存在失败的必达路径'}`
      })
    } else if (agg.retryWait > 0 || agg.failed > 0) {
      this.deps.emit({
        type: 'toast',
        level: 'warn',
        title: '部分路径未完成，正在重试',
        body: `${record?.subject ?? ''}`
      })
    }
  }
}
