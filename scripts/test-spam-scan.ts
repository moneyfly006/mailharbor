/**
 * 垃圾邮件文件夹扫描单测：
 *  - mock IMAP 里建 Junk 邮件夹，投递封"命中规则"的邮件
 *  - 开启 scanSpam 后，软件应自动取信、下载、归档，并禁止自动回信
 */
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { createBackendWith } from '../src/main/backend-core.ts'
import { startMockMailServer, MOCK } from './mock-mail-server.mjs'
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
const root = mkdtempSync(join(tmpdir(), 'mh-spam-'))
const tmpDir = join(root, 'tmp'); const outDir = join(root, 'out')
mkdirSync(tmpDir, { recursive: true }); mkdirSync(outDir, { recursive: true })

const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(SCHEMA)
const settings: Record<string, unknown> = {
  pollIntervalSec: 30, replyEnabled: false, scanSpam: true, logLevel: 'error',
  downloadAttempts: 1, downloadChunkSizeMB: 2, parallelDownload: false,
  replyLanguage: 'zh', replySubjectZh: '已收到', replyBodyZh: '已收到 {文件名}'
}
const bus = new EventEmitter(); const events: MainEvent[] = []
bus.on('event', (e: MainEvent) => events.push(e))
const backend = createBackendWith({ db, bus, codec: PLAIN_CODEC, getSetting: <T>(k: string) => settings[k] as T, tmpDir })

const input: AccountInput = {
  preset: 'custom', email: MOCK.user, displayName: 'Spam Test',
  imapHost: '127.0.0.1', imapPort, imapSecure: 'none', imapUser: MOCK.user,
  smtpHost: '127.0.0.1', smtpPort, smtpSecure: 'none', smtpUser: MOCK.user,
  smtpFromName: 'MailHarbor', smtpSameAsImap: true, password: MOCK.pass
}
const account = repos.createAccount(input)
repos.createRule({
  keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', priority: 10,
  fileTypes: ['zip'], autoReply: true, targets: [{ path: outDir, required: true }]
} as never)
await backend.scheduler.pause()  // 先确保不自动轮询，等邮件写入后再 checkNow
await backend.scheduler.resume()

// 建 Junk 邮箱并直接投递一封命中规则的邮件
const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: MOCK.user, pass: MOCK.pass }, logger: false })
await c.connect()
try { await (c as any).mailboxCreate('Junk') } catch (e) { console.log('  创建 Junk 邮箱失败（可能已存在）:', (e as Error).message.slice(0, 60)) }
const boundary = '----=SPAMTEST'
const raw = [
  `From: "Spammer" <spam@send.example>`, `To: ${MOCK.user}`,
  `Subject: =?UTF-8?B?${Buffer.from('原图+卡套 垃圾箱里的邮件').toString('base64')}?=`,
  `Date: ${new Date().toUTCString()}`, `Message-ID: <spam-${Date.now()}@test.local>`,
  'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
  `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'spam body', '',
  `--${boundary}`, 'Content-Type: application/zip', 'Content-Disposition: attachment; filename="SPAM_JUNK.zip"',
  'Content-Transfer-Encoding: base64', '', Buffer.from('PK\u0003\u0004spam').toString('base64'), '',
  `--${boundary}--`, ''
].join('\r\n')
await c.append('Junk', Buffer.from(raw, 'utf8'), [], new Date())
await c.logout()

await backend.scheduler.checkNow()
const found = await waitFor(() => repos.listRecords({ page: 1, pageSize: 10 }).rows.some((r) => r.subject.includes('垃圾箱里的邮件')), 40000)
eq('垃圾箱里的邮件被扫描到', found, true)
const row = repos.listRecords({ page: 1, pageSize: 10 }).rows.find((r) => r.subject.includes('垃圾箱里的邮件'))
eq('记录标记 mailbox=Junk', row?.mailbox, 'Junk')
eq('状态 done（已下载归档）', row?.status === 'done', true)
eq('垃圾邮件不自动回信', row?.replyStatus, 'disabled')
eq('附件已落盘', existsSync(join(outDir, 'SPAM_JUNK.zip')), true)

await backend.dispose(); await server.close(); db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
