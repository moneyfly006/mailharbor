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
import { resolveProxy, createBridge, type Bridge } from '../net/proxy'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join } from 'node:path'
import { simpleParser } from 'mailparser'

// 重连/心跳节奏（ARCHITECTURE §2.4）
export const IDLE_HEARTBEAT_MS = 5 * 60 * 1000
export const IDLE_RENEW_MS = 25 * 60 * 1000
export const IDLE_DEBOUNCE_MS = 500
export const POLL_FALLBACK_MS = 30 * 1000
export const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000, 5 * 60_000]
export const DOWNLOAD_TIMEOUT_MS = 900_000
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
  /** 代理设置（由设置页读取后注入；缺省=不使用代理） */
  proxy?: { mode: 'none' | 'system' | 'socks5' | 'http'; host: string; port: number }
}

/**
 * 解析代理并按需建立本地转发桥：
 * 返回 imapflow 实际要连的 host/port（可能是 127.0.0.1:xxxxx），以及 TLS 的 SNI 域名。
 */
async function endpointViaProxy(
  realHost: string,
  realPort: number,
  proxyCfg: ProviderConfig['proxy']
): Promise<{ host: string; port: number; servername: string; bridge: Bridge | null; proxyLabel: string | null }> {
  if (!proxyCfg || proxyCfg.mode === 'none') {
    return { host: realHost, port: realPort, servername: realHost, bridge: null, proxyLabel: null }
  }
  const proxy = await resolveProxy(proxyCfg)
  if (!proxy) {
    return { host: realHost, port: realPort, servername: realHost, bridge: null, proxyLabel: null }
  }
  const bridge = await createBridge(proxy, realHost, realPort)
  return {
    host: '127.0.0.1',
    port: bridge.port,
    servername: realHost,
    bridge,
    proxyLabel: `${proxy.kind.toUpperCase()} ${proxy.host}:${proxy.port}（${proxy.source}）`
  }
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
  /** 正文里提取到的 http(s) 链接（超大附件/网盘下载地址） */
  bodyLinks: string[]
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
export function providerConfigFromAccount(
  account: Account,
  secrets: { imapPass: string; smtpPass: string },
  proxy?: ProviderConfig['proxy']
): ProviderConfig {
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
    smtpFromName: account.smtpFromName,
    allowSelfSigned: !!account.allowSelfSigned,
    proxy
  }
}

export function providerConfigFromInput(input: AccountInput, proxy?: ProviderConfig['proxy']): ProviderConfig {
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
    smtpFromName: input.smtpFromName,
    allowSelfSigned: !!input.allowSelfSigned,
    proxy
  }
}

function smtpConfigOf(cfg: ProviderConfig): SmtpConfig {
  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    user: cfg.smtpUser,
    pass: cfg.smtpPass,
    allowSelfSigned: cfg.allowSelfSigned,
    proxy: cfg.proxy
  }
}

function imapOptionsOf(cfg: ProviderConfig, overrides: Partial<ImapFlowOptions> = {}): ImapFlowOptions {
  return {
    host: cfg.imapHost,
    port: cfg.imapPort,
    // secure 与 doSTARTTLS 互斥：imapflow 会直接报 Misconfiguration
    secure: cfg.imapSecure === 'ssl',
    doSTARTTLS: cfg.imapSecure === 'starttls',
    auth: { user: cfg.imapUser, pass: cfg.imapPass },
    // 部分国内服务器（QQ/163）要求 IMAP ID 命令，否则报 Unsafe Login
    clientInfo: { name: 'MailHarbor', version: '1.0' },
    logger: false,
    tls: { rejectUnauthorized: !cfg.allowSelfSigned, servername: cfg.imapHost },
    // 跨国链路/代理下握手更慢，放宽到 20s；读取超时 2 分钟（Gmail 大附件常见）
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    // 大附件分块 FETCH 时服务器可能长时间检索后再回数据；120 秒过短会误报 Socket timeout
    socketTimeout: 300_000,
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
    const type = (node.type ?? '').toLowerCase()
    // 有些邮箱（QQ/企业邮箱转发、超大附件转普通附件）会把附件标成 Content-Disposition: inline，
    // 甚至不写 disposition；只要"有文件名 + 不是正文文本 + 不是 multipart"，就按附件处理，
    // 否则会把真有文件的邮件误判成"没有附件 / 类型不符"。
    const hasFileExt = !!rawName && /\.[A-Za-z0-9]{1,8}$/.test(rawName)
    // 签名档里的小图（inline image，通常 <200KB）不算附件；客户发的大图/TIF 仍算
    const looksInlineImage =
      type.startsWith('image/') &&
      (node.size ?? 0) < 200 * 1024 &&
      /\.(png|jpe?g|gif|bmp|webp)$/i.test(rawName ?? '')
    const isAttachment =
      !isContainer &&
      !type.startsWith('text/') &&
      (node.disposition === 'attachment' ||
        (!!rawName && node.disposition !== 'inline') ||
        (node.disposition === 'inline' && hasFileExt && !looksInlineImage) ||
        (!node.disposition && hasFileExt))
    if (isAttachment) {
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
export async function testImapConnection(cfg: ProviderConfig, timeoutMs = 20_000): Promise<TestResultLine> {
  // 走代理时无法直接 TCP 预检真实地址，预检就对着本地桥做；直连才预检真实主机
  const started = Date.now()
  let client: ImapFlow | null = null
  let bridge: Bridge | null = null
  try {
    let endpoint: Awaited<ReturnType<typeof endpointViaProxy>>
    try {
      endpoint = await endpointViaProxy(cfg.imapHost, cfg.imapPort, cfg.proxy)
    } catch (e) {
      return {
        protocol: 'imap',
        ok: false,
        latencyMs: Date.now() - started,
        host: cfg.imapHost,
        port: cfg.imapPort,
        errorCode: 'PROXY_FAILED',
        message: `代理连接失败：${e instanceof Error ? e.message : String(e)}（检查设置里的代理地址/端口，或先关掉代理试试）`
      }
    }
    bridge = endpoint.bridge
    const probe = await probeTcp(endpoint.host, endpoint.port, Math.min(5000, timeoutMs))
    const pre = preflightLine('imap', cfg.imapHost, cfg.imapPort, probe)
    if (pre) {
      await bridge?.close()
      return endpoint.proxyLabel ? { ...pre, message: `${pre.message}（代理 ${endpoint.proxyLabel}）` } : pre
    }
    client = new ImapFlow(
      imapOptionsOf(cfg, {
        host: endpoint.host,
        port: endpoint.port,
        tls: { rejectUnauthorized: !cfg.allowSelfSigned, servername: endpoint.servername },
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
        message: `IMAP 登录成功，收件箱 ${mb && typeof mb === 'object' ? mb.exists : 0} 封（UIDVALIDITY ${uidValidity || '-'}）${endpoint.proxyLabel ? ` · 经代理 ${endpoint.proxyLabel}` : ' · 直连'}`
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
    await bridge?.close().catch(() => {})
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

  private bridge: Bridge | null = null
  /** 当前连接实际使用的端点（代理时是本地桥地址），多连接并行下载复用 */
  private endpoint: { host: string; port: number; servername: string } | null = null

  private async doConnect(): Promise<SyncState> {
    await this.closeClient()
    // 国内直连 Gmail 的 993 经常被断：按设置走代理（本地转发桥）
    const endpoint = await endpointViaProxy(this.cfg.imapHost, this.cfg.imapPort, this.cfg.proxy)
    this.bridge = endpoint.bridge
    this.endpoint = { host: endpoint.host, port: endpoint.port, servername: endpoint.servername }
    if (endpoint.proxyLabel) this.log.info(`IMAP 经代理连接：${endpoint.proxyLabel}`)
    const client = new ImapFlow(
      imapOptionsOf(this.cfg, {
        host: endpoint.host,
        port: endpoint.port,
        tls: { rejectUnauthorized: !this.cfg.allowSelfSigned, servername: endpoint.servername }
      })
    )
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
    const bridge = this.bridge
    this.bridge = null
    if (bridge) await bridge.close().catch(() => {})
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
      const foundRaw = await client.search({ uid: `${from}:*` }, { uid: true })
      this.log.info(`[debug] search uid ${from}:* => ${JSON.stringify(foundRaw).slice(0, 120)}`)
      const found = asUidList(foundRaw)
      uids = found.filter((u) => u >= from && u > opts.lastUid).sort((a, b) => a - b)
      uids = uids.slice(0, max)
    }
    if (uids.length === 0) return []

    const range = uids.join(',')
    // 关键：range 是「UID」，必须用 { uid: true } 取信。
    // 否则 imapflow 会按「序号」解释，邮箱里邮件数少于 UID 时直接报 out of range。
    const metas: FetchMessageObject[] = await client.fetchAll(
      range,
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
        // 单封解析失败不能阻塞整个批次：记日志跳过，调用方仍会推进 last_uid
        this.log.warn(`解析邮件 UID=${meta.uid} 失败`, e instanceof Error ? e.message : String(e))
      }
    }
    if (out.length > 0) this.state.lastSeenUid = Math.max(this.state.lastSeenUid, out[out.length - 1]!.uid)
    return out
  }

  /** 切换当前选中的邮箱（垃圾邮件扫描时用：下载附件必须在同一邮箱上下文） */
  async selectMailbox(folder: string): Promise<void> {
    const client = await this.ensureClient()
    const mb = await client.mailboxOpen(folder, { readOnly: true })
    if (mb) {
      this.state = {
        ...this.state,
        uidValidity: String(mb.uidValidity),
        uidNext: mb.uidNext,
        exists: mb.exists
      }
    }
  }

  /** 找到垃圾邮件文件夹（Gmail: [Gmail]/垃圾邮件 / QQ: Junk 等） */
  async findJunkFolder(): Promise<string | null> {
    const client = await this.ensureClient()
    try {
      const list = await client.list()
      const junk =
        list.find((f) => f.specialUse === '\\Junk') ??
        list.find((f) => /(^|\/)(spam|junk|垃圾邮件|垃圾箱|已删除|trash)$/i.test(f.path) && /spam|junk|垃圾/i.test(f.path))
      return junk?.path ?? null
    } catch {
      return null
    }
  }

  /**
   * 扫描垃圾邮件文件夹（不影响 INBOX 游标）。
   * Gmail 常把 QQ 发来的大附件邮件判为垃圾，开启后仍能自动下载归档。
   */
  async fetchJunkMessages(opts: {
    lastUid: number
    uidValidity?: string | null
    maxMessages?: number
  }): Promise<{ messages: InboundMessage[]; uidValidity: string | null }> {
    const folder = await this.findJunkFolder()
    if (!folder) return { messages: [], uidValidity: null }
    const client = await this.ensureClient()
    const max = Math.max(1, Math.min(opts.maxMessages ?? 20, 100))
    try {
      const junkBox = await client.mailboxOpen(folder, { readOnly: true })
      const uidValidity = junkBox ? String(junkBox.uidValidity) : null
      let uids: number[] = []
      if (opts.uidValidity && uidValidity && String(opts.uidValidity) !== uidValidity) {
        // 垃圾箱重建：只处理最近 max 封，避免一次刷太多
        const all = asUidList(await client.search({ uid: '1:*' }, { uid: true })).sort((a, b) => a - b)
        uids = all.slice(-max)
      } else {
        const from = Math.max(1, Math.floor(opts.lastUid) + 1)
        uids = asUidList(await client.search({ uid: `${from}:*` }, { uid: true }))
          .filter((u) => u >= from && u > opts.lastUid)
          .sort((a, b) => a - b)
          .slice(0, max)
      }
      if (uids.length === 0) return { messages: [], uidValidity }
      const metas: FetchMessageObject[] = await client.fetchAll(
        uids.join(','),
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
          this.log.warn(`解析垃圾邮件 UID=${meta.uid} 失败`, e instanceof Error ? e.message : String(e))
        }
      }
      this.log.info(`垃圾邮件扫描：${folder} 新增 ${out.length} 封（UID ${uids.join(',') || '-'}）`)
      return { messages: out, uidValidity }
    } catch (e) {
      this.log.warn('扫描垃圾邮件失败', e instanceof Error ? e.message : String(e))
      return { messages: [], uidValidity: null }
    }
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
    const plain = findBodyPart(meta.bodyStructure, 'text/plain')
    const html = findBodyPart(meta.bodyStructure, 'text/html')
    const bodyPart = plain ?? html
    const linkPart = html ?? plain
    const body = await this.readBody(meta.uid, bodyPart)
    const linkBody = linkPart === bodyPart ? body : await this.readBody(meta.uid, linkPart)
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
      bodyText: bodyPart?.type === 'text/html' ? htmlToText(body) : body,
      bodyLinks: this.extractBodyLinks(linkBody, linkPart?.type === 'text/html'),
      parts,
      autoSubmitted
    }
  }

  /** 从 html/text 正文里提取 http(s) 链接（用于识别「超大附件/网盘」邮件） */
  private extractBodyLinks(raw: string, isHtml: boolean): string[] {
    const text = isHtml ? raw.replace(/&amp;/gi, '&') : raw
    const links = new Set<string>()
    const re = /https?:\/\/[^\s<>"'）)】\]]+/gi
    for (const match of text.matchAll(re)) {
      links.add(match[0].replace(/[.,;:]+$/, ''))
      if (links.size >= 12) break
    }
    return [...links]
  }

  private async readBody(uid: number, part: MessageStructureObject | null): Promise<string> {
    const client = this.client
    if (!client || !part?.part) return ''
    try {
      const dl = await client.download(String(uid), part.part, { uid: true, maxBytes: MAX_BODY_BYTES })
      if (!dl.content) return ''
      const chunks: Buffer[] = []
      for await (const chunk of dl.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      }
      return Buffer.concat(chunks).toString('utf8')
    } catch (e) {
      this.log.warn(`读取正文失败 UID=${uid}`, e instanceof Error ? e.message : String(e))
      return ''
    }
  }

  // ---------------- 附件下载 ----------------
  async downloadAttachment(
    uid: number,
    part: InboundAttachment,
    destTmpPath: string,
    onProgress?: (received: number, total: number) => void,
    timeoutMs?: number,
    chunkSize?: number,
    parallel?: { enabled: boolean; connections: number; thresholdBytes: number }
  ): Promise<DownloadAttachmentResult> {
    const client = await this.ensureClient()
    await mkdir(dirname(destTmpPath), { recursive: true })
    const fetchBytes = Math.max(64 * 1024, Number(chunkSize) || 2 * 1024 * 1024)
    if (parallel?.enabled && Number(part.size) >= (parallel.thresholdBytes || 6 * 1024 * 1024)) {
      const ranged = await this.downloadViaRanges(
        uid,
        part,
        destTmpPath,
        onProgress,
        Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS,
        parallel.connections,
        fetchBytes
      )
      if (ranged) return ranged
    }
    const hash = createHash('sha256')
    let size = 0
    const controller = new AbortController()
    let failure: ProviderError | undefined
    const startedAt = Date.now()
    let lastDataAt = startedAt
    let lastNetworkBytes = client.stats().received
    const networkStart = lastNetworkBytes
    const abort = (error: ProviderError): void => {
      if (failure) return
      failure = error
      controller.abort()
      // 关闭连接才能取消仍在等待完整 IMAP 响应的 FETCH。
      client.close()
    }
    // ImapFlow 收齐一个 FETCH 响应后才交付这一段。网络仍在接收时保留下载。
    const stallTimer = setInterval(() => {
      const received = client.stats().received
      const now = Date.now()
      if (received > lastNetworkBytes) lastDataAt = now
      lastNetworkBytes = received
      if (now - lastDataAt >= 60_000) {
        abort(new ProviderError('DOWNLOAD_STALLED', 'IMAP 连接连续 60 秒未收到数据，已中断本次下载'))
      }
    }, 5000)
    const timer = setTimeout(() => {
      abort(new ProviderError('DOWNLOAD_TIMEOUT', '附件下载超时，可在「下载记录」调整超时设置后重试'))
    }, Math.max(30_000, Number(timeoutMs) || DOWNLOAD_TIMEOUT_MS))
    try {
      const dl = await client.download(String(uid), part.partId, { uid: true, chunkSize: fetchBytes, decodeText: false })
      if (!dl.content) {
        throw new ProviderError('PART_NOT_FOUND', `附件不存在或已被删除：${part.filename}`, 'UNKNOWN')
      }
      // RFC822.SIZE 是整封邮件大小。附件估算使用 MIME 部件的编码长度。
      const expected = dl.meta.encoding === 'base64' ? Math.round(part.size * 3 / 4) : part.size
      let lastReportAt = 0
      await pipeline(
        dl.content,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length
            lastDataAt = Date.now()
            hash.update(chunk)
            const now = Date.now()
            if (onProgress && now - lastReportAt >= 200) {
              lastReportAt = now
              try {
                onProgress(size, expected)
              } catch {
                /* 进度回调不能影响下载 */
              }
            }
            cb(null, chunk)
          }
        }),
        createWriteStream(destTmpPath),
        { signal: controller.signal }
      )
      if (failure) throw failure
      if (size === 0) throw new ProviderError('EMPTY_ATTACHMENT', '下载到的附件为空（可能被服务器拒绝）')
    } catch (e) {
      await rm(destTmpPath, { force: true }).catch(() => {})
      if (failure) throw failure
      if (e instanceof ProviderError) throw e
      const msg = e instanceof Error ? e.message : String(e)
      if (/too large|maxBytes/i.test(msg)) throw new ProviderError('ATTACHMENT_TOO_LARGE', '附件超过单封大小限制')
      throw new ProviderError('DOWNLOAD_FAILED', `附件下载失败：${msg}`)
    } finally {
      clearTimeout(timer)
      clearInterval(stallTimer)
    }
    this.log.info(`IMAP 附件传输 UID=${uid} part=${part.partId}，耗时 ${Date.now() - startedAt}ms`, {
      fetchBytes, networkBytes: Math.max(0, client.stats().received - networkStart), fileBytes: size
    })
    try {
      onProgress?.(size, size)
    } catch {
      /* ignore */
    }
    return { size, sha256: hash.digest('hex'), tmpPath: destTmpPath }
  }

  /**
   * 多连接并行下载：IMAP 单个 FETCH 是串行的，但可以把整封邮件按字节切成 N 段，
   * 在 N 条独立连接上同时 FETCH（source: {start,maxLength}），最后本地用 mailparser
   * 解析出目标附件。Gmail 单连接约 0.4MB/s，4 连接实测约 0.9-1.3MB/s。
   * 失败返回 null，由调用方回退到普通单连接下载。
   */
  /**
   * 分块并行 + 断点续传（IMAP）。
   *
   * 把整封邮件按固定块（默认 4MB）并行拉取，写到 destTmpPath.eml 的对应偏移；
   * 同时把「已完成的块」写入 .state.json。网络中断后再次重试时，只补缺失块，
   * 已下载部分不再重来——这就是 QQ / 企业邮箱可用的断点续传（Gmail 走 API 不用此路径）。
   *
   * imapflow 的 fetchOne({ source: { start, maxLength } }) 是 IMAP 的局部 FETCH，
   * 不传整封邮件，避免流量浪费。
   */
  private async downloadViaRanges(
    uid: number,
    part: InboundAttachment,
    destTmpPath: string,
    onProgress: ((received: number, total: number) => void) | undefined,
    timeoutMs: number,
    connections: number,
    chunkSize: number
  ): Promise<DownloadAttachmentResult | null> {
    const clients: ImapFlow[] = []
    const emlPath = `${destTmpPath}.eml`
    const statePath = `${emlPath}.state.json`
    const { existsSync, readFileSync, writeFileSync, renameSync } = await import('node:fs')
    const blockSize = Math.max(1 * 1024 * 1024, Math.min(8 * 1024 * 1024, Math.floor(chunkSize) || 4 * 1024 * 1024))
    type RangeState = { uid: number; part: string; total: number; completed: number[] }
    const readState = (): RangeState | null => {
      try {
        if (!existsSync(statePath)) return null
        const s = JSON.parse(readFileSync(statePath, 'utf8')) as RangeState
        if (!s || !Array.isArray(s.completed)) return null
        return s
      } catch {
        return null
      }
    }
    const saveState = (s: RangeState): void => {
      try {
        const tmp = `${statePath}.tmp`
        writeFileSync(tmp, JSON.stringify(s))
        renameSync(tmp, statePath)
      } catch {
        /* ignore */
      }
    }

    try {
      const main = await this.ensureClient()
      const meta = await main.fetchOne(String(uid), { size: true }, { uid: true })
      if (!meta) return null
      const total = Number((meta as { size?: number }).size ?? 0)
      if (!total || total <= 0) return null
      const blockCount = Math.ceil(total / blockSize)
      const endpoint = this.endpoint ?? { host: this.cfg.imapHost, port: this.cfg.imapPort, servername: this.cfg.imapHost }

      // 读取续传状态（同一封邮件、同一个 part 才复用）
      let state = readState()
      if (!state || state.total !== total || state.uid !== uid || state.part !== part.partId) {
        state = { uid, part: part.partId, total, completed: [] }
        saveState(state)
      }
      const completed = new Set(state.completed)
      const missing = [...Array(blockCount).keys()].filter((i) => !completed.has(i))
      if (missing.length === 0) {
        this.log.info(`断点续传：${part.filename} 已全部下载完成，直接解析本地缓存`)
      } else if (completed.size > 0) {
        this.log.info(`断点续传：${part.filename} 已有 ${completed.size}/${blockCount} 块，继续下载剩余 ${missing.length} 块`)
      }

      // 预分配本地文件（已存在则复用，保留已下载块）
      const fh = await open(emlPath, existsSync(emlPath) ? 'r+' : 'w')
      try {
        await fh.truncate(total)
        const n = Math.max(2, Math.min(8, Math.floor(connections) || 4))
        for (let i = 0; i < n; i++) {
          const c = new ImapFlow(
            imapOptionsOf(this.cfg, {
              host: endpoint.host,
              port: endpoint.port,
              tls: { rejectUnauthorized: !this.cfg.allowSelfSigned, servername: endpoint.servername },
              connectionTimeout: 20_000,
              greetingTimeout: 20_000,
              socketTimeout: 10 * 60_000,
              disableAutoIdle: true
            })
          )
          // 每条临时连接都必须挂 error 监听，否则 socket timeout 会冒到主进程
          c.on('error', (e: Error) => this.log.warn(`并行下载连接异常：${e.message}`))
          await c.connect()
          await c.mailboxOpen('INBOX', { readOnly: true })
          clients.push(c)
        }

        let downloadedBytes = 0
        for (const i of completed) {
          downloadedBytes += Math.min(blockSize, total - i * blockSize)
        }
        let nextIndex = 0
        const deadline = Date.now() + Math.max(60_000, timeoutMs)
        await Promise.all(
          clients.map(async (c) => {
            for (;;) {
              const idx = nextIndex++
              const i = missing[idx]
              if (i === undefined) return
              const start = i * blockSize
              const len = Math.min(blockSize, total - start)
              if (Date.now() > deadline) throw new ProviderError('DOWNLOAD_STALLED', '并行下载超时')
              const r = await c.fetchOne(String(uid), { source: { start, maxLength: len } }, { uid: true })
              const buf = (r as { source?: Buffer } | false) && !(r as false) ? (r as { source?: Buffer }).source : undefined
              if (!buf || buf.length === 0) throw new ProviderError('DOWNLOAD_FAILED', `分段 ${i} 为空`)
              await fh.write(buf, 0, buf.length, start)
              completed.add(i)
              downloadedBytes += buf.length
              saveState({ ...state!, completed: [...completed] })
              try {
                onProgress?.(Math.min(downloadedBytes, total), total)
              } catch {
                /* ignore */
              }
            }
          })
        )
      } finally {
        await fh.close().catch(() => {})
      }

      // 本地解析出目标附件
      const parsed = await simpleParser(createReadStream(emlPath))
      const wanted = basename(part.filename).toLowerCase()
      const atts = (parsed.attachments ?? []).filter((a) => a.content && a.content.length > 0)
      const exact = atts.filter((a) => (a.filename ?? '').toLowerCase() === wanted)
      const picked =
        exact.find((a) => Math.abs(a.content.length - part.size) <= Math.max(2048, part.size * 0.02)) ??
        exact[0] ??
        atts
          .filter((a) => Math.abs(a.content.length - part.size) <= Math.max(2048, part.size * 0.02))
          .sort((a, b) => b.content.length - a.content.length)[0]
      if (!picked?.content) return null
      const content = picked.content
      const hash = createHash('sha256').update(content).digest('hex')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(destTmpPath, content)
      try {
        onProgress?.(content.length, content.length)
      } catch {
        /* ignore */
      }
      this.log.info(
        `IMAP 分块下载完成 UID=${uid} ${part.filename}：整封 ${(total / 1048576).toFixed(1)}MB，附件 ${(content.length / 1048576).toFixed(1)}MB（续传支持已启用）`
      )
      // 成功后清理中间文件
      await rm(emlPath, { force: true }).catch(() => {})
      await rm(statePath, { force: true }).catch(() => {})
      return { size: content.length, sha256: hash, tmpPath: destTmpPath }
    } catch (e) {
      this.log.warn(`分块下载失败（保留已完成块，下次续传）：${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      for (const c of clients) {
        try {
          await c.logout()
        } catch {
          try {
            c.close()
          } catch {
            /* ignore */
          }
        }
      }
    }
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
