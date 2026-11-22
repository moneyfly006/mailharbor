import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
await p.goto('http://127.0.0.1:8921/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.getByText('邮箱账户').first().click()
await p.waitForTimeout(1200)
const info = await p.evaluate(() => {
  const input = [...document.querySelectorAll('input')].find((i) => i.value.includes('smtp.gmail.com'))
  if (!input) return 'no input'
  const out = []
  let el = input
  for (let i = 0; i < 5 && el; i++) {
    const cs = getComputedStyle(el)
    out.push({
      tag: el.tagName, cls: el.className?.toString().slice(0, 60),
      border: cs.borderWidth, borderColor: cs.borderColor,
      shadow: cs.boxShadow === 'none' ? '-' : cs.boxShadow.slice(0, 60),
      outline: cs.outlineWidth + ' ' + cs.outlineColor,
      bg: cs.backgroundColor
    })
    el = el.parentElement
  }
  return out
})
console.log(JSON.stringify(info, null, 1))
// 顺便看 Records 搜索框
await p.getByText('下载记录').first().click()
await p.waitForTimeout(1000)
const s = await p.evaluate(() => {
  const input = document.querySelector('.f-search input, .f-search-el')
  if (!input) return 'no search'
  const out = []; let el = input
  for (let i = 0; i < 4 && el; i++) { const cs = getComputedStyle(el); out.push({ tag: el.tagName, cls: el.className?.toString().slice(0,40), border: cs.borderWidth, shadow: cs.boxShadow.slice(0,40) }); el = el.parentElement }
  return out
})
console.log('SEARCH:', JSON.stringify(s, null, 1))
await b.close()
