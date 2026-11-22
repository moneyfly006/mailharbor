/**
 * 邮箱连接错误码与中文修复指引（ARCHITECTURE §2.3 的表）。
 *
 * 这是"非技术用户第一道坎"：错误码必须稳定、message 必须能直接照着修。
 * 所有 mapping 都是纯函数，便于单测（不需要真实邮箱）。
 */
import { connect as netConnect } from 'node:net'
import type { TestResultLine } from '@shared/types'

export type MailErrorCode =
  | 'IMAP_AUTH_FAILED'
  | 'IMAP_APP_PASSWORD_REQUIRED'
  | 'IMAP_DISABLED'
  | 'IMAP_UNREACHABLE'
  | 'IMAP_TLS_ERROR'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_SENDER_REJECTED'
  | 'SMTP_TEMP_FAIL'
  | 'SMTP_UNREACHABLE'
  | 'SMTP_TLS_ERROR'
  | 'PORT_BLOCKED'
  | 'TIMEOUT'
  | 'UNKNOWN'

/** 用户可读的中文修复指引（UI 直接显示） */
export const FIX_HINTS: Record<MailErrorCode, string> = {
  IMAP_AUTH_FAILED:
    'IMAP 登录被拒绝：请检查邮箱地址与应用专用密码 / 授权码是否复制完整（Gmail 为 16 位、无空格；QQ 是授权码不是登录密码）',
  IMAP_APP_PASSWORD_REQUIRED:
    '需要应用专用密码：请先开启两步验证，再到 Google 账号安全设置生成 16 位应用专用密码（不能填邮箱登录密码）',
  IMAP_DISABLED:
    '邮箱服务端未开启 IMAP：QQ 邮箱请到「设置 → 账户 → 开启 IMAP/SMTP 服务」；企业邮箱请联系管理员开启',
  IMAP_UNREACHABLE:
    '无法连接 IMAP 服务器：请检查网络、服务器地址与端口是否正确，以及防火墙 / 代理是否放行 993 出站',
  IMAP_TLS_ERROR:
    'IMAP 加密连接失败：请检查电脑系统时间是否准确、服务器证书是否过期；企业自建服务器可在账户里勾选「允许自签名证书」',
  SMTP_AUTH_FAILED: 'SMTP 登录被拒绝：请检查 SMTP 用户名与密码 / 授权码，并确认邮箱已开启 SMTP 服务',
  SMTP_SENDER_REJECTED:
    '发件地址不被服务器允许：回信的发件人必须等于登录账号或其已验证别名，请检查账户邮箱是否填写正确',
  SMTP_TEMP_FAIL: '邮件服务器临时拒绝收信（4xx）：稍后会自动重试；若持续出现请联系邮箱服务商',
  SMTP_UNREACHABLE: '无法连接 SMTP 服务器：请检查网络与服务器地址/端口，企业网络常见 465/587 被拦截',
  SMTP_TLS_ERROR: 'SMTP 加密连接失败：可尝试改用 465 端口 SSL（STARTTLS 被拦截时常见）或检查服务器证书',
  PORT_BLOCKED: '端口无法连接：可能被防火墙 / 运营商拦截，或服务器地址填错（IMAP 993；SMTP 465 或 587）',
  TIMEOUT: '连接超时：网络较慢或邮件服务器无响应，请稍后重试或换一个网络环境',
  UNKNOWN: '未知错误：请查看错误详情；如反复出现请联系技术支持'
}

export interface ClassifiedError {
  code: MailErrorCode
  message: string
  /** 服务端原始响应（已截断，排查用，UI 可折叠显示） */
  detail?: string
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT',
  'EPROTO',
  'HOSTNAME_MISMATCH'
])

const NETWORK_UNREACHABLE = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNRESET',
  'EPIPE'
])

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'TIMEOUT'
])

/** 从任意异常里提取一段可读的原始响应（截断 + 去换行，供 UI 折叠） */
export function errDetail(err: unknown): string {
  const e = err as Record<string, unknown> | null
  const parts: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
  }
  push(e?.responseText)
  push(e?.response)
  push(e?.serverResponseCode)
  if (parts.length === 0 && err instanceof Error) push(err.message)
  const s = parts.join(' | ').replace(/\s+/g, ' ').slice(0, 500)
  return s
}

function textOf(err: unknown): string {
  const e = err as Record<string, unknown> | null
  const bits = [e?.message, e?.responseText, e?.response, e?.serverResponseCode, e?.code]
  return bits.filter((x): x is string => typeof x === 'string').join(' \n ')
}

type BaseCode = MailErrorCode | 'UNREACHABLE' | 'TLS'

function withPrefix(base: BaseCode, protocol: 'imap' | 'smtp'): MailErrorCode {
  if (base === 'TIMEOUT' || base === 'PORT_BLOCKED' || base === 'UNKNOWN') return base
  if (base === 'UNREACHABLE') return protocol === 'imap' ? 'IMAP_UNREACHABLE' : 'SMTP_UNREACHABLE'
  if (base === 'TLS') return protocol === 'imap' ? 'IMAP_TLS_ERROR' : 'SMTP_TLS_ERROR'
  return base
}

/**
 * 统一错误映射（imapflow / nodemailer / node net / tls 的混合异常）。
 * 判定顺序：认证文案 → IMAP 关闭 → 发件人拒绝 → TLS → 网络 → 超时 → 未知。
 */
export function classifyMailError(err: unknown, protocol: 'imap' | 'smtp'): ClassifiedError {
  const e = err as Record<string, unknown> | null
  const text = textOf(err)
  const lower = text.toLowerCase()
  const code = typeof e?.code === 'string' ? e.code : ''
  const responseCode = typeof e?.responseCode === 'number' ? e.responseCode : undefined
  const detail = errDetail(err)
  const make = (c: MailErrorCode, extra?: string): ClassifiedError => ({ code: c, message: extra ?? FIX_HINTS[c], detail })

  if (/authenticationfailed|invalid credentials|login failed|authentication failed|badcredentials/i.test(text) || e?.authenticationFailed === true) {
    if (/application-specific password required|web login required|app password/i.test(lower)) return make('IMAP_APP_PASSWORD_REQUIRED')
    return make(protocol === 'imap' ? 'IMAP_AUTH_FAILED' : 'SMTP_AUTH_FAILED')
  }
  if (/application-specific password required|web login required/i.test(lower)) return make('IMAP_APP_PASSWORD_REQUIRED')
  if (/imap access is disabled|imap.*(disabled|turned off)|imap.*not enabled|imap disabled/i.test(lower)) return make('IMAP_DISABLED')
  if (protocol === 'smtp' && (responseCode === 535 || /535|5\.7\.8|authentication required/i.test(text))) return make('SMTP_AUTH_FAILED')
  if (protocol === 'smtp' && (responseCode === 550 || responseCode === 553 || /sender( address)? rejected|5\.7\.1|not permitted to send/i.test(text))) {
    return make('SMTP_SENDER_REJECTED')
  }
  if (protocol === 'smtp' && (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452 || /4\.7\.0|try again later/i.test(text))) {
    return make('SMTP_TEMP_FAIL')
  }
  if (e?.tlsFailed === true || TLS_CODES.has(code) || /certificate|self.signed|altname|wrong version number|ssl routines|tls/i.test(lower)) {
    return make(withPrefix('TLS', protocol))
  }
  if (code === 'ECONNREFUSED') return make('PORT_BLOCKED')
  if (NETWORK_UNREACHABLE.has(code) || /enotfound|econnrefused|ehostunreach|enetunreach|getaddrinfo/i.test(lower)) {
    return make(withPrefix('UNREACHABLE', protocol))
  }
  if (TIMEOUT_CODES.has(code) || /timed? ?out|timeout/i.test(lower)) return make('TIMEOUT')
  return make('UNKNOWN', detail ? `${FIX_HINTS.UNKNOWN}（${detail}）` : FIX_HINTS.UNKNOWN)
}

/** 预检 TCP 连通性（5s），区分 DNS 失败 / 端口不通 / 超时 */
export function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; latencyMs: number; error?: ClassifiedError }> {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const socket = netConnect({ host, port })
    let settled = false
    const finish = (ok: boolean, err?: ClassifiedError): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise({ ok, latencyMs: Date.now() - started, error: err })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, { code: 'TIMEOUT', message: FIX_HINTS.TIMEOUT }))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const classified = classifyMailError(err, 'imap')
      // 端口拒绝：更准确的说法是 PORT_BLOCKED；DNS/路由失败保持 UNREACHABLE 由调用方按协议前缀
      finish(false, classified)
    })
  })
}

/** 供 provider 生成一行 TestResultLine（预检失败时直接返回） */
export function preflightLine(
  protocol: 'imap' | 'smtp',
  host: string,
  port: number,
  probe: { ok: boolean; latencyMs: number; error?: ClassifiedError }
): TestResultLine | null {
  if (probe.ok) return null
  const base = probe.error?.code ?? 'UNKNOWN'
  const code = withPrefix(base, protocol)
  return {
    protocol,
    ok: false,
    latencyMs: probe.latencyMs,
    host,
    port,
    errorCode: code,
    message: FIX_HINTS[code] ?? probe.error?.message ?? FIX_HINTS.UNKNOWN
  }
}
