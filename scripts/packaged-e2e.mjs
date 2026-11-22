/**
 * 打包运行时端到端验证（node:sqlite 路径，等价于安装包内的运行环境）。
 * 不依赖真实邮箱：脚本内置 mock IMAP/SMTP。
 *
 * 用法（需先 pnpm exec electron-vite build）：
 *   node scripts/packaged-e2e.mjs
 * 可选环境变量：MH_ELECTRON_BIN 指定 Electron 可执行文件（默认取本地 node_modules）
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startMockMailServer, MOCK } from './mock-mail-server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(tmpdir(), 'mh-e2e-packaged')
const USER_DATA = join(BASE, 'user-data')
const PROD = join(BASE, 'prod')
const BACKUP = join(BASE, 'backup')

for (const d of [USER_DATA, PROD, BACKUP]) rmSync(d, { recursive: true, force: true })
mkdirSync(PROD, { recursive: true })
mkdirSync(BACKUP, { recursive: true })

const electronBin =
  process.env.MH_ELECTRON_BIN ??
  (process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron.exe'))

const mock = await startMockMailServer({ seed: true, quiet: true })
let pass = 0
let fail = 0
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}\n    got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1' // 模拟打包环境（无 better-sqlite3）

const app = await electron.launch({
  executablePath: electronBin,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`],
  env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)

const created = await win.evaluate(async ({ p, b }) => {
  const acc = await window.mailharbor.accounts.create({
    preset: 'custom', email: 'demo@mailharbor.test', displayName: 'E2E',
    imapHost: '127.0.0.1', imapPort: 1143, imapSecure: 'none', imapUser: 'demo@mailharbor.test',
    smtpHost: '127.0.0.1', smtpPort: 2525, smtpSecure: 'none', smtpUser: 'demo@mailharbor.test',
    smtpFromName: 'MailHarbor E2E', smtpSameAsImap: true, password: 'demo-pass'
  })
  const test = await window.mailharbor.accounts.testSaved(acc.id)
  const rules = await window.mailharbor.rules.list()
  const seeded = rules.find((r) => r.keyword === '原图+卡套')
  // 首次启动会预置「原图+卡套」规则，这里把它的目标路径改到临时目录再测
  const rule = seeded
    ? await window.mailharbor.rules.update(seeded.id, {
        keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact',
        priority: seeded.priority, fileTypes: ['zip', 'tif', 'tiff'], autoReply: true,
        targets: [{ path: p, required: true }, { path: b, required: true }]
      })
    : await window.mailharbor.rules.create({
        keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact',
        fileTypes: ['zip', 'tif', 'tiff'], autoReply: true,
        targets: [{ path: p, required: true }, { path: b, required: true }]
      })
  return { acc, test, rule, rules }
}, { p: PROD, b: BACKUP })

eq('账户已创建', !!created.acc.id, true)
eq('IMAP 测试通过', created.test.lines.find((l) => l.protocol === 'imap')?.ok, true)
eq('SMTP 测试通过', created.test.lines.find((l) => l.protocol === 'smtp')?.ok, true)
eq('首次启动预置了默认标题规则', created.rules.length >= 3, true)
eq('账户状态=已启用', await win.evaluate(async (id) => (await window.mailharbor.accounts.list()).find((a) => a.id === id)?.status, created.acc.id), 'enabled')

await win.evaluate(() => window.mailharbor.checkNow())
const filesIn = (d) => { try { return readdirSync(d) } catch { return [] } }
const end = Date.now() + 60000
while (Date.now() < end && (filesIn(PROD).length === 0 || filesIn(BACKUP).length === 0)) await win.waitForTimeout(2000)

eq('生产目录有文件', filesIn(PROD).length >= 1, true)
eq('备份目录有文件', filesIn(BACKUP).length >= 1, true)
eq('两目录文件名一致', filesIn(PROD)[0], filesIn(BACKUP)[0])
eq('附件是 ZIP', filesIn(PROD)[0] ? readFileSync(join(PROD, filesIn(PROD)[0])).subarray(0, 2).toString() === 'PK' : false, true)

const end2 = Date.now() + 30000
while (Date.now() < end2 && MOCK.sent.length === 0) await win.waitForTimeout(2000)
eq('SMTP 收到回信', MOCK.sent.length >= 1, true)
eq('回信里带上了对应文件名', MOCK.sent.some((m) => m.includes('POD_ORDER_20486')), true)

const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 20 }))
const hit = records.rows.find((r) => r.matchedKeyword === '原图+卡套')
eq('记录状态 done', hit?.status, 'done')
eq('两条投递都成功', hit?.attachments?.[0]?.deliveries?.every((d) => d.state === 'done'), true)
eq('回信状态 sent', hit?.replyStatus, 'sent')

await app.close()
await mock.close()
console.log(`\n打包运行时 E2E: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
