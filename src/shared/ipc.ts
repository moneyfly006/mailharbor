/** preload 暴露给渲染层的 API 契约（IPC channel 常量 + 方法签名） */
import type {
  Account, AccountInput, DashboardData, ListRecordsQuery, ListRecordsResult, MainEvent,
  ProxySettings, Rule, RuleInput, Settings, TestResult, UpdateState
} from './types'

export const IPC = {
  // 账户
  accountList: 'account:list',
  accountCreate: 'account:create',
  accountUpdate: 'account:update',
  accountDelete: 'account:delete',
  accountTest: 'account:test',
  accountTestSaved: 'account:test-saved',
  accountQqLogin: 'account:qq-login',
  accountToggle: 'account:toggle',
  // 规则
  ruleList: 'rule:list',
  ruleCreate: 'rule:create',
  ruleUpdate: 'rule:update',
  ruleDelete: 'rule:delete',
  ruleToggle: 'rule:toggle',
  ruleReorder: 'rule:reorder',
  ruleTargetsHealth: 'rule:targets-health',
  // 记录
  recordsList: 'records:list',
  recordsRetry: 'records:retry',
  recordsRetryDownload: 'records:retry-download',
  recordsReprocess: 'records:reprocess',
  rulesTestSubject: 'rules:test-subject',
  gmailStatus: 'gmail:status',
  gmailAuthStart: 'gmail:auth-start',
  gmailReauthorize: 'gmail:reauthorize',
  gmailRevoke: 'gmail:revoke',
  gmailTest: 'gmail:test',
  recordsOpenLink: 'records:open-link',
  recordsDownloadLink: 'records:download-link',
  recordsArchiveManual: 'records:archive-manual',
  recordsOpenFolder: 'records:open-folder',
  recordsExport: 'records:export',
  recordsClear: 'records:clear',
  // 自动回复测试信
  replyTest: 'reply:test',
  // 概览
  dashboard: 'dashboard:get',
  listeningSet: 'listening:set',
  checkNow: 'ops:check-now',
  rescan: 'ops:rescan',
  // 设置
  settingsGet: 'settings:get',
  proxyTest: 'settings:test-proxy',
  settingsSave: 'settings:save',
  // 通用
  pickFolder: 'dialog:pick-folder',
  openPath: 'shell:open-path',
  appInfo: 'app:info',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateState: 'update:state',
  // 事件
  event: 'main:event'
} as const

export interface Api {
  accounts: {
    list(): Promise<Account[]>
    create(input: AccountInput): Promise<Account>
    update(id: number, input: AccountInput): Promise<Account>
    remove(id: number): Promise<void>
    test(input: AccountInput & { id?: number }): Promise<TestResult>
    testSaved(id: number): Promise<TestResult>
    qqLogin(id: number): Promise<{ ok: boolean; message?: string }>
    toggle(id: number, enabled: boolean): Promise<Account>
  }
  rules: {
    list(): Promise<Rule[]>
    create(input: RuleInput): Promise<Rule>
    update(id: number, input: RuleInput): Promise<Rule>
    remove(id: number): Promise<void>
    toggle(id: number, enabled: boolean): Promise<Rule>
    reorder(ids: number[]): Promise<void>
    targetsHealth(): Promise<Rule[]>
    /** 标题测试：规则页调试用 */
    testSubject(
      subject: string,
      body?: string
    ): Promise<{ normalized: string; hits: Array<{ ruleId: number; keyword: string; source: 'subject' | 'body' }> }>
  }
  gmail: {
    status(): Promise<Array<{ accountId: number; email: string; provider: string; expiry: number | null; daysLeft: number | null; needsReauth: boolean; lastError: string | null }>>
    startAuth(accountId: number, clientId: string, clientSecret: string): Promise<{ authUrl: string }>
    reauthorize(accountId: number): Promise<{ authUrl: string }>
    revoke(accountId: number): Promise<void>
    test(accountId: number): Promise<{ ok: boolean; email?: string; message?: string }>
  }
  records: {
    list(q: ListRecordsQuery): Promise<ListRecordsResult>
    retry(messageId: number, deliveryId?: number): Promise<void>
    /** 重新下载并归档（下载失败后重试用） */
    retryDownload(messageId: number): Promise<{ ok: boolean; message?: string }>
    /** 重新识别（用于修改规则/升级后重扫单封邮件） */
    reprocess(messageId: number): Promise<{ ok: boolean; message?: string }>
    /** 用系统浏览器打开超大附件/网盘链接 */
    openLink(messageId: number): Promise<{ ok: boolean; message?: string }>
    /** 在应用内打开下载页，取得实际网页文件后归档 */
    downloadLink(messageId: number): Promise<{ ok: boolean; message?: string; archived?: number; extracted?: number }>
    /** 选择手动下载好的文件并归档到规则路径 */
    archiveManual(
      messageId: number
    ): Promise<{ ok: boolean; message?: string; archived?: number; extracted?: number }>
    openFolder(messageId: number, deliveryId?: number): Promise<void>
    exportCsv(q: ListRecordsQuery): Promise<{ path: string } | null>
    clear(): Promise<void>
  }
  reply: {
    /** 用第一个启用账户的 SMTP 发一封测试信 */
    test(to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }>
  }
  dashboard(): Promise<DashboardData>
  setListening(on: boolean): Promise<boolean>
  checkNow(): Promise<void>
  /** 补扫历史邮件（新增规则后让之前"未命中"的邮件重新入库） */
  rescan(): Promise<void>
  settings: {
    get(): Promise<Settings>
    save(s: Settings): Promise<Settings>
    testProxy(p: ProxySettings): Promise<{ ok: boolean; latencyMs: number; message: string }>
  }
  pickFolder(): Promise<string | null>
  openPath(p: string): Promise<void>
  appInfo(): Promise<{ version: string; userData: string; listening: boolean }>
  update: {
    check(): Promise<UpdateState>
    install(): Promise<void>
    state(): Promise<UpdateState>
  }
  onEvent(cb: (e: MainEvent) => void): () => void
}
