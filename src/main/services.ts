/**
 * 后端服务门面契约（backend teammate 实现 createBackend；Lead 在 index.ts 里调用）。
 * 渲染层不直接接触这些对象——通过 ipc.ts → preload → window.mailharbor 访问。
 */
import type { EventEmitter } from 'node:events'
import type { Account, AccountInput, MainEvent, TestResult } from '@shared/types'

export interface Backend {
  /** 事件总线：ipc.ts 会转发到渲染层 */
  bus: EventEmitter
  scheduler: {
    startAll(): Promise<void> | void
    stopAll(): Promise<void> | void
    pause(): void
    resume(): Promise<void> | void
    isListening(): boolean
    checkNow(): Promise<void>
    /** 补扫指定 UID（新增/启用规则后重跑历史邮件，不动游标） */
    reprocess(accountId: number, uids: number[]): Promise<{ processed: number; errors: number }>
    /** 立即执行一轮失败自动重试（测试/调试用），返回触发数量 */
    runAutoRetryOnce(): Promise<number>
    nextCheckAt(): number | null
    /** 是否正在执行一轮检查 */
    isChecking(): boolean
    /** 最近一次检查完成时间 */
    lastCheckAt(): number | null
  }
  /** 下载控制：暂停 / 继续 / 取消（HTTP 大文件下载支持） */
  downloads: {
    pause(messageId: number): void
    resume(messageId: number): void
    cancel(messageId: number): void
  }
  /** Gmail API 加速（授权状态 / 授权 / 撤销 / 连通性测试） */
  gmail: {
    status(): Array<{ accountId: number; email: string; provider: string; expiry: number | null; daysLeft: number | null; needsReauth: boolean; lastError: string | null }>
    startAuth(
      accountId: number,
      clientId: string,
      clientSecret: string
    ): Promise<{ authUrl: string; cancel: () => void }>
    /** 用已保存的客户端 ID/密钥重新授权（用于 scope 升级：Gmail + Drive） */
    reauthorize(accountId: number): Promise<{ authUrl: string }>
    revoke(accountId: number): void
    test(accountId: number): Promise<{ ok: boolean; email?: string; message?: string }>
    /** 直接下载该邮件里的 Google Drive 超大附件并归档 */
    fetchDriveAndArchive(messageId: number): Promise<{ ok: boolean; files?: number; message?: string; archived?: number; extracted?: number }>
  }
  /** 测试「还没保存」的表单（新建账户向导用） */
  testAccount(input: AccountInput): Promise<TestResult>
  /** 测试已保存账户（用库里的加密密码） */
  testSavedAccount(id: number): Promise<TestResult>
  /** 启动/重启时对账并继续未完成投递 */
  reconcile(): Promise<void> | void
  /** 用第一个启用账户的 SMTP 发一封测试信（自动回复页「发送测试信」用） */
  testReply(to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }>
  /** 标题测试：用给定标题跑一遍当前规则，返回命中的规则与归一化结果（规则页调试用） */
  testSubject(subject: string, body?: string): Promise<{
    normalized: string
    hits: Array<{ ruleId: number; keyword: string; source: 'subject' | 'body' }>
  }>
  /** 超大附件：用户手动下载后，把选中的文件归档到规则路径（并解压） */
  archiveManualFiles(
    messageId: number,
    files: string[]
  ): Promise<{ ok: boolean; message?: string; archived?: number; extracted?: number }>
  /** 重新识别一封「未命中/类型不符」的邮件（规则改了或软件升级后可用） */
  reprocessMessage(messageId: number): Promise<{ ok: boolean; message?: string }>
  /** 重新下载并归档指定邮件（用于「下载失败」后手动重试） */
  retryDownload(messageId: number): Promise<{ ok: boolean; message?: string }>
  /** 重试指定邮件的失败投递（deliveryId 省略=全部失败项） */
  retryMessage(messageId: number, deliveryId?: number): Promise<void>
  /** 应用启动时调用一次 */
  init(): Promise<void> | void
  dispose(): Promise<void> | void
}

export type { Account }
export type BusEvent = MainEvent
