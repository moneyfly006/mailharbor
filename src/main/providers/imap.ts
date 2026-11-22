/**
 * IMAP 收信 + SMTP 发信（imapflow / nodemailer，唯一 Provider 实现）。
 *
 * 关键约束（docs/ARCHITECTURE.md §2.4–2.7）：
 *  - 每个账户一条长连接；只读（BODY.PEEK，不置已读 / 不删除 / 不移动）
 *  - UIDVALIDITY 变化 → 丢弃 last_uid，全量重扫最近 7 天（Message-ID 去重兜底）
 *  - 增量：UID SEARCH UID <lastUid+1>:*，按 UID 升序处理
 *  - 附件元数据用 BODYSTRUCTURE 递归（最多 5 层），中文名走 file-writer.decodeFilename
 *  - 附件下载流式写临时文件 + SHA-256，不做全量内存缓冲
 *  - IDLE 心跳 5 分钟 NOOP；服务器不支持 IDLE 时降级 30s 轮询；断线指数退避重连
 */
import { ImapFlow } from 'imapflow'
import type { FetchMessageObject, ImapFlowOptions, MessageStructureObject } from 'imapflow'
import type { Account, AccountInput, Encryption, TestResult, TestResultLine } from '@shared/types'
import { decodeFilename, sanitizeFilename } from '../file-writer'
import { createLogger, type Logger } from '../log'
import {
  classifyMailError, FIX_HINTS, preflightLine, probeTcp, type MailErrorCode
} from './errors'
import {
  sendReply as sendSmtpReply, testSmtpConnection, type SendReplyResult, type SmtpConfig
} from '../smtp'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname } from 'node:path'

// 重连/心跳节奏（ARCHITECTURE §2.4）
export const IDLE_HEARTBEAT_MS = 5 * 60 * 1000
export const IDLE_RENEW_MS = 25 * 60 * 1000
export const IDLE_DEBOUNCE_MS = 500
export const POLL_FALLBACK_MS = 30 * 1000
export const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000, 5 * 60_000]
export const DOWNLOAD_TIMEOUT_MS = 180_000
const MAX_BODY_BYTES = 512 * 1024

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------
export interface ProviderConfig {
  accountId?: number
  email: string
  displayName?: string
  imapHost: string
  imapPort: number
  imapSecure: Encryption
  imapUser: string
  imapPass: string
  smtpHost: string
  smtpPort: number
  smtpSecure: Encryption
  smtpUser: string
  smtpPass: string
  smtpFromName?: string
  allowSelfSigned?: boolean
}

export interface InboundAttachment {
  /** IMAP BODYSTRUCTURE part 编号，如 '2' / '1.2' */
  partId: string
  /** 已解码的原始文件名（落盘前仍需 sanitizeFilename） */
  filename: string
  mimeType: string
  size: number
  disposition?: string
}

export interface InboundMessage {
  uid: number
  rfcMessageId: string
  references: string[]
  /** 线程键：References 根（第一项）或原 Message-ID；缺失用 uid:<uidvalidity>:<uid> */
  threadKey: string
  subject: string
  fromAddr: string
  fromName: string
  receivedAt: number
  bodyText: string
  parts: InboundAttachment[]
  /** Auto-Submitted 头非空（自动回复/转发），回信时须跳过 */
  autoSubmitted: boolean
}

export interface FetchNewOptions {
  /** 上次处理到的最大 UID（0 = 首次） */
  lastUid: number
  /** 上次的 UIDVALIDITY；与服务器不一致时触发全量重扫 */
  uidValidity?: string | null
  /** 单次最多处理的邮件数（默认 25，防止首次接入把整个收件箱灌进来） */
  maxMessages?: number
}

export interface SyncState {
  uidValidity: string | null
  uidNext: number | null
  exists: number
  lastSeenUid: number
}

export interface DownloadAttachmentResult {
  size: number
  sha256: string
  tmpPath: string
}

/** Provider 层错误：code 为稳定的业务错误码（ATTACHMENT_TOO_LARGE / DOWNLOAD_TIMEOUT ...） */
export class ProviderError extends Error {
  readonly code: string
  readonly mailCode?: MailErrorCode
  constructor(code: string, message: string, mailCode?: MailErrorCode) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.mailCode = mailCode
  }
}

export interface ProviderOptions {
  logger?: Logger
  /** 连接状态变化（scheduler 据此写 accounts.status / 推送事件） */
  onStateChange?: (s: { connected: boolean; errorCode?: MailErrorCode; message?: string }) => void
}

// ---------------------------------------------------------------------------
// 配置构造
// ---------------------------------------------------------------------------
export function providerConfigFromAccount(account: Account, secrets: { imapPass: string; smtpPass: string }): ProviderConfig {
  return {
    accountId: account.id,
    email: account.email,
    displayName: account.displayName,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    imapUser: account.imapUser,
    imapPass: secrets.imapPass,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    smtpUser: account.smtpUser,
    smtpPass: secrets.smtpPass,
    smtpFromName: account.smtpFromName
  }
}

export function providerConfigFromInput(input: AccountInput): ProviderConfig {
  const imapPass = input.password ?? ''
  return {
    email: input.email,
    displayName: input.displayName,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    imapUser: input.imapUser,
    imapPass,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUser: input.smtpUser || input.imapUser,
    smtpPass: input.smtpSameAsImap ? imapPass : input.smtpPassword ?? '',
    smtpFromName: input.smtpFromName
  }
}

function smtpConfigOf(cfg: ProviderConfig): SmtpConfig {
  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    user: cfg.smtpUser,
    pass: cfg.smtpPass,
    allowSelfSigned: cfg.allowSelfSigned
  }
}

function imapOptionsOf(cfg: ProviderConfig, overrides: Partial<ImapFlowOptions> = {}): ImapFlowOptions {
  return {
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure === 'ssl',
    doSTARTTLS: cfg.imapSecure !== 'none',
    auth: { user: cfg.imapUser, pass: cfg.imapPass },
    logger: false,
    tls: { rejectUnauthorized: !cfg.allowSelfSigned, servername: cfg.imapHost },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    // 连接空闲后自动进入 IDLE（EXISTS 事件靠它）；25 分钟自动断开重进（RFC 2177 要求 <29 分钟）
    disableAutoIdle: false,
    autoIdleDelay: 500,
    maxIdleTime: IDLE_RENEW_MS,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 纯函数：BODYSTRUCTURE 解析 / 头解析
// ---------------------------------------------------------------------------
/** 递归提取附件（最多 5 层，跳过 multipart 容器与 inline 图片） */
export function extractAttachments(
  root: MessageStructureObject | undefined,
  maxDepth = 5
): InboundAttachment[] {
  const out: InboundAttachment[] = []
  const walk = (node: MessageStructureObject | undefined, depth: number): void => {
    if (!node || depth > maxDepth) return
    const isContainer = node.type.startsWith('multipart/') || node.type === 'message/rfc822'
    const rawName = node.dispositionParameters?.filename ?? node.parameters?.name
    const isAttachment = node.disposition === 'attachment' || (!!rawName && node.disposition !== 'inline')
    if (isAttachment && !isContainer) {
      const decoded = decodeFilename(rawName) || `attachment-${out.length + 1}`
      out.push({
        partId: node.part ?? String(out.length + 1),
        filename: decoded,
        mimeType: node.type ?? 'application/octet-stream',
        size: node.size ?? 0,
        disposition: node.disposition
      })
      return
    }
    for (const child of node.childNodes ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return out
}

/** 找到第一个匹配的叶子节点（正文 text/plain / text/html 用） */
export function findBodyPart(
  root: MessageStructureObject | undefined,
  type: 'text/plain' | 'text/html',
  maxDepth = 5
): MessageStructureObject | null {
  const walk = (node: MessageStructureObject | undefined, depth: number): MessageStructureObject | null => {
    if (!node || depth > maxDepth) return null
    if (node.type === type && node.part) return node
    for (const child of node.childNodes ?? []) {
      const hit = walk(child, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(root, 0)
}

/** 极简 HTML 转文本（不引入 DOM 依赖；只用于规则匹配的正文兜底） */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 解析 FETCH 返回的 header Buffer（支持折行） */
export function parseHeaderBlock(buffer: Buffer | string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!buffer) return map
  const text = typeof buffer === 'string' ? buffer : buffer.toString('utf8')
  let lastKey = ''
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) && lastKey) {
      map.set(lastKey, `${map.get(lastKey) ?? ''} ${line.trim()}`)
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    lastKey = line.slice(0, idx).trim().toLowerCase()
    map.set(lastKey, line.slice(idx + 1).trim())
  }
  return map
}

/** References 头拆成 Message-ID 数组（'<' 开头的行为准，兼容无尖括号写法） */
export function parseReferences(value: string | undefined): string[] {
  if (!value) return []
  const brackets = value.match(/<[^<>]+>/g)
  if (brackets && brackets.length > 0) return brackets
  return value.split(/\s+/).filter((s) => /@/.test(s)).map((s) => `<${s.replace(/[<>]/g, '')}>`)
}

/** 线程键：References 根 → 原 Message-ID → uid 兜底 */
export function threadKeyOf(rfcMessageId: string | null | undefined, references: string[], fallback?: string): string {
  const refs = references.filter(Boolean)
  if (refs.length > 0) return refs[0]!
  const id = (rfcMessageId ?? '').trim()
  if (id) return id.startsWith('<') ? id : `<${id.replace(/[<>]/g, '')}>`
  return fallback ?? 'unknown-thread'
}

function asUidList(found: number[] | false | undefined): number[] {
  return Array.isArray(found) ? found : []
}

function toTime(v: Date | string | undefined, fallback = Date.now()): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return fallback
}

// ---------------------------------------------------------------------------
// 测试连接（IMAP + SMTP 分别返回一行）
// ---------------------------------------------------------------------------
export function mapImapError(err: unknown): { code: MailErrorCode; message: string; detail?: string } {
  return classifyMailError(err, 'imap')
}

/**
 * 测试 IMAP：TCP 预检（5s）→ TLS 握手 → LOGIN → SELECT INBOX(只读) → 读 UIDVALIDITY → LOGOUT
 */
export async function testImapConnection(cfg: ProviderConfig, timeoutMs = 10_000): Promise<TestResultLine> {
  const probe = await probeTcp(cfg.imapHost, cfg.imapPort, Math.min(5000, timeoutMs))
  const pre = preflightLine('imap', cfg.imapHost, cfg.imapPort, probe)
  if (pre) return pre

  const started = Date.now()
  let client: ImapFlow | null = null
  try {
    client = new ImapFlow(
      imapOptionsOf(cfg, {
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs * 2,
        // 测试连接只做一次 LOGIN/SELECT，不需要 IDLE
        disableAutoIdle: true
      })
    )
    await client.connect()
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const mb = client.mailbox
      const uidValidity = mb && typeof mb === 'object' ? String(mb.uidValidity) : ''
      return {
        protocol: 'imap',
        ok: true,
        latencyMs: Date.now() - started,
        host: cfg.imapHost,
        port: cfg.imapPort,
        message: `IMAP 登录成功，收件箱 ${mb && typeof mb === 'object' ? mb.exists : 0} 封（UIDVALIDITY ${uidValidity || '-'}）`
      }
    } finally {
      lock.release()
    }
  } catch (e) {
    const c = mapImapError(e)
    return {
      protocol: 'imap',
      ok: false,
      latencyMs: Date.now() - started,
      host: cfg.imapHost,
      port: cfg.imapPort,
      errorCode: c.code,
      message: c.message
    }
  } finally {
    if (client) {
      try {
        await client.logout()
      } catch {
        try {
          client.close()
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** 分别测试 IMAP 与 SMTP，任一步失败即给出错误码与中文修复指引 */
export async function testConnection(cfg: ProviderConfig): Promise<TestResult> {
  const [imap, smtp] = await Promise.all([
    testImapConnection(cfg).catch(
      (e): TestResultLine => ({
        protocol: 'imap',
        ok: false,
        latencyMs: 0,
        host: cfg.imapHost,
        port: cfg.imapPort,
        errorCode: 'UNKNOWN',
        message: e instanceof Error ? e.message : String(e)
      })
    ),
    testSmtpConnection(smtpConfigOf(cfg)).catch(
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
  ])
  return { ok: imap.ok && smtp.ok, lines: [imap, smtp], testedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Provider 实现
// ---------------------------------------------------------------------------
export class ImapSmtpProvider {
  readonly cfg: ProviderConfig
  private log: Logger
  private opts: ProviderOptions
  private client: ImapFlow | null = null
  private state: SyncState = { uidValidity: null, uidNext: null, exists: 0, lastSeenUid: 0 }
  private connecting: Promise<SyncState> | null = null

  private idleRunning = false
  private idleOnMail: (() => void) | null = null
  private idleDebounce: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private supervisorTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private reconnecting = false
  private disposed = false

  constructor(cfg: ProviderConfig, opts: ProviderOptions = {}) {
    this.cfg = cfg
    this.opts = opts
    this.log = opts.logger ?? createLogger(`imap:${cfg.email}`)
  }

  // ---------------- 连接 ----------------
  async connect(): Promise<SyncState> {
    if (this.connecting) return this.connecting
    if (this.client && this.client.usable) return this.state
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<SyncState> {
    await this.closeClient()
    const client = new ImapFlow(imapOptionsOf(this.cfg))
    this.client = client
    this.attachClientErrorHandlers(client)
    try {
      await client.connect()
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true })
      this.state = {
        uidValidity: mailbox ? String(mailbox.uidValidity) : null,
        uidNext: mailbox ? mailbox.uidNext : null,
        exists: mailbox ? mailbox.exists : 0,
        lastSeenUid: this.state.lastSeenUid
      }
      this.reconnectAttempts = 0
      this.log.info(`IMAP 已连接（${this.cfg.imapHost}:${this.cfg.imapPort}），UIDVALIDITY=${this.state.uidValidity}`)
      this.opts.onStateChange?.({ connected: true })
      if (this.idleRunning) this.attachIdleHandlers()
      return this.state
    } catch (e) {
      const c = mapImapError(e)
      this.log.warn(`IMAP 连接失败 [${c.code}]`, c.detail ?? c.message)
      this.opts.onStateChange?.({ connected: false, errorCode: c.code, message: c.message })
      await this.closeClient()
      throw new ProviderError(c.code, c.message, c.code)
    }
  }

  private attachClientErrorHandlers(client: ImapFlow): void {
    client.on('error', (err: Error) => {
      if (this.disposed) return
      const c = mapImapError(err)
      this.log.warn(`IMAP 连接异常 [${c.code}]`, c.detail ?? c.message)
      this.opts.onStateChange?.({ connected: false, errorCode: c.code, message: c.message })
    })
    client.on('close', () => {
      if (this.disposed) return
      this.log.info('IMAP 连接已断开（等待自动重连 / 下一次轮询）')
      this.opts.onStateChange?.({ connected: false })
    })
  }

  /** 取当前连接；必要时重连 */
  private async ensureClient(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client
    await this.connect()
    if (!this.client) throw new ProviderError('NO_CONNECTION', 'IMAP 未连接')
    return this.client
  }

  private async closeClient(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      client.removeAllListeners('exists')
      client.removeAllListeners('close')
      client.removeAllListeners('error')
    } catch {
      /* ignore */
    }
    try {
      if (client.usable) await client.logout()
      else client.close()
    } catch {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
  }

  isConnected(): boolean {
    return !!this.client && this.client.usable
  }

  isListening(): boolean {
    return this.idleRunning || !!this.pollTimer
  }

  getSyncState(): SyncState {
    return { ...this.state }
  }

  // ---------------- 增量收信 ----------------
  async fetchNewMessages(opts: FetchNewOptions): Promise<InboundMessage[]> {
    const client = await this.ensureClient()
    const sync = this.state
    const max = Math.max(1, Math.min(opts.maxMessages ?? 25, 200))
    let uids: number[] = []

    const uidValidityChanged =
      !!opts.uidValidity && !!sync.uidValidity && String(opts.uidValidity) !== String(sync.uidValidity)

    if (uidValidityChanged) {
      // 邮箱被重建/迁移：丢弃游标，全量重扫最近 7 天（上限 max），历史去重靠 Message-ID
      this.log.warn(`UIDVALIDITY 变化 ${opts.uidValidity} → ${sync.uidValidity}，改为全量重扫最近 7 天`)
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      try {
        uids = asUidList(await client.search({ since }, { uid: true })).sort((a, b) => a - b)
      } catch {
        uids = []
      }
      if (uids.length === 0) uids = asUidList(await client.search({ uid: '1:*' }, { uid: true })).sort((a, b) => a - b)
      uids = uids.slice(-max)
    } else {
      const from = Math.max(1, Math.floor(opts.lastUid) + 1)
      const found = asUidList(await client.search({ uid: `${from}:*` }, { uid: true }))
      uids = found.filter((u) => u >= from && u > opts.lastUid).sort((a, b) => a - b)
      uids = uids.slice(0, max)
    }
    if (uids.length === 0) return []

    const range = uids.join(',')
    const metas: FetchMessageObject[] = await client.fetchAll(range, {
      uid: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      headers: ['auto-submitted', 'references', 'in-reply-to', 'from']
    })
    metas.sort((a, b) => a.uid - b.uid)

    const out: InboundMessage[] = []
    for (const meta of metas) {
      try {
        out.push(await this.toInboundMessage(meta))
      } catch (e) {
        // 单封解析失败不能阻塞整个批次：记日志跳过，调用方仍会推进 last_uid
        this.log.warn(`解析邮件 UID=${meta.uid} 失败`, e instanceof Error ? e.message : String(e))
      }
    }
    if (out.length > 0) this.state.lastSeenUid = Math.max(this.state.lastSeenUid, out[out.length - 1]!.uid)
    return out
  }

  /**
   * 按 UID 精确取信（补扫用）：新增关键词规则后，把之前"未命中"的邮件重新解析一遍。
   * 与 fetchNewMessages 的区别：不受游标影响，也不会推进游标。
   */
  async fetchByUids(uids: number[]): Promise<InboundMessage[]> {
    const wanted = Array.from(new Set(uids.filter((u) => u > 0))).slice(0, 200)
    if (wanted.length === 0) return []
    const client = await this.ensureClient()
    const metas: FetchMessageObject[] = await client.fetchAll(
      wanted.join(','),
      {
        uid: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
        headers: ['auto-submitted', 'references', 'in-reply-to', 'from']
      },
      { uid: true }
    )
    metas.sort((a, b) => a.uid - b.uid)
    const out: InboundMessage[] = []
    for (const meta of metas) {
      try {
        out.push(await this.toInboundMessage(meta))
      } catch (e) {
        this.log.warn(`补扫解析邮件 UID=${meta.uid} 失败`, e instanceof Error ? e.message : String(e))
      }
    }
    return out
  }

  private async toInboundMessage(meta: FetchMessageObject): Promise<InboundMessage> {
    const envelope = meta.envelope ?? {}
    const headers = parseHeaderBlock(meta.headers)
    const references = parseReferences(headers.get('references'))
    const inReplyTo = headers.get('in-reply-to')
    if (inReplyTo) references.push(...parseReferences(inReplyTo))
    const rfcMessageId = (envelope.messageId ?? headers.get('message-id') ?? '').trim()
    const autoSubmitted = !!headers.get('auto-submitted') && !/^\s*no\s*$/i.test(headers.get('auto-submitted') ?? '')
    const from = envelope.from?.[0]
    const receivedAt = toTime(meta.internalDate ?? envelope.date)
    const bodyText = await this.readBodyText(meta)
    const parts = extractAttachments(meta.bodyStructure)
    return {
      uid: meta.uid,
      rfcMessageId,
      references,
      threadKey: threadKeyOf(rfcMessageId, references, `uid:${this.state.uidValidity ?? ''}:${meta.uid}`),
      subject: envelope.subject ?? '',
      fromAddr: from?.address ?? '',
      fromName: from?.name ?? '',
      receivedAt,
      bodyText,
      parts,
      autoSubmitted
    }
  }

  private async readBodyText(meta: FetchMessageObject): Promise<string> {
    const client = this.client
    if (!client) return ''
    const plain = findBodyPart(meta.bodyStructure, 'text/plain')
    const html = plain ? null : findBodyPart(meta.bodyStructure, 'text/html')
    const part = plain ?? html
    if (!part?.part) return ''
    try {
      const dl = await client.download(String(meta.uid), part.part, { uid: true, maxBytes: MAX_BODY_BYTES })
      if (!dl.content) return ''
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of dl.content) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        chunks.push(buf)
        total += buf.length
        if (total >= MAX_BODY_BYTES) break
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return part.type === 'text/html' ? htmlToText(text) : text
    } catch (e) {
      this.log.warn(`读取正文失败 UID=${meta.uid}`, e instanceof Error ? e.message : String(e))
      return ''
    }
  }

  // ---------------- 附件下载 ----------------
  async downloadAttachment(uid: number, part: InboundAttachment, destTmpPath: string): Promise<DownloadAttachmentResult> {
    const client = await this.ensureClient()
    await mkdir(dirname(destTmpPath), { recursive: true })
    const dl = await client.download(String(uid), part.partId, { uid: true })
    if (!dl.content) {
      throw new ProviderError('PART_NOT_FOUND', `附件不存在或已被删除：${part.filename}`, 'UNKNOWN')
    }
    const hash = createHash('sha256')
    let size = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      dl.content.destroy(new Error('download timeout'))
    }, DOWNLOAD_TIMEOUT_MS)
    try {
      await pipeline(
        dl.content,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length
            hash.update(chunk)
            cb(null, chunk)
          }
        }),
        createWriteStream(destTmpPath)
      )
    } catch (e) {
      await rm(destTmpPath, { force: true }).catch(() => {})
      if (timedOut) throw new ProviderError('DOWNLOAD_TIMEOUT', '附件下载超时（180 秒），请检查网络后重试')
      if (e instanceof ProviderError) throw e
      const msg = e instanceof Error ? e.message : String(e)
      if (/too large|maxBytes/i.test(msg)) throw new ProviderError('ATTACHMENT_TOO_LARGE', '附件超过单封大小限制')
      throw new ProviderError('DOWNLOAD_FAILED', `附件下载失败：${msg}`)
    } finally {
      clearTimeout(timer)
    }
    if (size === 0) {
      await rm(destTmpPath, { force: true }).catch(() => {})
      throw new ProviderError('EMPTY_ATTACHMENT', '下载到的附件为空（可能被服务器拒绝）')
    }
    return { size, sha256: hash.digest('hex'), tmpPath: destTmpPath }
  }

  // ---------------- 发信 ----------------
  async sendReply(req: Parameters<typeof sendSmtpReply>[1]): Promise<SendReplyResult> {
    return sendSmtpReply(smtpConfigOf(this.cfg), req)
  }

  async testConnection(): Promise<TestResult> {
    return testConnection(this.cfg)
  }

  // ---------------- IDLE / 轮询 / 自动重连 ----------------
  /**
   * 进入 IDLE 监听：服务器不支持 IDLE 时自动降级为 30s 轮询。
   * 断线由 supervisor 指数退避重连，重连成功后回调 onMail（scheduler 立即补扫）。
   */
  async startIdle(onMail: () => void): Promise<void> {
    this.idleOnMail = onMail
    this.idleRunning = true
    await this.ensureClient()
    const client = this.client
    if (!client) return
    if (!client.capabilities.has('IDLE')) {
      this.log.info('服务器不支持 IDLE，降级为 30 秒轮询')
      this.startPolling(onMail, POLL_FALLBACK_MS)
      return
    }
    this.attachIdleHandlers()
    this.heartbeatTimer = setInterval(() => void this.safeNoop(), IDLE_HEARTBEAT_MS)
    this.supervisorTimer = setInterval(() => void this.supervise(), 15_000)
    this.log.info('已进入 IMAP IDLE 监听（心跳 5 分钟）')
  }

  private attachIdleHandlers(): void {
    const client = this.client
    if (!client) return
    client.removeAllListeners('exists')
    client.on('exists', () => {
      if (!this.idleRunning) return
      if (this.idleDebounce) clearTimeout(this.idleDebounce)
      this.idleDebounce = setTimeout(() => {
        this.idleDebounce = null
        try {
          this.idleOnMail?.()
        } catch (e) {
          this.log.warn('IDLE 新邮件回调异常', e instanceof Error ? e.message : String(e))
        }
      }, IDLE_DEBOUNCE_MS)
    })
  }

  private async safeNoop(): Promise<void> {
    const client = this.client
    if (!client || !client.usable) return
    try {
      await client.noop()
    } catch (e) {
      this.log.warn('IMAP NOOP 心跳失败，等待重连', e instanceof Error ? e.message : String(e))
      await this.closeClient()
    }
  }

  private async supervise(): Promise<void> {
    if (this.disposed || !this.idleRunning || this.reconnecting) return
    if (this.isConnected()) return
    this.reconnecting = true
    try {
      const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!
      this.reconnectAttempts++
      this.log.info(`${Math.round(delay / 1000)}s 后尝试重连 IMAP（第 ${this.reconnectAttempts} 次）`)
      await new Promise((r) => setTimeout(r, delay))
      if (this.disposed || !this.idleRunning) return
      await this.connect()
      this.log.info('IMAP 重连成功，立即补扫离线期间的邮件')
      try {
        this.idleOnMail?.()
      } catch {
        /* ignore */
      }
    } catch (e) {
      this.log.warn('IMAP 重连失败', e instanceof Error ? e.message : String(e))
    } finally {
      this.reconnecting = false
    }
  }

  startPolling(cb: () => void, intervalMs = POLL_FALLBACK_MS): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      try {
        cb()
      } catch (e) {
        this.log.warn('轮询回调异常', e instanceof Error ? e.message : String(e))
      }
    }, intervalMs)
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async stopIdle(): Promise<void> {
    this.idleRunning = false
    this.idleOnMail = null
    if (this.idleDebounce) clearTimeout(this.idleDebounce)
    this.idleDebounce = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.supervisorTimer) clearInterval(this.supervisorTimer)
    this.heartbeatTimer = null
    this.supervisorTimer = null
    this.stopPolling()
    try {
      this.client?.removeAllListeners('exists')
    } catch {
      /* ignore */
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true
    await this.stopIdle()
    await this.closeClient()
  }

  /** 供测试重置 disposed 标记（生产不会调用） */
  resetDisposedForTests(): void {
    this.disposed = false
  }
}

// ---------------------------------------------------------------------------
// 便捷工厂
// ---------------------------------------------------------------------------
export function createProvider(cfg: ProviderConfig, opts: ProviderOptions = {}): ImapSmtpProvider {
  return new ImapSmtpProvider(cfg, opts)
}

export { sanitizeFilename, FIX_HINTS }
