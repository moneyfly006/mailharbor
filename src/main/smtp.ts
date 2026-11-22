/**
 * SMTP 回信：模板渲染 + MIME 构造 + nodemailer 发送 + 错误码映射。
 *
 * 安全/合规要点（ARCHITECTURE §2.6）：
 *  - From 必须是登录账号本身或已验证别名（Gmail/QQ 会 550/553 拒绝其它发件人）
 *  - Subject / To / 显示名来自不可信邮件头 → 先剔除 CR/LF 防 SMTP 头注入
 *  - 纯文本 UTF-8（base64 传输），不池化连接（低频发送，避免被风控）
 *  - 只回发件人，不设 Cc/Bcc/Reply-To
 */
import nodemailer from 'nodemailer'
import type { SendMailOptions, Transporter } from 'nodemailer'
import type { Encryption, Settings, TestResultLine } from '@shared/types'
import { classifyMailError, FIX_HINTS, preflightLine, probeTcp } from './providers/errors'

// ---------------------------------------------------------------------------
// 配置 / 请求
// ---------------------------------------------------------------------------
export interface SmtpConfig {
  host: string
  port: number
  secure: Encryption
  user: string
  pass: string
  /** 企业自建服务器允许自签名证书（默认 false，必须校验证书） */
  allowSelfSigned?: boolean
  /** 单次连接/握手超时（毫秒），默认 10s */
  timeoutMs?: number
}

export interface ReplyParty {
  address: string
  name?: string
}

export interface ReplyRequest {
  from: ReplyParty
  to: ReplyParty
  /** 原邮件主题（内部会补 Re: 并做头注入清洗） */
  subject: string
  body: string
  /** 原邮件的 Message-ID */
  inReplyTo?: string | null
  /** 原邮件的 References 链（不含 inReplyTo 亦可） */
  references?: string[]
}

export interface SendReplyResult {
  providerMessageId: string
  response: string
  accepted: string[]
}

/** sendReply 抛出的错误：带稳定错误码，reply-service 据此决定重试/熔断 */
export class ReplySendError extends Error {
  readonly code: string
  readonly detail?: string
  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'ReplySendError'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 模板渲染（{文件名} {数量} {关键词} {时间} {工厂名}）
// ---------------------------------------------------------------------------
export type ReplyVars = Record<string, string>

export interface ReplyVarsInput {
  filenames: string[]
  keyword?: string | null
  sentAt?: number
  factoryName?: string
}

export function formatLocalTime(at: number = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 构造模板变量；{文件名} 用「、」连接，{数量} 为文件个数 */
export function buildReplyVars(input: ReplyVarsInput): ReplyVars {
  const filenames = (input.filenames ?? []).filter((f) => !!f)
  return {
    文件名: filenames.join('、'),
    数量: String(filenames.length),
    关键词: input.keyword ?? '',
    时间: formatLocalTime(input.sentAt ?? Date.now()),
    工厂名: input.factoryName || 'MailHarbor'
  }
}

/** 渲染模板：只替换已知变量，未知占位符原样保留（便于用户发现拼写错误） */
export function renderTemplate(template: string, vars: ReplyVars): string {
  if (!template) return ''
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const v = vars[key.trim()]
    return v === undefined ? match : v
  })
}

export type ReplyLanguage = Settings['replyLanguage']

export interface ReplyTemplateSettings {
  replySubjectZh: string
  replyBodyZh: string
  replySubjectEn: string
  replyBodyEn: string
  replyLanguage: ReplyLanguage
}

export interface RenderedReply {
  subject: string
  body: string
}

/**
 * 按设置选择中/英文模板。
 * replyLanguage='both' 时：主题用中文模板，正文 = 中文 + 空行 + 英文（一封双语信，避免发两封）。
 */
export function composeReply(
  settings: ReplyTemplateSettings,
  vars: ReplyVars,
  lang: ReplyLanguage = settings.replyLanguage,
  fallbackSubject = '图稿已收到'
): RenderedReply {
  const zh = { subject: renderTemplate(settings.replySubjectZh, vars), body: renderTemplate(settings.replyBodyZh, vars) }
  const en = { subject: renderTemplate(settings.replySubjectEn, vars), body: renderTemplate(settings.replyBodyEn, vars) }
  let picked: RenderedReply
  if (lang === 'zh') picked = zh
  else if (lang === 'en') picked = en
  else picked = { subject: zh.subject || en.subject, body: [zh.body, en.body].filter(Boolean).join('\n\n') }

  const subject = normalizeReplySubject(picked.subject || fallbackSubject || en.subject)
  const body = picked.body || ''
  return { subject, body }
}

// ---------------------------------------------------------------------------
// 头字段清洗 / 编码
// ---------------------------------------------------------------------------
/** 剔除 CR/LF 与控制字符（防 SMTP 头注入），截断过长内容 */
export function sanitizeHeader(value: string | null | undefined, maxLen = 400): string {
  if (!value) return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maxLen)
}

/** 回信主题：已带 Re:/答复:/回复: 则不重复加；CR/LF 清洗 */
export function normalizeReplySubject(subject: string | null | undefined): string {
  const s = sanitizeHeader(subject)
  if (!s) return 'Re:'
  if (/^\s*(re|aw|sv|答复|回复)\s*[：:]/i.test(s)) return s
  return `Re: ${s}`
}

/** 非 ASCII 文本按 RFC 2047 base64 编码（buildReplyMime 预览用；nodemailer 发送时会自动编码） */
export function encodeHeaderWord(text: string): string {
  if (!text) return ''
  if (/^[\x20-\x7e]*$/.test(text) && !/=\?/.test(text)) return text
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += 45) chunks.push(b64.slice(i, i + 45))
  return chunks.map((c) => `=?UTF-8?B?${c}?=`).join(' ')
}

/** 地址格式化：显示名非 ASCII 时用 RFC 2047 编码 */
export function formatAddress(party: ReplyParty): string {
  const address = sanitizeHeader(party.address, 320)
  const name = sanitizeHeader(party.name, 120)
  if (!name) return address
  const encoded = encodeHeaderWord(name)
  return /^[\x20-\x7e]*$/.test(encoded) ? `"${encoded.replace(/"/g, '\\"')}" <${address}>` : `${encoded} <${address}>`
}

/** Message-ID 规范化：去 CR/LF 并补 <> */
export function normalizeMessageId(id: string | null | undefined): string {
  const s = sanitizeHeader(id, 320).replace(/[<>]/g, '')
  return s ? `<${s}>` : ''
}

/**
 * References 链：去重、保序，最后追加原 Message-ID（RFC 5322 回信惯例）。
 * IMAP 没有 threadId，thread_key 取根（第一项）或原 Message-ID。
 */
export function buildReferences(originalReferences: string[] | undefined, inReplyTo: string | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | null | undefined): void => {
    const id = normalizeMessageId(raw)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const r of originalReferences ?? []) push(r)
  push(inReplyTo)
  return out
}

function randomHex(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

/** 生成回信 Message-ID（用发件域名，尽量像正常邮件客户端） */
export function makeReplyMessageId(fromAddress: string, at: number = Date.now()): string {
  const domain = (fromAddress.split('@')[1] ?? 'mailharbor.local').replace(/[^a-z0-9.-]/gi, '') || 'mailharbor.local'
  return `<mh-${at.toString(36)}-${randomHex(6)}@${domain}>`
}

// ---------------------------------------------------------------------------
// MIME 构造（供预览 / 测试；发送走 nodemailer 结构化参数）
// ---------------------------------------------------------------------------
export interface BuiltMime {
  raw: string
  messageId: string
  subject: string
  references: string[]
}

export function buildReplyMime(req: ReplyRequest, at: number = Date.now()): BuiltMime {
  const messageId = makeReplyMessageId(req.from.address, at)
  const references = buildReferences(req.references, req.inReplyTo)
  const subject = normalizeReplySubject(req.subject)
  const headers: string[] = [
    `From: ${formatAddress({ address: req.from.address, name: req.from.name })}`,
    `To: ${formatAddress(req.to)}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-replied',
    'X-Mailer: MailHarbor'
  ]
  if (references.length > 0) {
    headers.push(`In-Reply-To: ${references[references.length - 1]}`)
    headers.push(`References: ${references.join(' ')}`)
  }
  const bodyB64 = Buffer.from((req.body ?? '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8').toString('base64')
  const bodyLines: string[] = []
  for (let i = 0; i < bodyB64.length; i += 76) bodyLines.push(bodyB64.slice(i, i + 76))
  return {
    raw: headers.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n') + '\r\n',
    messageId,
    subject,
    references
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
export function createSmtpTransport(cfg: SmtpConfig): Transporter {
  const timeout = cfg.timeoutMs ?? 10_000
  const isSsl = cfg.secure === 'ssl'
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: isSsl, // 465
    requireTLS: cfg.secure === 'starttls', // 587
    ignoreTLS: cfg.secure === 'none', // 仅本地/企业内网明文（mock 测试）
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    pool: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: Math.max(timeout, 30_000),
    tls: { rejectUnauthorized: !cfg.allowSelfSigned, servername: cfg.host }
  })
}

function mailOptionsFor(req: ReplyRequest): SendMailOptions {
  const references = buildReferences(req.references, req.inReplyTo)
  return {
    from: { name: sanitizeHeader(req.from.name, 120), address: sanitizeHeader(req.from.address, 320) },
    to: { name: sanitizeHeader(req.to.name, 120), address: sanitizeHeader(req.to.address, 320) },
    subject: normalizeReplySubject(req.subject),
    text: req.body ?? '',
    inReplyTo: req.inReplyTo ? normalizeMessageId(req.inReplyTo) : undefined,
    references: references.length ? references : undefined,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Mailer': 'MailHarbor' }
  }
}

/** 真正发信：失败抛 ReplySendError（code 为稳定错误码） */
export async function sendReply(cfg: SmtpConfig, req: ReplyRequest): Promise<SendReplyResult> {
  const transport = createSmtpTransport(cfg)
  try {
    const info = await transport.sendMail(mailOptionsFor(req))
    const accepted = (info.accepted ?? [])
      .map((a) => (typeof a === 'string' ? a : (a as { address?: string }).address ?? ''))
      .filter((a): a is string => !!a)
    return {
      providerMessageId: info.messageId ?? '',
      response: info.response ?? '',
      accepted
    }
  } catch (e) {
    const c = classifyMailError(e, 'smtp')
    throw new ReplySendError(c.code, c.message, c.detail)
  } finally {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
  }
}

/** SMTP 测试连接：TCP 预检 → EHLO/AUTH → QUIT */
export async function testSmtpConnection(cfg: SmtpConfig): Promise<TestResultLine> {
  const probe = await probeTcp(cfg.host, cfg.port, cfg.timeoutMs ?? 5000)
  const pre = preflightLine('smtp', cfg.host, cfg.port, probe)
  if (pre) return pre
  const started = Date.now()
  const transport = createSmtpTransport(cfg)
  try {
    await transport.verify()
    return {
      protocol: 'smtp',
      ok: true,
      latencyMs: Date.now() - started,
      host: cfg.host,
      port: cfg.port,
      message: 'SMTP 登录成功，可以发信'
    }
  } catch (e) {
    const c = classifyMailError(e, 'smtp')
    return {
      protocol: 'smtp',
      ok: false,
      latencyMs: Date.now() - started,
      host: cfg.host,
      port: cfg.port,
      errorCode: c.code,
      message: c.message
    }
  } finally {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
  }
}

export { FIX_HINTS as SMTP_FIX_HINTS }
