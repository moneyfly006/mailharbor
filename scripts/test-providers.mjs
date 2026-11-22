/**
 * 多邮箱 / 自建邮箱兼容性测试（真实 IMAP/SMTP 协议，TLS + STARTTLS + 自签名证书）
 *
 * 覆盖：
 *  1. 自建服务器 SSL + 自签名证书：开关关 → 报证书错误；开关开 → 可用
 *  2. IMAP STARTTLS（143/普通端口升级）可用
 *  3. SMTP SSL(465 类) 与 SMTP STARTTLS(587 类) 都能发信
 *  4. 错误密码 → 明确报「认证失败」而不是笼统超时
 *  5. 全链路：TLS 自建邮箱收信 → 落盘 → 回信
 *  6. 纯 HTML 正文的关键词匹配
 */
import { _electron as electron } from 'playwright'
import { ImapFlow } from 'imapflow'
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startTlsMockServers, TLS_MOCK } from './mock-tls-mail-server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(tmpdir(), 'mh-providers')
const USER_DATA = join(BASE, 'user-data')
const OUT = join(BASE, 'out')
for (const d of [USER_DATA, OUT]) rmSync(d, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const servers = await startTlsMockServers()
let pass = 0, fail = 0
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}\n    got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}
const ok = (n, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${extra}`)) }

const electronBin = process.platform === 'darwin'
  ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(ROOT, 'node_modules/electron/dist/electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({ executablePath: electronBin, args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`], env })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const U = TLS_MOCK.user
const P = TLS_MOCK.pass
const baseInput = (over = {}) => ({
  preset: 'custom', email: U, displayName: '自建邮箱',
  imapHost: TLS_MOCK.imapSsl.host, imapPort: TLS_MOCK.imapSsl.port, imapSecure: 'ssl',
  imapUser: U,
  smtpHost: TLS_MOCK.smtpSsl.host, smtpPort: TLS_MOCK.smtpSsl.port, smtpSecure: 'ssl',
  smtpUser: U, smtpFromName: '自建工厂', smtpSameAsImap: true,
  allowSelfSigned: true, password: P,
  ...over
})

console.log('1) 自签名证书开关')
const noTrust = await win.evaluate(async (input) => {
  const r = await window.mailharbor.accounts.test({ ...input, allowSelfSigned: false })
  return r.lines.map((l) => [l.protocol, l.ok, l.errorCode ?? ''])
}, baseInput())
ok('关掉「允许自签名」→ IMAP 报证书错误', noTrust[0][1] === false && String(noTrust[0][2]).includes('TLS'), JSON.stringify(noTrust[0]))
const withTrust = await win.evaluate(async (input) => {
  const r = await window.mailharbor.accounts.test(input)
  return r.lines.map((l) => [l.protocol, l.ok, l.errorCode ?? ''])
}, baseInput())
ok('打开「允许自签名」→ IMAP 通过', withTrust[0][1] === true, JSON.stringify(withTrust[0]))
ok('打开「允许自签名」→ SMTP 通过', withTrust[1][1] === true, JSON.stringify(withTrust[1]))

console.log('2) STARTTLS（自建服务器常见 143/587）')
const starttls = await win.evaluate(async (input) => {
  const r = await window.mailharbor.accounts.test(input)
  return r.lines.map((l) => [l.protocol, l.ok, l.errorCode ?? ''])
}, baseInput({
  imapSecure: 'starttls', imapPort: TLS_MOCK.imapStarttls.port,
  smtpSecure: 'starttls', smtpPort: TLS_MOCK.smtpStarttls.port
}))
ok('IMAP STARTTLS 通过', starttls[0][1] === true, JSON.stringify(starttls[0]))
ok('SMTP STARTTLS 通过', starttls[1][1] === true, JSON.stringify(starttls[1]))

console.log('3) 错误密码要给人话')
const badPass = await win.evaluate(async (input) => {
  const r = await window.mailharbor.accounts.test(input)
  return r.lines.map((l) => [l.protocol, l.ok, l.errorCode ?? '', l.message ?? ''])
}, baseInput({ password: 'wrong-password' }))
ok('IMAP 错误密码 → 认证失败', badPass[0][1] === false && /AUTH/.test(String(badPass[0][2])), JSON.stringify(badPass[0]))
ok('错误提示是中文可操作的建议', /密码|授权码|认证/.test(String(badPass[0][3])), String(badPass[0][3]).slice(0, 60))

console.log('4) 全链路：TLS 自建邮箱收信 → 落盘 → 回信')
const acc = await win.evaluate(async (input) => {
  const a = await window.mailharbor.accounts.create(input)
  const t = await window.mailharbor.accounts.testSaved(a.id)
  const rules = await window.mailharbor.rules.list().catch(() => [])
  // 用预置的「原图+卡套」规则，改到临时目录
  const seeded = rules.find((r) => r.keyword === '原图+卡套')
  const target = input.__out
  if (seeded) {
    await window.mailharbor.rules.update(seeded.id, {
      keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', priority: seeded.priority,
      fileTypes: ['zip', 'tif', 'tiff'], autoReply: true,
      targets: [{ path: target, required: true }]
    })
  } else {
    await window.mailharbor.rules.create({ keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact',
      fileTypes: ['zip', 'tif', 'tiff'], autoReply: true, targets: [{ path: target, required: true }] })
  }
  return { id: a.id, test: t.lines.map((l) => [l.protocol, l.ok]) }
}, { ...baseInput(), __out: OUT })
ok('账户保存后测试连接双绿', acc.test.every((l) => l[1] === true), JSON.stringify(acc.test))

await win.evaluate(() => window.mailharbor.checkNow())
const files = () => { try { return readdirSync(OUT) } catch { return [] } }
const end = Date.now() + 90000
while (Date.now() < end && files().length === 0) await win.waitForTimeout(2000)
ok('TLS 邮箱收到的附件已落盘', files().includes('TLS_TEST.zip'), JSON.stringify(files()))
await win.waitForTimeout(12000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
const row = recs.rows.find((r) => r.subject?.includes('TLS'))
ok('记录状态 done', row?.status === 'done', row?.status)
ok('TLS 自建邮箱回信成功', row?.replyStatus === 'sent', row?.replyStatus)
ok('SMTP(SSL) 收到了回信', TLS_MOCK.sent.length >= 1, String(TLS_MOCK.sent.length))

console.log('5) 纯 HTML 正文也要能命中关键词')
const bodyRule = await win.evaluate(async (out) => {
  const r = await window.mailharbor.rules.create({
    keyword: '卫衣', enabled: true, scope: 'subject_body', mode: 'contains', priority: 50,
    fileTypes: ['png'], autoReply: true, targets: [{ path: out, required: true }]
  })
  return r.id
}, OUT)
ok('正文匹配规则已创建', typeof bodyRule === 'number')

// 用 IMAP 追加一封「只有 HTML 正文」的邮件
const imap = new ImapFlow({
  host: TLS_MOCK.imapSsl.host, port: TLS_MOCK.imapSsl.port, secure: true,
  tls: { rejectUnauthorized: false }, auth: { user: U, pass: P }, logger: false
})
await imap.connect()
const b = '----HTMLONLY'
const raw = [
  `From: "Html Sender" <html@inkpressed.co>`, `To: ${U}`,
  `Subject: =?UTF-8?B?${Buffer.from('本周新品', 'utf8').toString('base64')}?=`,
  `Date: ${new Date().toUTCString()}`, `Message-ID: <html-${Date.now()}@mailharbor.test>`,
  'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
  `--${b}`, 'Content-Type: text/html; charset=utf-8', '',
  '<html><body><p>附件是这周的<b>卫衣</b>设计稿，请查收。</p></body></html>', '',
  `--${b}`, 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="HTML_卫衣.png"', '',
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(256, 5)]).toString('base64'), '',
  `--${b}--`, ''
].join('\r\n')
await imap.append('INBOX', Buffer.from(raw, 'utf8'), ['\\Seen'], new Date())
await imap.logout()
await win.evaluate(() => window.mailharbor.checkNow())
const end2 = Date.now() + 60000
while (Date.now() < end2 && !files().includes('HTML_卫衣.png')) await win.waitForTimeout(2000)
ok('HTML 正文命中 → 附件落盘', files().includes('HTML_卫衣.png'), JSON.stringify(files()))

console.log('6) 仅发件账户（阿里云 DirectMail 这类）+ 用它回信')
const sendOnly = await win.evaluate(async () => {
  // 用一个"只有 SMTP"的账户（IMAP 留空），SMTP 指向 mock 的 SSL 端口
  const a = await window.mailharbor.accounts.create({
    preset: 'custom', email: 'noreply@moneyfly.top', displayName: '通知发件箱',
    imapHost: '', imapPort: 993, imapSecure: 'ssl', imapUser: '',
    smtpHost: '127.0.0.1', smtpPort: 2465, smtpSecure: 'ssl', smtpUser: 'demo@mailharbor.test',
    smtpFromName: 'MoneyFly 通知', smtpSameAsImap: true, sendOnly: true,
    allowSelfSigned: true, password: 'demo-pass'
  })
  const t = await window.mailharbor.accounts.testSaved(a.id)
  // 把回信账户切到它
  const s = await window.mailharbor.settings.get()
  await window.mailharbor.settings.save({ ...s, replyAccountId: a.id })
  return { id: a.id, sendOnly: a.sendOnly, imapOk: t.lines.find((l) => l.protocol === 'imap')?.ok, smtpOk: t.lines.find((l) => l.protocol === 'smtp')?.ok }
})
ok('仅发件账户已保存（sendOnly=true）', sendOnly.sendOnly === true)
ok('仅发件账户跳过收件测试（IMAP 行标为跳过）', sendOnly.imapOk === true)
ok('仅发件账户 SMTP 登录成功', sendOnly.smtpOk === true)

// 再造一封邮件，验证回信从「仅发件账户」发出
const imap2 = new ImapFlow({ host: TLS_MOCK.imapSsl.host, port: TLS_MOCK.imapSsl.port, secure: true, tls: { rejectUnauthorized: false }, auth: { user: U, pass: P }, logger: false })
await imap2.connect()
const b2 = '----SENDONLY'
const rawS = [
  `From: "SendOnly Test" <so@inkpressed.co>`, `To: ${U}`,
  `Subject: =?UTF-8?B?${Buffer.from('原图+卡套 仅发件回信测试', 'utf8').toString('base64')}?=`,
  `Date: ${new Date().toUTCString()}`, `Message-ID: <so-${Date.now()}@mailharbor.test>`,
  'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b2}"`, '',
  `--${b2}`, 'Content-Type: text/plain; charset=utf-8', '', '仅发件回信测试', '',
  `--${b2}`, 'Content-Type: application/zip', 'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="SENDONLY.zip"', '',
  Buffer.from('PK\u0003\u0004so').toString('base64'), '',
  `--${b2}--`, ''
].join('\r\n')
await imap2.append('INBOX', Buffer.from(rawS, 'utf8'), ['\Seen'], new Date())
await imap2.logout()
await win.evaluate(() => window.mailharbor.checkNow())
await win.waitForTimeout(15000)
const recs2 = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
const soRow = recs2.rows.find((r) => r.subject?.includes('仅发件回信测试'))
ok('仅发件回信任务已回信', soRow?.replyStatus === 'sent', soRow?.replyStatus)
const lastSent = TLS_MOCK.sent[TLS_MOCK.sent.length - 1] ?? ''
ok('回信发自「仅发件账户」（From 是 noreply@moneyfly.top）', lastSent.includes('noreply@moneyfly.top'), lastSent.slice(0, 200).replace(/\r?\n/g, ' '))

await app.close()
await servers.close()
console.log(`\n多邮箱兼容性测试: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
