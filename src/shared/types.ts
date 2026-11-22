/**
 * MailHarbor 共享领域类型（主进程 / 渲染层 / preload 共用）
 * 与 docs/ARCHITECTURE.md §11 的状态枚举保持一致。
 */

// ---------------------------------------------------------------------------
// 账户
// ---------------------------------------------------------------------------
export type AccountStatus = 'enabled' | 'pending_test' | 'auth_failed' | 'conn_failed' | 'offline' | 'disabled'
export type Encryption = 'ssl' | 'starttls' | 'none'
export type ProviderPreset = 'gmail' | 'google_workspace' | 'qq' | 'outlook' | 'custom'

export interface Account {
  id: number
  preset: ProviderPreset
  email: string
  displayName: string
  status: AccountStatus
  enabled: boolean
  imapHost: string
  imapPort: number
  imapSecure: Encryption
  imapUser: string
  smtpHost: string
  smtpPort: number
  smtpSecure: Encryption
  smtpUser: string
  smtpFromName: string
  /** 是否与收件使用同一账号密码 */
  smtpSameAsImap: boolean
  hasPassword: boolean
  lastCheckAt: number | null
  lastOkAt: number | null
  lastErrorCode: string | null
  lastError: string | null
  lastUid: number
  uidValidity: string | null
  todayCount: number
  totalFiles: number
  createdAt: number
  updatedAt: number
}

export interface AccountInput {
  preset: ProviderPreset
  email: string
  displayName?: string
  imapHost: string
  imapPort: number
  imapSecure: Encryption
  imapUser: string
  smtpHost: string
  smtpPort: number
  smtpSecure: Encryption
  smtpUser: string
  smtpFromName?: string
  smtpSameAsImap: boolean
  /** 新建时必填；编辑时留空表示不修改 */
  password?: string
  smtpPassword?: string
}

export interface TestResultLine {
  protocol: 'imap' | 'smtp'
  ok: boolean
  latencyMs: number
  host: string
  port: number
  errorCode?: string
  message?: string
}
export interface TestResult {
  ok: boolean
  lines: TestResultLine[]
  testedAt: number
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------
export type MatchScope = 'subject' | 'subject_body'
export type MatchMode = 'exact' | 'contains'

export interface RuleTarget {
  id: number
  ruleId: number
  path: string
  required: boolean
  sortOrder: number
  enabled: boolean
  lastHealth: TargetHealth | null
  freeBytes: number | null
  totalBytes: number | null
}

export type TargetHealth = 'ok' | 'low_space' | 'unavailable' | 'unknown'

export interface Rule {
  id: number
  keyword: string
  enabled: boolean
  scope: MatchScope
  mode: MatchMode
  priority: number
  fileTypes: string[]
  autoReply: boolean
  hitMessages: number
  hitFiles: number
  lastHitAt: number | null
  targets: RuleTarget[]
  createdAt: number
  updatedAt: number
}

export interface RuleInput {
  keyword: string
  enabled: boolean
  scope: MatchScope
  mode: MatchMode
  priority?: number
  fileTypes: string[]
  autoReply: boolean
  targets: Array<{ id?: number; path: string; required: boolean }>
}

export interface RuleMatch {
  rule: Rule
  source: 'subject' | 'body'
}

// ---------------------------------------------------------------------------
// 邮件 / 附件 / 投递
// ---------------------------------------------------------------------------
export type MessageStatus = 'ignored_no_keyword' | 'ignored_type' | 'queued' | 'partial' | 'done' | 'failed'
export type ReplyStatus = 'disabled' | 'pending' | 'suppressed' | 'sent' | 'failed'
export type DeliveryState = 'pending' | 'copying' | 'done' | 'retry_wait' | 'failed' | 'skipped'

export interface Delivery {
  id: number
  messageId: number
  attachmentId: number
  targetId: number
  targetPath: string
  required: boolean
  state: DeliveryState
  attempts: number
  nextRetryAt: number | null
  savedPath: string | null
  savedName: string | null
  size: number | null
  errorCode: string | null
  error: string | null
  finishedAt: number | null
}

export interface RecordRow {
  id: number
  accountId: number
  accountEmail: string
  subject: string
  fromAddr: string
  fromName: string
  receivedAt: number
  matchedKeyword: string | null
  matchedRuleId: number | null
  status: MessageStatus
  replyStatus: ReplyStatus
  error: string | null
  attachments: Array<{
    id: number
    filename: string
    size: number | null
    state: 'pending' | 'downloaded' | 'failed' | 'skipped'
    deliveries: Delivery[]
  }>
}

export interface ListRecordsQuery {
  page?: number
  pageSize?: number
  status?: MessageStatus | 'all'
  accountId?: number | null
  keyword?: string
  search?: string
  from?: number
  to?: number
}

export interface ListRecordsResult {
  total: number
  page: number
  pageSize: number
  rows: RecordRow[]
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------
export interface DiskInfo {
  path: string
  health: TargetHealth
  freeBytes: number | null
  totalBytes: number | null
  ruleKeywords: string[]
}

export interface DashboardData {
  listening: boolean
  accounts: Account[]
  todayMessages: number
  todayMatched: number
  todayFiles: number
  todayFailed: number
  pendingRetry: number
  disks: DiskInfo[]
  recent: RecordRow[]
  pollIntervalSec: number
  nextCheckAt: number | null
  uptimeMs: number
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
export interface Settings {
  pollIntervalSec: number
  autostart: boolean
  minimizeToTray: boolean
  defaultPathEnabled: boolean
  defaultPath: string
  replyEnabled: boolean
  replyDelaySec: number
  replySubjectZh: string
  replyBodyZh: string
  replySubjectEn: string
  replyBodyEn: string
  replyLanguage: 'zh' | 'en' | 'both'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  retryMaxAttempts: number
  multiRuleStrategy: 'all' | 'priority'
}

// ---------------------------------------------------------------------------
// 事件（主进程 → 渲染层）
// ---------------------------------------------------------------------------
export type MainEvent =
  | { type: 'account:changed'; account: Account }
  | { type: 'rules:changed' }
  | { type: 'message:upserted'; record: RecordRow }
  | { type: 'delivery:changed'; messageId: number }
  | { type: 'dashboard:changed' }
  | { type: 'toast'; level: 'success' | 'warn' | 'error'; title: string; body?: string }
  | { type: 'listening:changed'; listening: boolean }
