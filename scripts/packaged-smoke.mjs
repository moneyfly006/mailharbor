import { _electron as electron } from 'playwright'
const EXE = '/Users/apple/Projects/mail-harbor/release/mac-arm64/Electron.app/Contents/MacOS/Electron'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'      // 模拟打包后没有 better-sqlite3
env.NO_SANDBOX = '1'
const app = await electron.launch({
  executablePath: EXE,
  args: ['/Users/apple/Projects/mail-harbor', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--user-data-dir=/tmp/mh-packaged'],
  env
})
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3500)
const text = await win.locator('body').innerText()
console.log('TITLE:', await win.title())
console.log('BODY chars:', text.length)
console.log('has 概览:', text.includes('概览'), '| has 触发规则:', text.includes('触发规则'), '| has 邮箱账户:', text.includes('邮箱账户'))
const info = await win.evaluate(async () => {
  try { return await window.mailharbor.appInfo() } catch (e) { return { error: String(e) } }
})
console.log('appInfo:', JSON.stringify(info))
const accounts = await win.evaluate(async () => { try { const a = await window.mailharbor.accounts.list(); return { count: a.length } } catch (e) { return { error: String(e) } } })
console.log('accounts:', JSON.stringify(accounts))
await win.screenshot({ path: '/tmp/packaged-smoke.png' })
await app.close()
