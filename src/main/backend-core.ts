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
import { sendReply as smtpSendReply, buildReplyVars, renderTemplate, type ReplyRequest, type SendReplyResult } from './smtp'
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
  /** 账户状态变化后推给 UI（列表/概览都靠它刷新） */
  const emitAccountChanged = (id: number): void => {
    try {
      const acc = repos.getAccount(id)
      if (acc) emit({ type: 'account:changed', account: acc })
    } catch {
      /* ignore */
    }
  }

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
      if (!account.hasPassword) {
        repos.setAccountStatus(id, 'auth_failed', { errorCode: 'PASSWORD_MISSING', error: '尚未保存密码' })
        emitAccountChanged(id)
        return failedTest('该账户尚未保存密码，请编辑账户重新填写', 'imap')
      }
      const secrets = repos.getAccountSecrets(id)
      const cfg = providerConfigFromAccount(account, secrets)
      let result: TestResult
      try {
        result = await testConnection(cfg)
      } catch (e) {
        result = failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, 'imap')
      }
      // 测试结果直接反映到账户状态：全绿 = 可收信；认证类失败 = auth_failed；网络类 = conn_failed
      const errLine = result.lines.find((l) => !l.ok)
      if (result.ok) {
        repos.setAccountStatus(id, account.enabled ? 'enabled' : 'pending_test', {
          checked: true,
          ok: true,
          errorCode: null,
          error: null
        })
      } else {
        const authFailed = errLine?.errorCode === 'IMAP_AUTH_FAILED' || errLine?.errorCode === 'SMTP_AUTH_FAILED'
        repos.setAccountStatus(id, authFailed ? 'auth_failed' : 'conn_failed', {
          checked: true,
          ok: false,
          errorCode: errLine?.errorCode ?? 'UNKNOWN',
          error: errLine?.message ?? '测试连接失败'
        })
      }
      emitAccountChanged(id)
      return result
    },
    async testReply(to: string): Promise<{ ok: boolean; message: string; providerMessageId?: string }> {
      const target = (to ?? '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
        return { ok: false, message: '收件邮箱格式不正确' }
      }
      const accounts = repos.listAccounts().filter((a) => a.enabled && a.hasPassword)
      const account = accounts[0]
      if (!account) return { ok: false, message: '没有已启用且配置了密码的账户，请先在「邮箱账户」里添加并测试通过' }
      const secrets = repos.getAccountSecrets(account.id)
      const cfg = providerConfigFromAccount(account, secrets)
      const smtpCfg = {
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure,
        user: cfg.smtpUser,
        pass: cfg.smtpPass
      }
      const settings = deps.getSetting as <T>(k: string) => T
      const lang = String(settings('replyLanguage') ?? 'en')
      const subjectTpl = String(
        lang === 'zh' ? settings('replySubjectZh') : settings('replySubjectEn')
      )
      const bodyTpl = String(lang === 'zh' ? settings('replyBodyZh') : settings('replyBodyEn'))
      const vars = buildReplyVars({
        filenames: ['POD_ORDER_TEST.zip', '设计图_测试.tif'],
        keyword: '原图+卡套',
        sentAt: Date.now(),
        factoryName: account.smtpFromName || 'MailHarbor'
      })
      try {
        const res = await (deps.sendReply ?? smtpSendReply)(smtpCfg as never, {
          from: { name: account.smtpFromName || 'MailHarbor', address: account.email },
          to: { address: target },
          subject: renderTemplate(subjectTpl, vars),
          body: renderTemplate(bodyTpl, vars)
        })
        emit({ type: 'toast', level: 'success', title: '测试信已发送', body: `收件人 ${target}` })
        return { ok: true, message: `测试信已发送到 ${target}`, providerMessageId: res.providerMessageId }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        emit({ type: 'toast', level: 'error', title: '测试信发送失败', body: msg })
        return { ok: false, message: msg }
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
