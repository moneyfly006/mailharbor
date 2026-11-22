import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const OUT = '/Users/apple/Projects/mail-harbor/docs/assets/manual'
mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
await p.goto('http://127.0.0.1:8941/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
const shot = async (name) => { await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
await shot('01-dashboard')
await p.getByText('邮箱账户').first().click(); await p.waitForTimeout(1200); await shot('02-accounts')
// 展开网络代理
await p.getByText('网络代理').first().click().catch(() => {}); await p.waitForTimeout(700); await shot('03-proxy')
await p.getByText('触发规则').first().click(); await p.waitForTimeout(1200); await shot('04-rules')
await p.getByText('自动回复').first().click(); await p.waitForTimeout(1200); await shot('05-autoreply')
await p.getByText('下载记录').first().click(); await p.waitForTimeout(1200); await shot('06-records')
await b.close()
