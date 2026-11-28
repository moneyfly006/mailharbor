/**
 * 数据仓库层（better-sqlite3 同步查询）。
 *
 * 设计要点：
 *  - 纯 DB 层，不依赖 electron —— DB 实例与密码编解码器由 backend 装配时注入（configureRepos）。
 *    这样 repos 单测可以直接用 :memory: / 临时文件数据库跑，不需要 electron 运行时。
 *  - 时间统一 UTC 毫秒（INTEGER），布尔 0/1。
 *  - 所有对外结构严格对齐 `@shared/types.ts`（Account / Rule / RecordRow / Delivery）。
 *  - 幂等键：messages(account_id,imap_uid)、attachments(message_id,part_id)、
 *    deliveries(attachment_id,target_id)、auto_replies(account_id,thread_key) WHERE status='sent'。
 */
import type {
  Account, AccountInput, AccountStatus, Delivery, DeliveryState, DiskInfo, Encryption,
  ListRecordsQuery, ListRecordsResult, MatchMode, MatchScope, MessageStatus, ProviderPreset,
  RecordRow, ReplyStatus, Rule, RuleInput, RuleTarget, TargetHealth
} from '@shared/types'
import type { DB } from './db'
import { accessSync, constants as FS, statfsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 装配 / 类型
// ---------------------------------------------------------------------------
/** node:sqlite 的 BLOB 读出来是 Uint8Array，better-sqlite3 是 Buffer，两者都接受 */
export type SecretBlob = Buffer | Uint8Array | null | undefined

export interface SecretsCodec {
  encrypt(plain: string): Buffer
  decrypt(buf: SecretBlob): string
}

/** 兜底编解码器：仅用于测试 / 没有 electron safeStorage 的场景（与 db.ts 的 plain: 前缀兼容） */
export const PLAIN_CODEC: SecretsCodec = {
  encrypt: (plain) => (plain ? Buffer.from(`plain:${plain}`, 'utf8') : Buffer.alloc(0)),
  decrypt: (buf) => {
    if (!buf || buf.length === 0) return ''
    const s = Buffer.from(buf).toString('utf8')
    return s.startsWith('plain:') ? s.slice(6) : ''
  }
}

let dbRef: DB | null = null
let codec: SecretsCodec = PLAIN_CODEC

/** backend 启动时注入数据库与密码编解码器（electron safeStorage 实现在 db.ts） */
export function configureRepos(opts: { db: DB; codec?: SecretsCodec }): void {
  dbRef = opts.db
  if (opts.codec) codec = opts.codec
}

/** 单测用：解绑当前数据库（不关闭） */
export function resetReposForTests(): void {
  dbRef = null
  codec = PLAIN_CODEC
  healthCache.clear()
}

function db(): DB {
  if (!dbRef) throw new Error('数据层未初始化：请先 configureRepos({ db })')
  return dbRef
}

const now = (): number => Date.now()

/** 本地时区今天 00:00 的毫秒时间戳 */
export function startOfToday(at: number = now()): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function safeJsonArray(s: string | null | undefined, fallback: string[] = []): string[] {
  if (!s) return fallback
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(String) : fallback
  } catch {
    return fallback
  }
}

const bool = (v: number | null | undefined): boolean => !!v
const bit = (v: boolean | undefined): number => (v ? 1 : 0)

// ---------------------------------------------------------------------------
// 原始行类型（与 DDL 一一对应）
// ---------------------------------------------------------------------------
export interface AccountRow {
  id: number
  preset: ProviderPreset
  email: string
  display_name: string | null
  enabled: number
  status: AccountStatus
  imap_host: string
  imap_port: number
  imap_secure: Encryption
  imap_user: string
  imap_pass_enc: SecretBlob
  smtp_host: string
  smtp_port: number
  smtp_secure: Encryption
  smtp_user: string
  smtp_from_name: string | null
  smtp_same_as_imap: number
  smtp_pass_enc: SecretBlob
  allow_self_signed: number
  send_only: number
  last_check_at: number | null
  last_ok_at: number | null
  last_error_code: string | null
  last_error: string | null
  uid_validity: string | null
  last_uid: number
  created_at: number
  updated_at: number
}

export interface RuleRow {
  id: number
  keyword: string
  enabled: number
  scope: MatchScope
  mode: MatchMode
  priority: number
  file_types: string
  auto_reply: number
  hit_messages: number
  hit_files: number
  last_hit_at: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

export interface TargetRow {
  id: number
  rule_id: number
  path: string
  required: number
  sort_order: number
  enabled: number
  deleted_at: number | null
  created_at: number
}

export interface MessageRow {
  id: number
  account_id: number
  imap_uid: number
  provider_message_id: string | null
  thread_key: string | null
  rfc_message_id: string | null
  subject: string | null
  from_addr: string | null
  from_name: string | null
  received_at: number | null
  matched_rule_id: number | null
  matched_keyword: string | null
  match_source: string | null
  status: MessageStatus
  reply_status: ReplyStatus
  error: string | null
  links: string | null
  mailbox: string | null
  auto_retry_count: number
  next_retry_at: number | null
  created_at: number
  updated_at: number
}

export interface AttachmentRow {
  id: number
  message_id: number
  part_id: string
  filename: string
  mime_type: string | null
  declared_size: number | null
  tmp_path: string | null
  sha256: string | null
  size: number | null
  status: 'pending' | 'downloaded' | 'failed' | 'skipped'
  extracted_count: number
  extract_skipped: number
  extract_error: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export interface DeliveryRow {
  id: number
  message_id: number
  attachment_id: number
  target_id: number
  target_path: string
  required: number
  state: DeliveryState
  attempts: number
  next_retry_at: number | null
  saved_path: string | null
  saved_name: string | null
  size: number | null
  sha256: string | null
  error_code: string | null
  error: string | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
}

export interface ReplyRow {
  id: number
  account_id: number
  message_id: number
  thread_key: string
  to_addr: string
  subject: string | null
  body_preview: string | null
  status: 'sent' | 'failed' | 'suppressed'
  provider_message_id: string | null
  error: string | null
  sent_at: number | null
  created_at: number
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------
function mapAccount(r: AccountRow, todayCount = 0, totalFiles = 0): Account {
  return {
    id: r.id,
    preset: r.preset,
    email: r.email,
    displayName: r.display_name ?? '',
    status: r.status,
    enabled: bool(r.enabled),
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: r.imap_secure,
    imapUser: r.imap_user,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: r.smtp_secure,
    smtpUser: r.smtp_user,
    smtpFromName: r.smtp_from_name ?? '',
    smtpSameAsImap: bool(r.smtp_same_as_imap),
    allowSelfSigned: bool(r.allow_self_signed ?? 0),
    sendOnly: bool(r.send_only ?? 0),
    hasPassword: !!r.imap_pass_enc && r.imap_pass_enc.length > 0,
    lastCheckAt: r.last_check_at,
    lastOkAt: r.last_ok_at,
    lastErrorCode: r.last_error_code,
    lastError: r.last_error,
    lastUid: r.last_uid,
    uidValidity: r.uid_validity,
    todayCount,
    totalFiles,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    messageId: r.message_id,
    attachmentId: r.attachment_id,
    targetId: r.target_id,
    targetPath: r.target_path,
    required: bool(r.required),
    state: r.state,
    attempts: r.attempts,
    nextRetryAt: r.next_retry_at,
    savedPath: r.saved_path,
    savedName: r.saved_name,
    size: r.size,
    errorCode: r.error_code,
    error: r.error,
    finishedAt: r.finished_at
  }
}

// ---------------------------------------------------------------------------
// 目标路径健康检查（同步版，供概览/规则页）
// ---------------------------------------------------------------------------
export interface TargetHealthInfo {
  health: TargetHealth
  freeBytes: number | null
  totalBytes: number | null
}

/** 磁盘剩余 < 2GB 视为低空间（ARCHITECTURE §11.1 TargetHealth） */
export const LOW_SPACE_BYTES = 2 * 1024 * 1024 * 1024
const HEALTH_TTL_MS = 30_000

interface HealthCacheEntry extends TargetHealthInfo {
  checkedAt: number
}

const healthCache = new Map<string, HealthCacheEntry>()

function healthKey(path: string): string {
  return resolve(path)
}

/** 同步检查一个目录：存在、是目录、可写、剩余空间 */
export function checkDiskHealth(path: string): TargetHealthInfo {
  try {
    if (!path) return { health: 'unknown', freeBytes: null, totalBytes: null }
    const st = statSync(path)
    if (!st.isDirectory()) return { health: 'unavailable', freeBytes: null, totalBytes: null }
    accessSync(path, FS.W_OK)
    const fsStat = statfsSync(path)
    const free = Number(fsStat.bavail) * Number(fsStat.bsize)
    const total = Number(fsStat.blocks) * Number(fsStat.bsize)
    return { health: free < LOW_SPACE_BYTES ? 'low_space' : 'ok', freeBytes: free, totalBytes: total }
  } catch {
    return { health: 'unavailable', freeBytes: null, totalBytes: null }
  }
}

/** 批量写入健康检查缓存（backend 定时刷新 / 规则页点开时刷新） */
export function setTargetsHealth(entries: Array<{ path: string; health: TargetHealth; freeBytes: number | null; totalBytes: number | null }>): void {
  const at = now()
  for (const e of entries) healthCache.set(healthKey(e.path), { ...e, checkedAt: at })
}

export function clearTargetsHealthCache(): void {
  healthCache.clear()
}

function healthOf(path: string, allowCheck = true): TargetHealthInfo & { lastHealth: TargetHealth | null } {
  const key = healthKey(path)
  const hit = healthCache.get(key)
  if (hit && now() - hit.checkedAt < HEALTH_TTL_MS) {
    return { health: hit.health, freeBytes: hit.freeBytes, totalBytes: hit.totalBytes, lastHealth: hit.health }
  }
  if (!allowCheck) return { health: 'unknown', freeBytes: null, totalBytes: null, lastHealth: hit?.health ?? null }
  const info = checkDiskHealth(path)
  healthCache.set(key, { ...info, checkedAt: now() })
  return { ...info, lastHealth: info.health }
}

/** 刷新所有启用规则的目标路径健康（规则页 / 概览角标用） */
export function refreshTargetsHealth(): void {
  const rows = db()
    .prepare(
      `SELECT t.path FROM rule_targets t JOIN rules r ON r.id=t.rule_id
       WHERE t.deleted_at IS NULL AND t.enabled=1 AND r.deleted_at IS NULL AND r.enabled=1`
    )
    .all() as Array<{ path: string }>
  const at = now()
  for (const r of rows) {
    const info = checkDiskHealth(r.path)
    healthCache.set(healthKey(r.path), { ...info, checkedAt: at })
  }
}

// ---------------------------------------------------------------------------
// 账户
// ---------------------------------------------------------------------------
export function listAccounts(): Account[] {
  const rows = db().prepare('SELECT * FROM accounts ORDER BY id ASC').all() as AccountRow[]
  const today = startOfToday()
  const todayRows = db()
    .prepare('SELECT account_id, COUNT(*) AS c FROM messages WHERE received_at >= ? GROUP BY account_id')
    .all(today) as Array<{ account_id: number; c: number }>
  const fileRows = db()
    .prepare(
      `SELECT m.account_id AS account_id, COUNT(DISTINCT d.attachment_id) AS c
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.state='done' GROUP BY m.account_id`
    )
    .all() as Array<{ account_id: number; c: number }>
  const tMap = new Map(todayRows.map((r) => [r.account_id, r.c]))
  const fMap = new Map(fileRows.map((r) => [r.account_id, r.c]))
  return rows.map((r) => mapAccount(r, tMap.get(r.id) ?? 0, fMap.get(r.id) ?? 0))
}

export function getAccount(id: number): Account | null {
  const row = db().prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined
  if (!row) return null
  return mapAccount(row, accountTodayCount(id), accountTotalFiles(id))
}

export function getAccountRow(id: number): AccountRow | null {
  return (db().prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined) ?? null
}

export function listEnabledAccounts(): Account[] {
  const rows = db().prepare('SELECT * FROM accounts WHERE enabled=1 AND status != ? ORDER BY id ASC').all('disabled') as AccountRow[]
  const today = startOfToday()
  const tMap = new Map(
    (db().prepare('SELECT account_id, COUNT(*) AS c FROM messages WHERE received_at >= ? GROUP BY account_id').all(today) as Array<{ account_id: number; c: number }>).map(
      (r) => [r.account_id, r.c]
    )
  )
  return rows.map((r) => mapAccount(r, tMap.get(r.id) ?? 0, 0))
}

/** 读取解密后的密码（只在内核服务里用，绝不进日志 / 事件） */
export function getAccountSecrets(id: number): { imapPass: string; smtpPass: string } {
  const row = getAccountRow(id)
  if (!row) return { imapPass: '', smtpPass: '' }
  const imapPass = codec.decrypt(row.imap_pass_enc)
  const smtpPass = row.smtp_same_as_imap ? imapPass : codec.decrypt(row.smtp_pass_enc)
  return { imapPass, smtpPass }
}

export function createAccount(input: AccountInput): Account {
  const email = (input.email ?? '').trim()
  const sendOnly = !!input.sendOnly
  // 只发件账户（如阿里云 DirectMail）没有 IMAP，用邮箱地址兜底当用户名
  const imapUser = (input.imapUser ?? '').trim() || (sendOnly ? email : '')
  if (!email) throw new Error('请填写邮箱地址')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱地址格式不正确')
  if (!sendOnly && !input.imapHost?.trim()) throw new Error('请填写 IMAP 服务器地址（只发信的账户请勾选「仅发件」）')
  if (!sendOnly && !imapUser) throw new Error('请填写 IMAP 用户名')
  if (!input.smtpHost?.trim()) throw new Error('请填写 SMTP 服务器地址')
  if (!input.password) throw new Error('请填写应用专用密码 / 授权码')
  const smtpPass = input.smtpSameAsImap ? input.password : input.smtpPassword ?? ''
  if (!input.smtpSameAsImap && !smtpPass) throw new Error('请填写 SMTP 密码')

  const ts = now()
  try {
    const info = db()
      .prepare(
        `INSERT INTO accounts(
           preset,email,display_name,enabled,status,
           imap_host,imap_port,imap_secure,imap_user,imap_pass_enc,
           smtp_host,smtp_port,smtp_secure,smtp_user,smtp_from_name,smtp_same_as_imap,smtp_pass_enc,allow_self_signed,send_only,
           uid_validity,last_uid,created_at,updated_at
         ) VALUES(?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?,?, NULL,0,?,?)`
      )
      .run(
        input.preset,
        email,
        input.displayName?.trim() || email.split('@')[0],
        1,
        'pending_test',
        input.imapHost?.trim() ?? '',
        Number(input.imapPort) || 993,
        input.imapSecure,
        imapUser,
        codec.encrypt(input.password),
        input.smtpHost.trim(),
        Number(input.smtpPort) || 465,
        input.smtpSecure,
        (input.smtpUser?.trim() || imapUser),
        input.smtpFromName?.trim() || 'MailHarbor 收货助手',
        bit(input.smtpSameAsImap),
        codec.encrypt(smtpPass),
        bit(input.allowSelfSigned),
        bit(sendOnly),
        ts,
        ts
      )
    return getAccount(Number(info.lastInsertRowid)) as Account
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) throw new Error('该邮箱服务器 + 账号已存在，请勿重复添加')
    throw new Error(`保存账户失败：${msg}`)
  }
}

export function updateAccount(id: number, input: AccountInput): Account {
  const old = getAccountRow(id)
  if (!old) throw new Error('账户不存在或已被删除')
  const email = (input.email ?? '').trim()
  if (!email) throw new Error('请填写邮箱地址')
  const imapUser = (input.imapUser ?? '').trim()
  const sendOnly = !!input.sendOnly
  if (!sendOnly && !input.imapHost?.trim()) throw new Error('请填写 IMAP 服务器地址（只发信的账户请勾选「仅发件」）')
  if (!input.smtpHost?.trim()) throw new Error('请填写 SMTP 服务器地址')

  const toBuffer = (b: SecretBlob): Buffer | null => (b ? Buffer.from(b) : null)
  const newImapPass = input.password ? codec.encrypt(input.password) : toBuffer(old.imap_pass_enc)
  const smtpSame = !!input.smtpSameAsImap
  let newSmtpPass: Buffer | null
  if (smtpSame) newSmtpPass = input.password ? codec.encrypt(input.password) : toBuffer(old.smtp_pass_enc)
  else if (input.smtpPassword) newSmtpPass = codec.encrypt(input.smtpPassword)
  else newSmtpPass = toBuffer(old.smtp_pass_enc)

  const changedConfig =
    'password' in input && !!input.password
      ? true
      : old.imap_host !== input.imapHost.trim() ||
        old.imap_port !== (Number(input.imapPort) || 993) ||
        old.imap_secure !== input.imapSecure ||
        old.imap_user !== imapUser ||
        old.smtp_host !== input.smtpHost.trim() ||
        old.smtp_port !== (Number(input.smtpPort) || 465) ||
        old.smtp_secure !== input.smtpSecure ||
        old.smtp_user !== (input.smtpUser?.trim() || imapUser) ||
        old.email !== email ||
        old.smtp_same_as_imap !== bit(smtpSame)

  const nextStatus: AccountStatus = !old.enabled ? 'disabled' : changedConfig ? 'pending_test' : old.status
  try {
    db()
      .prepare(
        `UPDATE accounts SET
           preset=?, email=?, display_name=?, status=?,
           imap_host=?, imap_port=?, imap_secure=?, imap_user=?, imap_pass_enc=?,
           smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_from_name=?, smtp_same_as_imap=?, smtp_pass_enc=?,
           allow_self_signed=?, send_only=?,
           last_error_code=?, last_error=?, updated_at=?
         WHERE id=?`
      )
      .run(
        input.preset,
        email,
        input.displayName?.trim() || email.split('@')[0],
        nextStatus,
        input.imapHost?.trim() ?? '',
        Number(input.imapPort) || 993,
        input.imapSecure,
        imapUser,
        newImapPass,
        input.smtpHost.trim(),
        Number(input.smtpPort) || 465,
        input.smtpSecure,
        input.smtpUser?.trim() || imapUser,
        input.smtpFromName?.trim() || 'MailHarbor 收货助手',
        bit(smtpSame),
        newSmtpPass,
        bit(!!input.allowSelfSigned),
        bit(!!input.sendOnly),
        changedConfig ? null : old.last_error_code,
        changedConfig ? null : old.last_error,
        now(),
        id
      )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) throw new Error('该邮箱服务器 + 账号已存在，请勿重复添加')
    throw new Error(`保存账户失败：${msg}`)
  }
  return getAccount(id) as Account
}

export function deleteAccount(id: number): void {
  db().prepare('DELETE FROM accounts WHERE id=?').run(id)
}

export function setAccountEnabled(id: number, enabled: boolean): Account {
  const row = getAccountRow(id)
  if (!row) throw new Error('账户不存在或已被删除')
  const status: AccountStatus = enabled ? (row.status === 'disabled' ? 'pending_test' : row.status) : 'disabled'
  db().prepare('UPDATE accounts SET enabled=?, status=?, updated_at=? WHERE id=?').run(bit(enabled), status, now(), id)
  return getAccount(id) as Account
}

export function setAccountStatus(
  id: number,
  status: AccountStatus,
  opts: { errorCode?: string | null; error?: string | null; checked?: boolean; ok?: boolean } = {}
): void {
  const ts = now()
  // 注意：健康/状态变化不算"配置变更"，不动 updated_at（scheduler 用它判断是否重建连接）
  db()
    .prepare(
      `UPDATE accounts SET status=?, last_error_code=?, last_error=?,
         last_check_at=CASE WHEN ? THEN ? ELSE last_check_at END,
         last_ok_at=CASE WHEN ? THEN ? ELSE last_ok_at END
       WHERE id=?`
    )
    .run(
      status,
      opts.errorCode ?? null,
      opts.error ?? null,
      opts.checked ? 1 : 0,
      ts,
      opts.ok ? 1 : 0,
      ts,
      id
    )
}

/** 增量收信游标 / 健康时间 */
// ---------------------------------------------------------------------------
// OAuth 令牌（Gmail API 加速用；client_secret 与 refresh_token 均加密存储）
// ---------------------------------------------------------------------------
export interface OAuthTokenRow {
  account_id: number
  provider: string
  email: string
  client_id: string
  client_secret_enc: SecretBlob | null
  refresh_token_enc: SecretBlob | null
  access_token: string | null
  expiry: number | null
  last_error: string | null
  updated_at: number
}

export function saveOAuthToken(input: {
  accountId: number
  provider: string
  email: string
  clientId: string
  clientSecret: string
  refreshToken: string | null
  accessToken?: string | null
  expiry?: number | null
}): void {
  db()
    .prepare(
      `INSERT INTO oauth_tokens(account_id,provider,email,client_id,client_secret_enc,refresh_token_enc,access_token,expiry,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET
         provider=excluded.provider, email=excluded.email, client_id=excluded.client_id,
         client_secret_enc=excluded.client_secret_enc,
         refresh_token_enc=COALESCE(excluded.refresh_token_enc, refresh_token_enc),
         access_token=excluded.access_token, expiry=excluded.expiry, last_error=NULL, updated_at=excluded.updated_at`
    )
    .run(
      input.accountId,
      input.provider,
      input.email,
      input.clientId,
      codec.encrypt(input.clientSecret),
      input.refreshToken ? codec.encrypt(input.refreshToken) : null,
      input.accessToken ?? null,
      input.expiry ?? null,
      now()
    )
}

export function getOAuthToken(accountId: number): OAuthTokenRow | null {
  return (db().prepare('SELECT * FROM oauth_tokens WHERE account_id=?').get(accountId) as OAuthTokenRow | undefined) ?? null
}

export function getOAuthSecrets(accountId: number): { clientSecret: string; refreshToken: string } {
  const row = getOAuthToken(accountId)
  if (!row) return { clientSecret: '', refreshToken: '' }
  return {
    clientSecret: codec.decrypt(row.client_secret_enc),
    refreshToken: codec.decrypt(row.refresh_token_enc)
  }
}

export function listOAuthTokens(): OAuthTokenRow[] {
  return db().prepare('SELECT * FROM oauth_tokens').all() as OAuthTokenRow[]
}

/** 记录授权错误（refresh_token 失效等），供 UI 提示重新授权 */
export function markOAuthError(accountId: number, error: string | null): void {
  db().prepare('UPDATE oauth_tokens SET last_error=?, updated_at=updated_at WHERE account_id=?').run(error, accountId)
}

export function deleteOAuthToken(accountId: number): void {
  db().prepare('DELETE FROM oauth_tokens WHERE account_id=?').run(accountId)
}

export function getAccountSpamState(id: number): { lastUid: number; uidValidity: string | null } | null {
  const row = db().prepare('SELECT spam_last_uid, spam_uid_validity FROM accounts WHERE id=?').get(id) as
    | { spam_last_uid: number; spam_uid_validity: string | null }
    | undefined
  if (!row) return null
  return { lastUid: row.spam_last_uid ?? 0, uidValidity: row.spam_uid_validity }
}

export function updateAccountSpamState(id: number, lastUid: number, uidValidity: string | null): void {
  db().prepare('UPDATE accounts SET spam_last_uid=?, spam_uid_validity=? WHERE id=?').run(lastUid, uidValidity, id)
}

export function updateAccountSyncState(
  id: number,
  state: { lastUid?: number; uidValidity?: string | null; lastCheckAt?: number; lastOkAt?: number }
): void {
  const row = getAccountRow(id)
  if (!row) return
  // 游标/健康不是配置变更：不更新 updated_at（否则 scheduler 每轮都会重建连接）
  db()
    .prepare(
      `UPDATE accounts SET last_uid=?, uid_validity=?, last_check_at=?, last_ok_at=? WHERE id=?`
    )
    .run(
      state.lastUid ?? row.last_uid,
      state.uidValidity === undefined ? row.uid_validity : state.uidValidity,
      state.lastCheckAt ?? row.last_check_at,
      state.lastOkAt ?? row.last_ok_at,
      id
    )
}

/** 补扫历史邮件：把游标退回起点，让 pipeline 重新扫一遍（已完成的会跳过，忽略的会重试） */
export function resetAccountCursor(accountId: number): void {
  db().prepare('UPDATE accounts SET last_uid=0 WHERE id=?').run(accountId)
}

/** 需要补扫的账户（启用且未停用） */
export function listAccountsForRescan(): number[] {
  const rows = db()
    .prepare("SELECT id FROM accounts WHERE enabled=1 AND status NOT IN ('disabled')")
    .all() as Array<{ id: number }>
  return rows.map((r) => r.id)
}

/** 某个规则配置的目标路径（概览用，按规则分组） */
export function rulePathSummary(): Array<{ ruleId: number; keyword: string; enabled: boolean; paths: Array<{ path: string; required: boolean }> }> {
  const rules = listRules()
  return rules.map((r) => ({
    ruleId: r.id,
    keyword: r.keyword,
    enabled: r.enabled,
    paths: r.targets.filter((t) => t.enabled).map((t) => ({ path: t.path, required: t.required }))
  }))
}

/** 未命中关键词/类型不符的邮件 UID（补扫重跑用） */
/** 手动重试「下载失败」的邮件：把状态恢复到 queued，附件重置为 pending，便于重新拉取 */
/** 超大附件（manual_needed）待自动重试：最近 7 天、尝试次数 < 3 */
export function listManualNeededForRetry(limit = 2): Array<{ id: number; account_id: number; links: string | null; auto_retry_count: number }> {
  return db()
    .prepare(
      `SELECT id, account_id, links, auto_retry_count FROM messages
       WHERE status='manual_needed' AND received_at > ? AND auto_retry_count < 3
       ORDER BY id DESC LIMIT ?`
    )
    .all(Date.now() - 7 * 86400_000, limit) as Array<{ id: number; account_id: number; links: string | null; auto_retry_count: number }>
}

/** 自动重试队列：状态为 partial/failed、已到重试时间、且当前没有正在下载的附件 */
export function listAutoRetryMessages(nowTs: number, limit = 10): Array<{ id: number; account_id: number; imap_uid: number }> {
  return db()
    .prepare(
      `SELECT m.id, m.account_id, m.imap_uid FROM messages m
       WHERE m.status IN ('partial','failed')
         AND (m.next_retry_at IS NULL OR m.next_retry_at <= ?)
         AND m.auto_retry_count < 6
         AND NOT EXISTS (
           SELECT 1 FROM attachments a
           WHERE a.message_id=m.id AND a.status='pending' AND a.updated_at > ?
         )
       ORDER BY COALESCE(m.next_retry_at,0) ASC LIMIT ?`
    )
    .all(nowTs, nowTs - 120_000, limit) as Array<{ id: number; account_id: number; imap_uid: number }>
}

/** 把失败/等待重试的路径重置为待重试（自动重试用） */
export function resetDeliveriesForAutoRetry(messageId: number): number {
  const info = db()
    .prepare(
      `UPDATE deliveries SET state='pending', attempts=0, next_retry_at=NULL, error_code=NULL, error=NULL, updated_at=?
       WHERE message_id=? AND state IN ('failed','retry_wait')`
    )
    .run(now(), messageId)
  return info.changes
}

export function bumpMessageAutoRetry(id: number, nextRetryAt: number | null): number {
  db().prepare('UPDATE messages SET auto_retry_count=auto_retry_count+1, next_retry_at=?, updated_at=? WHERE id=?').run(nextRetryAt, now(), id)
  const row = db().prepare('SELECT auto_retry_count FROM messages WHERE id=?').get(id) as { auto_retry_count: number } | undefined
  return row?.auto_retry_count ?? 0
}

export function clearMessageAutoRetry(id: number): void {
  db().prepare('UPDATE messages SET auto_retry_count=0, next_retry_at=NULL WHERE id=?').run(id)
}

/** 找出长时间停在 queued 且附件仍未下载的邮件（软件被关闭/网络中断留下的"处理中"） */
export function listStuckQueuedMessages(olderThanMs: number): Array<{ id: number; subject: string | null }> {
  const cutoff = now() - olderThanMs
  return db()
    .prepare(
      `SELECT m.id, m.subject FROM messages m
       WHERE m.status='queued' AND m.updated_at < ?
         AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=m.id AND a.status IN ('pending','failed'))
       ORDER BY m.updated_at ASC LIMIT 50`
    )
    .all(cutoff) as Array<{ id: number; subject: string | null }>
}

export function resetMessageForDownloadRetry(messageId: number): { accountId: number; imapUid: number } | null {
  const row = db()
    .prepare('SELECT id, account_id, imap_uid FROM messages WHERE id=?')
    .get(messageId) as { id: number; account_id: number; imap_uid: number } | undefined
  if (!row) return null
  const ts = now()
  db().prepare("UPDATE messages SET status='queued', error=NULL, reply_status='pending', updated_at=? WHERE id=?").run(ts, messageId)
  db().prepare("UPDATE attachments SET status='pending', error=NULL, updated_at=? WHERE message_id=?").run(ts, messageId)
  return { accountId: row.account_id, imapUid: row.imap_uid }
}

export function listIgnoredMessageUids(accountId: number, limit = 200): number[] {
  const rows = db()
    .prepare(
      `SELECT imap_uid FROM messages
       WHERE account_id=? AND status IN ('ignored_no_keyword','ignored_type')
       ORDER BY imap_uid DESC LIMIT ?`
    )
    .all(accountId, limit) as Array<{ imap_uid: number }>
  return rows.map((r) => r.imap_uid)
}

export function accountTodayCount(accountId: number): number {
  const r = db()
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE account_id=? AND received_at >= ?')
    .get(accountId, startOfToday()) as { c: number }
  return r.c
}

export function accountTotalFiles(accountId: number): number {
  const r = db()
    .prepare(
      `SELECT COUNT(DISTINCT d.attachment_id) AS c FROM deliveries d
       JOIN messages m ON m.id=d.message_id WHERE m.account_id=? AND d.state='done'`
    )
    .get(accountId) as { c: number }
  return r.c
}

// ---------------------------------------------------------------------------
// 规则 / 目标路径
// ---------------------------------------------------------------------------
function targetsOfRule(ruleId: number, includeDeleted = false): TargetRow[] {
  const sql = includeDeleted
    ? 'SELECT * FROM rule_targets WHERE rule_id=? ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM rule_targets WHERE rule_id=? AND deleted_at IS NULL AND enabled=1 ORDER BY sort_order ASC, id ASC'
  return db().prepare(sql).all(ruleId) as TargetRow[]
}

function mapRuleTarget(t: TargetRow): RuleTarget {
  const h = healthOf(t.path)
  return {
    id: t.id,
    ruleId: t.rule_id,
    path: t.path,
    required: bool(t.required),
    sortOrder: t.sort_order,
    enabled: bool(t.enabled),
    lastHealth: h.lastHealth,
    freeBytes: h.freeBytes,
    totalBytes: h.totalBytes
  }
}

function mapRule(r: RuleRow): Rule {
  return {
    id: r.id,
    keyword: r.keyword,
    enabled: bool(r.enabled),
    scope: r.scope,
    mode: r.mode,
    priority: r.priority,
    fileTypes: safeJsonArray(r.file_types, ['zip', 'rar', '7z', 'tar', 'tif', 'tiff']),
    autoReply: bool(r.auto_reply),
    hitMessages: r.hit_messages,
    hitFiles: r.hit_files,
    lastHitAt: r.last_hit_at,
    targets: targetsOfRule(r.id).map(mapRuleTarget),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 规则列表（仅未删除）；健康值优先用缓存，过期则现场检查一次 */
export function listRules(): Rule[] {
  const rows = db().prepare('SELECT * FROM rules WHERE deleted_at IS NULL ORDER BY priority ASC, id ASC').all() as RuleRow[]
  return rows.map(mapRule)
}

/** 规则页专用：先刷新磁盘健康再返回（targetsHealth 接口） */
export function listRulesWithHealth(): Rule[] {
  refreshTargetsHealth()
  return listRules()
}

export function getRule(id: number): Rule | null {
  const row = db().prepare('SELECT * FROM rules WHERE id=? AND deleted_at IS NULL').get(id) as RuleRow | undefined
  return row ? mapRule(row) : null
}

/** 只取匹配需要的轻量字段（pipeline 热路径） */
export function listEnabledRules(): Array<Pick<Rule, 'id' | 'keyword' | 'enabled' | 'scope' | 'mode' | 'priority' | 'fileTypes' | 'autoReply' | 'targets'>> {
  return listRules().filter((r) => r.enabled)
}

function normalizeTargetPaths(targets: RuleInput['targets']): Array<{ id?: number; path: string; required: boolean }> {
  const out: Array<{ id?: number; path: string; required: boolean }> = []
  const seen = new Set<string>()
  for (const t of targets ?? []) {
    const raw = (t.path ?? '').trim()
    if (!raw) continue
    const key = resolve(raw).toLowerCase()
    if (seen.has(key)) throw new Error('同一规则下的目标文件夹不能重复')
    seen.add(key)
    out.push({ id: t.id, path: raw, required: t.required !== false })
  }
  if (out.length === 0) throw new Error('请至少配置一个目标文件夹')
  return out
}

function validateRuleInput(input: RuleInput): void {
  if (!input.keyword?.trim()) throw new Error('关键词不能为空')
  if (!Array.isArray(input.fileTypes) || input.fileTypes.length === 0) throw new Error('请至少选择一种附件类型')
  normalizeTargetPaths(input.targets)
}

export function createRule(input: RuleInput): Rule {
  validateRuleInput(input)
  const targets = normalizeTargetPaths(input.targets)
  const ts = now()
  const d = db()
  const tx = d.transaction((): number => {
    const info = d
      .prepare(
        `INSERT INTO rules(keyword,enabled,scope,mode,priority,file_types,auto_reply,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.keyword.trim(),
        bit(input.enabled),
        input.scope,
        input.mode,
        Number(input.priority) || 100,
        JSON.stringify(input.fileTypes.map((t) => t.toLowerCase().replace(/^\./, ''))),
        bit(input.autoReply),
        ts,
        ts
      )
    const ruleId = Number(info.lastInsertRowid)
    const ins = d.prepare(
      `INSERT INTO rule_targets(rule_id,path,required,sort_order,enabled,created_at) VALUES(?,?,?,?,1,?)`
    )
    targets.forEach((t, i) => ins.run(ruleId, t.path, bit(t.required), i, ts))
    return ruleId
  })
  return getRule(tx()) as Rule
}

export function updateRule(id: number, input: RuleInput): Rule {
  validateRuleInput(input)
  const targets = normalizeTargetPaths(input.targets)
  const old = db().prepare('SELECT * FROM rules WHERE id=? AND deleted_at IS NULL').get(id) as RuleRow | undefined
  if (!old) throw new Error('规则不存在或已被删除')
  const ts = now()
  const d = db()
  d.transaction(() => {
    d.prepare(
      `UPDATE rules SET keyword=?,enabled=?,scope=?,mode=?,priority=?,file_types=?,auto_reply=?,updated_at=? WHERE id=?`
    ).run(
      input.keyword.trim(),
      bit(input.enabled),
      input.scope,
      input.mode,
      Number(input.priority) || old.priority,
      JSON.stringify(input.fileTypes.map((t) => t.toLowerCase().replace(/^\./, ''))),
      bit(input.autoReply),
      ts,
      id
    )
    const existing = targetsOfRule(id, true)
    const byId = new Map(existing.map((t) => [t.id, t]))
    const used = new Set<number>()
    const ins = d.prepare(
      `INSERT INTO rule_targets(rule_id,path,required,sort_order,enabled,deleted_at,created_at) VALUES(?,?,?,?,1,NULL,?)`
    )
    const upd = d.prepare(
      `UPDATE rule_targets SET path=?,required=?,sort_order=?,enabled=1,deleted_at=NULL WHERE id=?`
    )
    targets.forEach((t, i) => {
      let hit: TargetRow | undefined
      if (t.id && byId.has(t.id) && !used.has(t.id)) hit = byId.get(t.id)
      if (!hit) hit = existing.find((e) => !used.has(e.id) && resolve(e.path).toLowerCase() === resolve(t.path).toLowerCase())
      if (hit) {
        used.add(hit.id)
        upd.run(t.path, bit(t.required), i, hit.id)
      } else {
        ins.run(id, t.path, bit(t.required), i, ts)
      }
    })
    // 历史 delivery 存的是 target_path 快照，target_id 无外键 → 删除多余 target 安全
    const del = d.prepare('DELETE FROM rule_targets WHERE id=?')
    for (const e of existing) if (!used.has(e.id)) del.run(e.id)
  })()
  return getRule(id) as Rule
}

/** 软删除：deleted_at 置位后不再参与匹配，历史记录仍可引用 keyword 快照 */
export function deleteRule(id: number): void {
  const ts = now()
  const d = db()
  d.transaction(() => {
    d.prepare('UPDATE rules SET deleted_at=?, enabled=0, updated_at=? WHERE id=?').run(ts, ts, id)
    d.prepare('UPDATE rule_targets SET deleted_at=?, enabled=0 WHERE rule_id=?').run(ts, id)
  })()
}

export function setRuleEnabled(id: number, enabled: boolean): Rule {
  db().prepare('UPDATE rules SET enabled=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(bit(enabled), now(), id)
  const rule = getRule(id)
  if (!rule) throw new Error('规则不存在或已被删除')
  return rule
}

/** 拖拽排序：按数组顺序重写 priority（数字越小越优先） */
export function reorderRules(ids: number[]): void {
  const d = db()
  const upd = d.prepare('UPDATE rules SET priority=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
  const ts = now()
  d.transaction(() => {
    ids.forEach((id, i) => upd.run((i + 1) * 10, ts, id))
  })()
}

/** 命中计数：邮件数 +1、文件数 +N、最近命中时间 */
export function hitIncrement(ruleId: number, opts: { messages?: number; files?: number } = {}): void {
  db()
    .prepare(
      `UPDATE rules SET hit_messages=hit_messages+?, hit_files=hit_files+?, last_hit_at=?, updated_at=? WHERE id=?`
    )
    .run(opts.messages ?? 1, opts.files ?? 0, now(), now(), ruleId)
}

export function resetRuleHits(id: number): void {
  db().prepare('UPDATE rules SET hit_messages=0, hit_files=0, last_hit_at=NULL, updated_at=? WHERE id=?').run(now(), id)
}

// ---------------------------------------------------------------------------
// 邮件
// ---------------------------------------------------------------------------
export interface UpsertMessageInput {
  accountId: number
  imapUid: number
  rfcMessageId?: string | null
  providerMessageId?: string | null
  threadKey?: string | null
  subject?: string | null
  fromAddr?: string | null
  fromName?: string | null
  receivedAt?: number | null
  matchedRuleId?: number | null
  matchedKeyword?: string | null
  matchSource?: 'subject' | 'body' | 'none' | null
  status?: MessageStatus
  replyStatus?: ReplyStatus
  error?: string | null
  links?: string[] | null
  mailbox?: string
}

/** 幂等 upsert：唯一键 (account_id,imap_uid)。返回 id 与是否新插入 */
export function upsertMessage(input: UpsertMessageInput): { id: number; inserted: boolean } {
  const d = db()
  const ts = now()
  const existing = d
    .prepare('SELECT id FROM messages WHERE account_id=? AND imap_uid=?')
    .get(input.accountId, input.imapUid) as { id: number } | undefined
  if (existing) {
    d.prepare(
      `UPDATE messages SET
         links=COALESCE(?, links),
         mailbox=COALESCE(?, mailbox),
         provider_message_id=COALESCE(?, provider_message_id),
         thread_key=COALESCE(?, thread_key),
         rfc_message_id=COALESCE(?, rfc_message_id),
         subject=COALESCE(?, subject),
         from_addr=COALESCE(?, from_addr),
         from_name=COALESCE(?, from_name),
         received_at=COALESCE(?, received_at),
         updated_at=?
       WHERE id=?`
    ).run(
      input.links ? JSON.stringify(input.links) : null,
      input.mailbox ?? null,
      input.providerMessageId ?? null,
      input.threadKey ?? null,
      input.rfcMessageId ?? null,
      input.subject ?? null,
      input.fromAddr ?? null,
      input.fromName ?? null,
      input.receivedAt ?? null,
      ts,
      existing.id
    )
    return { id: existing.id, inserted: false }
  }
  const info = d
    .prepare(
      `INSERT INTO messages(
         account_id,imap_uid,provider_message_id,thread_key,rfc_message_id,subject,from_addr,from_name,
         received_at,matched_rule_id,matched_keyword,match_source,status,reply_status,error,links,mailbox,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.accountId,
      input.imapUid,
      input.providerMessageId ?? null,
      input.threadKey ?? null,
      input.rfcMessageId ?? null,
      input.subject ?? null,
      input.fromAddr ?? null,
      input.fromName ?? null,
      input.receivedAt ?? null,
      input.matchedRuleId ?? null,
      input.matchedKeyword ?? null,
      input.matchSource ?? null,
      input.status ?? 'queued',
      input.replyStatus ?? 'pending',
      input.error ?? null,
      input.links ? JSON.stringify(input.links) : null,
      input.mailbox ?? 'INBOX',
      ts,
      ts
    )
  return { id: Number(info.lastInsertRowid), inserted: true }
}

export function getMessage(id: number): MessageRow | null {
  return (db().prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined) ?? null
}

export function getMessageByUid(accountId: number, imapUid: number): MessageRow | null {
  return (
    (db().prepare('SELECT * FROM messages WHERE account_id=? AND imap_uid=?').get(accountId, imapUid) as
      | MessageRow
      | undefined) ?? null
  )
}

export function updateMessageStatus(id: number, status: MessageStatus, error?: string | null): void {
  db().prepare('UPDATE messages SET status=?, error=?, updated_at=? WHERE id=?').run(status, error ?? null, now(), id)
}

export function updateMessageReplyStatus(id: number, status: ReplyStatus, error?: string | null): void {
  db().prepare('UPDATE messages SET reply_status=?, error=COALESCE(?, error), updated_at=? WHERE id=?').run(status, error ?? null, now(), id)
}

export function updateMessageMatch(
  id: number,
  patch: { matchedRuleId?: number | null; matchedKeyword?: string | null; matchSource?: 'subject' | 'body' | 'none' | null }
): void {
  const row = getMessage(id)
  if (!row) return
  db()
    .prepare('UPDATE messages SET matched_rule_id=?, matched_keyword=?, match_source=?, updated_at=? WHERE id=?')
    .run(
      patch.matchedRuleId === undefined ? row.matched_rule_id : patch.matchedRuleId,
      patch.matchedKeyword === undefined ? row.matched_keyword : patch.matchedKeyword,
      patch.matchSource === undefined ? row.match_source : patch.matchSource,
      now(),
      id
    )
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------
export function upsertAttachment(
  messageId: number,
  input: { partId: string; filename: string; mimeType?: string | null; declaredSize?: number | null }
): AttachmentRow {
  const d = db()
  const ts = now()
  const existing = d
    .prepare('SELECT * FROM attachments WHERE message_id=? AND part_id=?')
    .get(messageId, input.partId) as AttachmentRow | undefined
  if (existing) {
    d.prepare('UPDATE attachments SET filename=?, mime_type=?, declared_size=?, updated_at=? WHERE id=?').run(
      input.filename,
      input.mimeType ?? null,
      input.declaredSize ?? null,
      ts,
      existing.id
    )
    return d.prepare('SELECT * FROM attachments WHERE id=?').get(existing.id) as AttachmentRow
  }
  const info = d
    .prepare(
      `INSERT INTO attachments(message_id,part_id,filename,mime_type,declared_size,status,created_at,updated_at)
       VALUES(?,?,?,?,?,'pending',?,?)`
    )
    .run(messageId, input.partId, input.filename, input.mimeType ?? null, input.declaredSize ?? null, ts, ts)
  return d.prepare('SELECT * FROM attachments WHERE id=?').get(Number(info.lastInsertRowid)) as AttachmentRow
}

export function getAttachment(id: number): AttachmentRow | null {
  return (db().prepare('SELECT * FROM attachments WHERE id=?').get(id) as AttachmentRow | undefined) ?? null
}

export function listAttachmentsByMessage(messageId: number): AttachmentRow[] {
  return db().prepare('SELECT * FROM attachments WHERE message_id=? ORDER BY id ASC').all(messageId) as AttachmentRow[]
}

/** 秒传：查找同名同大小且已下载的附件（用于跨邮件去重，避免重复下载） */
export function findDownloadedAttachmentByMeta(
  filename: string,
  size: number | null,
  excludeId: number
): { tmp_path: string; sha256: string | null; size: number | null } | null {
  if (!filename) return null
  const row = db()
    .prepare(
      `SELECT tmp_path, sha256, size FROM attachments
       WHERE id<>? AND filename=? AND status='downloaded' AND tmp_path IS NOT NULL
         AND (? IS NULL OR size=?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(excludeId, filename, size, size) as { tmp_path: string; sha256: string | null; size: number | null } | undefined
  return row ?? null
}

export function setAttachmentExtractInfo(
  attachmentId: number,
  info: { extracted: number; skipped: number; errors: string[] }
): void {
  db()
    .prepare('UPDATE attachments SET extracted_count=?, extract_skipped=?, extract_error=? WHERE id=?')
    .run(info.extracted, info.skipped, info.errors.length ? info.errors.slice(0, 5).join('；') : null, attachmentId)
}

export function setAttachmentDownloaded(
  id: number,
  info: { tmpPath: string; size: number; sha256: string }
): void {
  db()
    .prepare(
      `UPDATE attachments SET tmp_path=?, size=?, sha256=?, status='downloaded', error=NULL, updated_at=? WHERE id=?`
    )
    .run(info.tmpPath, info.size, info.sha256, now(), id)
}

export function setAttachmentStatus(
  id: number,
  status: AttachmentRow['status'],
  error?: string | null
): void {
  db().prepare('UPDATE attachments SET status=?, error=?, updated_at=? WHERE id=?').run(status, error ?? null, now(), id)
}

// ---------------------------------------------------------------------------
// 投递（附件 × 目标路径）
// ---------------------------------------------------------------------------
export interface DeliveryCreateInput {
  messageId: number
  attachmentId: number
  targetId: number
  targetPath: string
  required: boolean
}

/** 幂等创建（INSERT OR IGNORE, 唯一键 attachment_id+target_id），返回该消息全部 delivery */
export function createDeliveries(items: DeliveryCreateInput[]): DeliveryRow[] {
  if (items.length === 0) return []
  const d = db()
  const ts = now()
  const ins = d.prepare(
    `INSERT OR IGNORE INTO deliveries(
       message_id,attachment_id,target_id,target_path,required,state,attempts,created_at,updated_at
     ) VALUES(?,?,?,?,?,'pending',0,?,?)`
  )
  d.transaction(() => {
    for (const it of items) {
      ins.run(it.messageId, it.attachmentId, it.targetId, it.targetPath, bit(it.required), ts, ts)
    }
  })()
  return listDeliveriesByMessage(items[0]!.messageId)
}

export function listDeliveriesByMessage(messageId: number): DeliveryRow[] {
  return db()
    .prepare('SELECT * FROM deliveries WHERE message_id=? ORDER BY id ASC')
    .all(messageId) as DeliveryRow[]
}

export function getDelivery(id: number): DeliveryRow | null {
  return (db().prepare('SELECT * FROM deliveries WHERE id=?').get(id) as DeliveryRow | undefined) ?? null
}

/** 待处理队列：pending（无 next_retry_at 或已到期）+ retry_wait 到期 */
export function dueDeliveries(at: number = now(), limit = 200): DeliveryRow[] {
  return db()
    .prepare(
      `SELECT * FROM deliveries
       WHERE (state='pending' AND (next_retry_at IS NULL OR next_retry_at<=?))
          OR (state='retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at<=?)
       ORDER BY id ASC LIMIT ?`
    )
    .all(at, at, limit) as DeliveryRow[]
}

export function copyingDeliveries(): DeliveryRow[] {
  return db().prepare("SELECT * FROM deliveries WHERE state='copying'").all() as DeliveryRow[]
}

export function pendingDeliveryCount(): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM deliveries WHERE state IN ('pending','retry_wait','copying')")
    .get() as { c: number }
  return r.c
}

export interface DeliveryPatch {
  attempts?: number
  nextRetryAt?: number | null
  savedPath?: string | null
  savedName?: string | null
  size?: number | null
  sha256?: string | null
  errorCode?: string | null
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

export function updateDeliveryState(id: number, state: DeliveryState, patch: DeliveryPatch = {}): void {
  const row = getDelivery(id)
  if (!row) return
  db()
    .prepare(
      `UPDATE deliveries SET state=?, attempts=?, next_retry_at=?, saved_path=?, saved_name=?, size=?, sha256=?,
         error_code=?, error=?, started_at=?, finished_at=?, updated_at=? WHERE id=?`
    )
    .run(
      state,
      patch.attempts ?? row.attempts,
      patch.nextRetryAt === undefined ? row.next_retry_at : patch.nextRetryAt,
      patch.savedPath === undefined ? row.saved_path : patch.savedPath,
      patch.savedName === undefined ? row.saved_name : patch.savedName,
      patch.size === undefined ? row.size : patch.size,
      patch.sha256 === undefined ? row.sha256 : patch.sha256,
      patch.errorCode === undefined ? row.error_code : patch.errorCode,
      patch.error === undefined ? row.error : patch.error,
      patch.startedAt === undefined ? row.started_at : patch.startedAt,
      patch.finishedAt === undefined ? row.finished_at : patch.finishedAt,
      now(),
      id
    )
}

export function markDeliveryDone(
  id: number,
  info: { savedPath: string; savedName: string; size: number; sha256?: string | null }
): void {
  const ts = now()
  db()
    .prepare(
      `UPDATE deliveries SET state='done', saved_path=?, saved_name=?, size=?, sha256=?, error_code=NULL, error=NULL,
         next_retry_at=NULL, finished_at=?, updated_at=? WHERE id=?`
    )
    .run(info.savedPath, info.savedName, info.size, info.sha256 ?? null, ts, ts, id)
}

/** 失败重试：attempts 由调用方决定（路径不可用不消耗 attempts） */
export function markDeliveryRetry(
  id: number,
  opts: { errorCode: string; error: string; nextRetryAt: number; attempts: number }
): void {
  db()
    .prepare(
      `UPDATE deliveries SET state='retry_wait', attempts=?, next_retry_at=?, error_code=?, error=?, updated_at=? WHERE id=?`
    )
    .run(opts.attempts, opts.nextRetryAt, opts.errorCode, opts.error, now(), id)
}

export function markDeliveryFailed(
  id: number,
  opts: { errorCode: string; error: string; attempts: number }
): void {
  const ts = now()
  db()
    .prepare(
      `UPDATE deliveries SET state='failed', attempts=?, next_retry_at=NULL, error_code=?, error=?, finished_at=?, updated_at=? WHERE id=?`
    )
    .run(opts.attempts, opts.errorCode, opts.error, ts, ts, id)
}

export function markDeliverySkipped(id: number, reason = '规则/路径已停用'): void {
  const ts = now()
  db()
    .prepare(
      `UPDATE deliveries SET state='skipped', error_code='SKIPPED', error=?, finished_at=?, updated_at=? WHERE id=?`
    )
    .run(reason, ts, ts, id)
}

/** 手动重试：deliveryId 省略时重置该邮件全部 failed 记录；返回受影响条数 */
export function resetDeliveriesForRetry(messageId: number, deliveryId?: number): number {
  const d = db()
  const ts = now()
  const info = deliveryId
    ? d
        .prepare(
          `UPDATE deliveries SET state='pending', attempts=0, next_retry_at=NULL, error_code=NULL, error=NULL,
             finished_at=NULL, updated_at=? WHERE id=? AND message_id=?`
        )
        .run(ts, deliveryId, messageId)
    : d
        .prepare(
          `UPDATE deliveries SET state='pending', attempts=0, next_retry_at=NULL, error_code=NULL, error=NULL,
             finished_at=NULL, updated_at=? WHERE message_id=? AND state='failed'`
        )
        .run(ts, messageId)
  return info.changes
}

/** 启动对账：把 copying 改回 pending（dispatcher 会先尝试认领已落盘文件） */
export function resetCopyingDeliveries(): number {
  return db().prepare("UPDATE deliveries SET state='pending', updated_at=? WHERE state='copying'").run(now()).changes
}

export function deliveryAggregate(messageId: number): {
  total: number
  done: number
  failed: number
  skipped: number
  pending: number
  retryWait: number
  copying: number
  requiredTotal: number
  requiredDone: number
  requiredFailed: number
  allTerminal: boolean
  requiredAllDone: boolean
} {
  const rows = listDeliveriesByMessage(messageId)
  const agg = {
    total: rows.length,
    done: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    retryWait: 0,
    copying: 0,
    requiredTotal: 0,
    requiredDone: 0,
    requiredFailed: 0,
    allTerminal: true,
    requiredAllDone: true
  }
  for (const r of rows) {
    if (r.required) {
      agg.requiredTotal++
      if (r.state === 'done') agg.requiredDone++
      if (r.state === 'failed') agg.requiredFailed++
      if (r.state !== 'done') agg.requiredAllDone = false
    }
    switch (r.state) {
      case 'done':
        agg.done++
        break
      case 'failed':
        agg.failed++
        break
      case 'skipped':
        agg.skipped++
        break
      case 'pending':
        agg.pending++
        agg.allTerminal = false
        break
      case 'copying':
        agg.copying++
        agg.allTerminal = false
        break
      case 'retry_wait':
        agg.retryWait++
        agg.allTerminal = false
        break
    }
  }
  return agg
}

// ---------------------------------------------------------------------------
// 回信记录
// ---------------------------------------------------------------------------
export function hasSentThread(accountId: number, threadKey: string): boolean {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND thread_key=? AND status='sent'")
    .get(accountId, threadKey) as { c: number }
  return r.c > 0
}

export function insertReply(input: {
  accountId: number
  messageId: number
  threadKey: string
  toAddr: string
  subject?: string | null
  bodyPreview?: string | null
  status: ReplyRow['status']
  providerMessageId?: string | null
  error?: string | null
  sentAt?: number | null
}): number {
  const info = db()
    .prepare(
      `INSERT INTO auto_replies(
         account_id,message_id,thread_key,to_addr,subject,body_preview,status,provider_message_id,error,sent_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.accountId,
      input.messageId,
      input.threadKey,
      input.toAddr,
      input.subject ?? null,
      input.bodyPreview ?? null,
      input.status,
      input.providerMessageId ?? null,
      input.error ?? null,
      input.sentAt ?? null,
      now()
    )
  return Number(info.lastInsertRowid)
}

/** 今日已成功回信数（日上限 300 用） */
export function repliesTodayCount(accountId: number): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND status='sent' AND sent_at>=?")
    .get(accountId, startOfToday()) as { c: number }
  return r.c
}

/** 最近一小时内已发出的回信数（每小时上限用） */
export function repliesLastHourCount(accountId: number, nowMs: number = Date.now()): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND status='sent' AND sent_at>=?")
    .get(accountId, nowMs - 3600_000) as { c: number }
  return r.c
}

/** 最近一段时间内的失败回信（连续 3 次失败熔断用） */
export function recentReplyFailures(accountId: number, sinceMs: number): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND status='failed' AND created_at>=?")
    .get(accountId, now() - sinceMs) as { c: number }
  return r.c
}

export function lastReplySentAt(accountId: number): number | null {
  const r = db()
    .prepare("SELECT MAX(sent_at) AS t FROM auto_replies WHERE account_id=? AND status='sent'")
    .get(accountId) as { t: number | null }
  return r.t
}

export function listRepliesByMessage(messageId: number): ReplyRow[] {
  return db().prepare('SELECT * FROM auto_replies WHERE message_id=? ORDER BY id ASC').all(messageId) as ReplyRow[]
}

// ---------------------------------------------------------------------------
// 记录页 / 概览 / CSV
// ---------------------------------------------------------------------------
function buildRecordQuery(q: ListRecordsQuery): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (q.status && q.status !== 'all') {
    if (q.status === 'partial') {
      // UI 的「待重试」= 部分成功待重试 + 重试耗尽失败（都是需要人看一眼的）
      where.push("m.status IN ('partial','failed')")
    } else if (q.status === 'done') {
      // 「已归档」也把历史数据里的 'done' 与 'queued' 之后的终态一起算，避免漏显示
      where.push("m.status IN ('done')")
    } else {
      where.push('m.status=?')
      params.push(q.status)
    }
  }
  if (q.accountId != null) {
    where.push('m.account_id=?')
    params.push(q.accountId)
  }
  if (q.keyword) {
    where.push('m.matched_keyword LIKE ?')
    params.push(`%${q.keyword}%`)
  }
  if (q.search) {
    // 主题 / 发件人 / 发件人显示名 / 附件文件名 / 命中关键词 都能搜
    where.push(
      `(m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ? OR m.matched_keyword LIKE ?
        OR EXISTS (SELECT 1 FROM attachments a2 WHERE a2.message_id = m.id AND a2.filename LIKE ?))`
    )
    const s = `%${q.search}%`
    params.push(s, s, s, s, s)
  }
  if (q.from != null) {
    where.push('m.received_at>=?')
    params.push(q.from)
  }
  if (q.to != null) {
    where.push('m.received_at<=?')
    params.push(q.to)
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function toRecordRow(m: MessageRow, accountEmail: string, attachments: AttachmentRow[], deliveries: DeliveryRow[]): RecordRow {
  const byAttachment = new Map<number, DeliveryRow[]>()
  for (const d of deliveries) {
    const arr = byAttachment.get(d.attachment_id) ?? []
    arr.push(d)
    byAttachment.set(d.attachment_id, arr)
  }
  return {
    id: m.id,
    accountId: m.account_id,
    accountEmail,
    subject: m.subject ?? '',
    fromAddr: m.from_addr ?? '',
    fromName: m.from_name ?? '',
    receivedAt: m.received_at ?? m.created_at,
    matchedKeyword: m.matched_keyword,
    matchedRuleId: m.matched_rule_id,
    status: m.status,
    replyStatus: m.reply_status,
    error: m.error,
    links: safeJsonArray(m.links ?? null, []) as string[],
    mailbox: m.mailbox ?? 'INBOX',
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size ?? a.declared_size ?? null,
      state: a.status,
      extractedCount: a.extracted_count ?? 0,
      extractError: a.extract_error ?? null,
      deliveries: (byAttachment.get(a.id) ?? []).map(mapDelivery)
    }))
  }
}

export function listRecords(q: ListRecordsQuery = {}): ListRecordsResult {
  const d = db()
  const page = Math.max(1, Math.floor(Number(q.page) || 1))
  // 上限放宽到 10 万：记录页导出 CSV 会传 pageSize=100000 取全量
  const pageSize = Math.min(100_000, Math.max(1, Math.floor(Number(q.pageSize) || 20)))
  const { sql: whereSql, params } = buildRecordQuery(q)
  const totalRow = d
    .prepare(`SELECT COUNT(*) AS c FROM messages m ${whereSql}`)
    .get(...params) as { c: number }
  const rows = d
    .prepare(
      `SELECT m.*, COALESCE(a.email,'') AS account_email
       FROM messages m LEFT JOIN accounts a ON a.id=m.account_id
       ${whereSql}
       ORDER BY COALESCE(m.received_at, m.created_at) DESC, m.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<MessageRow & { account_email: string }>

  if (rows.length === 0) return { total: totalRow.c, page, pageSize, rows: [] }
  const ids = rows.map((r) => r.id)
  const ph = ids.map(() => '?').join(',')
  const attachments = d
    .prepare(`SELECT * FROM attachments WHERE message_id IN (${ph}) ORDER BY id ASC`)
    .all(...ids) as AttachmentRow[]
  const deliveries = d
    .prepare(`SELECT * FROM deliveries WHERE message_id IN (${ph}) ORDER BY id ASC`)
    .all(...ids) as DeliveryRow[]
  const aMap = new Map<number, AttachmentRow[]>()
  for (const a of attachments) {
    const arr = aMap.get(a.message_id) ?? []
    arr.push(a)
    aMap.set(a.message_id, arr)
  }
  const dMap = new Map<number, DeliveryRow[]>()
  for (const dl of deliveries) {
    const arr = dMap.get(dl.message_id) ?? []
    arr.push(dl)
    dMap.set(dl.message_id, arr)
  }
  return {
    total: totalRow.c,
    page,
    pageSize,
    rows: rows.map((m) => toRecordRow(m, m.account_email, aMap.get(m.id) ?? [], dMap.get(m.id) ?? []))
  }
}

export function getRecordById(messageId: number): RecordRow | null {
  const d = db()
  const row = d
    .prepare(
      `SELECT m.*, COALESCE(a.email,'') AS account_email
       FROM messages m LEFT JOIN accounts a ON a.id=m.account_id WHERE m.id=?`
    )
    .get(messageId) as (MessageRow & { account_email: string }) | undefined
  if (!row) return null
  return toRecordRow(row, row.account_email, listAttachmentsByMessage(messageId), listDeliveriesByMessage(messageId))
}

/** 打开记录对应文件夹：优先已落盘文件的所在目录，否则目标路径 */
export function folderOfRecord(messageId: number, deliveryId?: number): string | null {
  const deliveries = listDeliveriesByMessage(messageId)
  const chosen = deliveryId ? deliveries.find((x) => x.id === deliveryId) : deliveries.find((x) => x.saved_path) ?? deliveries[0]
  if (!chosen) return null
  if (chosen.saved_path) return dirname(chosen.saved_path)
  return chosen.target_path || null
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const STATUS_ZH: Record<MessageStatus, string> = {
  ignored_no_keyword: '未命中关键词',
  ignored_type: '附件类型不符',
  manual_needed: '超大附件·待下载',
  queued: '处理中',
  partial: '部分成功·待重试',
  done: '已完成',
  failed: '失败'
}
const REPLY_ZH: Record<ReplyStatus, string> = {
  disabled: '已关闭',
  pending: '等待中',
  suppressed: '已抑制',
  sent: '已回信',
  failed: '回信失败'
}
const DELIVERY_ZH: Record<DeliveryState, string> = {
  pending: '排队中',
  copying: '复制中',
  done: '已写入',
  retry_wait: '等待重试',
  failed: '失败',
  skipped: '已跳过'
}

export function recordsToCsv(rows: RecordRow[]): string {
  const header = ['时间', '账户', '发件人', '主题', '命中关键词', '附件', '目标路径结果', '状态', '回信状态', '错误']
  const lines = [header.map(csvCell).join(',')]
  const fmt = (t: number): string => {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  for (const r of rows) {
    const attachments = r.attachments.map((a) => `${a.filename}${a.size ? `(${a.size}B)` : ''}`).join(' / ')
    const deliveries = r.attachments
      .flatMap((a) => a.deliveries)
      .map((d) => `${d.targetPath}: ${DELIVERY_ZH[d.state]}${d.savedName ? `(${d.savedName})` : ''}${d.errorCode ? `[${d.errorCode}]` : ''}`)
      .join(' / ')
    lines.push(
      [
        fmt(r.receivedAt),
        r.accountEmail,
        `${r.fromName} <${r.fromAddr}>`,
        r.subject,
        r.matchedKeyword ?? '',
        attachments,
        deliveries,
        STATUS_ZH[r.status] ?? r.status,
        REPLY_ZH[r.replyStatus] ?? r.replyStatus,
        r.error ?? ''
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\r\n')
}

// ---------------------------------------------------------------------------
// 概览聚合
// ---------------------------------------------------------------------------
export interface DashboardStats {
  todayMessages: number
  todayMatched: number
  todayFiles: number
  todayFailed: number
  pendingRetry: number
}

/** 概览「失败待重试」列表：直接查所有失败/等待重试的路径（不再只看最近 8 条记录） */
export function listRetryDeliveries(limit = 8): Array<{
  messageId: number
  deliveryId: number
  filename: string
  size: number | null
  targetPath: string
  drive: string
  required: boolean
  state: 'retry_wait' | 'failed'
  error: string | null
  attempts: number
  nextRetryAt: number | null
}> {
  const rows = db()
    .prepare(
      `SELECT d.id AS deliveryId, d.message_id AS messageId, d.target_path AS targetPath,
              d.required AS required, d.state AS state, d.error AS error, d.attempts AS attempts,
              d.next_retry_at AS nextRetryAt, a.filename AS filename, a.size AS size
       FROM deliveries d
       JOIN messages m ON m.id=d.message_id
       JOIN attachments a ON a.id=d.attachment_id
       WHERE d.state IN ('failed','retry_wait')
       ORDER BY d.updated_at DESC LIMIT ?`
    )
    .all(limit) as any[]
  return rows.map((r) => ({
    messageId: Number(r.messageId),
    deliveryId: Number(r.deliveryId),
    filename: String(r.filename ?? ''),
    size: r.size ?? null,
    targetPath: String(r.targetPath ?? ''),
    // 与 UI 一致：取盘符（D/E/F）
    drive: (() => {
      const m = /^([A-Za-z]:)/.exec(String(r.targetPath ?? ''))
      return m ? m[1]!.replace(':', '').toUpperCase() : ''
    })(),
    required: !!r.required,
    state: r.state === 'failed' ? 'failed' : 'retry_wait',
    error: r.error ?? null,
    attempts: Number(r.attempts ?? 0),
    nextRetryAt: r.nextRetryAt ?? null
  }))
}

export function dashboardStats(): DashboardStats {
  const d = db()
  const today = startOfToday()
  const one = (sql: string, ...args: unknown[]): number => (d.prepare(sql).get(...args) as { c: number }).c
  return {
    todayMessages: one('SELECT COUNT(*) AS c FROM messages WHERE received_at>=?', today),
    todayMatched: one('SELECT COUNT(*) AS c FROM messages WHERE received_at>=? AND matched_rule_id IS NOT NULL', today),
    todayFiles: one(
      "SELECT COUNT(DISTINCT attachment_id) AS c FROM deliveries WHERE state='done' AND finished_at>=?",
      today
    ),
    todayFailed: one("SELECT COUNT(*) AS c FROM messages WHERE received_at>=? AND status='failed'", today),
    // 与「下载记录 → 待重试」同口径：messages.status IN ('partial','failed')
    pendingRetry: one("SELECT COUNT(*) AS c FROM messages WHERE status IN ('partial','failed')")
  }
}

/** 概览页「各目标盘剩余空间」：所有启用规则的目标路径去重，附所属关键词 */
export function listDisks(): DiskInfo[] {
  const rows = db()
    .prepare(
      `SELECT t.path AS path, r.keyword AS keyword
       FROM rule_targets t JOIN rules r ON r.id=t.rule_id
       WHERE t.deleted_at IS NULL AND t.enabled=1 AND r.deleted_at IS NULL AND r.enabled=1
       ORDER BY r.priority ASC, t.sort_order ASC, t.id ASC`
    )
    .all() as Array<{ path: string; keyword: string }>
  const map = new Map<string, { path: string; keywords: Set<string> }>()
  for (const r of rows) {
    const key = resolve(r.path)
    const hit = map.get(key)
    if (hit) hit.keywords.add(r.keyword)
    else map.set(key, { path: r.path, keywords: new Set([r.keyword]) })
  }
  return [...map.values()].map((v) => {
    const info = healthOf(v.path)
    return {
      path: v.path,
      health: info.health,
      freeBytes: info.freeBytes,
      totalBytes: info.totalBytes,
      ruleKeywords: [...v.keywords]
    }
  })
}

// ---------------------------------------------------------------------------
// 运维辅助
// ---------------------------------------------------------------------------
export function clearMessages(): void {
  db().prepare('DELETE FROM messages').run()
}

/** 删除单条邮件记录及其附件、投递、回信记录（不删除已归档的文件） */
export function deleteMessageRecord(messageId: number): boolean {
  const d = db()
  const row = d.prepare('SELECT id FROM messages WHERE id=?').get(messageId)
  if (!row) return false
  d.transaction(() => {
    d.prepare('DELETE FROM deliveries WHERE message_id=?').run(messageId)
    d.prepare('DELETE FROM attachments WHERE message_id=?').run(messageId)
    d.prepare('DELETE FROM auto_replies WHERE message_id=?').run(messageId)
    d.prepare('DELETE FROM messages WHERE id=?').run(messageId)
  })()
  return true
}

export function countMessages(): number {
  return (db().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c
}
