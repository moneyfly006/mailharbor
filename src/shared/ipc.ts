/** preload 暴露给渲染层的 API 契约（IPC channel 常量 + 方法签名） */
import type {
  Account, AccountInput, DashboardData, ListRecordsQuery, ListRecordsResult, MainEvent,
  Rule, RuleInput, Settings, TestResult
} from './types'

export const IPC = {
  // 账户
  accountList: 'account:list',
  accountCreate: 'account:create',
  accountUpdate: 'account:update',
  accountDelete: 'account:delete',
  accountTest: 'account:test',
  accountTestSaved: 'account:test-saved',
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
  recordsOpenFolder: 'records:open-folder',
  recordsExport: 'records:export',
  recordsClear: 'records:clear',
  // 自动回复测试信
  replyTest: 'reply:test',
  // 概览
  dashboard: 'dashboard:get',
  listeningSet: 'listening:set',
  checkNow: 'ops:check-now',
  // 设置
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  // 通用
  pickFolder: 'dialog:pick-folder',
  openPath: 'shell:open-path',
  appInfo: 'app:info',
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
  }
  records: {
    list(q: ListRecordsQuery): Promise<ListRecordsResult>
    retry(messageId: number, deliveryId?: number): Promise<void>
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
  settings: {
    get(): Promise<Settings>
    save(s: Settings): Promise<Settings>
  }
  pickFolder(): Promise<string | null>
  openPath(p: string): Promise<void>
  appInfo(): Promise<{ version: string; userData: string; listening: boolean }>
  onEvent(cb: (e: MainEvent) => void): () => void
}
