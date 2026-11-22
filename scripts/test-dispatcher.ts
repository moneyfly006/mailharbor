/**
 * dispatcher.ts 单测（临时目录 + 内存 DB，不连邮箱）
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-dispatcher.ts
 */
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync, chmodSync } from 'node:fs'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { Dispatcher, precheckTarget, retryDelayMs, RETRY_DELAYS_MS, PATH_RECHECK_MS } from '../src/main/dispatcher.ts'
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
async function rejects(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    fail++
    console.log(`  ✗ ${name}（应当抛错）`)
  } catch {
    pass++
    console.log(`  ✓ ${name}`)
  }
}

const db = new Database(':memory:')
db.pragma('foreign_keys=ON')
db.exec(SCHEMA)
repos.configureRepos({ db, codec: PLAIN_CODEC })

const root = mkdtempSync(join(tmpdir(), 'mh-dispatch-'))
const prodDir = join(root, 'prod')
const backupDir = join(root, 'backup')
const missingDir = join(root, 'not-mounted')
const tmpDir = join(root, 'tmp')
mkdirSync(prodDir, { recursive: true })
mkdirSync(backupDir, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

const account = repos.createAccount({
  preset: 'custom', email: 'demo@mailharbor.test', imapHost: 'h', imapPort: 993, imapSecure: 'ssl',
  imapUser: 'demo@mailharbor.test', smtpHost: 'h2', smtpPort: 465, smtpSecure: 'ssl',
  smtpUser: 'demo@mailharbor.test', smtpSameAsImap: true, password: 'x'
})
const rule = repos.createRule({
  keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', fileTypes: ['zip'], autoReply: true,
  targets: [
    { path: prodDir, required: true },
    { path: backupDir, required: true },
    { path: missingDir, required: true }
  ]
})
const tProd = rule.targets[0]!
const tBackup = rule.targets[1]!
const tMissing = rule.targets[2]!

const events: MainEvent[] = []
const settings: Record<string, unknown> = { retryMaxAttempts: 8, multiRuleStrategy: 'all', defaultPathEnabled: false }
const dispatcher = new Dispatcher({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  tmpDir
})
const settled: number[] = []
dispatcher.onSettled = (id) => {
  settled.push(id)
}

let seq = 0
function makeMessage(subjectSuffix = ''): { messageId: number; attachmentId: number; tmpFile: string; content: string } {
  seq++
  const up = repos.upsertMessage({
    accountId: account.id,
    imapUid: seq,
    rfcMessageId: `<m${seq}@test>`,
    providerMessageId: `<m${seq}@test>`,
    threadKey: `<m${seq}@test>`,
    subject: `原图+卡套 ${subjectSuffix}`,
    fromAddr: 'david@inkpressed.co',
    fromName: 'David',
    receivedAt: Date.now(),
    matchedRuleId: rule.id,
    matchedKeyword: '原图+卡套',
    matchSource: 'subject',
    status: 'queued'
  })
  const content = `PK\u0003\u0004 fake zip content ${seq}`
  const tmpFile = join(tmpDir, `m${seq}.part`)
  writeFileSync(tmpFile, content)
  const att = repos.upsertAttachment(up.id, { partId: '2', filename: 'POD_ORDER.zip', declaredSize: content.length })
  const sha256 = createHash('sha256').update(content).digest('hex')
  repos.setAttachmentDownloaded(att.id, { tmpPath: tmpFile, size: content.length, sha256 })
  return { messageId: up.id, attachmentId: att.id, tmpFile, content }
}

console.log('retry delay:')
eq('retryDelayMs 序列', RETRY_DELAYS_MS.map((_, i) => retryDelayMs(i + 1)), RETRY_DELAYS_MS)
eq('retryDelayMs 超界封顶 1h', retryDelayMs(99), 3_600_000)
eq('retryDelayMs 从 15s 起', retryDelayMs(1), 15_000)

console.log('precheck:')
eq('可用目录', (await precheckTarget(prodDir, 10)).ok, true)
eq('不存在目录 → PATH_UNAVAILABLE', (await precheckTarget(missingDir, 10)).code, 'PATH_UNAVAILABLE')
eq('空路径 → PATH_UNAVAILABLE', (await precheckTarget('', 10)).code, 'PATH_UNAVAILABLE')

console.log('多路径扇出:')
const m1 = makeMessage('一')
const deliveries = repos.createDeliveries([
  { messageId: m1.messageId, attachmentId: m1.attachmentId, targetId: tProd.id, targetPath: prodDir, required: true },
  { messageId: m1.messageId, attachmentId: m1.attachmentId, targetId: tBackup.id, targetPath: backupDir, required: true },
  { messageId: m1.messageId, attachmentId: m1.attachmentId, targetId: tMissing.id, targetPath: missingDir, required: true }
])
eq('创建 3 条投递', deliveries.length, 3)
await dispatcher.runOnce()

const d1 = repos.getDelivery(deliveries[0]!.id)!
const d2 = repos.getDelivery(deliveries[1]!.id)!
const d3 = repos.getDelivery(deliveries[2]!.id)!
eq('生产目录 done', d1.state, 'done')
eq('备份目录 done', d2.state, 'done')
eq('不可用路径 retry_wait', d3.state, 'retry_wait')
eq('不可用路径错误码', d3.error_code, 'PATH_UNAVAILABLE')
eq('不可用路径不消耗 attempts', d3.attempts, 0)
eq('不可用路径 nextRetryAt ≈ +60s', Math.abs((d3.next_retry_at ?? 0) - (Date.now() + PATH_RECHECK_MS)) < 5000, true)
eq('生产目录文件存在', readdirSync(prodDir).includes('POD_ORDER.zip'), true)
eq('备份目录文件存在', readdirSync(backupDir).includes('POD_ORDER.zip'), true)
eq('落盘内容一致', readFileSync(join(prodDir, 'POD_ORDER.zip'), 'utf8'), m1.content)
eq('投递记录 savedPath', d1.saved_path, join(prodDir, 'POD_ORDER.zip'))
eq('消息聚合 status=partial', repos.getMessage(m1.messageId)!.status, 'partial')
eq('未 settle（还有 retry_wait）', settled.includes(m1.messageId), false)
ok('发出了 delivery:changed 事件', events.some((e) => e.type === 'delivery:changed' && e.messageId === m1.messageId))
ok('发出了 message:upserted 事件', events.some((e) => e.type === 'message:upserted' && e.record.id === m1.messageId))

console.log('幂等 / 已 done 不重做:')
const beforeMtime = statSync(join(prodDir, 'POD_ORDER.zip')).mtimeMs
await dispatcher.runOnce()
eq('不可用路径仍未到期不重试', repos.getDelivery(d3.id)!.state, 'retry_wait')
eq('已 done 不重写（mtime 不变）', statSync(join(prodDir, 'POD_ORDER.zip')).mtimeMs, beforeMtime)
eq('生产/备份仍各 1 个文件', [readdirSync(prodDir).length, readdirSync(backupDir).length], [1, 1])

console.log('重名自动加序号:')
const m2 = makeMessage('二')
repos.createDeliveries([{ messageId: m2.messageId, attachmentId: m2.attachmentId, targetId: tProd.id, targetPath: prodDir, required: true }])
await dispatcher.runOnce()
eq('第二个同名文件 → (2)', readdirSync(prodDir).sort(), ['POD_ORDER (2).zip', 'POD_ORDER.zip'])
eq('重名文件内容正确', readFileSync(join(prodDir, 'POD_ORDER (2).zip'), 'utf8'), m2.content)
eq('消息全 done', repos.getMessage(m2.messageId)!.status, 'done')
eq('全部终态触发 settle', settled.includes(m2.messageId), true)

console.log('复制失败消耗 attempts 并退避:')
// 临时文件指向目录 → copyFile 抛 EISDIR，归为 COPY_FAILED，消耗 attempts
const m3 = makeMessage('三')
const badTmp = join(tmpDir, 'isdir.part')
mkdirSync(badTmp, { recursive: true })
const badAtt = repos.upsertAttachment(m3.messageId, { partId: '3', filename: 'bad.zip' })
repos.setAttachmentDownloaded(badAtt.id, { tmpPath: badTmp, size: 10, sha256: 'x' })
const badD = repos.createDeliveries([{ messageId: m3.messageId, attachmentId: badAtt.id, targetId: tProd.id, targetPath: prodDir, required: true }])[0]!
await dispatcher.runOnce()
const badAfter = repos.getDelivery(badD.id)!
eq('复制失败 → retry_wait', badAfter.state, 'retry_wait')
eq('复制失败 attempts=1', badAfter.attempts, 1)
eq('复制失败错误码 COPY_FAILED', badAfter.error_code, 'COPY_FAILED')
eq('复制失败退避 15s', Math.abs((badAfter.next_retry_at ?? 0) - (Date.now() + 15_000)) < 5000, true)
eq('消息聚合 partial', repos.getMessage(m3.messageId)!.status, 'partial')

console.log('重试耗尽 → failed:')
settings.retryMaxAttempts = 1
const retryNow = badAfter.next_retry_at ?? 0
const fastSettings = { retryMaxAttempts: 1 }
const fastDispatcher = new Dispatcher({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => (fastSettings as Record<string, unknown>)[k] as T,
  tmpDir,
  now: () => retryNow + 1
})
await fastDispatcher.runOnce()
const failedD = repos.getDelivery(badD.id)!
eq('attempts=2 达上限 → failed', failedD.state, 'failed')
eq('failed 错误码', failedD.error_code, 'COPY_FAILED')

console.log('手动重试:')
await dispatcher.retryDelivery(m3.messageId, badD.id)
eq('重试后 pending', repos.getDelivery(badD.id)!.state, 'pending')
eq('重试后 attempts=0', repos.getDelivery(badD.id)!.attempts, 0)
eq('重试后消息 queued', repos.getMessage(m3.messageId)!.status, 'queued')

console.log('路径不可用不消耗 attempts 的再次验证:')
const beforeAttempts = repos.getDelivery(d3.id)!.attempts
const later = new Dispatcher({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  tmpDir,
  now: () => (d3.next_retry_at ?? 0) + 1
})
await later.runOnce()
const d3again = repos.getDelivery(d3.id)!
eq('再次重查后仍 retry_wait', d3again.state, 'retry_wait')
eq('attempts 仍为 0', d3again.attempts, beforeAttempts)

console.log('只读目录 → ACCESS_DENIED 不消耗 attempts:')
if (process.platform !== 'win32') {
  const roDir = join(root, 'readonly')
  mkdirSync(roDir, { recursive: true })
  chmodSync(roDir, 0o555)
  const m4 = makeMessage('四')
  const roD = repos.createDeliveries([{ messageId: m4.messageId, attachmentId: m4.attachmentId, targetId: tProd.id, targetPath: roDir, required: true }])[0]!
  await dispatcher.runOnce()
  const roAfter = repos.getDelivery(roD.id)!
  eq('只读目录 → retry_wait', roAfter.state, 'retry_wait')
  eq('只读目录 attempts 不增加', roAfter.attempts, 0)
  eq('只读目录错误码 ACCESS_DENIED', roAfter.error_code, 'ACCESS_DENIED')
  chmodSync(roDir, 0o755)
}

console.log('reconcile 对账:')
// 场景 A：copying 但目标文件其实已落盘 → 认领 done
const m5 = makeMessage('五')
const att5 = repos.listAttachmentsByMessage(m5.messageId)[0]!
const adoptD = repos.createDeliveries([{ messageId: m5.messageId, attachmentId: att5.id, targetId: tProd.id, targetPath: prodDir, required: true }])[0]!
repos.updateDeliveryState(adoptD.id, 'copying', { startedAt: Date.now() })
writeFileSync(join(prodDir, 'POD_ORDER (3).zip'), m5.content)
// 场景 B：copying 但文件不存在 → 重置 pending
const m6 = makeMessage('六')
const att6 = repos.listAttachmentsByMessage(m6.messageId)[0]!
const redoD = repos.createDeliveries([{ messageId: m6.messageId, attachmentId: att6.id, targetId: tBackup.id, targetPath: backupDir, required: true }])[0]!
repos.updateDeliveryState(redoD.id, 'copying', { startedAt: Date.now() })
// 场景 C：tmp 里 >24h 的 .part 应被清理
const oldTmp = join(tmpDir, 'ancient.part')
writeFileSync(oldTmp, 'old')
const old = (Date.now() - 25 * 3600 * 1000) / 1000
utimesSync(oldTmp, old, old)
const rec = await dispatcher.reconcile()
eq('reconcile 认领 done 数量', rec.adopted, 1)
eq('reconcile 重置数量', rec.reset, 1)
eq('reconcile 清理 tmp 数量', rec.tmpCleaned, 1)
eq('认领后 delivery done', repos.getDelivery(adoptD.id)!.state, 'done')
eq('认领后 savedName', repos.getDelivery(adoptD.id)!.saved_name, 'POD_ORDER (3).zip')
eq('重置后 delivery pending', repos.getDelivery(redoD.id)!.state, 'pending')
eq('tmp 旧文件已删除', readdirSync(tmpDir).includes('ancient.part'), false)

console.log('并发上限设定:')
const custom = new Dispatcher({ emit: () => {}, getSetting: () => 8, tmpDir, concurrency: 2 })
eq('自定义并发构造成功', typeof custom.runOnce, 'function')
custom.stop()
dispatcher.stop()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
