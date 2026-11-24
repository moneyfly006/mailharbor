/**
 * Gmail 附件流式解码单测：把 {"data":"<base64url>"} 按随机分块喂进去，
 * 校验解码后的文件与原始二进制完全一致（sha256 相等）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { writeGmailBase64JsonToFile } from '../src/main/gmail/client.ts'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`)
  }
}
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

async function runCase(name: string, payload: Buffer, chunkSize: number, withPadding: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-stream-'))
  const dest = join(dir, 'out.bin')
  const b64 = withPadding ? payload.toString('base64url') : payload.toString('base64url').replace(/=+$/, '')
  const json = withPadding
    ? JSON.stringify({ data: b64, size: payload.length })
    : // 模拟真实 Gmail 的格式化 JSON（冒号后空格、换行）
      `{\n  "size": ${payload.length},\n  "data": "${b64}"\n}`
  const chunks: string[] = []
  for (let i = 0; i < json.length; i += chunkSize) chunks.push(json.slice(i, i + chunkSize))
  const src = Readable.from(chunks.map((c) => Buffer.from(c, 'ascii')))
  const r = await writeGmailBase64JsonToFile(src, dest, payload.length)
  const got = readFileSync(dest)
  ok(`${name}：大小正确`, got.length === payload.length && r.size === payload.length)
  ok(`${name}：内容一致（sha256）`, sha(got) === sha(payload) && r.sha256 === sha(payload))
  rmSync(dir, { recursive: true, force: true })
}

const payload = randomBytes(3 * 1024 * 1024 + 137)
await runCase('小分块 1KB', payload, 1024, true)
await runCase('分块 7KB（含边界）', payload, 7001, true)
await runCase('大分块 64KB', payload, 65536, true)
await runCase('无 padding', payload, 4096, false)
// 边界：正好一块、空 data、非 4 倍数残留
const small = randomBytes(3)
const dir = mkdtempSync(join(tmpdir(), 'gmail-stream-'))
const dest = join(dir, 'small.bin')
await writeGmailBase64JsonToFile(Readable.from([Buffer.from(JSON.stringify({ data: small.toString('base64url') }))]), dest, 3)
ok('3 字节边界数据', readFileSync(dest).equals(small))
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
