/**
 * 网络代理支持：IMAP/SMTP 是裸 TCP，不能像 HTTP 那样直接走系统代理，
 * 所以这里把 SOCKS5 / HTTP CONNECT 代理包装成「本地端口转发」，
 * 再让 imapflow / nodemailer 连 127.0.0.1:<随机端口>，TLS 的 SNI 仍用真实域名。
 *
 * 为什么需要它：国内直连 Gmail 的 993/465 经常被断，必须走本机代理（Clash/V2Ray 等）。
 */
import net from 'node:net'
import tls from 'node:tls'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ProxyMode = 'none' | 'system' | 'socks5' | 'http'

export interface ProxyConfig {
  mode: ProxyMode
  host: string
  port: number
  /** 诊断信息：实际生效的代理来源 */
  source?: string
}

export const DEFAULT_PROXY: ProxyConfig = { mode: 'system', host: '127.0.0.1', port: 7890 }

/** 从系统设置里探测代理（macOS scutil / Windows 注册表 / *nix 环境变量） */
export async function detectSystemProxy(): Promise<{ host: string; port: number; kind: 'socks5' | 'http'; source: string } | null> {
  // 1) 环境变量优先（企业环境/CI 常用）
  const envAll = process.env.ALL_PROXY ?? process.env.all_proxy
  const envHttps = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const fromEnv = envAll ?? envHttps
  if (fromEnv) {
    try {
      const url = new URL(fromEnv.includes('://') ? fromEnv : `http://${fromEnv}`)
      const kind = url.protocol.startsWith('socks') ? 'socks5' : 'http'
      return { host: url.hostname, port: Number(url.port || (kind === 'socks5' ? 1080 : 8080)), kind, source: 'env' }
    } catch {
      /* ignore */
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 3000 })
      const pick = (key: string): string | null => {
        const m = stdout.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`))
        return m ? m[1]!.trim() : null
      }
      const socksEnable = pick('SOCKSEnable') === '1'
      const socksHost = pick('SOCKSProxy')
      const socksPort = pick('SOCKSPort')
      if (socksEnable && socksHost && socksPort) {
        return { host: socksHost, port: Number(socksPort), kind: 'socks5', source: 'macOS 系统代理 (SOCKS)' }
      }
      const httpsEnable = pick('HTTPSEnable') === '1'
      const httpsHost = pick('HTTPSProxy')
      const httpsPort = pick('HTTPSPort')
      if (httpsEnable && httpsHost && httpsPort) {
        return { host: httpsHost, port: Number(httpsPort), kind: 'http', source: 'macOS 系统代理 (HTTPS)' }
      }
    } catch {
      /* scutil 不可用 */
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { timeout: 3000 }
      )
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
      const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim()
      if (enabled && server) {
        // 形如 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=..."
        const part = server.includes('=') ? server.split(';').find((s) => /https?=/.test(s)) ?? server : server
        const addr = part.includes('=') ? part.split('=')[1]! : part
        const [h, p] = addr.split(':')
        if (h && p) {
          return { host: h, port: Number(p), kind: 'http', source: 'Windows 系统代理' }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // *nix：常见本地代理端口探活
  for (const port of [7890, 7891, 1080, 10808, 8889, 2080]) {
    if (await isPortOpen('127.0.0.1', port)) {
      return { host: '127.0.0.1', port, kind: port === 1080 || port === 10808 ? 'socks5' : 'http', source: `本地代理端口 ${port}` }
    }
  }
  return null
}

function isPortOpen(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// ---------------------------------------------------------------------------
// SOCKS5 / HTTP CONNECT 握手（纯 Node，无第三方依赖）
// ---------------------------------------------------------------------------
function socks5Connect(socket: net.Socket, dstHost: string, dstPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (msg: string): void => reject(new Error(`SOCKS5 代理失败：${msg}`))
    let stage: 'greet' | 'reply' = 'greet'
    socket.once('error', (e) => fail(e.message))
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    socket.on('data', function onData(chunk: Buffer) {
      if (stage === 'greet') {
        if (chunk[0] !== 0x05) return fail('不是 SOCKS5 代理')
        if (chunk[1] !== 0x00) return fail('代理要求认证（本软件暂不支持带密码的 SOCKS5）')
        stage = 'reply'
        const host = Buffer.from(dstHost, 'utf8')
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([(dstPort >> 8) & 0xff, dstPort & 0xff])
        ])
        socket.write(req)
        return
      }
      if (chunk[1] !== 0x00) return fail(`连接被拒绝（错误码 ${chunk[1]}）`)
      socket.removeListener('data', onData)
      socket.removeAllListeners('error')
      resolve()
    })
  })
}

function httpConnect(socket: net.Socket, dstHost: string, dstPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (msg: string): void => reject(new Error(`HTTP 代理失败：${msg}`))
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx < 0) {
        if (buffer.length > 8192) fail('代理响应异常')
        return
      }
      socket.removeListener('data', onData)
      socket.removeAllListeners('error')
      const status = buffer.slice(0, idx).split('\r\n')[0] ?? ''
      if (!/^HTTP\/1\.[01]\s+200/i.test(status)) return fail(status || '未知响应')
      resolve()
    }
    socket.once('error', (e) => fail(e.message))
    socket.on('data', onData)
    socket.write(
      `CONNECT ${dstHost}:${dstPort} HTTP/1.1\r\nHost: ${dstHost}:${dstPort}\r\n` +
        `Proxy-Connection: keep-alive\r\nUser-Agent: MailHarbor\r\n\r\n`
    )
  })
}

export interface Bridge {
  port: number
  close(): Promise<void>
}

/** 把 (dstHost,dstPort) 通过代理映射到本机 127.0.0.1:<port> */
export async function createBridge(
  proxy: { host: string; port: number; kind: 'socks5' | 'http' },
  dstHost: string,
  dstPort: number
): Promise<Bridge> {
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    const upstream = net.connect({ host: proxy.host, port: proxy.port })
    const handshake = proxy.kind === 'socks5' ? socks5Connect : httpConnect
    upstream.once('connect', () => {
      handshake(upstream, dstHost, dstPort)
        .then(() => {
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
        })
        .catch((e: Error) => {
          client.end(`PROXY-ERROR ${e.message}\r\n`)
          upstream.destroy()
        })
    })
    upstream.once('error', () => {
      client.destroy()
    })
    client.once('error', () => upstream.destroy())
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

/** 代理是否可用（给"测试代理"按钮用） */
export async function testProxy(
  proxy: { host: string; port: number; kind: 'socks5' | 'http' },
  dstHost = 'imap.gmail.com',
  dstPort = 993
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const started = Date.now()
  try {
    const bridge = await createBridge(proxy, dstHost, dstPort)
    try {
      await new Promise<void>((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port: bridge.port, servername: dstHost, rejectUnauthorized: true })
        const timer = setTimeout(() => {
          s.destroy()
          reject(new Error('代理握手超时'))
        }, 12000)
        s.once('secureConnect', () => {
          clearTimeout(timer)
          s.destroy()
          resolve()
        })
        s.once('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
      })
      return { ok: true, latencyMs: Date.now() - started, message: `代理可用：${proxy.kind.toUpperCase()} ${proxy.host}:${proxy.port} → ${dstHost}:${dstPort}` }
    } finally {
      await bridge.close()
    }
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: `${e instanceof Error ? e.message : String(e)}（检查代理是否开启、端口是否正确）`
    }
  }
}

/** 解析用户设置里的代理；system 模式下探测系统代理，探测不到则视为直连 */
export async function resolveProxy(cfg: { mode: ProxyMode; host: string; port: number }): Promise<{ kind: 'socks5' | 'http'; host: string; port: number; source: string } | null> {
  if (cfg.mode === 'none') return null
  if (cfg.mode === 'socks5' || cfg.mode === 'http') {
    if (!cfg.host || !cfg.port) return null
    return { kind: cfg.mode, host: cfg.host, port: cfg.port, source: '手动设置' }
  }
  const detected = await detectSystemProxy()
  return detected ? { kind: detected.kind, host: detected.host, port: detected.port, source: detected.source } : null
}
