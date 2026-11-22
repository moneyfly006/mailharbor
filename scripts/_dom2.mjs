import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
await p.goto('http://127.0.0.1:8931/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(1000)
await p.getByText('下载记录').first().click(); await p.waitForTimeout(900)
await p.locator('input').first().click(); await p.waitForTimeout(400)
const info = await p.evaluate(() => {
  const input = document.activeElement
  const out = []
  let el = input
  for (let i = 0; i < 4 && el; i++) {
    const cs = getComputedStyle(el)
    out.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), border: cs.borderWidth + ' ' + cs.borderColor, outline: cs.outlineWidth + ' ' + cs.outlineColor, outlineOffset: cs.outlineOffset, shadow: cs.boxShadow.slice(0, 50) })
    el = el.parentElement
  }
  return out
})
console.log(JSON.stringify(info, null, 1))
await b.close()
