/**
 * 真实 Gmail 端到端：自己给自己发一封「原图+卡套」邮件 → 看软件是否检测、落盘到 2 个路径、回信
 * 密码从 MH_GMAIL_PASS 读取，不落盘。
 */
import { _electron as electron } from 'playwright'
import nodemailer from 'nodemailer'
import { readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-gmail'
const USER = 'moneyflysubssr@gmail.com'
const PASS = process.env.MH_GMAIL_PASS
const PROD = '/Users/apple/POD/生产/卡套'
const BACKUP = '/Users/apple/POD/备份/卡套'
const STAMP = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)

// 清空目标目录（只删本次测试前的临时内容；保留用户其它文件）
for (const d of [PROD, BACKUP]) {
  rmSync(d, { recursive: true, force: true })
  execSync(`mkdir -p "${d}"`)
}

// 1) 准备附件
const zipPath = '/tmp/MH_SELF_TEST.zip'
execSync(`cd /tmp && rm -rf mhzip && mkdir mhzip && printf 'MailHarbor self test\\n' > mhzip/readme.txt && cd mhzip && zip -q ${zipPath} readme.txt`)
console.log('附件:', zipPath, statSync(zipPath).size, 'bytes')

// 2) 自己给自己发
const subject = `原图+卡套 追加: SELF_TEST_${STAMP}`
const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: USER, pass: PASS } })
await transport.sendMail({
  from: `"MoneyFly POD" <${USER}>`,
  to: USER,
  subject,
  text: `这是 MailHarbor 自动归档测试邮件（${STAMP}）。\n附件应被复制到 生产/卡套 与 备份/卡套 两个文件夹。`,
  attachments: [{ filename: 'MH_SELF_TEST.zip', path: zipPath }]
})
transport.close()
console.log('已发送测试邮件，主题:', subject)

// 3) 启动软件，等它收信
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({
  executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`],
  env
})
const win = await app.firstWindow()
app.process().stdout?.on('data', (d) => { const s = String(d); if (/命中|落盘|未命中|回信|检测|IDLE/.test(s)) process.stdout.write('  [app] ' + s) })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const waitFor = async (fn, timeoutMs = 150000, step = 3000) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await win.waitForTimeout(step)
  }
  return false
}
console.log('\n等待软件检测到新邮件并落盘（最多 150 秒）…')
const filesIn = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.zip')) } catch { return [] } }
const ok = await waitFor(() => filesIn(PROD).length > 0 && filesIn(BACKUP).length > 0)
const prodFiles = filesIn(PROD)
const backupFiles = filesIn(BACKUP)
console.log('生产目录:', prodFiles)
console.log('备份目录:', backupFiles)

// 4) 查记录与回信状态
await win.waitForTimeout(3000)
const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
const row = records.rows.find((r) => r.subject?.includes('SELF_TEST'))
console.log('\n记录行:', row ? JSON.stringify({ subject: row.subject, kw: row.matchedKeyword, status: row.status, reply: row.replyStatus, deliveries: row.attachments?.[0]?.deliveries?.map((d) => [d.targetPath, d.state]) }) : '未找到')

await win.screenshot({ path: '/Users/apple/Projects/mail-harbor/design/exports/app/06-真实Gmail测试.png' })
await app.close()

let pass = 0, fail = 0
const check = (n, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${extra}`)) }
console.log('\n结果:')
check('软件检测到邮件并落盘（生产目录）', prodFiles.length > 0)
check('同一份文件复制到备份路径', backupFiles.length > 0)
check('两个路径文件名一致', prodFiles[0] === backupFiles[0], `${prodFiles[0]} vs ${backupFiles[0]}`)
check('记录命中关键词=原图+卡套', row?.matchedKeyword === '原图+卡套')
check('邮件状态=已完成', row?.status === 'done')
check('两条投递都成功', row?.attachments?.[0]?.deliveries?.every((d) => d.state === 'done'))
check('已自动回信', row?.replyStatus === 'sent')
console.log(`\n真实 Gmail E2E: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
