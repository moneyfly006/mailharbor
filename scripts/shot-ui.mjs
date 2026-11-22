import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
await page.goto('http://127.0.0.1:8917/index.html', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const out = '/Users/apple/Projects/mail-harbor/design/exports/app'
mkdirSync(out, { recursive: true })
await page.screenshot({ path: out + '/00-shell.png' })
const navs = ['概览', '触发规则', '邮箱账户', '自动回复', '下载记录']
for (const [i, name] of navs.entries()) {
  try {
    await page.getByText(name, { exact: false }).first().click({ timeout: 4000 })
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${name}.png` })
    const txt = await page.locator('body').innerText()
    console.log(`  ✓ ${name} (${txt.length} chars)`)
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`)
  }
}
console.log('errors:', errs.slice(0, 5))
await browser.close()
