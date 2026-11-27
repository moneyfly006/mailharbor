/**
 * Gmail OAuth2 授权（桌面应用 + PKCE + 本机回调）
 *
 * 流程：生成 PKCE → 打开系统浏览器授权页 → 本机 127.0.0.1 随机端口收到授权码
 *      → 走代理用授权码换 access_token + refresh_token → 由调用方加密保存。
 *
 * 注意：测试模式（Testing）下 refresh_token 7 天过期，过期后需要重新授权。
 */
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { httpsRequestText, type ProxyTarget } from '../net/http-proxy-client'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  // Gmail 超过 25MB 的附件会放到 Google Drive，需要只读权限才能自动下载
  'https://www.googleapis.com/auth/drive.readonly'
]
const SCOPE = SCOPES.join(' ')
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface GmailTokens {
  accessToken: string
  refreshToken: string | null
  expiry: number
  scope?: string
}

export interface GmailAuthSession {
  authUrl: string
  /** 等待用户完成授权；超时/拒绝会 reject */
  wait: Promise<GmailTokens>
  cancel: () => void
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 启动授权：返回授权链接 + 等待结果 */
export async function startGmailAuth(opts: {
  clientId: string
  clientSecret: string
  proxy?: ProxyTarget | null
}): Promise<GmailAuthSession> {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const redirectUri = `http://127.0.0.1:${port}`

  const authUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(opts.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&access_type=offline&prompt=consent&include_granted_scopes=true` +
    `&code_challenge=${challenge}&code_challenge_method=S256`

  let timer: NodeJS.Timeout | null = null
  const wait = new Promise<GmailTokens>((resolve, reject) => {
    timer = setTimeout(() => {
      server.close()
      reject(new Error('授权超时（5 分钟），请重新点击「授权 Gmail 加速」'))
    }, 5 * 60_000)

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (error) {
        res.end('<h2>授权被拒绝或失败，请回到软件查看原因。</h2>')
        if (timer) clearTimeout(timer)
        server.close()
        reject(new Error(`授权失败：${error}`))
        return
      }
      if (!code) {
        res.end('<h2>等待授权…</h2>')
        return
      }
      res.end('<h2>授权成功，可以关闭此页面，回到软件继续。</h2>')
      if (timer) clearTimeout(timer)
      server.close()
      // 用授权码换令牌
      ;(async () => {
        try {
          const body = new URLSearchParams({
            code,
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier
          }).toString()
          const { status, text } = await httpsRequestText(TOKEN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': String(Buffer.byteLength(body))
            },
            body,
            proxy: opts.proxy ?? null
          })
          const json = JSON.parse(text || '{}') as {
            access_token?: string
            refresh_token?: string
            expires_in?: number
            scope?: string
            error?: string
            error_description?: string
          }
          if (status >= 400 || !json.access_token) {
            reject(new Error(`换取令牌失败：${json.error ?? status} ${json.error_description ?? ''}`.trim()))
            return
          }
          resolve({
            accessToken: json.access_token,
            refreshToken: json.refresh_token ?? null,
            expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
            scope: json.scope
          })
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })()
    })
  })

  return {
    authUrl,
    wait,
    cancel: () => {
      if (timer) clearTimeout(timer)
      server.close()
    }
  }
}

/** 用 refresh_token 换新的 access_token */
export async function refreshAccessToken(opts: {
  clientId: string
  clientSecret: string
  refreshToken: string
  proxy?: ProxyTarget | null
}): Promise<{ accessToken: string; expiry: number }> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token'
  }).toString()
  const { status, text } = await httpsRequestText(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body))
    },
    body,
    proxy: opts.proxy ?? null
  })
  const json = JSON.parse(text || '{}') as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (status >= 400 || !json.access_token) {
    const err = json.error ?? String(status)
    throw new Error(
      err === 'invalid_grant'
        ? 'Gmail 授权已过期（测试模式 7 天），请重新点击「授权 Gmail 加速」'
        : `刷新 Gmail 令牌失败：${err} ${json.error_description ?? ''}`.trim()
    )
  }
  return { accessToken: json.access_token, expiry: Date.now() + (json.expires_in ?? 3600) * 1000 }
}
