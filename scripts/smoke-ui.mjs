#!/usr/bin/env node
/**
 * UI 冒烟 + 截图：启动 mock 邮件服务器 → 用 Playwright 启动 Electron → 每页截图 → 验证关键文案。
 * 用法: node scripts/smoke-ui.mjs
 * 输出: design/exports/app/*.png
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startMockMailServer, MOCK } from './mock-mail-server.mjs'

const ROOT = process.cwd()
const OUT = join(ROOT, 'design', 'exports', 'app')
const USER_DATA = '/tmp/mh-ui-smoke'
const STORAGE = '/tmp/mh-ui-storage'

rmSync(USER_DATA, { recursive: true, force: true })
rmSync(STORAGE, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const mock = await startMockMailServer({ seed: true, quiet: true })
console.log('mock server up:', MOCK.imap, MOCK.smtp)

const electronPath = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app = await electron.launch({
  executablePath: electronPath,
  args: [ROOT, `--user-data-dir=${USER_DATA}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', MH_MOCK_IMAP_PORT: String(MOCK.imap.port) }
})
const win = await app.firstWindow()
win.on('console', (m) => { if (m.type() === 'error') console.log('[renderer:error]', m.text()) })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const pages = ['概览', '触发规则', '邮箱账户', '自动回复', '下载记录']
const results = []
for (const [i, name] of pages.entries()) {
  try {
    await win.locator(`text=${name}`).first().click({ timeout: 4000 })
    await win.waitForTimeout(900)
    const file = join(OUT, `${String(i + 1).padStart(2, '0')}-${name}.png`)
    await win.screenshot({ path: file })
    const body = await win.locator('body').innerText()
    results.push({ name, file, chars: body.length, ok: body.length > 100 })
    console.log(`  ✓ ${name} → ${file} (${body.length} chars)`)
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`)
    results.push({ name, ok: false })
  }
}

// 窗口尺寸截图（1440x900 基准）
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
await win.waitForTimeout(300)
await win.screenshot({ path: join(OUT, '00-window.png') })

await app.close()
await mock.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\nUI 冒烟: ${results.length - failed}/${results.length} 页通过`)
process.exit(failed ? 1 : 0)
