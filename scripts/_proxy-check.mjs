import { _electron as electron } from 'playwright'
const ROOT = '/Users/apple/Projects/mail-harbor'
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({ executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [ROOT, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/mh-proxy2'], env })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(2500)
for (const [mode, port] of [['socks5', 11089], ['system', 0], ['none', 0]]) {
  const r = await win.evaluate(async ({ m, p }) => window.mailharbor.settings.testProxy({ mode: m, host: '127.0.0.1', port: p }), { m: mode, p: port })
  console.log(`[${mode}]`, r.ok ? 'OK' : 'FAIL', r.latencyMs + 'ms', '|', r.message)
}
// 用 SOCKS5 代理保存设置，然后测连接
await win.evaluate(async () => {
  const s = await window.mailharbor.settings.get()
  await window.mailharbor.settings.save({ ...s, proxy: { mode: 'socks5', host: '127.0.0.1', port: 11089 } })
})
const test = await win.evaluate(async () => {
  const acc = await window.mailharbor.accounts.list()
  if (!acc.length) return { skip: true }
  return window.mailharbor.accounts.testSaved(acc[0].id)
})
console.log('经 SOCKS5 测试连接:', JSON.stringify(test === null ? null : (test.skip ? 'no-account' : test.lines.map((l) => [l.protocol, l.ok, l.message]))))
await app.close()
