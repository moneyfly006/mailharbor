/**
 * scheduler.ts 单测（注入假 Provider + 假 pipeline，不连邮箱）
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-scheduler.ts
 */
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from '../src/main/schema.ts'
import * as repos from '../src/main/repos.ts'
import { PLAIN_CODEC } from '../src/main/repos.ts'
import { Scheduler, AUTH_RETRY_MS, type SchedulerProvider } from '../src/main/scheduler.ts'
import type { Account, MainEvent } from '../shared/types.ts'
import type { InboundMessage, ProviderConfig, SyncState } from '../src/main/providers/imap.ts'

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
async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > timeoutMs) return false
    await sleep(20)
  }
  return true
}

const db = new Database(':memory:')
db.pragma('foreign_keys=ON')
db.exec(SCHEMA)
repos.configureRepos({ db, codec: PLAIN_CODEC })
const tmpDir = mkdtempSync(join(tmpdir(), 'mh-sched-'))

function makeAccount(email: string, host = 'imap.ok.test'): Account {
  return repos.createAccount({
    preset: 'custom',
    email,
    imapHost: host,
    imapPort: 993,
    imapSecure: 'ssl',
    imapUser: email,
    smtpHost: 'smtp.ok.test',
    smtpPort: 465,
    smtpSecure: 'ssl',
    smtpUser: email,
    smtpSameAsImap: true,
    password: 'secret-pass'
  })
}

const okAccount = makeAccount('ok@mailharbor.test')
const failAccount = makeAccount('offline@mailharbor.test', 'imap.offline.test')
const authAccount = makeAccount('auth@mailharbor.test', 'imap.auth.test')
const disabledAccount = makeAccount('disabled@mailharbor.test', 'imap.disabled.test')
repos.setAccountEnabled(disabledAccount.id, false)
const noPassAccount = makeAccount('nopass@mailharbor.test', 'imap.nopass.test')
db.prepare('UPDATE accounts SET imap_pass_enc=NULL WHERE id=?').run(noPassAccount.id)

const msg = (uid: number): InboundMessage => ({
  uid,
  rfcMessageId: `<msg-${uid}@test>`,
  references: [],
  threadKey: `<msg-${uid}@test>`,
  subject: `原图+卡套 ${uid}`,
  fromAddr: 'david@inkpressed.co',
  fromName: 'David',
  receivedAt: Date.now(),
  bodyText: 'body',
  parts: [],
  autoSubmitted: false
})

const createdProviders: FakeProvider[] = []
class FakeProvider implements SchedulerProvider {
  connected = false
  fetchCalls = 0
  idleCb: (() => void) | null = null
  disconnected = false
  readonly cfg: ProviderConfig
  private behavior: { batches?: InboundMessage[][]; failConnect?: unknown }
  constructor(cfg: ProviderConfig, behavior: { batches?: InboundMessage[][]; failConnect?: unknown }) {
    this.cfg = cfg
    this.behavior = behavior
  }
  async connect(): Promise<SyncState> {
    if (this.behavior.failConnect) throw this.behavior.failConnect
    this.connected = true
    return { uidValidity: '1', uidNext: 100, exists: 1, lastSeenUid: 0 }
  }
  async fetchNewMessages(opts: { lastUid: number }): Promise<InboundMessage[]> {
    this.fetchCalls++
    const batch = this.behavior.batches?.shift() ?? []
    return batch.filter((m) => m.uid > opts.lastUid)
  }
  async startIdle(cb: () => void): Promise<void> {
    this.idleCb = cb
  }
  async stopIdle(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnectCalls++
    this.connected = false
    this.disconnected = true
  }
  disconnectCalls = 0
  isConnected(): boolean {
    return this.connected
  }
}

const events: MainEvent[] = []
const processed: Array<{ accountId: number; uid: number }> = []
const pipeline = {
  async process(account: Account, _provider: unknown, m: InboundMessage) {
    processed.push({ accountId: account.id, uid: m.uid })
    return { messageId: m.uid, status: 'queued' }
  }
}
const settings: Record<string, unknown> = { pollIntervalSec: 30 }

const scheduler = new Scheduler({
  emit: (e) => events.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  pipeline,
  createProvider: (account, cfg) => {
    let behavior: { batches?: InboundMessage[][]; failConnect?: unknown } = {}
    if (account.id === okAccount.id) behavior = { batches: [[msg(5), msg(6)]] }
    else if (account.id === failAccount.id) behavior = { failConnect: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
    else if (account.id === authAccount.id) behavior = { failConnect: Object.assign(new Error('LOGIN failed'), { authenticationFailed: true }) }
    else behavior = { batches: [[]] }
    const p = new FakeProvider(cfg, behavior)
    createdProviders.push(p)
    return p
  }
})

console.log('启动 / 收信:')
scheduler.startAll()
ok('startAll 后 isListening=true', scheduler.isListening())
ok('发出 listening:changed 事件', events.some((e) => e.type === 'listening:changed' && e.listening === true))
ok('只在启用账户上建了 provider（disabled/nopass 跳过）', createdProviders.length >= 3)
ok('等待首轮 poll 处理完成', await waitFor(() => processed.length === 2))
eq('按 UID 顺序处理', processed.map((p) => p.uid), [5, 6])
await waitFor(() => repos.getAccount(okAccount.id)!.status === 'enabled')
eq('连接成功 → status enabled', repos.getAccount(okAccount.id)!.status, 'enabled')
eq('lastUid 推进到 6', repos.getAccount(okAccount.id)!.lastUid, 6)
eq('uidValidity 落库', repos.getAccount(okAccount.id)!.uidValidity, '1')
eq('不处理 disabled 账户', processed.some((p) => p.accountId === disabledAccount.id), false)
eq('不处理无密码账户', processed.some((p) => p.accountId === noPassAccount.id), false)
ok('nextCheckAt 是数字', typeof scheduler.nextCheckAt() === 'number')

console.log('手动检查 / 增量:')
await scheduler.checkNow()
eq('没有新邮件不重复处理', processed.length, 2)
const okProvider = createdProviders.find((p) => p.cfg.email === okAccount.email)!
eq('fetchNewMessages 被调用', okProvider.fetchCalls >= 2, true)
ok('provider 已进入 IDLE', !!okProvider.idleCb)
eq('游标/健康状态变化不重建 provider', createdProviders.filter((p) => p.cfg.email === okAccount.email).length, 1)

console.log('失败退避:')
await waitFor(() => repos.getAccount(failAccount.id)!.status === 'offline')
eq('网络失败 → offline', repos.getAccount(failAccount.id)!.status, 'offline')
eq('网络失败错误码', repos.getAccount(failAccount.id)!.lastErrorCode, 'PORT_BLOCKED')
eq('认证失败 → auth_failed', repos.getAccount(authAccount.id)!.status, 'auth_failed')
ok('认证失败推送 toast', events.some((e) => e.type === 'toast' && e.level === 'error' && e.title.includes('重新设置密码')))
ok('认证失败推送 account:changed', events.some((e) => e.type === 'account:changed' && e.account.id === authAccount.id))

console.log('pause / resume:')
scheduler.pause()
eq('pause 后 isListening=false', scheduler.isListening(), false)
eq('pause 后 nextCheckAt=null', scheduler.nextCheckAt(), null)
ok('pause 推送 listening:changed false', events.some((e) => e.type === 'listening:changed' && e.listening === false))
await scheduler.resume()
eq('resume 后 isListening=true', scheduler.isListening(), true)
eq('resume 后 nextCheckAt 有值', typeof scheduler.nextCheckAt(), 'number')

console.log('IDLE 回调触发轮询:')
const before = processed.length
okProvider.idleCb?.()
await waitFor(() => okProvider.fetchCalls >= 3)
eq('IDLE 触发后无新邮件不重复处理', processed.length, before)

console.log('stopAll:')
scheduler.stopAll()
eq('stopAll 后 isListening=false', scheduler.isListening(), false)
ok('停止时断开 provider', okProvider.disconnectCalls > 0)

console.log('认证失败 30 分钟重试间隔:')
// 重新放一个 scheduler 验证 nextAttemptAt 计算
const authEv: MainEvent[] = []
// 只留 authAccount 启用，便于断言它的 30 分钟重试间隔
repos.setAccountEnabled(okAccount.id, false)
repos.setAccountEnabled(failAccount.id, false)
repos.setAccountEnabled(noPassAccount.id, false)
const s2 = new Scheduler({
  emit: (e) => authEv.push(e),
  getSetting: <T>(k: string) => settings[k] as T,
  pipeline,
  createProvider: (_account, cfg) =>
    new FakeProvider(cfg, { failConnect: Object.assign(new Error('LOGIN failed'), { authenticationFailed: true }) })
})
s2.startAll()
await waitFor(() => {
  const n = s2.nextCheckAt()
  return n !== null && n > Date.now() + AUTH_RETRY_MS - 60_000
})
const next = s2.nextCheckAt()
const now = Date.now()
ok('认证失败后 nextCheckAt ≥ 约 30 分钟后', next !== null && next >= now + AUTH_RETRY_MS - 5000)
s2.stopAll()
repos.setAccountEnabled(okAccount.id, true)
repos.setAccountEnabled(failAccount.id, true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
