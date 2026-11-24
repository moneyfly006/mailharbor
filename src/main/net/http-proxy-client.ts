/**
 * 走本机代理的 HTTPS 请求（Node 原生 http/https，不依赖 undici）。
 *
 * 为什么需要：Node 自带 fetch 不读 HTTPS_PROXY，而 Gmail API 必须走代理。
 * 这里用标准 IMAP/SMTP 同款方式：先向代理发 CONNECT 建隧道，再在隧道上做 TLS。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { PassThrough, type Readable } from 'node:stream'

export interface ProxyTarget {
  host: string
  port: number
  kind: 'socks5' | 'http'
}

export interface HttpsRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  proxy?: ProxyTarget | null
  timeoutMs?: number
}

function createTunnel(target: URL, proxy: ProxyTarget): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const port = Number(target.port) || 443
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
      timeout: 20000
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.once('error', reject)
    req.once('timeout', () => {
      req.destroy()
      reject(new Error('代理连接超时'))
    })
    req.end()
  })
}

/** 发起请求，返回原生响应（可流式读取） */
export async function httpsRequest(urlStr: string, opts: HttpsRequestOptions = {}): Promise<http.IncomingMessage> {
  const url = new URL(urlStr)
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let socket: import('node:net').Socket | undefined
  if (opts.proxy) {
    const raw = await createTunnel(url, opts.proxy)
    socket = tls.connect({ socket: raw, servername: url.hostname })
    await new Promise<void>((resolve, reject) => {
      socket!.once('secureConnect', () => resolve())
      socket!.once('error', reject)
    })
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: Number(url.port) || 443,
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers,
        servername: url.hostname,
        timeout: opts.timeoutMs ?? 60_000,
        ...(socket ? { createConnection: () => socket as import('node:net').Socket } : {})
      },
      (res) => resolve(res)
    )
    req.once('error', reject)
    req.once('timeout', () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** 读取整个响应体（JSON 等小数据） */
export async function httpsRequestText(urlStr: string, opts: HttpsRequestOptions = {}): Promise<{ status: number; text: string }> {
  const res = await httpsRequest(urlStr, opts)
  const chunks: Buffer[] = []
  for await (const chunk of res) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }
}

/** 把响应体转成可读流（用于下载附件） */
export function responseStream(res: http.IncomingMessage): Readable {
  const out = new PassThrough()
  res.pipe(out)
  return out
}
