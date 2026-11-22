/**
 * 打包运行时端到端验证（node:sqlite 路径，等价于 Windows 安装包里的运行环境）
 * 起 mock IMAP/SMTP → 启动 Electron（禁 better-sqlite3）→ 建账户/规则 → 收信 → 多路径落盘 → 回信
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { startMockMailServer, MOCK } from './mock-mail-server.mjs'

const ROOT = '/Users/apple/Projects/mail-harbor'
const USER_DATA = '/tmp/mh-e2e-packaged'
const PROD = '/tmp/mh-e2e-prod'
const BACKUP = '/tmp/mh-e2e-backup'
for (const d of [USER_DATA, PROD, BACKUP]) rmSync(d, { recursive: true, force: true })
mkdirSync(PROD, { recursive: true }); mkdirSync(BACKUP, { recursive: true })

const mock = await startMockMailServer({ seed: true, quiet: true })
let pass = 0, fail = 0
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}\n    got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [ROOT, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + USER_DATA],
  env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)

// 直接走真实 IPC（等价于用户点界面后的调用）：建账户 + 建规则
const created = await win.evaluate(async ({ p, b }) => {
  const acc = await window.mailharbor.accounts.create({
    preset: 'custom', email: 'demo@mailharbor.test', displayName: 'E2E',
    imapHost: '127.0.0.1', imapPort: 1143, imapSecure: 'none', imapUser: 'demo@mailharbor.test',
    smtpHost: '127.0.0.1', smtpPort: 2525, smtpSecure: 'none', smtpUser: 'demo@mailharbor.test',
    smtpFromName: 'MailHarbor E2E', smtpSameAsImap: true, password: 'demo-pass'
  })
  const test = await window.mailharbor.accounts.testSaved(acc.id)
  const rule = await window.mailharbor.rules.create({
    keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact',
    fileTypes: ['zip', 'tif', 'tiff'], autoReply: true,
    targets: [{ path: p, required: true }, { path: b, required: true }]
  })
  return { acc, test, rule }
}, { p: PROD, b: BACKUP })

eq('账户已创建', !!created.acc.id, true)
eq('IMAP 测试通过', created.test.lines.find((l) => l.protocol === 'imap')?.ok, true)
eq('SMTP 测试通过', created.test.lines.find((l) => l.protocol === 'smtp')?.ok, true)
eq('规则两个路径', created.rule.targets.length, 2)
const rulesNow = await win.evaluate(() => window.mailharbor.rules.list())
console.log('DEBUG rules:', JSON.stringify(rulesNow.map((r) => ({ kw: r.keyword, en: r.enabled, mode: r.mode, t: r.targets.length }))))
eq('测试后账户状态=已启用', await win.evaluate(async (id) => (await window.mailharbor.accounts.list()).find((a) => a.id === id)?.status, created.acc.id), 'enabled')

// 触发一次检查；落盘/回信可能是异步的，轮询等待
async function waitFor(fn, timeoutMs = 40000, stepMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* ignore */ }
    await win.waitForTimeout(stepMs)
  }
  return false
}

await win.evaluate(() => window.mailharbor.checkNow())
await waitFor(() => readdirSync(PROD).length > 0 && readdirSync(BACKUP).length > 0)
const prodFiles = readdirSync(PROD)
const backupFiles = readdirSync(BACKUP)
eq('生产目录有文件', prodFiles.length >= 1, true)
eq('备份目录有文件', backupFiles.length >= 1, true)
eq('两目录文件名一致', prodFiles[0], backupFiles[0])
eq('附件内容是 zip', prodFiles[0] ? readFileSync(join(PROD, prodFiles[0])).subarray(0, 2).toString() === 'PK' : false, true)
await waitFor(() => MOCK.sent.length >= 1)
eq('SMTP 收到回信', MOCK.sent.length >= 1, true)
eq('回信含文件名', (MOCK.sent[0] ?? '').includes('POD_ORDER_20486'), true)

const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 20 }))
eq('记录已写入', records.total >= 1, true)
const hit = records.rows.find((r) => r.matchedKeyword === '原图+卡套')
eq('命中行状态 done', hit?.status, 'done')
eq('命中行两条投递', hit?.attachments?.[0]?.deliveries?.length, 2)
eq('两条投递都成功', hit?.attachments?.[0]?.deliveries?.every((d) => d.state === 'done'), true)
eq('回信状态 sent', hit?.replyStatus, 'sent')

await win.screenshot({ path: '/tmp/packaged-e2e.png' })
await app.close()
await mock.close()
console.log(`\n打包运行时 E2E: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
