/**
 * Gmail API 客户端（只读）：刷新令牌、按 Message-ID 定位邮件、下载附件。
 *
 * 为什么按 Message-ID 定位：收信仍由 IMAP 完成（游标/去重逻辑不变），
 * 下载附件时再用邮件的 RFC822 Message-ID 到 Gmail API 里找到同一封，走 HTTPS 取附件。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { httpsRequest, httpsRequestText, responseStream, type ProxyTarget } from '../net/http-proxy-client'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1'

/**
 * 把 Gmail 附件接口的 JSON 流（{"data":"<base64url>"}）边收边解码写文件。
 * 独立成纯函数便于单测；内存占用与响应分块大小同阶。
 */
export async function writeGmailBase64JsonToFile(
  source: AsyncIterable<Buffer | string>,
  destPath: string,
  declaredSize: number,
  onProgress?: (received: number, total: number) => void
): Promise<{ size: number; sha256: string }> {
  const out = createWriteStream(destPath)
  const hash = createHash('sha256')
  let state: 'search' | 'data' | 'done' = 'search'
  let carry = ''
  let written = 0
  let lastReport = 0
  const writeDecoded = (str: string): void => {
    const cleaned = str.replace(/[^A-Za-z0-9_-]/g, '')
    if (cleaned.length === 0) return
    // 末尾不足 4 个字符时补 = 再解码（base64url 允许省略 padding）
    const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4)
    const buf = Buffer.from(padded, 'base64url')
    out.write(buf)
    hash.update(buf)
    written += buf.length
    const now = Date.now()
    if (now - lastReport > 300) {
      lastReport = now
      try {
        onProgress?.(written, declaredSize)
      } catch {
        /* ignore */
      }
    }
  }
  for await (const chunk of source) {
    const s = Buffer.isBuffer(chunk) ? chunk.toString('ascii') : String(chunk)
    if (state === 'done') continue
    if (state === 'search') {
      const probe = carry + s
      // 真实响应是格式化 JSON（"data": "…"，冒号后可能有空格/换行），用正则兼容
      const m = /"data"\s*:\s*"/.exec(probe)
      if (!m) {
        carry = probe.slice(-64)
        continue
      }
      carry = ''
      state = 'data'
      const rest = probe.slice(m.index + m[0].length)
      const quote = rest.indexOf('"')
      if (quote >= 0) {
        writeDecoded(rest.slice(0, quote))
        state = 'done'
      } else {
        const usableLen = rest.length - (rest.length % 4)
        writeDecoded(rest.slice(0, usableLen))
        carry = rest.slice(usableLen)
      }
      continue
    }
    const probe = carry + s
    const quote = probe.indexOf('"')
    if (quote >= 0) {
      writeDecoded(probe.slice(0, quote))
      carry = ''
      state = 'done'
    } else {
      const usableLen = probe.length - (probe.length % 4)
      writeDecoded(probe.slice(0, usableLen))
      carry = probe.slice(usableLen)
    }
  }
  if (carry && state === 'data') writeDecoded(carry)
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
  try {
    onProgress?.(written, written)
  } catch {
    /* ignore */
  }
  return { size: written, sha256: hash.digest('hex') }
}

export interface GmailApiOptions {
  clientId: string
  clientSecret: string
  refreshToken: string
  proxy?: ProxyTarget | null
  logger?: { warn: (msg: string, ...args: unknown[]) => void; info: (msg: string, ...args: unknown[]) => void }
}

interface AttachmentInfo {
  attachmentId: string
  filename: string
  size: number
}

export class GmailApiClient {
  private opts: GmailApiOptions
  private accessToken: string | null = null
  private expiry = 0
  private messageIdCache = new Map<string, { id: string | null; at: number }>()
  private refreshing: Promise<string> | null = null

  constructor(opts: GmailApiOptions) {
    this.opts = opts
  }

  private get log(): NonNullable<GmailApiOptions['logger']> {
    return (
      this.opts.logger ?? { warn: () => {}, info: () => {} }
    )
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiry - 60_000) return this.accessToken
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const { refreshAccessToken } = await import('./oauth')
        const r = await refreshAccessToken({
          clientId: this.opts.clientId,
          clientSecret: this.opts.clientSecret,
          refreshToken: this.opts.refreshToken,
          proxy: this.opts.proxy ?? null
        })
        this.accessToken = r.accessToken
        this.expiry = r.expiry
        return r.accessToken
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  private authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  /** 基本连通性测试：读取账号资料 */
  async test(): Promise<{ ok: boolean; email?: string; message?: string }> {
    try {
      const token = await this.token()
      const { status, text } = await httpsRequestText(`${GMAIL}/users/me/profile`, {
        headers: this.authHeaders(token),
        proxy: this.opts.proxy ?? null
      })
      if (status >= 400) return { ok: false, message: `Gmail API ${status}: ${text.slice(0, 160)}` }
      const json = JSON.parse(text) as { emailAddress?: string }
      return { ok: true, email: json.emailAddress }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /** RFC822 Message-ID → Gmail API message id（带 5 分钟缓存） */
  async findMessageIdByRfc822(rfcMessageId: string): Promise<string | null> {
    const key = rfcMessageId.trim()
    const cached = this.messageIdCache.get(key)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.id
    try {
      const token = await this.token()
      const q = encodeURIComponent(`rfc822msgid:${key.replace(/^<|>$/g, '')}`)
      const { status, text } = await httpsRequestText(`${GMAIL}/users/me/messages?maxResults=3&q=${q}`, {
        headers: this.authHeaders(token),
        proxy: this.opts.proxy ?? null
      })
      if (status >= 400) {
        this.log.warn('Gmail API 搜索邮件失败', status, text.slice(0, 120))
        this.messageIdCache.set(key, { id: null, at: Date.now() })
        return null
      }
      const json = JSON.parse(text) as { messages?: Array<{ id: string }> }
      const id = json.messages?.[0]?.id ?? null
      this.messageIdCache.set(key, { id, at: Date.now() })
      return id
    } catch (e) {
      this.log.warn('Gmail API 搜索异常', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  /** 读取邮件里的附件清单 */
  private async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const token = await this.token()
    const { status, text } = await httpsRequestText(`${GMAIL}/users/me/messages/${messageId}?format=full`, {
      headers: this.authHeaders(token),
      proxy: this.opts.proxy ?? null
    })
    if (status >= 400) throw new Error(`读取邮件结构失败：${status} ${text.slice(0, 120)}`)
    const json = JSON.parse(text) as { payload?: unknown }
    const out: AttachmentInfo[] = []
    const walk = (node: any): void => {
      if (!node) return
      const filename = String(node.filename ?? '')
      const body = node.body ?? {}
      if (filename && body.attachmentId && body.size) {
        out.push({ attachmentId: String(body.attachmentId), filename, size: Number(body.size) })
      }
      for (const child of node.parts ?? []) walk(child)
    }
    walk(json.payload)
    return out
  }

  /**
   * 下载指定附件到本地文件（整体 JSON + base64url 解码）。
   * 返回 null 表示没找到匹配的附件，由调用方回退 IMAP。
   */
  async downloadAttachmentByRfc822(opts: {
    rfcMessageId: string
    filename: string
    declaredSize?: number
    destPath: string
    onProgress?: (received: number, total: number) => void
    timeoutMs?: number
  }): Promise<{ size: number; sha256: string; tmpPath: string } | null> {
    const messageId = await this.findMessageIdByRfc822(opts.rfcMessageId)
    if (!messageId) return null
    const attachments = await this.listAttachments(messageId)
    if (attachments.length === 0) return null
    const wanted = opts.filename.toLowerCase()
    const exact = attachments.filter((a) => a.filename.toLowerCase() === wanted)
    const picked =
      exact.sort((a, b) => Math.abs(a.size - (opts.declaredSize ?? a.size)) - Math.abs(b.size - (opts.declaredSize ?? b.size)))[0] ??
      attachments.sort((a, b) => b.size - a.size)[0]
    if (!picked) return null

    const token = await this.token()
    const url = `${GMAIL}/users/me/messages/${messageId}/attachments/${encodeURIComponent(picked.attachmentId)}`
    const t0 = Date.now()
    const res = await httpsRequest(url, {
      headers: this.authHeaders(token),
      proxy: this.opts.proxy ?? null,
      timeoutMs: opts.timeoutMs ?? 15 * 60_000
    })
    if ((res.statusCode ?? 0) >= 400) {
      throw new Error(`下载附件失败：HTTP ${res.statusCode}`)
    }

    // Gmail 的附件接口返回 JSON：{"data":"<base64url>"}，边收边解码写盘（大附件不占内存）
    const r = await writeGmailBase64JsonToFile(res, opts.destPath, picked.size, (received, total) => {
      try {
        opts.onProgress?.(received, total)
      } catch {
        /* ignore */
      }
    })
    if (r.size === 0) throw new Error('Gmail API 返回的附件为空')
    this.log.info(
      `Gmail API 附件下载完成：${picked.filename} ${(r.size / 1048576).toFixed(1)}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s`
    )
    return { size: r.size, sha256: r.sha256, tmpPath: opts.destPath }
  }
}
