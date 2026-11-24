/**
 * Gmail API 附件下载测速脚本（方案 A：OAuth 测试模式）
 *
 * 用途：在把 Gmail API 接进软件之前，先用真实账号验证「HTTP 下载附件」比 IMAP 快多少。
 *
 * 用法（在项目根目录执行）：
 *   1) 第一次授权：
 *      node scripts/gmail-api-speed.mjs --client-id=xxx --client-secret=yyy
 *      （会打印一个 Google 授权链接，浏览器打开、登录并点「允许」后自动继续）
 *   2) 之后复用已保存的刷新令牌：
 *      node scripts/gmail-api-speed.mjs
 *   3) 可选：同时对比 IMAP 速度
 *      MH_GMAIL_PASS=应用专用密码 node scripts/gmail-api-speed.mjs
 *
 * 凭据只保存在本机 ~/.mailharbor-gmail-api.json（权限 600），不会写进仓库。
 * 说明：测试模式下刷新令牌 7 天过期，过期后重新执行第 1 步即可。
 */
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const TOKEN_FILE = join(homedir(), '.mailharbor-gmail-api.json')
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.join('=') || true]
  })
)
const DRY_RUN = Boolean(args['dry-run'])
const TARGET_MIN_MB = Number(args['min-mb'] ?? 5)
const TARGET_MAX_MB = Number(args['max-mb'] ?? 60)

const log = (...a) => console.log(...a)
const fail = (msg) => {
  console.error('✗', msg)
  process.exit(1)
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function loadSaved() {
  try {
    if (!existsSync(TOKEN_FILE)) return null
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}

function saveTokens(data) {
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url], () => {})
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {})
  else execFile('xdg-open', [url], () => {})
}

/** 第一步：浏览器授权，拿一次性授权码 */
async function authorize(clientId, clientSecret) {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const redirectUri = `http://127.0.0.1:${port}`

  const url =
    `${AUTH_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&access_type=offline&prompt=consent` +
    `&code_challenge=${challenge}&code_challenge_method=S256`

  log('\n请在浏览器中打开下面的链接，登录并点「允许」：\n')
  log(url, '\n')
  log('（通常会自动打开浏览器；若没有，请手动复制上面的链接）')
  if (DRY_RUN) {
    log('\n--dry-run：只检查授权链接生成，不等待回调。')
    server.close()
    return null
  }
  openBrowser(url)

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待授权超时（5 分钟）')), 5 * 60_000)
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri)
      const c = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (err) {
        res.end('<h2>授权被拒绝或失败，请回到终端查看。</h2>')
        clearTimeout(timer)
        reject(new Error(`授权失败：${err}`))
      } else if (c) {
        res.end('<h2>授权成功，可以关闭此页面，回到终端继续。</h2>')
        clearTimeout(timer)
        resolve(c)
      } else {
        res.end('<h2>等待授权…</h2>')
      }
    })
  }).finally(() => server.close())

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  })
  const resp = await fetch(TOKEN_URL, { method: 'POST', body })
  const json = await resp.json()
  if (!resp.ok) fail(`换取令牌失败：${JSON.stringify(json).slice(0, 300)}`)
  if (!json.refresh_token) {
    log('提示：本次没有返回刷新令牌（可能之前授权过）。如需长期使用，请到 Google 账号「第三方应用」里移除本应用后重新授权。')
  }
  return {
    clientId,
    clientSecret,
    refreshToken: json.refresh_token ?? null,
    accessToken: json.access_token,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000
  }
}

async function getAccessToken(saved) {
  if (!saved?.refreshToken) fail('没有可用的刷新令牌，请先用 --client-id / --client-secret 授权一次。')
  if (saved.accessToken && saved.expiry && Date.now() < saved.expiry - 60_000) return saved.accessToken
  const body = new URLSearchParams({
    client_id: saved.clientId,
    client_secret: saved.clientSecret,
    refresh_token: saved.refreshToken,
    grant_type: 'refresh_token'
  })
  const resp = await fetch(TOKEN_URL, { method: 'POST', body })
  const json = await resp.json()
  if (!resp.ok) fail(`刷新令牌失败（测试模式下令牌 7 天过期，需重新授权）：${JSON.stringify(json).slice(0, 300)}`)
  saved.accessToken = json.access_token
  saved.expiry = Date.now() + (json.expires_in ?? 3600) * 1000
  saveTokens(saved)
  return saved.accessToken
}

async function apiGet(path, token) {
  const resp = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) throw new Error(`Gmail API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  return resp.json()
}

/** 从邮件结构里找出最大的附件 */
function pickBiggestAttachment(payload) {
  let best = null
  const walk = (node) => {
    if (!node) return
    const filename = node.filename ?? ''
    const body = node.body ?? {}
    if (filename && body.attachmentId && body.size) {
      if (!best || body.size > best.size) {
        best = { filename, attachmentId: body.attachmentId, size: body.size, mimeType: node.mimeType }
      }
    }
    for (const child of node.parts ?? []) walk(child)
  }
  walk(payload)
  return best
}

/** 下载附件（Gmail API 返回 base64url JSON，本地解码落盘；带进度与速度） */
async function downloadAttachment(token, messageId, att, destPath) {
  const url = `${GMAIL}/users/me/messages/${messageId}/attachments/${encodeURIComponent(att.attachmentId)}`
  const t0 = Date.now()
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`下载失败 ${resp.status}: ${detail.slice(0, 400)}`)
  }
  const json = await resp.json()
  if (!json?.data) throw new Error(`附件数据为空：${JSON.stringify(json).slice(0, 200)}`)
  const buf = Buffer.from(json.data, 'base64url')
  const secs = (Date.now() - t0) / 1000
  const hash = createHash('sha256').update(buf)
  writeFileSync(destPath, buf)
  const mb = buf.length / 1048576
  log(`  下载完成：${mb.toFixed(1)}MB / ${secs.toFixed(1)}s · ${(mb / secs).toFixed(2)} MB/s`)
  return { bytes: buf.length, secs, speed: mb / secs, sha256: hash.digest('hex') }
}

/** 可选：用 IMAP 下同一个附件，做对比 */
async function downloadViaImap(user, pass, subject, att, destPath) {
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
    clientInfo: { name: 'MailHarbor', version: '1.0' }, socketTimeout: 300_000
  })
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    // 在收件箱最近 40 封里找最大的附件（不要求同一封，只测 IMAP 传输速度）
    const metas = await client.fetchAll('1:*', { envelope: true, bodyStructure: true }, { uid: true })
    let best = null
    for (const m of metas.slice(-40)) {
      const parts = []
      const walk = (n) => {
        if (!n) return
        if (n.childNodes) n.childNodes.forEach(walk)
        else if (n.dispositionParameters?.filename) parts.push(n)
      }
      walk(m.bodyStructure)
      const p = parts.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
      if (p && (!best || (p.size ?? 0) > (best.p.size ?? 0))) best = { m, p }
    }
    if (!best) throw new Error('IMAP 收件箱里没有找到带附件的邮件')
    log(`  （IMAP 对比对象：${best.p.dispositionParameters?.filename}，${((best.p.size ?? 0) / 1048576).toFixed(1)}MB）`)
    const t0 = Date.now()
    let bytes = 0
    const hash = createHash('sha256')
    const dl = await client.download(String(best.m.uid), best.p.part, { uid: true, chunkSize: 2 * 1024 * 1024 })
    await pipeline(
      dl.content,
      new (await import('node:stream')).Transform({
        transform(chunk, _e, cb) { bytes += chunk.length; hash.update(chunk); cb(null, chunk) }
      }),
      createWriteStream(destPath)
    )
    const secs = (Date.now() - t0) / 1000
    return { bytes, secs, speed: bytes / 1048576 / secs, sha256: hash.digest('hex') }
  } finally {
    lock.release()
    await client.logout().catch(() => {})
  }
}

async function main() {
  log('=== Gmail API 附件下载测速（方案 A）===')
  let saved = loadSaved()
  const clientId = (args['client-id'] ?? saved?.clientId ?? '').toString().trim()
  const clientSecret = (args['client-secret'] ?? saved?.clientSecret ?? '').toString().trim()

  if (clientId && clientSecret && (args['authorize'] || !saved?.refreshToken)) {
    log(`\n开始授权（客户端 ID：${clientId.slice(0, 12)}…）`)
    const tokens = await authorize(clientId, clientSecret)
    if (DRY_RUN) return
    saved = tokens
    saveTokens(saved)
    log(`授权成功，令牌已保存到 ${TOKEN_FILE}（测试模式 7 天后需重新授权）`)
  }

  if (!saved?.refreshToken) {
    fail(
      '还没有授权。请先运行：\n' +
        '  node scripts/gmail-api-speed.mjs --client-id=你的ID --client-secret=你的密钥\n' +
        '（授权链接会在终端打印，浏览器点「允许」即可）'
    )
  }

  const token = await getAccessToken(saved)
  const profile = await apiGet('/users/me/profile', token)
  log(`\n账号：${profile.emailAddress}`)

  // 找邮件：优先带大附件的
  const list = await apiGet('/users/me/messages?maxResults=40&q=has:attachment', token)
  const messages = list.messages ?? []
  if (messages.length === 0) fail('收件箱里没有带附件的邮件，无法测速。')

  let chosen = null
  for (const m of messages) {
    const full = await apiGet(`/users/me/messages/${m.id}?format=full`, token)
    const att = pickBiggestAttachment(full.payload)
    if (att && att.size >= TARGET_MIN_MB * 1048576 && att.size <= TARGET_MAX_MB * 1048576) {
      chosen = { message: full, att }
      break
    }
  }
  if (!chosen) {
    log(`没有找到 ${TARGET_MIN_MB}–${TARGET_MAX_MB}MB 的附件，改用最大的一封。`)
    for (const m of messages.slice(0, 10)) {
      const full = await apiGet(`/users/me/messages/${m.id}?format=full`, token)
      const att = pickBiggestAttachment(full.payload)
      if (att && (!chosen || att.size > chosen.att.size)) chosen = { message: full, att }
    }
  }
  if (!chosen) fail('这些邮件里没有解析到附件。')

  const { message, att } = chosen
  log(`\n选中附件：${att.filename}（${(att.size / 1048576).toFixed(1)}MB，类型 ${att.mimeType}）`)
  log(`邮件主题：${message.payload?.headers?.find((h) => h.name === 'Subject')?.value ?? '(无)'}`)
  log(`邮件日期：${new Date(Number(message.internalDate)).toLocaleString('zh-CN')}`)

  const dest = join(process.env.TMPDIR ?? '/tmp', `gmail-api-speed-${Date.now()}.bin`)
  log('\n开始用 Gmail API（HTTPS）下载…')
  const api = await downloadAttachment(token, message.id, att, dest)
  log(`\n✓ Gmail API：${(api.bytes / 1048576).toFixed(1)}MB / ${api.secs.toFixed(1)}s = ${api.speed.toFixed(2)} MB/s`)

  const imapPass = (process.env.MH_GMAIL_PASS ?? '').replace(/\s+/g, '')
  if (imapPass) {
    log('\n开始用 IMAP 下载同一封邮件的附件（对比）…')
    try {
      const subject = message.payload?.headers?.find((h) => h.name === 'Subject')?.value ?? ''
      const imap = await downloadViaImap(profile.emailAddress, imapPass, subject, att, dest + '.imap')
      log(`\n✓ IMAP：${(imap.bytes / 1048576).toFixed(1)}MB / ${imap.secs.toFixed(1)}s = ${imap.speed.toFixed(2)} MB/s`)
      log(`\n结论：Gmail API 是 IMAP 的 ${(api.speed / imap.speed).toFixed(1)} 倍`)
    } catch (e) {
      log('IMAP 对比失败（不影响 API 结果）：', e instanceof Error ? e.message : String(e))
    }
  } else {
    log('\n（如需与 IMAP 对比，设置环境变量 MH_GMAIL_PASS=应用专用密码 后重跑）')
  }

  log(`\n下载文件保存在：${dest}（${(statSync(dest).size / 1048576).toFixed(1)}MB）`)
  log(`SHA256：${api.sha256}`)
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
