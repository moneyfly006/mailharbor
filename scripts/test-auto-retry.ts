/**
 * 失败自动重试单测：
 *  - 失败的邮件（下载失败、状态 failed）会被自动重新下载
 *  - 正在下载中的邮件不会被重复触发
 *  - 开关关闭时不重试
 */
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { createBackendWith } from '../src/main/backend-core.ts'
import { startMockMailServer, MOCK, mimeFor } from './mock-mail-server.mjs'
import type { AccountInput, MainEvent } from '../shared/types.ts'

let pass = 0, fail = 0
const eq = (n: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}\n    got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn: () => boolean, timeout = 30000): Promise<boolean> {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > timeout) return false; await sleep(200) }
  return true
}

let server: any = null
let imapPort = 0, smtpPort = 0
for (let i = 0; i < 5 && !server; i++) {
  imapPort = 20000 + Math.floor(Math.random() * 20000); smtpPort = imapPort + 1
  try { MOCK.sent.length = 0; server = await startMockMailServer({ seed: false, quiet: true, imapPort, smtpPort }) } catch (e) { if (i === 4) throw e }
}
const root = mkdtempSync(join(tmpdir(), 'mh-retry-'))
const tmpDir = join(root, 'tmp'); const outDir = join(root, 'out')
mkdirSync(tmpDir, { recursive: true }); mkdirSync(outDir, { recursive: true })

const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(SCHEMA)
const settings: Record<string, unknown> = {
  pollIntervalSec: 30, replyEnabled: false, scanSpam: false, logLevel: 'error',
  downloadAttempts: 1, downloadChunkSizeMB: 2, parallelDownload: false,
  autoRetryFailed: true, autoRetryBaseMs: 1000
}
const bus = new EventEmitter(); const events: MainEvent[] = []
bus.on('event', (e: MainEvent) => events.push(e))
const backend = createBackendWith({ db, bus, codec: PLAIN_CODEC, getSetting: <T>(k: string) => settings[k] as T, tmpDir })

const input: AccountInput = {
  preset: 'custom', email: MOCK.user, displayName: 'Retry Test',
  imapHost: '127.0.0.1', imapPort, imapSecure: 'none', imapUser: MOCK.user,
  smtpHost: '127.0.0.1', smtpPort, smtpSecure: 'none', smtpUser: MOCK.user,
  smtpFromName: 'MailHarbor', smtpSameAsImap: true, password: MOCK.pass
}
const account = repos.createAccount(input)
repos.createRule({
  keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', priority: 10,
  fileTypes: ['zip'], autoReply: false, targets: [{ path: outDir, required: true }]
} as never)
await backend.scheduler.startAll()

// 造一封"下载失败"的邮件：UID 与 mock 里的邮件一致，状态 failed、附件 pending
server.imap.appendMessage('INBOX', [], false, new Uint8Array(mimeFor({
  subject: '原图+卡套 自动重试测试', from: { name: 'Retry', address: 'retry@test.local' },
  fileName: 'RETRY_1.zip', content: 'PK\u0003\u0004retry', date: new Date()
})))
const up = repos.upsertMessage({
  accountId: account.id, imapUid: 1, subject: '原图+卡套 自动重试测试',
  fromAddr: 'retry@test.local', fromName: 'Retry', status: 'failed',
  error: '模拟下载失败', links: null, mailbox: 'INBOX'
})
repos.upsertAttachment(up.id, { partId: '2', filename: 'RETRY_1.zip', mimeType: 'application/zip', declaredSize: 16 })
repos.setAttachmentStatus(up.id ? repos.listAttachmentsByMessage(up.id)[0]!.id : 0, 'failed', '模拟下载失败')

// 1) 开关关闭 → 不重试
settings.autoRetryFailed = false
eq('开关关闭时不触发自动重试', await backend.scheduler.runAutoRetryOnce(), 0)
eq('开关关闭时状态不变', repos.getMessage(up.id)?.status, 'failed')

// 2) 开启 → 自动重试成功
settings.autoRetryFailed = true
const triggered = await backend.scheduler.runAutoRetryOnce()
eq('检测到失败邮件并触发自动重试', triggered >= 1, true)
const done = await waitFor(() => repos.getMessage(up.id)?.status === 'done', 40000)
eq('自动重试后状态 done', done && repos.getMessage(up.id)?.status, 'done')
eq('附件已落盘', existsSync(join(outDir, 'RETRY_1.zip')), true)
const rec = repos.getRecordById(up.id)!
eq('记录里没有失败路径', rec.attachments.flatMap((a) => a.deliveries).every((d) => d.state === 'done'), true)
eq('自动重试计数已清零', (repos.getMessage(up.id) as any).auto_retry_count, 0)

// 3) 正在下载中的邮件（queued + 刚更新的 pending 附件）不会被重复触发
const up2 = repos.upsertMessage({
  accountId: account.id, imapUid: 2, subject: '原图+卡套 下载中', fromAddr: 'retry@test.local',
  status: 'queued', links: null, mailbox: 'INBOX'
})
const att2 = repos.upsertAttachment(up2.id, { partId: '2', filename: 'BUSY.zip', mimeType: 'application/zip', declaredSize: 16 })
repos.setAttachmentStatus(att2.id, 'pending', null)
eq('下载中的邮件不会被自动重试', await backend.scheduler.runAutoRetryOnce(), 0)

await backend.dispose(); await server.close(); db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
