#!/usr/bin/env node
/** 静态自检：src/ 下是否存在空目录/半成品文件、关键文件是否齐全、TODO 数量 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src/main', 'src/preload', 'src/renderer', 'src/shared']
const KEY = [
  'src/main/backend-impl.ts', 'src/main/repos.ts', 'src/main/providers/imap.ts',
  'src/main/scheduler.ts', 'src/main/pipeline.ts', 'src/main/dispatcher.ts',
  'src/renderer/main.tsx', 'src/renderer/App.tsx', 'src/renderer/pages/Rules.tsx',
  'src/renderer/pages/Accounts.tsx', 'src/renderer/pages/Records.tsx',
  'src/renderer/pages/Dashboard.tsx', 'src/renderer/pages/AutoReply.tsx'
]
let files = 0, lines = 0, todos = 0, empties = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (!['.ts', '.tsx', '.css'].includes(extname(p))) continue
    files++
    const src = readFileSync(p, 'utf8')
    const n = src.split('\n').length
    lines += n
    if (n < 3) empties.push(p)
    todos += (src.match(/TODO|FIXME|待实现/g) || []).length
  }
}
for (const r of ROOTS) { try { walk(r) } catch {} }
console.log(`源码文件: ${files} 个，共 ${lines} 行，TODO/FIXME: ${todos} 处`)
if (empties.length) console.log('空/半成品文件:', empties.join(', '))
const missing = KEY.filter((f) => { try { statSync(f); return false } catch { return true } })
console.log('关键文件缺失:', missing.length ? missing.join(', ') : '无')
