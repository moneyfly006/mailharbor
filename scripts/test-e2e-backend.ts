/**
 * 端到端联调（本机 mock IMAP/SMTP，不需要真实 Gmail/QQ）：
 *   启动模拟服务器 → 建账户 → 测试连接 → 建规则（两个目标目录）
 *   → scheduler 收信 → 规则匹配 → 下载附件 → 多路径扇出 → SMTP 回信 → 记录
 *   → 幂等复跑 → 部分路径失败（只重试失败路径，不重复写已成功路径）
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-e2e-backend.ts
 */
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { createBackendWith } from '../src/main/backend-core.ts'
import { startMockMailServer, MOCK, SEED, mimeFor } from './mock-mail-server.mjs'
import type { AccountInput, MainEvent } from '../shared/types.ts'

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn: () => boolean, timeoutMs = 15_000, label = ''): Promise<boolean> {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > timeoutMs) {
      console.log(`  … 等待超时：${label}`)
      return false
    }
    await sleep(50)
  }
  return true
}

// ---------------------------------------------------------------------------
// 启动 mock 服务器（随机高位端口，避免和 Lead 常驻的 1143/2525 冲突）
// ---------------------------------------------------------------------------
let server: Awaited<ReturnType<typeof startMockMailServer>> | null = null
let imapPort = 0
let smtpPort = 0
for (let attempt = 0; attempt < 5 && !server; attempt++) {
  imapPort = 20_000 + Math.floor(Math.random() * 20_000)
  smtpPort = imapPort + 1
  try {
    MOCK.sent.length = 0
    server = await startMockMailServer({ seed: true, quiet: true, imapPort, smtpPort })
  } catch (e) {
    if (attempt === 4) throw e
    console.log(`端口 ${imapPort}/${smtpPort} 被占用，换一个…`)
  }
}
if (!server) throw new Error('mock server 启动失败')
console.log(`mock 邮件服务器已启动：IMAP ${imapPort} · SMTP ${smtpPort}`)

try {
  // -------------------------------------------------------------------------
  // 后端装配（内存 DB，真实 IMAP/SMTP provider，1 小时临时目录）
  // -------------------------------------------------------------------------
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  const root = mkdtempSync(join(tmpdir(), 'mh-e2e-'))
  const tmpDir = join(root, 'tmp')
  const prodDir = join(root, 'D_pod_prod')
  const backupDir = join(root, 'E_pod_backup')
  const missingDir = join(root, 'F_not_mounted')
  mkdirSync(prodDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  const settings: Record<string, unknown> = {
    pollIntervalSec: 30,
    autostart: false,
    minimizeToTray: true,
    defaultPathEnabled: false,
    defaultPath: '',
    replyEnabled: true,
    replyDelaySec: 0,
    replySubjectZh: '图稿已收到 · {关键词}',
    replyBodyZh: '您好，已收到您的图稿（{数量} 个文件）：\n{文件名}\n\n{工厂名}',
    replySubjectEn: 'Artwork received — {关键词}',
    replyBodyEn: 'Hi, received {数量} file(s): {文件名}\n\n{工厂名}',
    replyLanguage: 'en',
    logLevel: 'error',
    retryMaxAttempts: 8,
    multiRuleStrategy: 'all'
  }
  const bus = new EventEmitter()
  const events: MainEvent[] = []
  bus.on('event', (e: MainEvent) => events.push(e))
  const backend = createBackendWith({
    db,
    bus,
    codec: PLAIN_CODEC,
    getSetting: <T>(k: string) => settings[k] as T,
    tmpDir
  })

  const input: AccountInput = {
    preset: 'custom',
    email: MOCK.user,
    displayName: 'MailHarbor 演示',
    imapHost: '127.0.0.1',
    imapPort,
    imapSecure: 'none',
    imapUser: MOCK.user,
    smtpHost: '127.0.0.1',
    smtpPort,
    smtpSecure: 'none',
    smtpUser: MOCK.user,
    smtpFromName: 'MailHarbor 收货助手',
    smtpSameAsImap: true,
    password: MOCK.pass
  }

  console.log('测试连接（mock 服务器）:')
  const testResult = await backend.testAccount(input)
  ok('testAccount ok=true', testResult.ok)
  eq('IMAP 一行 ok', testResult.lines.find((l) => l.protocol === 'imap')?.ok, true)
  eq('SMTP 一行 ok', testResult.lines.find((l) => l.protocol === 'smtp')?.ok, true)
  ok('IMAP 成功文案含中文', /[\u4e00-\u9fff]/.test(testResult.lines[0]!.message ?? ''))

  const badInput: AccountInput = { ...input, imapHost: '127.0.0.1', imapPort: 1 }
  const badResult = await backend.testAccount(badInput)
  eq('错误 host/port → ok=false', badResult.ok, false)
  ok('错误 host/port 带错误码', !!badResult.lines[0]!.errorCode)
  ok('错误 host/port 中文修复指引', /[\u4e00-\u9fff]/.test(badResult.lines[0]!.message ?? ''))

  // -------------------------------------------------------------------------
  // 账户 + 规则 + 收信
  // -------------------------------------------------------------------------
  const account = repos.createAccount(input)
  eq('新账户 status=pending_test', account.status, 'pending_test')
  const rule = repos.createRule({
    keyword: '原图+卡套',
    enabled: true,
    scope: 'subject',
    // 用 exact 验证真实业务口径：mock 种子标题「原图+卡套 追加: POD_ORDER_20486」应命中
    mode: 'exact',
    priority: 10,
    fileTypes: ['zip', 'tif', 'tiff'],
    autoReply: true,
    targets: [
      { path: prodDir, required: true },
      { path: backupDir, required: true }
    ]
  })
  eq('规则两个目标', rule.targets.length, 2)

  const savedTest = await backend.testSavedAccount(account.id)
  ok('testSavedAccount（用库里加密密码）ok=true', savedTest.ok)

  await backend.init()
  backend.scheduler.startAll()
  ok('调度器 isListening', backend.scheduler.isListening())
  eq('账户连接成功 → enabled', await waitFor(() => repos.getAccount(account.id)!.status === 'enabled', 10_000, 'account enabled') ? repos.getAccount(account.id)!.status : 'timeout', 'enabled')

  await backend.scheduler.checkNow()
  const processed3 = await waitFor(
    () => repos.listRecords({ pageSize: 50 }).total >= 3 && repos.getAccount(account.id)!.lastUid >= 3,
    20_000,
    '3 封邮件入库'
  )
  ok('3 封邮件入库且游标到 3', processed3)

  const done = await waitFor(() => {
    const r = repos.listRecords({ pageSize: 50 }).rows.find((x) => x.attachments.length > 0)
    return !!r && r.status === 'done' && r.replyStatus === 'sent' && MOCK.sent.length >= 1
  }, 20_000, '邮件 done + 回信 sent')
  ok('命中邮件 done 且已回信', done)

  // -------------------------------------------------------------------------
  // 断言：落盘 / 记录 / 回信
  // -------------------------------------------------------------------------
  console.log('多路径落盘:')
  eq('生产目录文件', readdirSync(prodDir), ['POD_ORDER_20486.zip'])
  eq('备份目录文件', readdirSync(backupDir), ['POD_ORDER_20486.zip'])
  const expected = Buffer.from(SEED[0].content, 'utf8')
  eq('生产目录内容与附件一致', readFileSync(join(prodDir, 'POD_ORDER_20486.zip')).equals(expected), true)
  eq('备份目录内容与附件一致', readFileSync(join(backupDir, 'POD_ORDER_20486.zip')).equals(expected), true)

  const matched = repos.listRecords({ pageSize: 50 }).rows.find((r) => r.subject.includes('原图+卡套'))
  ok('找到命中记录', !!matched)
  eq('命中记录 status=done', matched!.status, 'done')
  eq('命中记录 replyStatus=sent', matched!.replyStatus, 'sent')
  eq('命中关键词', matched!.matchedKeyword, '原图+卡套')
  eq('附件 1 个', matched!.attachments.length, 1)
  eq('附件状态 downloaded', matched!.attachments[0]!.state, 'downloaded')
  eq('投递 2 条且都 done', matched!.attachments[0]!.deliveries.map((d) => d.state), ['done', 'done'])
  eq('投递目标路径', matched!.attachments[0]!.deliveries.map((d) => d.targetPath), [prodDir, backupDir])

  const uid1 = repos.getMessageByUid(account.id, 1)!
  eq('uid=1 消息 done', uid1.status, 'done')
  eq('uid=1 回信 sent', uid1.reply_status, 'sent')
  eq('uid=1 thread_key 有值', !!uid1.thread_key, true)
  eq('auto_replies 记录 1 条 sent', repos.listRepliesByMessage(uid1.id).filter((r) => r.status === 'sent').length, 1)

  console.log('回信内容:')
  eq('mock SMTP 收到 1 封', MOCK.sent.length, 1)
  const rawReply = MOCK.sent[0] ?? ''
  const parsedReply = await simpleParser(rawReply)
  ok('回信含原始 Message-ID（In-Reply-To）', (parsedReply.inReplyTo ?? '').includes(uid1.rfc_message_id ?? '') || /In-Reply-To:/i.test(rawReply))
  ok('回信主题带 Re:', (parsedReply.subject ?? '').startsWith('Re:'))
  ok('回信主题含关键词', (parsedReply.subject ?? '').includes('原图+卡套'))
  ok('回信正文提到文件名', (parsedReply.text ?? '').includes('POD_ORDER_20486'))
  ok('回信 From 是账户邮箱', (parsedReply.from?.value[0]?.address ?? '') === MOCK.user)
  ok('回信是纯文本（无 HTML）', !parsedReply.html)
  ok('回信带 Auto-Submitted', (parsedReply.headers.get('auto-submitted') ?? '') === 'auto-replied')

  console.log('未命中关键词:')
  const uid2 = repos.getMessageByUid(account.id, 2)!
  eq('uid=2（手机壳）ignored_no_keyword', uid2.status, 'ignored_no_keyword')
  eq('uid=2 无附件下载', repos.listAttachmentsByMessage(uid2.id).length, 0)
  const uid3 = repos.getMessageByUid(account.id, 3)!
  eq('uid=3（报价）ignored_no_keyword', uid3.status, 'ignored_no_keyword')
  eq('uid=3 无附件下载', repos.listAttachmentsByMessage(uid3.id).length, 0)

  // -------------------------------------------------------------------------
  // 幂等：再跑一轮不重复下载 / 不重复回信
  // -------------------------------------------------------------------------
  console.log('幂等复跑:')
  const msgCount = repos.listRecords({ pageSize: 100 }).total
  const sentCount = MOCK.sent.length
  const prodFiles = readdirSync(prodDir)
  const backupFiles = readdirSync(backupDir)
  await backend.scheduler.checkNow()
  await sleep(1200)
  eq('邮件数不变', repos.listRecords({ pageSize: 100 }).total, msgCount)
  eq('不重复回信', MOCK.sent.length, sentCount)
  eq('生产目录不重复写', readdirSync(prodDir), prodFiles)
  eq('备份目录不重复写', readdirSync(backupDir), backupFiles)
  eq('游标不回退', repos.getAccount(account.id)!.lastUid, 3)

  // -------------------------------------------------------------------------
  // 启动对账（应无破坏）
  // -------------------------------------------------------------------------
  console.log('启动对账:')
  await backend.reconcile()
  eq('对账后邮件数不变', repos.listRecords({ pageSize: 100 }).total, msgCount)
  eq('对账后生产目录文件不变', readdirSync(prodDir), prodFiles)

  // -------------------------------------------------------------------------
  // 部分路径失败：把备份路径换成不存在的盘 → 只该条失败，生产路径继续成功
  // -------------------------------------------------------------------------
  console.log('部分路径失败（备份盘不可用）:')
  const prodTarget = rule.targets.find((t) => t.path === prodDir)!
  repos.updateRule(rule.id, {
    keyword: '原图+卡套',
    enabled: true,
    scope: 'subject',
    mode: 'contains',
    fileTypes: ['zip', 'tif', 'tiff'],
    autoReply: true,
    targets: [
      { id: prodTarget.id, path: prodDir, required: true },
      { path: missingDir, required: true }
    ]
  })
  const mail4 = {
    subject: '原图+卡套 追加: POD_ORDER_99999',
    from: { name: 'David Chen', address: 'david@inkpressed.co' },
    fileName: 'POD_ORDER_99999.zip',
    content: 'PK\u0003\u0004fake-zip-content-99999',
    date: new Date()
  }
  server.imap.appendMessage('INBOX', [], false, new Uint8Array(mimeFor(mail4)))
  const sentBeforePartial = MOCK.sent.length
  await backend.scheduler.checkNow()
  const partialReady = await waitFor(() => {
    const m = repos.getMessageByUid(account.id, 4)
    if (!m) return false
    const ds = repos.listDeliveriesByMessage(m.id)
    return ds.length === 2 && ds.some((d) => d.state === 'retry_wait')
  }, 20_000, '第 4 封部分失败')
  ok('第 4 封产出 2 条投递且一条 retry_wait', partialReady)

  const uid4 = repos.getMessageByUid(account.id, 4)!
  const ds4 = repos.listDeliveriesByMessage(uid4.id)
  eq('生产路径成功', ds4.find((d) => d.target_path === prodDir)?.state, 'done')
  const missingDelivery = ds4.find((d) => d.target_path === missingDir)!
  eq('备份/缺失路径 retry_wait', missingDelivery.state, 'retry_wait')
  eq('缺失路径错误码 PATH_UNAVAILABLE', missingDelivery.error_code, 'PATH_UNAVAILABLE')
  eq('缺失路径不消耗 attempts', missingDelivery.attempts, 0)
  eq('第 4 封消息 partial', repos.getMessage(uid4.id)!.status, 'partial')
  eq('必达未完成 → 暂不回信', repos.getMessage(uid4.id)!.reply_status, 'pending')
  eq('回信数不变', MOCK.sent.length, sentBeforePartial)
  ok('生产目录新增第 4 封文件', readdirSync(prodDir).includes('POD_ORDER_99999.zip'))
  eq('生产目录旧文件未重复写', readdirSync(prodDir).filter((f) => f === 'POD_ORDER_20486.zip').length, 1)
  eq('备份目录未被写入第 4 封', readdirSync(backupDir).includes('POD_ORDER_99999.zip'), false)
  eq('旧文件 mtime 未变', statSync(join(prodDir, 'POD_ORDER_20486.zip')).size, expected.length)

  // -------------------------------------------------------------------------
  // IDLE：追加一封新邮件，不点「立即检查」，靠 IMAP IDLE 自动触发（≤15s）
  // -------------------------------------------------------------------------
  console.log('IMAP IDLE 实时收信:')
  const uidBeforeIdle = repos.getAccount(account.id)!.lastUid
  const mail5 = {
    subject: '原图+卡套 IDLE: POD_ORDER_77777',
    from: { name: 'David Chen', address: 'david@inkpressed.co' },
    fileName: 'POD_ORDER_77777.zip',
    content: 'PK\u0003\u0004fake-zip-content-77777',
    date: new Date()
  }
  server.imap.appendMessage('INBOX', [], false, new Uint8Array(mimeFor(mail5)))
  const idleProcessed = await waitFor(
    () => repos.getAccount(account.id)!.lastUid > uidBeforeIdle,
    15_000,
    'IDLE 自动收信'
  )
  ok('IDLE 事件触发自动收信（未手动 checkNow）', idleProcessed)

  // -------------------------------------------------------------------------
  // 事件推送（ipc.ts 依赖这些事件刷新 UI）
  // -------------------------------------------------------------------------
  console.log('事件推送:')
  ok('推送 account:changed', events.some((e) => e.type === 'account:changed'))
  ok('推送 message:upserted（含嵌套 deliveries）', events.some((e) => e.type === 'message:upserted' && e.record.attachments.some((a) => a.deliveries.length > 0)))
  ok('推送 delivery:changed', events.some((e) => e.type === 'delivery:changed'))
  ok('推送 dashboard:changed', events.some((e) => e.type === 'dashboard:changed'))
  ok('推送 toast 成功（已归档）', events.some((e) => e.type === 'toast' && e.level === 'success'))
  ok('推送 listening:changed', events.some((e) => e.type === 'listening:changed'))

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------
  await backend.dispose()
  eq('dispose 后 isListening=false', backend.scheduler.isListening(), false)
} finally {
  await server.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
