/**
 * reply-service.ts 单测（内存 DB + 注入假发送函数，不连 SMTP）
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-reply.ts
 */
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { decideReply, ReplyService, DAILY_REPLY_CAP } from '../src/main/reply-service.ts'
import { ReplySendError, type ReplyRequest, type SendReplyResult } from '../src/main/smtp.ts'
import type { MainEvent } from '../shared/types.ts'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}
function ok(name: string, cond: boolean): void {
  eq(name, cond, true)
}

console.log('decideReply 纯决策:')
const base = {
  replyStatus: 'pending' as const,
  autoReply: true,
  globalEnabled: true,
  requiredAllDone: true,
  alreadySentThread: false,
  fromAddr: 'david@inkpressed.co',
  selfAddresses: ['demo@mailharbor.test'],
  autoSubmitted: false,
  dailyCount: 0,
  circuitOpen: false
}
eq('正常 → send', decideReply(base).action, 'send')
eq('全局关闭 → disabled', decideReply({ ...base, globalEnabled: false }).replyStatus, 'disabled')
eq('规则关闭 → disabled', decideReply({ ...base, autoReply: false }).replyStatus, 'disabled')
eq('Auto-Submitted → suppress', decideReply({ ...base, autoSubmitted: true }).replyStatus, 'suppressed')
eq('发件人是自己 → suppress', decideReply({ ...base, fromAddr: 'DEMO@mailharbor.test' }).replyStatus, 'suppressed')
eq('mailer-daemon → suppress', decideReply({ ...base, fromAddr: 'MAILER-DAEMON@mail.example.com' }).replyStatus, 'suppressed')
eq('no-reply → suppress', decideReply({ ...base, fromAddr: 'no-reply@shop.com' }).replyStatus, 'suppressed')
eq('同线程已回 → suppress', decideReply({ ...base, alreadySentThread: true }).replyStatus, 'suppressed')
eq('必达未完成 → wait', decideReply({ ...base, requiredAllDone: false }).action, 'wait')
eq('每小时上限 → suppress', decideReply({ ...base, hourlyCount: 60 }).replyStatus, 'suppressed')
eq('每小时上限可配（80）', decideReply({ ...base, hourlyCount: 60, hourlyCap: 80 }).action, 'send')
eq('同线程关掉后可再回', decideReply({ ...base, alreadySentThread: true, threadOnce: false }).action, 'send')
eq('熔断中 → wait', decideReply({ ...base, circuitOpen: true }).action, 'wait')
eq('已 sent → wait', decideReply({ ...base, replyStatus: 'sent' }).action, 'wait')
eq('无效地址 → suppress', decideReply({ ...base, fromAddr: 'not-an-email' }).replyStatus, 'suppressed')

// ---------------------------------------------------------------------------
// 服务集成
// ---------------------------------------------------------------------------
const db = new Database(':memory:')
db.pragma('foreign_keys=ON')
db.exec(SCHEMA)
repos.configureRepos({ db, codec: PLAIN_CODEC })
const root = mkdtempSync(join(tmpdir(), 'mh-reply-'))
const targetDir = join(root, 'prod')
const { mkdirSync } = await import('node:fs')
mkdirSync(targetDir, { recursive: true })
const tmpFile = join(root, 'a.part')
writeFileSync(tmpFile, 'PK-fake-zip')

const account = repos.createAccount({
  preset: 'custom', email: 'demo@mailharbor.test', displayName: '演示', imapHost: 'h', imapPort: 993,
  imapSecure: 'ssl', imapUser: 'demo@mailharbor.test', smtpHost: 's', smtpPort: 465, smtpSecure: 'ssl',
  smtpUser: 'demo@mailharbor.test', smtpFromName: '宁波工厂收货助手', smtpSameAsImap: true, password: 'x'
})
repos.setAccountStatus(account.id, 'enabled', { ok: true })
const rule = repos.createRule({
  keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', fileTypes: ['zip'], autoReply: true,
  targets: [{ path: targetDir, required: true }]
})
const tId = rule.targets[0]!.id

const settings: Record<string, unknown> = {
  replyEnabled: true,
  replyDelaySec: 0,
  replySubjectZh: '图稿已收到 · {关键词}',
  replyBodyZh: '您好，已收到 {数量} 个文件：{文件名}（{工厂名}）',
  replySubjectEn: 'Artwork received',
  replyBodyEn: 'Received {数量}: {文件名}',
  replyLanguage: 'zh',
  logLevel: 'error'
}
const events: MainEvent[] = []
let sendCalls: ReplyRequest[] = []
let sendImpl: (req: ReplyRequest) => Promise<SendReplyResult> = async () => ({ providerMessageId: '<sent@test>', response: '250 OK', accepted: [] })
const service = new ReplyService({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  getSecrets: () => ({ imapPass: 'x', smtpPass: 'x' }),
  send: (_cfg, req) => {
    sendCalls.push(req)
    return sendImpl(req)
  }
})

let seq = 0
function seedMessage(opts: { fromAddr?: string; threadKey?: string; deliveryState?: 'done' | 'retry_wait'; status?: 'done' | 'partial' } = {}): number {
  seq++
  const from = opts.fromAddr ?? 'david@inkpressed.co'
  const up = repos.upsertMessage({
    accountId: account.id,
    imapUid: 100 + seq,
    rfcMessageId: `<orig-${seq}@test>`,
    providerMessageId: `<orig-${seq}@test>`,
    threadKey: opts.threadKey ?? `<orig-${seq}@test>`,
    subject: '原图+卡套 追加',
    fromAddr: from,
    fromName: 'David Chen',
    receivedAt: Date.now(),
    matchedRuleId: rule.id,
    matchedKeyword: '原图+卡套',
    matchSource: 'subject',
    status: opts.status ?? 'done',
    replyStatus: 'pending'
  })
  const att = repos.upsertAttachment(up.id, { partId: '2', filename: 'POD_ORDER_20486.zip', mimeType: 'application/zip' })
  repos.setAttachmentDownloaded(att.id, { tmpPath: tmpFile, size: 12, sha256: 'sha' })
  repos.createDeliveries([
    { messageId: up.id, attachmentId: att.id, targetId: tId, targetPath: targetDir, required: true }
  ])
  const d = repos.listDeliveriesByMessage(up.id)[0]!
  if ((opts.deliveryState ?? 'done') === 'done') {
    repos.markDeliveryDone(d.id, { savedPath: join(targetDir, 'POD_ORDER_20486.zip'), savedName: 'POD_ORDER_20486.zip', size: 12 })
  } else {
    repos.updateDeliveryState(d.id, 'retry_wait', { nextRetryAt: Date.now() + 60_000 })
  }
  return up.id
}

console.log('发送成功:')
const m1 = seedMessage()
await service.maybeReply(m1)
eq('回信请求次数', sendCalls.length, 1)
eq('回信主题带 Re', /^Re: 图稿已收到/.test(sendCalls[0]!.subject), true)
eq('回信正文含文件名', sendCalls[0]!.body.includes('POD_ORDER_20486.zip'), true)
eq('回信正文含数量', sendCalls[0]!.body.includes('1 个文件'), true)
eq('回信正文含工厂名', sendCalls[0]!.body.includes('宁波工厂收货助手'), true)
eq('In-Reply-To 关联原信', sendCalls[0]!.inReplyTo, '<orig-1@test>')
eq('From 是账户邮箱', sendCalls[0]!.from.address, 'demo@mailharbor.test')
eq('To 是原发件人', sendCalls[0]!.to.address, 'david@inkpressed.co')
eq('消息 reply_status=sent', repos.getMessage(m1)!.reply_status, 'sent')
eq('auto_replies 有 1 条 sent', repos.listRepliesByMessage(m1).filter((r) => r.status === 'sent').length, 1)
eq('同线程已回标记', repos.hasSentThread(account.id, '<orig-1@test>'), true)
ok('推送了 message:upserted', events.some((e) => e.type === 'message:upserted'))

console.log('不重复回信:')
await service.maybeReply(m1)
eq('再次调用不发送', sendCalls.length, 1)

console.log('同线程第二封 (RE:) 被抑制:')
const m2 = seedMessage({ threadKey: '<orig-1@test>' })
await service.maybeReply(m2)
eq('同线程不发送', sendCalls.length, 1)
eq('第二封被标 suppressed', repos.getMessage(m2)!.reply_status, 'suppressed')
eq('auto_replies 有 suppressed 记录', repos.listRepliesByMessage(m2).some((r) => r.status === 'suppressed'), true)

console.log('自己发给自己 → 抑制:')
const m3 = seedMessage({ fromAddr: 'demo@mailharbor.test' })
await service.maybeReply(m3)
eq('自己发的不回', sendCalls.length, 1)
eq('自己发的标 suppressed', repos.getMessage(m3)!.reply_status, 'suppressed')

console.log('mailer-daemon → 抑制:')
const m4 = seedMessage({ fromAddr: 'MAILER-DAEMON@mx.example.com' })
await service.maybeReply(m4)
eq('退信不回', sendCalls.length, 1)
eq('退信标 suppressed', repos.getMessage(m4)!.reply_status, 'suppressed')

console.log('必达路径未完成 → 等待:')
const m5 = seedMessage({ deliveryState: 'retry_wait', status: 'partial' })
await service.maybeReply(m5)
eq('必达未完成不发送', sendCalls.length, 1)
eq('保持 pending', repos.getMessage(m5)!.reply_status, 'pending')

console.log('全局关闭回信:')
settings.replyEnabled = false
const m6 = seedMessage()
await service.maybeReply(m6)
eq('关闭后不发送', sendCalls.length, 1)
eq('关闭后 reply_status=disabled', repos.getMessage(m6)!.reply_status, 'disabled')
settings.replyEnabled = true

console.log('发送失败 → failed + 熔断:')
sendImpl = async () => {
  throw new ReplySendError('SMTP_TEMP_FAIL', '邮件服务器临时拒绝（4xx）')
}
const failures: number[] = []
for (let i = 0; i < 3; i++) failures.push(seedMessage({ threadKey: `<thread-fail-${i}@test>` }))
for (const id of failures) await service.maybeReply(id)
eq('失败 3 次都发起了发送', sendCalls.length, 1 + 3)
eq('失败后 reply_status=failed', failures.map((id) => repos.getMessage(id)!.reply_status), ['failed', 'failed', 'failed'])
eq('失败记录落库', repos.listRepliesByMessage(failures[0]!).some((r) => r.status === 'failed'), true)
ok('熔断 toast 已推送', events.some((e) => e.type === 'toast' && e.title.includes('暂停')))
const m7 = seedMessage({ threadKey: '<thread-after-circuit@test>' })
await service.maybeReply(m7)
eq('熔断期间不再发送', sendCalls.length, 4)
eq('熔断期间保持 pending', repos.getMessage(m7)!.reply_status, 'pending')

console.log('SMTP 认证失败 → 账户 auth_failed:')
sendImpl = async () => {
  throw new ReplySendError('SMTP_AUTH_FAILED', 'SMTP 登录被拒绝')
}
// 用新 service 避免熔断状态
const authService = new ReplyService({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  getSecrets: () => ({ imapPass: 'x', smtpPass: 'x' }),
  send: () => {
    throw new ReplySendError('SMTP_AUTH_FAILED', 'SMTP 登录被拒绝')
  }
})
const m8 = seedMessage({ threadKey: '<thread-auth@test>' })
await authService.maybeReply(m8)
eq('认证失败 account auth_failed', repos.getAccount(account.id)!.status, 'auth_failed')
eq('认证失败 reply_status=failed', repos.getMessage(m8)!.reply_status, 'failed')
ok('认证失败推送 account:changed', events.some((e) => e.type === 'account:changed'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
