/**
 * 后端装配核心（不依赖 electron，可被单测直接组装）。
 *
 * 生产入口 backend-impl.ts 注入 db.ts 的 openDb/加密实现；单测注入 :memory: 数据库 +
 * 假 Provider / 假 SMTP 发送函数，从而端到端验证「收信 → 匹配 → 下载 → 扇出 → 记录 → 回信」。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountInput, MainEvent, TestResult } from '@shared/types'
import type { DB } from './db'
import * as repos from './repos'
import type { SecretsCodec } from './repos'
import { configureRepos } from './repos'
import { Dispatcher } from './dispatcher'
import { MailPipeline } from './pipeline'
import { ReplyService } from './reply-service'
import { Scheduler, type SchedulerProvider } from './scheduler'
import {
  providerConfigFromAccount, providerConfigFromInput, testConnection, type ProviderConfig
} from './providers/imap'
import { sendReply as smtpSendReply, type ReplyRequest, type SendReplyResult } from './smtp'
import { setLogLevel } from './log'
import type { Backend } from './services'

export interface BackendCoreDeps {
  db: DB
  bus: EventEmitter
  codec: SecretsCodec
  getSetting: <T = unknown>(key: string) => T
  tmpDir: string
  now?: () => number
  /** 单测注入假 provider（生产不传 → 真实 IMAP/SMTP） */
  createProvider?: (account: import('@shared/types').Account, cfg: ProviderConfig) => SchedulerProvider
  /** 单测注入假发信（生产不传 → 真实 SMTP） */
  sendReply?: (cfg: import('./smtp').SmtpConfig, req: ReplyRequest) => Promise<SendReplyResult>
}

function failedTest(message: string, protocol: 'imap' | 'smtp' = 'imap', input?: AccountInput): TestResult {
  return {
    ok: false,
    lines: [
      {
        protocol: 'imap',
        ok: false,
        latencyMs: 0,
        host: input?.imapHost ?? '',
        port: input?.imapPort ?? 0,
        errorCode: 'UNKNOWN',
        message: protocol === 'imap' ? message : '跳过 IMAP 测试'
      },
      {
        protocol: 'smtp',
        ok: false,
        latencyMs: 0,
        host: input?.smtpHost ?? '',
        port: input?.smtpPort ?? 0,
        errorCode: 'UNKNOWN',
        message: protocol === 'smtp' ? message : '跳过 SMTP 测试'
      }
    ],
    testedAt: Date.now()
  }
}

export function createBackendWith(deps: BackendCoreDeps): Backend {
  const emit = (e: MainEvent): void => {
    try {
      deps.bus.emit('event', e)
    } catch {
      /* 渲染层未就绪不影响主流程 */
    }
  }
  const now = deps.now ?? ((): number => Date.now())

  configureRepos({ db: deps.db, codec: deps.codec })
  try {
    setLogLevel(String(deps.getSetting('logLevel') ?? 'info'))
  } catch {
    /* ignore */
  }
  mkdirSync(deps.tmpDir, { recursive: true })

  const dispatcher = new Dispatcher({
    emit,
    getSetting: deps.getSetting,
    tmpDir: deps.tmpDir,
    now
  })
  const replyService = new ReplyService({
    emit,
    getSetting: deps.getSetting,
    getSecrets: (id) => repos.getAccountSecrets(id),
    now,
    send: deps.sendReply ?? smtpSendReply
  })
  const pipeline = new MailPipeline({
    emit,
    getSetting: deps.getSetting,
    dispatcher,
    replyService,
    tmpDir: deps.tmpDir,
    now
  })
  dispatcher.onSettled = (messageId) => pipeline.onDeliveriesSettled(messageId)

  const scheduler = new Scheduler({
    emit,
    getSetting: deps.getSetting,
    pipeline: {
      process: (account, provider, msg) => pipeline.process(account, provider as never, msg)
    },
    now,
    createProvider: deps.createProvider
  })

  let disposed = false
  const backend: Backend = {
    bus: deps.bus,
    scheduler: {
      startAll: () => scheduler.startAll(),
      stopAll: () => scheduler.stopAll(),
      pause: () => scheduler.pause(),
      resume: async () => {
        await scheduler.resume()
        emit({ type: 'dashboard:changed' })
      },
      isListening: () => scheduler.isListening(),
      checkNow: async () => {
        await scheduler.checkNow()
      },
      nextCheckAt: () => scheduler.nextCheckAt()
    },
    async testAccount(input: AccountInput): Promise<TestResult> {
      if (!input?.password) return failedTest('请填写应用专用密码 / 授权码后再测试连接', 'imap', input)
      if (!input.smtpSameAsImap && !input.smtpPassword) {
        return failedTest('请填写 SMTP 密码（未勾选「与收件使用同一密码」时必填）', 'smtp', input)
      }
      try {
        return await testConnection(providerConfigFromInput(input))
      } catch (e) {
        return failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, 'imap', input)
      }
    },
    async testSavedAccount(id: number): Promise<TestResult> {
      const account = repos.getAccount(id)
      if (!account) throw new Error('账户不存在或已被删除')
      if (!account.hasPassword) return failedTest('该账户尚未保存密码，请编辑账户重新填写', 'imap')
      const secrets = repos.getAccountSecrets(id)
      const cfg = providerConfigFromAccount(account, secrets)
      try {
        return await testConnection(cfg)
      } catch (e) {
        return failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, 'imap')
      }
    },
    async reconcile(): Promise<void> {
      const r = await dispatcher.reconcile()
      if (r.adopted + r.reset + r.tmpCleaned > 0) {
        emit({ type: 'dashboard:changed' })
        emit({ type: 'toast', level: 'success', title: '启动对账完成', body: `认领 ${r.adopted} · 重做 ${r.reset} · 清理临时文件 ${r.tmpCleaned}` })
      }
    },
    async retryMessage(messageId: number, deliveryId?: number): Promise<void> {
      await dispatcher.retryDelivery(messageId, deliveryId)
    },
    async init(): Promise<void> {
      dispatcher.start()
      emit({ type: 'dashboard:changed' })
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      scheduler.stopAll()
      dispatcher.stop()
      replyService.dispose()
    }
  }
  return backend
}

/** 生产用的默认临时目录（backend-impl 会传 app.getPath('temp')） */
export function defaultTmpDir(baseTmp: string): string {
  return join(baseTmp, 'mailharbor')
}
