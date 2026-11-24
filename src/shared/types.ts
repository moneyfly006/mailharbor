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
  /** 允许自签名证书（企业自建 IMAP/SMTP 常见） */
  allowSelfSigned: boolean
  /** 只用于发信（如阿里云 DirectMail，没有收件箱） */
  sendOnly: boolean
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
  /** 允许自签名证书（企业自建 IMAP/SMTP 常见） */
  allowSelfSigned?: boolean
  /** 只用于发信（没有收件箱的服务，如阿里云 DirectMail） */
  sendOnly?: boolean
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
export type MessageStatus =
  | 'ignored_no_keyword'
  | 'ignored_type'
  /** 超大附件/网盘链接邮件：等待从网页下载文件 */
  | 'manual_needed'
  | 'queued'
  | 'partial'
  | 'done'
  | 'failed'
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
  /** 邮件正文里提取到的下载链接（超大附件/网盘） */
  links: string[]
  /** 邮件所在文件夹：INBOX / Junk（垃圾邮件） */
  mailbox: string
  attachments: Array<{
    id: number
    filename: string
    size: number | null
    state: 'pending' | 'downloaded' | 'failed' | 'skipped'
    /** 已解压出的文件数（0=未解压或不是压缩包） */
    extractedCount?: number
    extractError?: string | null
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

export interface RulePathSummary {
  ruleId: number
  keyword: string
  enabled: boolean
  paths: Array<{ path: string; required: boolean }>
}

export interface DashboardData {
  listening: boolean
  accounts: Account[]
  /** 概览「触发规则 · 存储路径」卡片用：规则 → 目标路径 */
  rulePaths: RulePathSummary[]
  todayMessages: number
  todayMatched: number
  todayFiles: number
  todayFailed: number
  pendingRetry: number
  /** 失败待重试的路径（与「下载记录 → 待重试」同口径，最多 8 条） */
  retryItems: Array<{
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
  }>
  disks: DiskInfo[]
  recent: RecordRow[]
  pollIntervalSec: number
  nextCheckAt: number | null
  /** 是否正在执行一轮检查（用于「检查中」提示） */
  checking: boolean
  /** 最近一次检查完成时间 */
  lastCheckAt: number | null
  uptimeMs: number
}

// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 附件下载进度（大附件/弱网时给用户看）
// ---------------------------------------------------------------------------
export interface DownloadProgress {
  messageId: number
  attachmentId: number
  filename: string
  /** 已下载字节 */
  received: number
  /** 预计总字节（0=未知） */
  total: number
  /** 0-100；total 未知时为 null */
  percent: number | null
  state: 'active' | 'done' | 'failed'
  /** 第几次尝试（从 1 开始） */
  attempt: number
  /** 实时速度（字节/秒，0=未知） */
  bytesPerSec: number
  message?: string
  updatedAt: number
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  progressPercent: number | null
  message: string | null
  checkedAt: number | null
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
export type ProxyMode = 'none' | 'system' | 'socks5' | 'http'

export interface ProxySettings {
  /** 不使用 / 跟随系统 / 自定义 SOCKS5 / 自定义 HTTP */
  mode: ProxyMode
  host: string
  port: number
}

export interface Settings {
  pollIntervalSec: number
  autostart: boolean
  minimizeToTray: boolean
  defaultPathEnabled: boolean
  defaultPath: string
  replyEnabled: boolean
  replyDelaySec: number
  /** 同一线程只回一次（默认 true，防回信轰炸） */
  replyThreadOnce: boolean
  /** 每小时回信上限（默认 60，防账号被风控） */
  replyHourlyCap: number
  /** 回信署名 / 工厂名，模板变量 {工厂名} */
  factoryName: string
  replySubjectZh: string
  replyBodyZh: string
  replySubjectEn: string
  replyBodyEn: string
  replyLanguage: 'zh' | 'en' | 'both'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  retryMaxAttempts: number
  /** 附件下载失败时自动重试次数（弱网/大附件建议 2–3） */
  downloadAttempts: number
  /** 单个附件下载超时（秒），大附件/弱网可调到 1800 */
  downloadTimeoutSec: number
  /** IMAP 分块大小（MB）：越大越少往返，高延迟链路提速明显 */
  downloadChunkSizeMB: number
  /** 同时扫描垃圾邮件文件夹（Gmail 常把 QQ 发来的大附件邮件判为垃圾） */
  scanSpam: boolean
  /** 失败自动重试（失败邮件按退避时间自动重新下载，最多 6 次） */
  autoRetryFailed: boolean
  /** Gmail API 加速（附件走 HTTPS 下载，比 IMAP 快 3–6 倍） */
  gmailApiAccel: boolean
  /** 多连接并行下载（把整封邮件切段，在 N 条连接上同时取，再本地解析附件） */
  parallelDownload: boolean
  /** 并行连接数（2-8，默认 4） */
  parallelConnections: number
  /** 超过多少 MB 才用并行下载（默认 6MB） */
  parallelThresholdMB: number
  /** ZIP/RAR 落盘后自动解压到同一文件夹（保留压缩包） */
  extractArchives: boolean
  /** 网络代理（国内访问 Gmail 必须；默认跟随系统） */
  proxy: ProxySettings
  /** 回信用哪个账户发（null = 谁收到就用谁发） */
  replyAccountId: number | null
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
  | { type: 'update:changed'; state: UpdateState }
  | { type: 'download:progress'; progress: DownloadProgress }
  | { type: 'gmail:auth'; accountId: number; authorized: boolean; error?: string }
