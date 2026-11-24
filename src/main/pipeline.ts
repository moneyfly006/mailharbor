/**
 * 单封邮件状态机：
 *   fetchMessage → matchRules → 无命中(ignored_no_keyword / 兜底路径) → 附件白名单
 *   → 下载到 tmp → 每个命中规则 × 每个 target 生成 delivery → dispatcher 扇出
 *   → 全部 required 成功后 replyService 回信 → 聚合 messages.status → 托盘/事件
 */
import type { Account, MainEvent, MessageStatus, ReplyStatus, Rule } from '@shared/types'
import * as repos from './repos'
import type { AttachmentRow, MessageRow } from './repos'
import { BUSINESS_DEFAULT_TYPES, isAllowedAttachment, matchRules } from './rule-engine'
import { pathExists, sanitizeFilename } from './file-writer'
import type { InboundAttachment, InboundMessage } from './providers/imap'
import { createLogger, type Logger } from './log'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const FILE_SHARE_HOSTS = [
  'wx.mail.qq.com', 'ftn.qq.com', 'weiyun.com', 'pan.baidu.com', 'yun.baidu.com', 'cloud.189.cn',
  'alipan.com', 'aliyundrive.com', 'drive.google.com', 'dropbox.com', '1drv.ms', 'onedrive.live.com', 'sharepoint.com'
]

export function isBigAttachmentLink(value: string): boolean {
  const url = URL.parse(value)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  const host = url.hostname
  if (host === 'mail.qq.com' && /^\/cgi-bin\//i.test(url.pathname)) return true
  if (host === '189.cn' && /^\/t\//i.test(url.pathname)) return true
  if (FILE_SHARE_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true
  return url.protocol === 'https:' && isAllowedAttachment(url.pathname, undefined, BUSINESS_DEFAULT_TYPES)
}

export function isBigAttachmentMail(links: string[]): boolean {
  return links.some((l) => isBigAttachmentLink(l))
}
export type Emit = (e: MainEvent) => void

/** pipeline 只依赖 provider 的下载能力，便于单测注入假 provider */
export interface AttachmentDownloader {
  downloadAttachment(
    uid: number,
    part: InboundAttachment,
    destTmpPath: string,
    onProgress?: (received: number, total: number) => void,
    timeoutMs?: number,
    chunkSize?: number,
    parallel?: { enabled: boolean; connections: number; thresholdBytes: number }
  ): Promise<{ size: number; sha256: string; tmpPath: string }>
}

export interface DeliveryQueue {
  schedule(): void
}

export interface ReplySink {
  maybeReply(messageId: number): Promise<void>
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

export interface PipelineDeps {
  emit: Emit
  getSetting: <T = unknown>(key: string) => T
  dispatcher: DeliveryQueue
  replyService: ReplySink
  tmpDir: string
  linkedFiles?: {
    supports(account: Account, url: string): boolean
    download(accountId: number, messageId: number, url: string, dest: string): Promise<{ path: string; filename: string } | null>
  }
  /** Gmail API 加速下载（可选；返回 null 表示不可用 → 回退 IMAP） */
  gmail?: {
    download(opts: {
      account: Account
      rfcMessageId: string
      filename: string
      declaredSize: number
      destPath: string
      onProgress: (received: number, total: number) => void
      timeoutMs: number
    }): Promise<{ size: number; sha256: string; tmpPath: string } | null>
  }
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

export const DEFAULT_FALLBACK_TYPES = ['zip', 'rar', '7z', 'tar', 'tif', 'tiff']

export class MailPipeline {
  private deps: PipelineDeps
  private log: Logger
  private linkedDownloads = new Set<number>()

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
  async process(
    account: Account,
    provider: AttachmentDownloader,
    msg: InboundMessage,
    mailbox = 'INBOX'
  ): Promise<ProcessOutcome> {
    const fallbackOutcome = (messageId: number, status: MessageStatus, skipped = false): ProcessOutcome => ({
      messageId,
      status,
      matchedRuleIds: [],
      deliveryCount: 0,
      skipped
    })

    // 已处理过的邮件（UID 重扫 / 重启）：忽略状态与 queued 可重试，其余跳过，保证不重复下载/回信
    // queued 表示"处理中断/用户手动重试下载"，需要重新走一遍
    const existing = repos.getMessageByUid(account.id, msg.uid)
    const reprocessable: MessageStatus[] = ['ignored_no_keyword', 'ignored_type', 'queued']
    if (existing && (this.linkedDownloads.has(existing.id) || !reprocessable.includes(existing.status))) {
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
      status: 'queued',
      links: msg.bodyLinks.length > 0 ? msg.bodyLinks : null,
      mailbox
    })
    const messageId = up.id

    // 邮件里只有文件链接时，优先使用已启用的网页下载账号。
    if (msg.parts.length === 0 && hitRules.length > 0 && isBigAttachmentMail(msg.bodyLinks)) {
      repos.updateMessageMatch(messageId, {
        matchedRuleId: hitRules[0]!.rule.id,
        matchedKeyword: hitRules[0]!.rule.keyword,
        matchSource: hitRules[0]!.hit.source
      })
      const linked = this.deps.linkedFiles
      const links = linked ? msg.bodyLinks.filter((url) => linked.supports(account, url)) : []
      if (linked && links.length > 0) {
        const rules = hitRules.map(({ rule }) => rule)
        const targets = rules.flatMap((rule) => rule.targets).filter((target) => target.enabled)
        if (targets.length > 0) {
          this.linkedDownloads.add(messageId)
          this.emitRecord(messageId)
          try {
            const items = []
            for (const url of links) {
              const key = createHash('sha256').update(url).digest('hex').slice(0, 24)
              const partId = `web:${key}`
              const dest = join(this.deps.tmpDir, `web-${messageId}-${key}.part`)
              let attachment = repos.listAttachmentsByMessage(messageId).find((entry) => entry.part_id === partId)
              if (attachment?.status !== 'downloaded' || !attachment.tmp_path || !(await pathExists(attachment.tmp_path))) {
                try {
                  const file = await linked.download(account.id, messageId, url, dest)
                  if (!file) throw new Error('中转站下载已取消')
                  const fileStat = await stat(file.path)
                  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('中转站返回了空文件')
                  const hash = createHash('sha256')
                  for await (const buffer of createReadStream(file.path)) hash.update(buffer)
                  attachment = repos.upsertAttachment(messageId, {
                    partId, filename: file.filename, mimeType: null, declaredSize: fileStat.size
                  })
                  repos.setAttachmentDownloaded(attachment.id, { tmpPath: file.path, size: fileStat.size, sha256: hash.digest('hex') })
                } catch (error) {
                  await rm(dest, { force: true }).catch(() => {})
                  throw error
                }
              }
              for (const target of targets) items.push({
                messageId, attachmentId: attachment.id, targetId: target.id,
                targetPath: target.path, required: target.required
              })
            }
            repos.createDeliveries(items)
            repos.updateMessageReplyStatus(messageId, this.initialReplyStatus(account, msg, rules), null)
            this.emitRecord(messageId)
            this.deps.emit({ type: 'delivery:changed', messageId })
            this.deps.dispatcher.schedule()
            return { messageId, status: 'queued', matchedRuleIds: rules.map((rule) => rule.id), deliveryCount: items.length, skipped: false }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'QQ 中转站下载失败'
            repos.updateMessageStatus(messageId, 'failed', message)
            repos.updateMessageReplyStatus(messageId, 'disabled', '中转站下载失败')
            this.emitRecord(messageId)
            return fallbackOutcome(messageId, 'failed')
          } finally {
            this.linkedDownloads.delete(messageId)
          }
        }
      }
      repos.clearMessageAutoRetry(messageId)
      repos.updateMessageStatus(
        messageId,
        'manual_needed',
        '邮件正文含有文件下载链接。可在应用内下载并归档，也可用浏览器下载后选择文件归档。'
      )
      repos.updateMessageReplyStatus(messageId, 'disabled', '等待手动下载归档后再回信')
      this.log.info(`超大附件邮件：${msg.subject}（正文链接 ${msg.bodyLinks.length} 个）→ manual_needed`)
      this.emitRecord(messageId)
      return fallbackOutcome(messageId, 'manual_needed')
    }


    // ---------------- 无命中 ----------------
    if (hitRules.length === 0) {
      const fallbackEnabled = !!this.setting<boolean>('defaultPathEnabled')
      const fallbackPath = String(this.setting<string>('defaultPath') ?? '').trim()
      const allowed = fallbackEnabled && fallbackPath
        ? msg.parts.filter((p) => isAllowedAttachment(p.filename, p.mimeType, this.fallbackTypes(rules)))
        : []
      if (allowed.length === 0) {
        const enabledKeywords = rules.map((r) => r.keyword).join(' / ') || '（没有启用的规则）'
        repos.updateMessageStatus(
          messageId,
          'ignored_no_keyword',
          `未命中关键词：邮件标题是「${msg.subject || '(无主题)'}」，当前启用的规则是「${enabledKeywords}」。若标题写法不同（多了前后缀/符号），可在「触发规则」里用「标题测试」核对，或把匹配方式改成「包含」。`
        )
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
    // 每条命中规则先看自己的白名单；若该规则一个附件都没覆盖（老规则没勾 ZIP/RAR 等），
    // 则退化为「业务默认类型」——宁可归档也不要漏掉客户的图稿，并在记录里提示更新规则。
    const effectiveTypes = new Map<number, string[]>()
    let usedFallbackTypes = false
    for (const { rule } of hitRules) {
      const matched = msg.parts.some((p) => isAllowedAttachment(p.filename, p.mimeType, rule.fileTypes))
      if (matched || msg.parts.length === 0) {
        effectiveTypes.set(rule.id, rule.fileTypes.length > 0 ? rule.fileTypes : BUSINESS_DEFAULT_TYPES)
      } else {
        effectiveTypes.set(rule.id, BUSINESS_DEFAULT_TYPES)
        usedFallbackTypes = true
      }
    }
    const typesOf = (ruleId: number): string[] => effectiveTypes.get(ruleId) ?? BUSINESS_DEFAULT_TYPES
    const allowedParts = msg.parts.filter((p) =>
      hitRules.some(({ rule }) => isAllowedAttachment(p.filename, p.mimeType, typesOf(rule.id)))
    )
    if (allowedParts.length === 0) {
      repos.updateMessageMatch(messageId, {
        matchedRuleId: hitRules[0]!.rule.id,
        matchedKeyword: hitRules[0]!.rule.keyword,
        matchSource: hitRules[0]!.hit.source
      })
      repos.clearMessageAutoRetry(messageId)
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
      const ruleAttachments = downloaded.filter((d) =>
        isAllowedAttachment(d.part.filename, d.part.mimeType, typesOf(rule.id))
      )
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
    const fromJunk = mailbox !== 'INBOX'
    const replyStatus = fromJunk
      ? ('disabled' as const)
      : this.initialReplyStatus(account, msg, hitRules.map((h) => h.rule))
    repos.updateMessageReplyStatus(
      messageId,
      replyStatus,
      fromJunk ? '邮件来自垃圾邮件文件夹，默认不自动回信' : undefined
    )
    repos.updateMessageStatus(
      messageId,
      'queued',
      usedFallbackTypes
        ? '规则里没勾选实际附件类型（如 ZIP/RAR），本次已按默认类型归档；建议到「触发规则」把压缩包类型勾上'
        : null
    )

    if (usedFallbackTypes) {
      this.deps.emit({
        type: 'toast',
        level: 'warn',
        title: '已按默认类型归档（规则未勾选该类型）',
        body: '这次收到的附件类型（如 ZIP/RAR）不在规则白名单里，已按默认类型归档；建议到「触发规则」把压缩包类型勾上。'
      })
    }
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
    // Gmail 账户走 API 时多个附件可以并发（各自独立 HTTPS 请求）；IMAP 仍串行，避免争抢同一连接
    const useGmail = Boolean(this.deps.gmail && account.preset === 'gmail' && msg.rfcMessageId)
    const results = await mapLimit(parts, useGmail ? 3 : 1, (part) =>
      this.downloadOne(account, provider, messageId, msg, part)
    )
    if (results.some((r) => r === null)) return null
    return results as Array<{ attachmentId: number; part: InboundAttachment }>
  }

  /** 下载单个附件（复用已下载 / Gmail API / IMAP 重试） */
  private async downloadOne(
    account: Account,
    provider: AttachmentDownloader,
    messageId: number,
    msg: InboundMessage,
    part: InboundAttachment
  ): Promise<{ attachmentId: number; part: InboundAttachment } | null> {
    {
      const row = repos.upsertAttachment(messageId, {
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        declaredSize: part.size
      })
      if (row.status === 'downloaded' && row.tmp_path && (await pathExists(row.tmp_path))) {
        return { attachmentId: row.id, part }
      }
      // 秒传：同一文件（同名同大小）之前已下载过，直接复用本地文件，不再走网络
      const cached = repos.findDownloadedAttachmentByMeta(part.filename, part.size ?? null, row.id)
      if (cached && (await pathExists(cached.tmp_path))) {
        const destCached = join(this.deps.tmpDir, `${account.id}-cache-${row.id}${extname(part.filename) || '.bin'}`)
        try {
          await copyFile(cached.tmp_path, destCached)
          repos.setAttachmentDownloaded(row.id, {
            tmpPath: destCached,
            size: cached.size ?? part.size ?? 0,
            sha256: cached.sha256 ?? ''
          })
          this.log.info(`附件秒传（本地已有）：${part.filename}`)
          this.deps.emit({
            type: 'download:progress',
            progress: {
              messageId,
              attachmentId: row.id,
              filename: part.filename,
              received: cached.size ?? 0,
              total: cached.size ?? 0,
              percent: 100,
              state: 'done',
              attempt: 0,
              bytesPerSec: 0,
              message: '本地已有，秒传',
              updatedAt: Date.now()
            }
          })
          return { attachmentId: row.id, part }
        } catch {
          /* 秒传失败则继续正常下载 */
        }
      }
      const safePart = sanitizeFilename(part.partId || 'attachment', 'attachment').replace(/[^\w.-]/g, '_')
      const dest = join(
        this.deps.tmpDir,
        `${account.id}-${account.uidValidity ?? 'na'}-${msg.uid}-${safePart}.part`
      )
      // 弱网/大附件：自动重试若干次（每次重新发 FETCH，进度从 0 开始）
      const maxAttempts = Math.max(1, Number(this.setting<number>('downloadAttempts') ?? 3))
      const timeoutMs = Math.max(60, Number(this.setting<number>('downloadTimeoutSec') ?? 900)) * 1000
      const chunkMB = Number(this.setting<number>('downloadChunkSizeMB'))
      const chunkSize = ([1, 2, 4, 8, 16].includes(chunkMB) ? chunkMB : 2) * 1024 * 1024
      // 大附件多连接并行（把整封邮件切段，在 N 条连接上同时取，再本地解析附件）
      const parallel = {
        enabled: this.setting<boolean>('parallelDownload') !== false,
        connections: Math.max(2, Math.min(8, Number(this.setting<number>('parallelConnections') ?? 4))),
        thresholdBytes: Math.max(1, Number(this.setting<number>('parallelThresholdMB') ?? 6)) * 1024 * 1024
      }
      let res: { size: number; sha256: string; tmpPath: string } | null = null
      let lastErr: { message: string; code: string } | null = null
      let completedAttempt = 1
      // Gmail API 加速：优先走 HTTPS（比 IMAP 快 3–6 倍）；失败自动回退 IMAP
      if (this.deps.gmail && account.preset === 'gmail' && msg.rfcMessageId) {
        try {
          const apiRes = await this.deps.gmail.download({
            account,
            rfcMessageId: msg.rfcMessageId,
            filename: part.filename,
            declaredSize: Number(part.size) || 0,
            destPath: dest,
            timeoutMs,
            onProgress: (received, total) => {
              this.deps.emit({
                type: 'download:progress',
                progress: {
                  messageId,
                  attachmentId: row.id,
                  filename: part.filename,
                  received,
                  total,
                  percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
                  state: 'active',
                  attempt: 1,
                  bytesPerSec: 0,
                  message: 'Gmail API',
                  updatedAt: Date.now()
                }
              })
            }
          })
          if (apiRes) {
            res = apiRes
            this.log.info(`附件经 Gmail API 下载：${part.filename}（${Math.round(apiRes.size / 1024)}KB）`)
          }
        } catch (e) {
          this.log.warn(`Gmail API 下载失败，回退 IMAP：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      for (let attempt = 1; attempt <= maxAttempts && !res; attempt++) {
        let lastReceived = 0
        let lastTotal = Math.max(0, Number(part.size) || 0)
        let lastSampleAt = Date.now()
        let lastSampleBytes = 0
        let speed = 0
        const emitProgress = (received: number, total: number, note?: string): void => {
          lastReceived = received
          lastTotal = total
          const nowMs = Date.now()
          const dt = (nowMs - lastSampleAt) / 1000
          if (dt >= 1) {
            const delta = received - lastSampleBytes
            speed = Math.round(delta / dt)
            lastSampleAt = nowMs
            lastSampleBytes = received
          }
          const pct = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null
          this.deps.emit({
            type: 'download:progress',
            progress: {
              messageId,
              attachmentId: row.id,
              filename: part.filename,
              received,
              total,
              percent: pct,
              state: 'active',
              attempt,
              bytesPerSec: speed,
              message: note,
              updatedAt: Date.now()
            }
          })
        }
        // 心跳：60 秒没收到数据会被看门狗中断；在此之前每 3 秒推一次，避免界面看起来"卡住没进度"
        const heartbeat = setInterval(() => {
          emitProgress(lastReceived, lastTotal, lastReceived === 0 ? '等待首段数据…' : undefined)
        }, 3000)
        try {
          res = await provider.downloadAttachment(msg.uid, part, dest, emitProgress, timeoutMs, chunkSize, parallel)
          completedAttempt = attempt
          lastErr = null
          break
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          lastErr = { message, code: (e as { code?: string }).code ?? 'DOWNLOAD_FAILED' }
          this.log.warn(`附件下载失败（第 ${attempt}/${maxAttempts} 次）#${messageId} ${part.filename}：${message}`)
          this.deps.emit({
            type: 'download:progress',
            progress: {
              messageId,
              attachmentId: row.id,
              filename: part.filename,
              received: 0,
              total: Math.max(0, Number(part.size) || 0),
              percent: null,
              state: attempt >= maxAttempts ? 'failed' : 'active',
              attempt,
              bytesPerSec: 0,
              message,
              updatedAt: Date.now()
            }
          })
        } finally {
          clearInterval(heartbeat)
        }
        if (attempt < maxAttempts) await sleep(1500 * attempt)
      }

      if (!res) {
        const message = lastErr?.message ?? '下载失败'
        const code = lastErr?.code ?? 'DOWNLOAD_FAILED'
        repos.setAttachmentStatus(row.id, 'failed', message)
        repos.updateMessageStatus(messageId, 'failed', `[${code}] ${message}`)
        this.log.error(`附件下载失败 #${messageId} ${part.filename} [${code}]`, message)
        this.deps.emit({
          type: 'toast',
          level: 'error',
          title: '附件下载失败，可在「下载记录」点「重试下载」',
          body: `${part.filename}：${message}`
        })
        return null
      }

      repos.setAttachmentDownloaded(row.id, { tmpPath: res.tmpPath || dest, size: res.size, sha256: res.sha256 })
      const result = { attachmentId: row.id, part }
      this.deps.emit({
        type: 'download:progress',
        progress: {
          messageId,
          attachmentId: row.id,
          filename: part.filename,
          received: res.size,
          total: res.size,
          percent: 100,
          state: 'done',
          attempt: completedAttempt,
          bytesPerSec: 0,
          updatedAt: Date.now()
        }
      })
      this.log.info(`附件已下载：${part.filename}（${Math.round(res.size / 1024)}KB）`)
      return result
    }
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
