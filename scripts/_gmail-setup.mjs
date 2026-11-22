/**
 * 用真实 Gmail 账号配置 MailHarbor（仅本机测试用，密码从环境变量读取，不落盘）
 * 1) 建账户 → 测试连接
 * 2) 把收信游标设到"当前最新" —— 避免把 7000+ 封历史邮件全扫一遍、误回旧邮件
 * 3) 建三条规则（手机壳 1 路径 / 卡套 2 路径 / 浴室垫 1 路径）
 */
import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { ImapFlow } from 'imapflow'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-gmail'
const USER = 'moneyflysubssr@gmail.com'
const PASS = process.env.MH_GMAIL_PASS
if (!PASS) { console.error('缺少 MH_GMAIL_PASS'); process.exit(1) }

const PATHS = {
  '原图+手机壳': ['/Users/apple/POD/生产/手机壳'],
  '原图+卡套': ['/Users/apple/POD/生产/卡套', '/Users/apple/POD/备份/卡套'],
  '原图+浴室垫': ['/Users/apple/POD/生产/浴室垫']
}
for (const list of Object.values(PATHS)) for (const p of list) mkdirSync(p, { recursive: true })

// 当前最新 UID（设置游标用）
const probe = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false })
await probe.connect()
const lock = await probe.getMailboxLock('INBOX')
const uidNext = Number(probe.mailbox.uidNext ?? 0)
lock.release()
await probe.logout()
console.log('Gmail INBOX uidNext =', uidNext, '→ 游标将设为', uidNext - 1)

rmSync(USER_DATA, { recursive: true, force: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'

const launch = () => electron.launch({
  executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`],
  env
})

// ---- 第一次：建账户 + 测连接 ----
let app = await launch()
let win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const created = await win.evaluate(async ({ user, pass }) => {
  const acc = await window.mailharbor.accounts.create({
    preset: 'gmail',
    email: user,
    displayName: 'MoneyFly 测试',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl',
    imapUser: user,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl',
    smtpUser: user, smtpFromName: 'MoneyFly POD',
    smtpSameAsImap: true,
    password: pass
  })
  const test = await window.mailharbor.accounts.testSaved(acc.id)
  return { id: acc.id, test }
}, { user: USER, pass: PASS })

console.log('账户 #' + created.id, 'IMAP:', created.test.lines.find((l) => l.protocol === 'imap')?.ok,
  'SMTP:', created.test.lines.find((l) => l.protocol === 'smtp')?.ok)
console.log('测试详情:', created.test.lines.map((l) => `${l.protocol} ${l.ok ? 'OK' : 'FAIL'} ${l.latencyMs}ms ${l.message ?? ''}`).join(' | '))
await app.close()

// ---- 设置游标为最新，避免扫历史 ----
const db = new DatabaseSync(`${USER_DATA}/mailharbor.db`)
db.prepare('UPDATE accounts SET last_uid=? WHERE id=?').run(uidNext - 1, created.id)
console.log('游标已设置:', db.prepare('SELECT id,email,last_uid,status FROM accounts').all())
db.close()

// ---- 第二次：建三条规则 ----
app = await launch()
win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const rules = await win.evaluate(async (paths) => {
  const out = []
  let priority = 10
  for (const [keyword, list] of Object.entries(paths)) {
    const rule = await window.mailharbor.rules.create({
      keyword, enabled: true, scope: 'subject', mode: 'exact', priority,
      fileTypes: ['zip', 'tif', 'tiff', 'jpg', 'png', 'pdf'], autoReply: true,
      targets: list.map((p) => ({ path: p, required: true }))
    })
    out.push({ keyword, id: rule.id, paths: rule.targets.length })
    priority += 10
  }
  const accounts = await window.mailharbor.accounts.list()
  return { out, accounts: accounts.map((a) => ({ id: a.id, email: a.email, status: a.status, lastUid: a.lastUid })) }
}, PATHS)

console.log('规则:', JSON.stringify(rules.out))
console.log('账户:', JSON.stringify(rules.accounts))
await app.close()
console.log('配置完成 ✅')
