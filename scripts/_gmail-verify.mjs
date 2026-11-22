/** 复用 /tmp/mh-gmail 配置，启动软件等它把 UID 8164 那封测试邮件处理掉 */
import { _electron as electron } from 'playwright'
import { readdirSync, rmSync } from 'node:fs'
const ROOT = '/Users/apple/Projects/mail-harbor'
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const PROD = '/Users/apple/POD/生产/卡套'
const BACKUP = '/Users/apple/POD/备份/卡套'
const app = await electron.launch({ executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [ROOT, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/mh-gmail'], env })
app.process().stdout?.on('data', (d) => { const s = String(d); if (/命中|落盘|未命中|回信|IDLE|IMAP/.test(s)) process.stdout.write('[app] ' + s) })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
const files = (d) => { try { return readdirSync(d) } catch { return [] } }
const waitFor = async (fn, t = 90000, step = 2500) => { const end = Date.now() + t; while (Date.now() < end) { if (await fn()) return true; await win.waitForTimeout(step) } return false }
console.log('等待处理…')
await waitFor(() => files(PROD).length > 0 && files(BACKUP).length > 0)
console.log('生产:', files(PROD), '备份:', files(BACKUP))
await win.waitForTimeout(12000)   // 等回信延迟 10s
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
console.log('记录:', JSON.stringify(recs.rows.map((r) => ({ s: r.subject?.slice(0, 36), kw: r.matchedKeyword, st: r.status, rp: r.replyStatus, dl: r.attachments?.[0]?.deliveries?.map((d) => d.state) }))))
await win.screenshot({ path: '/Users/apple/Projects/mail-harbor/design/exports/app/06-真实Gmail测试.png' })
await app.close()
