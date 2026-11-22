/**
 * 真实 Gmail 全流程（单进程）：
 * 清空测试目录 → 启动软件 → 建账户（自动从最新开始收）→ 三条规则 → 自测连接
 * → 自己给自己发「原图+卡套」带 ZIP → 等检测/落盘/回信 → 断言
 */
import { _electron as electron } from 'playwright'
import nodemailer from 'nodemailer'
import { readdirSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-gmail4'
const USER = 'moneyflysubssr@gmail.com'
const PASS = process.env.MH_GMAIL_PASS
const PATHS = {
  '原图+手机壳': ['/Users/apple/POD/生产/手机壳'],
  '原图+卡套': ['/Users/apple/POD/生产/卡套', '/Users/apple/POD/备份/卡套'],
  '原图+浴室垫': ['/Users/apple/POD/生产/浴室垫']
}
for (const list of Object.values(PATHS)) for (const p of list) { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }) }
rmSync(USER_DATA, { recursive: true, force: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({
  executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`],
  env
})
const win = await app.firstWindow()
app.process().stdout?.on('data', (d) => { const s = String(d); if (/首次接入|命中|落盘|未命中|回信|检测|搜索|search/.test(s)) process.stdout.write('[app] ' + s) })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

// 1) 账户
const acc = await win.evaluate(async ({ user, pass }) => {
  const a = await window.mailharbor.accounts.create({
    preset: 'gmail', email: user, displayName: 'MoneyFly 测试',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl', imapUser: user,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: user,
    smtpFromName: 'MoneyFly POD', smtpSameAsImap: true, password: pass
  })
  const t = await window.mailharbor.accounts.testSaved(a.id)
  return { id: a.id, test: t }
}, { user: USER, pass: PASS })
console.log('账户 #' + acc.id, 'IMAP', acc.test.lines[0]?.ok, 'SMTP', acc.test.lines[1]?.ok)

// 2) 规则
const rules = await win.evaluate(async (paths) => {
  const out = []; let pri = 10
  for (const [kw, list] of Object.entries(paths)) {
    const r = await window.mailharbor.rules.create({
      keyword: kw, enabled: true, scope: 'subject', mode: 'exact', priority: pri,
      fileTypes: ['zip','tif','tiff','jpg','png','pdf'], autoReply: true,
      targets: list.map((p) => ({ path: p, required: true }))
    })
    out.push([r.keyword, r.targets.length]); pri += 10
  }
  return out
}, PATHS)
console.log('规则:', JSON.stringify(rules))

// 3) 发测试邮件
execSync(`cd /tmp && rm -rf mhzip && mkdir mhzip && printf 'MailHarbor self test\\n' > mhzip/readme.txt && rm -f MH_SELF_TEST.zip && cd mhzip && zip -q /tmp/MH_SELF_TEST.zip readme.txt`)
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const subject = `原图+卡套 追加: SELF_TEST_${stamp}`
const mailer = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: USER, pass: PASS } })
await mailer.sendMail({
  from: `"MoneyFly POD" <${USER}>`, to: USER, subject,
  text: `MailHarbor 自动化测试 ${stamp}`,
  attachments: [{ filename: 'MH_SELF_TEST.zip', path: '/tmp/MH_SELF_TEST.zip' }]
})
mailer.close()
console.log('已发送:', subject)

// 4) 等待
const filesIn = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.zip')) } catch { return [] } }
const waitFor = async (fn, t = 180000, step = 3000) => { const end = Date.now() + t; while (Date.now() < end) { if (await fn()) return true; await win.waitForTimeout(step) } return false }
const got = await waitFor(() => filesIn(PATHS['原图+卡套'][0]).length > 0 && filesIn(PATHS['原图+卡套'][1]).length > 0)
console.log('生产目录:', filesIn(PATHS['原图+卡套'][0]), '备份目录:', filesIn(PATHS['原图+卡套'][1]))
await win.waitForTimeout(14000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
const row = recs.rows.find((r) => r.subject?.includes('SELF_TEST'))
console.log('记录:', row ? JSON.stringify({ kw: row.matchedKeyword, st: row.status, rp: row.replyStatus, dl: row.attachments?.[0]?.deliveries?.map((d) => [d.targetPath, d.state]) }) : '(无)')
await win.screenshot({ path: `${ROOT}/design/exports/app/06-真实Gmail测试.png` })
await app.close()

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${e}`)) }
console.log('\n结果:')
check('IMAP 登录成功', acc.test.lines[0]?.ok)
check('SMTP 登录成功', acc.test.lines[1]?.ok)
check('三条规则：1/2/1 个路径', JSON.stringify(rules.map((r) => r[1])) === '[1,2,1]')
check('检测到新邮件并落盘（生产）', filesIn(PATHS['原图+卡套'][0]).length > 0)
check('同一文件复制到备份路径', filesIn(PATHS['原图+卡套'][1]).length > 0)
check('两路径文件名一致', filesIn(PATHS['原图+卡套'][0])[0] === filesIn(PATHS['原图+卡套'][1])[0])
check('命中关键词', row?.matchedKeyword === '原图+卡套')
check('状态=已完成', row?.status === 'done')
check('两条投递成功', row?.attachments?.[0]?.deliveries?.every((d) => d.state === 'done'))
check('已自动回信', row?.replyStatus === 'sent')
console.log(`\n真实 Gmail 全流程: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
