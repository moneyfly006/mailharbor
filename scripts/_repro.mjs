import { _electron as electron } from 'playwright'
import { startMockMailServer, MOCK } from '/Users/apple/Projects/mail-harbor/scripts/mock-mail-server.mjs'
import { rmSync, mkdirSync } from 'node:fs'
const ROOT = '/Users/apple/Projects/mail-harbor'
rmSync('/tmp/mh-repro', { recursive: true, force: true }); rmSync('/tmp/mh-repro-p', { recursive: true, force: true }); rmSync('/tmp/mh-repro-b', { recursive: true, force: true })
mkdirSync('/tmp/mh-repro-p', { recursive: true }); mkdirSync('/tmp/mh-repro-b', { recursive: true })
const mock = await startMockMailServer({ seed: true, quiet: true })
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({ executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [ROOT, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/mh-repro'], env })
app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d))
app.process().stderr?.on('data', (d) => process.stdout.write('[main:err] ' + d))
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.evaluate(async ({ p, b }) => {
  const acc = await window.mailharbor.accounts.create({ preset: 'custom', email: 'demo@mailharbor.test', displayName: '', imapHost: '127.0.0.1', imapPort: 1143, imapSecure: 'none', imapUser: 'demo@mailharbor.test', smtpHost: '127.0.0.1', smtpPort: 2525, smtpSecure: 'none', smtpUser: 'demo@mailharbor.test', smtpFromName: 'MH', smtpSameAsImap: true, password: 'demo-pass' })
  window.__acc = acc.id
}, { p: '/tmp/mh-repro-p', b: '/tmp/mh-repro-b' })
await win.waitForTimeout(6000)   // 先让邮件以"未命中"入库
const before = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
console.log('BEFORE RULE:', JSON.stringify(before.rows.map((r) => [r.subject, r.status])))
await win.evaluate(async ({ p, b }) => {
  window.__r = await window.mailharbor.rules.create({ keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', fileTypes: ['zip','tif','tiff'], autoReply: true, targets: [{ path: p, required: true }, { path: b, required: true }] })
}, { p: '/tmp/mh-repro-p', b: '/tmp/mh-repro-b' })
await win.waitForTimeout(9000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
console.log('RECORDS:', JSON.stringify(recs.rows.map((r) => [r.subject, r.status, r.matchedKeyword])))
await app.close(); await mock.close()
