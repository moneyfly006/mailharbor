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
    nextCheckAt(): number | null
  }
  /** 测试「还没保存」的表单（新建账户向导用） */
  testAccount(input: AccountInput): Promise<TestResult>
  /** 测试已保存账户（用库里的加密密码） */
  testSavedAccount(id: number): Promise<TestResult>
  /** 启动/重启时对账并继续未完成投递 */
  reconcile(): Promise<void> | void
  /** 用第一个启用账户的 SMTP 发一封测试信（自动回复页「发送测试信」用） */
  testReply(to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }>
  /** 重试指定邮件的失败投递（deliveryId 省略=全部失败项） */
  retryMessage(messageId: number, deliveryId?: number): Promise<void>
  /** 应用启动时调用一次 */
  init(): Promise<void> | void
  dispose(): Promise<void> | void
}

export type { Account }
export type BusEvent = MainEvent
