/**
 * 真实 Gmail 多场景测试（走 SOCKS5 代理）：
 *  1. 标题命中 + ZIP 附件 → 2 个路径
 *  2. 标题命中 + TIF 附件 → 1 个路径
 *  3. 标题不命中、正文命中（scope=标题+正文）+ PNG → 1 个路径
 *  4. 标题命中 + 3 个附件（ZIP/TIF/PDF）→ 2 个路径 × 3 份
 */
import { _electron as electron } from 'playwright'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-gmail-cases'
const USER = 'moneyflysubssr@gmail.com', PASS = process.env.MH_GMAIL_PASS
const PROXY = { mode: 'socks5', host: '127.0.0.1', port: 11089 }
const DIRS = {
  '原图+卡套': ['/Users/apple/POD/生产/卡套', '/Users/apple/POD/备份/卡套'],
  '原图+浴室垫': ['/Users/apple/POD/生产/浴室垫'],
  '卫衣': ['/Users/apple/POD/生产/卫衣'],
}
for (const list of Object.values(DIRS)) for (const d of list) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
rmSync(USER_DATA, { recursive: true, force: true })

// 附件素材
execSync('cd /tmp && rm -rf mhcase && mkdir mhcase && printf "zip content\\n" > mhcase/a.txt && rm -f case.zip case1.tif case2.png case3.pdf && cd mhcase && zip -q /tmp/case.zip a.txt')
writeFileSync('/tmp/case1.tif', Buffer.concat([Buffer.from('II*\0', 'binary'), Buffer.alloc(2048, 7)]))
writeFileSync('/tmp/case2.png', Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47]), Buffer.alloc(1024, 3)]))
writeFileSync('/tmp/case3.pdf', Buffer.from('%PDF-1.4\n% test artwork\n'))

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({ executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`], env })
app.process().stdout?.on('data', (d) => { const s = String(d); if (/命中|落盘|未命中|回信|代理/.test(s)) process.stdout.write('[app] ' + s) })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(2500)

// 1) 代理设置 + 账户 + 规则
await win.evaluate(async (proxy) => {
  const s = await window.mailharbor.settings.get()
  await window.mailharbor.settings.save({ ...s, proxy })
}, PROXY)
const setup = await win.evaluate(async ({ user, pass, dirs }) => {
  const a = await window.mailharbor.accounts.create({
    preset: 'gmail', email: user, displayName: 'MoneyFly',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl', imapUser: user,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: user,
    smtpFromName: 'MoneyFly POD', smtpSameAsImap: true, password: pass
  })
  const t = await window.mailharbor.accounts.testSaved(a.id)
  const rules = []
  let pri = 10
  for (const [kw, list] of Object.entries(dirs)) {
    const r = await window.mailharbor.rules.create({
      keyword: kw, enabled: true,
      scope: kw === '卫衣' ? 'subject_body' : 'subject',
      mode: kw === '卫衣' ? 'contains' : 'exact',
      priority: pri, fileTypes: ['zip','tif','tiff','png','pdf'], autoReply: true,
      targets: list.map((p) => ({ path: p, required: true }))
    })
    rules.push([r.keyword, r.scope, r.targets.length]); pri += 10
  }
  return { id: a.id, lines: t.lines.map((l) => [l.protocol, l.ok, l.message]), rules }
}, { user: USER, pass: PASS, dirs: DIRS })
console.log('账户/连接:', setup.id, JSON.stringify(setup.lines))
console.log('规则:', JSON.stringify(setup.rules))
await win.waitForTimeout(5000)

// 2) 造 4 封邮件并 APPEND
const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false })
await c.connect()
const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
function rawMail({ subject, body, attachments }) {
  const b = '----MH_' + Math.random().toString(36).slice(2)
  const parts = [
    `From: "David Chen" <david.test@inkpressed.co>`, `To: ${USER}`, `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <case-${Date.now()}-${Math.random().toString(36).slice(2)}@mailharbor.test>`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body, ''
  ]
  for (const a of attachments) {
    parts.push(`--${b}`, `Content-Type: ${a.type}; name="${a.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.name}"`, '', readFileSync(a.path).toString('base64'), '')
  }
  parts.push(`--${b}--`, '')
  return Buffer.from(parts.join('\r\n'), 'utf8')
}
const cases = [
  { name: '1-ZIP-标题命中', mail: rawMail({ subject: '原图+卡套 追加: CASE1', body: '第一批卡套图稿', attachments: [{ type: 'application/zip', name: 'CASE1_卡套.zip', path: '/tmp/case.zip' }] }) },
  { name: '2-TIF-标题命中', mail: rawMail({ subject: '原图+浴室垫 BATH-CASE2', body: '浴室垫图稿', attachments: [{ type: 'image/tiff', name: 'CASE2_浴室垫.tif', path: '/tmp/case1.tif' }] }) },
  { name: '3-正文命中-PNG', mail: rawMail({ subject: '本周新单请查收', body: '附件是这周的卫衣设计稿，请按图生产。', attachments: [{ type: 'image/png', name: 'CASE3_卫衣.png', path: '/tmp/case2.png' }] }) },
  { name: '4-多附件-标题命中', mail: rawMail({ subject: '原图+卡套 第二批: CASE4', body: '卡套第二批，含三种格式', attachments: [
      { type: 'application/zip', name: 'CASE4_卡套.zip', path: '/tmp/case.zip' },
      { type: 'image/tiff', name: 'CASE4_卡套.tif', path: '/tmp/case1.tif' },
      { type: 'application/pdf', name: 'CASE4_说明.pdf', path: '/tmp/case3.pdf' }] }) }
]
for (const cs of cases) {
  await c.append('INBOX', cs.mail, ['\\Seen'], new Date())
  console.log('已 APPEND:', cs.name)
}
await c.logout()

// 3) 等待全部落盘
const ls = (d) => { try { return readdirSync(d) } catch { return [] } }
const waitFor = async (fn, t = 240000, step = 3000) => { const end = Date.now() + t; while (Date.now() < end) { if (await fn()) return true; await win.waitForTimeout(step) } return false }
const allDone = () => ls(DIRS['原图+卡套'][0]).length >= 4 && ls(DIRS['原图+卡套'][1]).length >= 4 && ls(DIRS['原图+浴室垫'][0]).length >= 1 && ls(DIRS['卫衣'][0]).length >= 1
const ok = await waitFor(allDone)
await win.waitForTimeout(16000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 30 }))
const rows = recs.rows.filter((r) => r.subject?.includes('CASE') || r.subject?.includes('新单'))
console.log('\n记录:')
for (const r of rows) console.log('  -', r.subject?.slice(0, 34), '| kw=', r.matchedKeyword, '| st=', r.status, '| reply=', r.replyStatus,
  '| files=', r.attachments?.map((a) => `${a.filename}:${a.deliveries?.filter((d) => d.state === 'done').length}`).join(','))

await win.screenshot({ path: `${ROOT}/design/exports/app/06-真实Gmail测试.png` })
await app.close()

let pass = 0, fail = 0
const check = (n, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${extra}`)) }
console.log('\n结果:')
check('IMAP 经 SOCKS5 代理登录', setup.lines[0]?.[1] === true, JSON.stringify(setup.lines[0]))
check('SMTP 经代理登录', setup.lines[1]?.[1] === true, JSON.stringify(setup.lines[1]))
check('① ZIP 落到生产路径', ls(DIRS['原图+卡套'][0]).includes('CASE1_卡套.zip'))
check('① 同一 ZIP 复制到备份路径', ls(DIRS['原图+卡套'][1]).includes('CASE1_卡套.zip'))
check('② TIF 落到浴室垫路径', ls(DIRS['原图+浴室垫'][0]).includes('CASE2_浴室垫.tif'))
check('③ 正文命中 → 卫衣 PNG 落盘', ls(DIRS['卫衣'][0]).includes('CASE3_卫衣.png'))
check('④ 多附件：ZIP 落 2 路径', ls(DIRS['原图+卡套'][0]).includes('CASE4_卡套.zip') && ls(DIRS['原图+卡套'][1]).includes('CASE4_卡套.zip'))
check('④ 多附件：TIF 落 2 路径', ls(DIRS['原图+卡套'][0]).includes('CASE4_卡套.tif') && ls(DIRS['原图+卡套'][1]).includes('CASE4_卡套.tif'))
check('④ 多附件：PDF 落 2 路径', ls(DIRS['原图+卡套'][0]).includes('CASE4_说明.pdf') && ls(DIRS['原图+卡套'][1]).includes('CASE4_说明.pdf'))
check('四条记录都已完成', rows.filter((r) => r.status === 'done').length >= 4, String(rows.length))
check('四条记录都已回信', rows.filter((r) => r.replyStatus === 'sent').length >= 4)
console.log(`\n真实 Gmail 多场景: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
