/**
 * 真实 Gmail 确定性测试：用 IMAP APPEND 造一封"客户邮件"（不依赖邮件投递延迟），
 * 验证软件检测 → 双路径落盘 → SMTP 回信。
 */
import { _electron as electron } from 'playwright'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { readdirSync, rmSync, mkdirSync, readFileSync } from 'node:fs'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-gmail-append'
const USER = 'moneyflysubssr@gmail.com', PASS = process.env.MH_GMAIL_PASS
const P = { prod: '/Users/apple/POD/生产/卡套', backup: '/Users/apple/POD/备份/卡套' }
for (const d of Object.values(P)) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
rmSync(USER_DATA, { recursive: true, force: true })

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({
  executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`], env
})
app.process().stdout?.on('data', (d) => { const s = String(d); if (/命中|落盘|未命中|回信|首次接入|失败|超时|WARN|ERROR/.test(s)) process.stdout.write('[app] ' + s) })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 1) 账户 + 规则
const acc = await win.evaluate(async ({ user, pass }) => {
  const a = await window.mailharbor.accounts.create({
    preset: 'gmail', email: user, displayName: 'MoneyFly 测试',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl', imapUser: user,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: user,
    smtpFromName: 'MoneyFly POD', smtpSameAsImap: true, password: pass
  })
  const t = await window.mailharbor.accounts.testSaved(a.id)
  await window.mailharbor.rules.create({ keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', priority: 10,
    fileTypes: ['zip','tif','tiff','jpg','png','pdf'], autoReply: true,
    targets: [{ path: '/Users/apple/POD/生产/卡套', required: true }, { path: '/Users/apple/POD/备份/卡套', required: true }] })
  return { id: a.id, lines: t.lines.map((l) => ({ p: l.protocol, ok: l.ok, msg: l.message })) }
}, { user: USER, pass: PASS })
console.log('账户:', acc.id, JSON.stringify(acc.lines))
await win.waitForTimeout(4000)   // 等首次接入设定游标

// 2) IMAP APPEND 一封"客户邮件"
const boundary = '----MH_' + Date.now()
const zip = readFileSync('/tmp/MH_SELF_TEST.zip')
const raw = [
  `From: "David Chen" <david.test@inkpressed.co>`,
  `To: ${USER}`,
  `Subject: =?UTF-8?B?${Buffer.from('原图+卡套 追加: APPEND_TEST_001', 'utf8').toString('base64')}?=`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <append-${Date.now()}@mailharbor.test>`,
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  '测试：请按附件图稿生产，交期 12 月 5 日。',
  '',
  `--${boundary}`,
  'Content-Type: application/zip',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="MH_APPEND_TEST.zip"',
  '',
  zip.toString('base64'),
  '',
  `--${boundary}--`,
  ''
].join('\r\n')
const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false })
await c.connect()
await c.append('INBOX', Buffer.from(raw, 'utf8'), ['\\Seen'], new Date())
console.log('已 APPEND 一封「原图+卡套」邮件到 INBOX')
await c.logout()

// 3) 等待处理
const files = (d) => { try { return readdirSync(d).filter((f) => /\.(zip|tif|tiff)$/i.test(f)) } catch { return [] } }
const waitFor = async (fn, t = 180000, step = 2500) => { const end = Date.now() + t; while (Date.now() < end) { if (await fn()) return true; await win.waitForTimeout(step) } return false }
const got = await waitFor(() => files(P.prod).length > 0 && files(P.backup).length > 0)
console.log('生产:', files(P.prod), '备份:', files(P.backup))
await win.waitForTimeout(15000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
const row = recs.rows.find((r) => r.subject?.includes('APPEND_TEST'))
console.log('记录:', row ? JSON.stringify({ kw: row.matchedKeyword, st: row.status, rp: row.replyStatus, dl: row.attachments?.[0]?.deliveries?.map((d) => [d.targetPath, d.state]) }) : '(无)')
await win.screenshot({ path: `${ROOT}/design/exports/app/06-真实Gmail测试.png` })
await app.close()

let pass = 0, fail = 0
const check = (n, c2, e = '') => { c2 ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)) }
console.log('\n结果:')
check('IMAP 经代理登录成功', acc.lines.find((l) => l.p === 'imap')?.ok)
check('SMTP 登录成功', acc.lines.find((l) => l.p === 'smtp')?.ok)
check('检测到新邮件', got)
check('生产路径落盘', files(P.prod).length > 0)
check('备份路径落盘（同一文件复制）', files(P.backup).length > 0)
check('两路径文件名一致', files(P.prod)[0] === files(P.backup)[0])
check('命中关键词', row?.matchedKeyword === '原图+卡套')
check('状态=已完成', row?.status === 'done')
check('两条投递都成功', row?.attachments?.[0]?.deliveries?.every((d) => d.state === 'done'))
check('已自动回信', row?.replyStatus === 'sent')
console.log(`\n真实 Gmail APPEND 测试: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
