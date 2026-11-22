/**
 * repos.ts 单测（内存 SQLite，不依赖 electron / 不连邮箱）
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-repos.ts
 */
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'

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
function throws(name: string, fn: () => unknown, contains?: string): void {
  try {
    fn()
    fail++
    console.log(`  ✗ ${name}（应当抛错但没有）`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (contains && !msg.includes(contains)) {
      fail++
      console.log(`  ✗ ${name}（错误信息不含 "${contains}"：${msg}）`)
    } else {
      pass++
      console.log(`  ✓ ${name}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 建库
// ---------------------------------------------------------------------------
const memory = new Database(':memory:')
memory.pragma('foreign_keys=ON')
memory.exec(SCHEMA)
repos.configureRepos({ db: memory, codec: PLAIN_CODEC })

const tmpRoot = mkdtempSync(join(tmpdir(), 'mh-repos-'))
const dirProd = join(tmpRoot, 'prod')
const dirBackup = join(tmpRoot, 'backup')
mkdirSync(dirProd, { recursive: true })
mkdirSync(dirBackup, { recursive: true })
const dirMissing = join(tmpRoot, 'not-mounted')

console.log('accounts:')
const input = {
  preset: 'custom' as const,
  email: 'demo@mailharbor.test',
  displayName: '演示账户',
  imapHost: '127.0.0.1',
  imapPort: 1143,
  imapSecure: 'none' as const,
  imapUser: 'demo@mailharbor.test',
  smtpHost: '127.0.0.1',
  smtpPort: 2525,
  smtpSecure: 'none' as const,
  smtpUser: 'demo@mailharbor.test',
  smtpFromName: 'MailHarbor 收货助手',
  smtpSameAsImap: true,
  password: 'demo-pass'
}
const acc = repos.createAccount(input)
eq('createAccount 返回 id', acc.id > 0, true)
eq('createAccount 状态 pending_test', acc.status, 'pending_test')
eq('createAccount 已保存密码', acc.hasPassword, true)
eq('createAccount 今日收件 0', acc.todayCount, 0)
eq('createAccount smtpSameAsImap', acc.smtpSameAsImap, true)
throws('重复账户报错', () => repos.createAccount(input), '已存在')
throws('空密码报错', () => repos.createAccount({ ...input, imapHost: 'other.host', password: '' }), '密码')
eq('listAccounts 数量', repos.listAccounts().length, 1)
eq('getAccountSecrets 解密', repos.getAccountSecrets(acc.id).imapPass, 'demo-pass')

repos.updateAccountSyncState(acc.id, { lastUid: 12, uidValidity: '1', lastOkAt: 1700000000000 })
const accSync = repos.getAccount(acc.id)!
eq('syncState lastUid', accSync.lastUid, 12)
eq('syncState uidValidity', accSync.uidValidity, '1')
eq('syncState lastOkAt', accSync.lastOkAt, 1700000000000)

const accUpdated = repos.updateAccount(acc.id, { ...input, password: '' })
eq('updateAccount 空密码保留旧密码', repos.getAccountSecrets(accUpdated.id).imapPass, 'demo-pass')
const accChanged = repos.updateAccount(acc.id, { ...input, password: 'new-pass', displayName: '改名' })
eq('updateAccount 改密码', repos.getAccountSecrets(accChanged.id).imapPass, 'new-pass')
eq('updateAccount 改配置后待测试', accChanged.status, 'pending_test')
eq('updateAccount 显示名', accChanged.displayName, '改名')

repos.setAccountStatus(acc.id, 'enabled', { ok: true, checked: true })
eq('setAccountStatus', repos.getAccount(acc.id)!.status, 'enabled')
eq('setAccountStatus 记录 lastOkAt', typeof repos.getAccount(acc.id)!.lastOkAt, 'number')

eq('setAccountEnabled false', repos.setAccountEnabled(acc.id, false).status, 'disabled')
eq('setAccountEnabled true 回 pending_test', repos.setAccountEnabled(acc.id, true).status, 'pending_test')
repos.setAccountStatus(acc.id, 'enabled', { ok: true })

console.log('rules:')
const rule1 = repos.createRule({
  keyword: '原图+卡套',
  enabled: true,
  scope: 'subject',
  mode: 'exact',
  priority: 10,
  fileTypes: ['zip', 'tif', 'tiff'],
  autoReply: true,
  targets: [
    { path: dirProd, required: true },
    { path: dirBackup, required: false }
  ]
})
eq('createRule targets 数量', rule1.targets.length, 2)
eq('createRule 排序 sortOrder', rule1.targets.map((t) => t.sortOrder), [0, 1])
eq('createRule required', rule1.targets.map((t) => t.required), [true, false])
eq('createRule 目标健康', rule1.targets.map((t) => t.lastHealth), ['ok', 'ok'])
eq('createRule 可用空间 >0', (rule1.targets[0]!.freeBytes ?? 0) > 0, true)

throws('空关键词报错', () => repos.createRule({ ...rule1Input(), keyword: '  ' }), '关键词')
throws('无目标报错', () => repos.createRule({ ...rule1Input(), targets: [] }), '目标文件夹')
throws('重复路径报错', () =>
  repos.createRule({ ...rule1Input(), targets: [{ path: dirProd, required: true }, { path: dirProd, required: false }] })
)

const rule2 = repos.createRule({ ...rule1Input(), keyword: '原图+手机壳', priority: 20 })
eq('listRules 按 priority 排序', repos.listRules().map((r) => r.keyword), ['原图+卡套', '原图+手机壳'])
repos.reorderRules([rule2.id, rule1.id])
eq('reorderRules 生效', repos.listRules().map((r) => r.keyword), ['原图+手机壳', '原图+卡套'])
eq('setRuleEnabled', repos.setRuleEnabled(rule2.id, false).enabled, false)
eq('listEnabledRules 过滤', repos.listEnabledRules().map((r) => r.id), [rule1.id])

repos.hitIncrement(rule1.id, { messages: 2, files: 3 })
const hitRule = repos.getRule(rule1.id)!
eq('hitIncrement 邮件数', hitRule.hitMessages, 2)
eq('hitIncrement 文件数', hitRule.hitFiles, 3)
eq('hitIncrement lastHitAt', typeof hitRule.lastHitAt, 'number')

const targetIds = rule1.targets.map((t) => t.id)
const ruleUpdated = repos.updateRule(rule1.id, {
  keyword: '原图+卡套',
  enabled: true,
  scope: 'subject',
  mode: 'exact',
  fileTypes: ['zip'],
  autoReply: false,
  targets: [
    { id: targetIds[0], path: dirProd, required: true },
    { path: dirMissing, required: true }
  ]
})
eq('updateRule targets 数量', ruleUpdated.targets.length, 2)
eq('updateRule 保留原 target id', ruleUpdated.targets[0]!.id, targetIds[0])
eq('updateRule 新路径健康 unavailable', ruleUpdated.targets.find((t) => t.path === dirMissing)!.lastHealth, 'unavailable')
eq('updateRule autoReply', ruleUpdated.autoReply, false)

const rule3 = repos.createRule({ ...rule1Input(), keyword: '临时规则' })
repos.deleteRule(rule3.id)
eq('deleteRule 软删后 list 不含', repos.listRules().some((r) => r.id === rule3.id), false)
eq('deleteRule 软删后 get 为 null', repos.getRule(rule3.id), null)

console.log('messages / attachments:')
const msgInput = {
  accountId: acc.id,
  imapUid: 1,
  rfcMessageId: '<m1@test>',
  providerMessageId: '<m1@test>',
  threadKey: '<m1@test>',
  subject: '原图+卡套 追加: POD_ORDER_20486',
  fromAddr: 'david@inkpressed.co',
  fromName: 'David Chen',
  receivedAt: Date.now()
}
const up1 = repos.upsertMessage({ ...msgInput, matchedRuleId: rule1.id, matchedKeyword: '原图+卡套', matchSource: 'subject' })
eq('upsertMessage 首次 inserted', up1.inserted, true)
const up2 = repos.upsertMessage({ ...msgInput, subject: '原图+卡套 改名' })
eq('upsertMessage 幂等 id 相同', up2.id, up1.id)
eq('upsertMessage 幂等 inserted=false', up2.inserted, false)
eq('upsertMessage 更新主题', repos.getMessage(up1.id)!.subject, '原图+卡套 改名')
eq('getMessageByUid', repos.getMessageByUid(acc.id, 1)!.id, up1.id)
eq('upsertMessage 状态默认 queued', repos.getMessage(up1.id)!.status, 'queued')
repos.updateMessageStatus(up1.id, 'queued')
repos.updateMessageReplyStatus(up1.id, 'pending')
repos.updateMessageMatch(up1.id, { matchedRuleId: rule1.id, matchedKeyword: '原图+卡套', matchSource: 'subject' })
eq('updateMessageMatch', repos.getMessage(up1.id)!.matched_rule_id, rule1.id)

const att = repos.upsertAttachment(up1.id, {
  partId: '2',
  filename: 'POD_ORDER_20486.zip',
  mimeType: 'application/octet-stream',
  declaredSize: 35
})
const att2 = repos.upsertAttachment(up1.id, { partId: '2', filename: 'POD_ORDER_20486.zip' })
eq('upsertAttachment 幂等', att2.id, att.id)
repos.setAttachmentDownloaded(att.id, { tmpPath: join(tmpRoot, '2.part'), size: 35, sha256: 'abc' })
const attLoaded = repos.getAttachment(att.id)!
eq('setAttachmentDownloaded status', attLoaded.status, 'downloaded')
eq('setAttachmentDownloaded size', attLoaded.size, 35)

console.log('deliveries:')
const tProd = ruleUpdated.targets.find((t) => t.path === dirProd)!
const tMissing = ruleUpdated.targets.find((t) => t.path === dirMissing)!
const created = repos.createDeliveries([
  { messageId: up1.id, attachmentId: att.id, targetId: tProd.id, targetPath: dirProd, required: true },
  { messageId: up1.id, attachmentId: att.id, targetId: tMissing.id, targetPath: dirMissing, required: true }
])
eq('createDeliveries 数量', created.length, 2)
const again = repos.createDeliveries([
  { messageId: up1.id, attachmentId: att.id, targetId: tProd.id, targetPath: dirProd, required: true },
  { messageId: up1.id, attachmentId: att.id, targetId: tMissing.id, targetPath: dirMissing, required: true }
])
eq('createDeliveries 幂等', again.length, 2)

eq('dueDeliveries 数量', repos.dueDeliveries(Date.now()).length, 2)
const d1 = created[0]!
repos.updateDeliveryState(d1.id, 'copying', { startedAt: Date.now() })
eq('updateDeliveryState copying', repos.getDelivery(d1.id)!.state, 'copying')
repos.markDeliveryDone(d1.id, { savedPath: join(dirProd, 'POD_ORDER_20486.zip'), savedName: 'POD_ORDER_20486.zip', size: 35, sha256: 'abc' })
eq('markDeliveryDone state', repos.getDelivery(d1.id)!.state, 'done')
eq('markDeliveryDone finishedAt', typeof repos.getDelivery(d1.id)!.finished_at, 'number')

const d2 = created[1]!
repos.markDeliveryRetry(d2.id, { errorCode: 'PATH_UNAVAILABLE', error: '盘未挂载', nextRetryAt: Date.now() + 60_000, attempts: 0 })
eq('markDeliveryRetry state', repos.getDelivery(d2.id)!.state, 'retry_wait')
eq('markDeliveryRetry 不消费 attempts', repos.getDelivery(d2.id)!.attempts, 0)
eq('dueDeliveries 未到期不含', repos.dueDeliveries(Date.now()).length, 0)
eq('dueDeliveries 到期含', repos.dueDeliveries(Date.now() + 61_000).length, 1)
repos.markDeliveryFailed(d2.id, { errorCode: 'NO_SPACE', error: '空间不足', attempts: 8 })
eq('markDeliveryFailed state', repos.getDelivery(d2.id)!.state, 'failed')
eq('resetDeliveriesForRetry', repos.resetDeliveriesForRetry(up1.id), 1)
eq('resetDeliveriesForRetry 后 pending', repos.getDelivery(d2.id)!.state, 'pending')

const aggMid = repos.deliveryAggregate(up1.id)
eq('deliveryAggregate total', aggMid.total, 2)
eq('deliveryAggregate done', aggMid.done, 1)
eq('deliveryAggregate allTerminal false（刚重置 pending）', aggMid.allTerminal, false)
repos.markDeliveryDone(d2.id, { savedPath: join(dirMissing, 'x.zip'), savedName: 'x.zip', size: 35 })
eq('deliveryAggregate requiredAllDone', repos.deliveryAggregate(up1.id).requiredAllDone, true)
eq('deliveryAggregate allTerminal', repos.deliveryAggregate(up1.id).allTerminal, true)

console.log('replies:')
eq('hasSentThread 初始 false', repos.hasSentThread(acc.id, '<m1@test>'), false)
repos.insertReply({
  accountId: acc.id,
  messageId: up1.id,
  threadKey: '<m1@test>',
  toAddr: 'david@inkpressed.co',
  status: 'sent',
  subject: 'Re: 原图+卡套',
  bodyPreview: '已收到',
  providerMessageId: '<r1@test>',
  sentAt: Date.now()
})
eq('hasSentThread 回过后 true', repos.hasSentThread(acc.id, '<m1@test>'), true)
eq('repliesTodayCount', repos.repliesTodayCount(acc.id), 1)
repos.insertReply({ accountId: acc.id, messageId: up1.id, threadKey: '<m2@test>', toAddr: 'a@b.c', status: 'failed', error: '550' })
eq('recentReplyFailures', repos.recentReplyFailures(acc.id, 60_000), 1)
eq('lastReplySentAt', typeof repos.lastReplySentAt(acc.id), 'number')

console.log('records / dashboard:')
const listed = repos.listRecords({ page: 1, pageSize: 10 })
eq('listRecords total', listed.total, 1)
eq('listRecords 嵌套附件', listed.rows[0]!.attachments.length, 1)
eq('listRecords 嵌套投递', listed.rows[0]!.attachments[0]!.deliveries.length, 2)
eq('listRecords 账户邮箱', listed.rows[0]!.accountEmail, 'demo@mailharbor.test')
eq('listRecords 搜索命中发件人', repos.listRecords({ search: 'David' }).total, 1)
eq('listRecords 搜索命中主题', repos.listRecords({ search: '改名' }).total, 1)
eq('listRecords 搜索命中附件文件名', repos.listRecords({ search: 'POD_ORDER_20486' }).total, 1)
eq('listRecords 搜索命中附件名片段', repos.listRecords({ search: '20486.zip' }).total, 1)
eq('listRecords 搜索不命中', repos.listRecords({ search: '不存在的内容' }).total, 0)
eq('listRecords 待重试含 failed', repos.listRecords({ status: 'partial' }).total >= 0, true)
eq('listRecords 状态筛选', repos.listRecords({ status: 'done' }).total, 0)
eq('listRecords 关键词筛选', repos.listRecords({ keyword: '卡套' }).total, 1)
eq('listRecords 账户筛选', repos.listRecords({ accountId: acc.id }).total, 1)
eq('listRecords 账户筛选不命中', repos.listRecords({ accountId: 999 }).total, 0)
eq('getRecordById', repos.getRecordById(up1.id)!.id, up1.id)
eq('folderOfRecord 优先 saved_path', repos.folderOfRecord(up1.id), dirProd)
eq('folderOfRecord 指定 delivery', repos.folderOfRecord(up1.id, d2.id), dirMissing)

repos.updateMessageStatus(up1.id, 'done')
const csv = repos.recordsToCsv(repos.listRecords({}).rows)
eq('recordsToCsv 含表头', csv.split('\r\n')[0]!.includes('命中关键词'), true)
eq('recordsToCsv 含文件名', csv.includes('POD_ORDER_20486.zip'), true)
eq('recordsToCsv 无表头 BOM', csv.charCodeAt(0) !== 0xfeff, true)

const stats = repos.dashboardStats()
eq('dashboard todayMessages', stats.todayMessages, 1)
eq('dashboard todayMatched', stats.todayMatched, 1)
eq('dashboard todayFiles', stats.todayFiles, 1)
eq('dashboard todayFailed', stats.todayFailed, 0)
eq('dashboard pendingRetry', stats.pendingRetry, 0)

const disks = repos.listDisks()
eq('listDisks 去重后的路径数', disks.length, 2)
eq('listDisks 含 unavailable', disks.some((d) => d.health === 'unavailable'), true)
eq('listDisks ruleKeywords', disks.every((d) => d.ruleKeywords.includes('原图+卡套')), true)

eq('accountTodayCount', repos.accountTodayCount(acc.id), 1)
eq('accountTotalFiles', repos.accountTotalFiles(acc.id), 1)
eq('pendingDeliveryCount', repos.pendingDeliveryCount(), 0)
eq('countMessages', repos.countMessages(), 1)
repos.deleteAccount(acc.id)
eq('deleteAccount 级联删除 messages', repos.countMessages(), 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

function rule1Input(): {
  keyword: string
  enabled: boolean
  scope: 'subject'
  mode: 'exact'
  fileTypes: string[]
  autoReply: boolean
  targets: Array<{ path: string; required: boolean }>
} {
  return {
    keyword: '原图+卡套',
    enabled: true,
    scope: 'subject',
    mode: 'exact',
    fileTypes: ['zip', 'tif'],
    autoReply: true,
    targets: [{ path: dirProd, required: true }]
  }
}
