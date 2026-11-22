import { chromium } from 'playwright'
const port = process.argv[2] ?? '8923'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.getByText('邮箱账户').first().click()
await p.waitForTimeout(1500)
await p.screenshot({ path: '/tmp/acct_fixed.png' })
// 聚焦一个输入框，看焦点态是否还有多层框
await p.locator('input').filter({ hasText: '' }).nth(2).click().catch(() => {})
await p.waitForTimeout(600)
await p.screenshot({ path: '/tmp/acct_focus.png' })
await b.close()
