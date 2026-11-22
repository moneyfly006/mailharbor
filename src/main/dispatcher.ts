/**
 * 投递调度器：附件 × 目标路径（deliveries 状态机 + 重试队列 + 启动对账）。
 *
 * 核心规则（ARCHITECTURE §6.3）：
 *  - 跨路径并行、单路径串行，全局并发上限 4
 *  - 已 done 的 delivery 永不重做（A 盘成功、B 盘失败 → 只重试 B）
 *  - 路径不可用 / 空间不足 → retry_wait，**不消耗 attempts**，60s 后再查
 *  - 复制失败 → attempts+1，退避 15s→30s→1m→2m→5m→10m→30m→1h；超过 retryMaxAttempts(默认8) → failed
 *  - 启动对账：copying 状态根据目标目录里已存在文件（size+sha256）认领 done，否则重做
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { MainEvent } from '@shared/types'
import * as repos from './repos'
import type { DeliveryRow } from './repos'
import { copyIntoDir, diskFree, pathExists, sanitizeFilename } from './file-writer'
import { createLogger, type Logger } from './log'

export type Emit = (e: MainEvent) => void

export const RETRY_DELAYS_MS = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000
]
export const PATH_RECHECK_MS = 60_000
export const DEFAULT_MAX_ATTEMPTS = 8
export const DEFAULT_CONCURRENCY = 4
const TICK_MS = 3000
const TMP_MAX_AGE_MS = 24 * 3600 * 1000
const MIN_FREE_BYTES = 2 * 1024 * 1024 // 再小的盘也不值得写

/** 第 n 次失败后的等待时间（n 从 1 开始） */
export function retryDelayMs(attempts: number): number {
  const idx = Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1))
  return RETRY_DELAYS_MS[idx]!
}

/** 路径类错误：不消耗 attempts，只等路径/空间恢复 */
const PATH_CODES = new Set(['PATH_UNAVAILABLE', 'NO_SPACE', 'ACCESS_DENIED'])

export function classifyCopyError(e: unknown): { code: string; message: string } {
  const err = e as NodeJS.ErrnoException & { code?: string }
  const code = typeof err?.code === 'string' ? err.code : 'COPY_FAILED'
  const message = e instanceof Error ? e.message : String(e)
  const mapped =
    code === 'ENOSPC'
      ? 'NO_SPACE'
      : code === 'EACCES' || code === 'EPERM'
        ? 'ACCESS_DENIED'
        : code === 'ENOENT' || code === 'ENOTDIR'
          ? 'PATH_UNAVAILABLE'
          : PATH_CODES.has(code)
            ? code
            : 'COPY_FAILED'
  return { code: mapped, message }
}

export interface TargetPrecheck {
  ok: boolean
  code?: string
  message?: string
}

/** 写盘前置检查：目录存在、是目录、可写、剩余空间 ≥ 附件 × 1.2 */
export async function precheckTarget(targetPath: string, neededBytes = 0): Promise<TargetPrecheck> {
  if (!targetPath) return { ok: false, code: 'PATH_UNAVAILABLE', message: '目标文件夹为空' }
  try {
    const st = await stat(targetPath)
    if (!st.isDirectory()) {
      return { ok: false, code: 'PATH_UNAVAILABLE', message: `目标路径不是文件夹：${targetPath}` }
    }
  } catch {
    return { ok: false, code: 'PATH_UNAVAILABLE', message: `目标文件夹不可用（盘未挂载或无权限）：${targetPath}` }
  }
  const space = await diskFree(targetPath)
  if (!space) return { ok: false, code: 'PATH_UNAVAILABLE', message: `无法读取磁盘剩余空间：${targetPath}` }
  const need = Math.max(neededBytes * 1.2, MIN_FREE_BYTES)
  if (space.free < need) {
    return {
      ok: false,
      code: 'NO_SPACE',
      message: `目标磁盘空间不足：剩余 ${(space.free / 1024 / 1024).toFixed(0)}MB，至少需要 ${(need / 1024 / 1024).toFixed(0)}MB`
    }
  }
  return { ok: true }
}

export interface DispatcherDeps {
  emit: Emit
  getSetting: <T = unknown>(key: string) => T
  tmpDir: string
  now?: () => number
  logger?: Logger
  concurrency?: number
}

export class Dispatcher {
  private deps: DispatcherDeps
  private log: Logger
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = true
  private active = new Map<number, Promise<void>>()
  private kickScheduled = false

  /** 全部 delivery 进入终态时回调（pipeline 聚合状态 + 触发回信） */
  onSettled: ((messageId: number) => void | Promise<void>) | null = null

  constructor(deps: DispatcherDeps) {
    this.deps = deps
    this.log = deps.logger ?? createLogger('dispatcher')
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private maxAttempts(): number {
    const raw = Number(this.deps.getSetting<number>('retryMaxAttempts') ?? DEFAULT_MAX_ATTEMPTS)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ATTEMPTS
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => void this.runOnce(), TICK_MS)
    void this.runOnce()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 有新的 delivery 入队时尽快跑一轮（不阻塞调用方） */
  schedule(): void {
    if (this.kickScheduled) return
    this.kickScheduled = true
    setTimeout(() => {
      this.kickScheduled = false
      void this.runOnce()
    }, 30)
  }

  /**
   * 扫一轮到期队列：全局并发 ≤4、同目标路径串行（路径 A 与路径 B 可并行）。
   */
  async runOnce(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = repos.dueDeliveries(this.now())
      if (due.length === 0) return
      const concurrency = Math.max(1, this.deps.concurrency ?? DEFAULT_CONCURRENCY)
      const busyPaths = new Set<string>()
      let cursor = 0
      const launch = (): void => {
        while (cursor < due.length && this.active.size < concurrency) {
          const row = due[cursor++]!
          if (this.active.has(row.id)) continue
          if (busyPaths.has(row.target_path)) continue
          busyPaths.add(row.target_path)
          const task = this.processDelivery(row)
            .catch((e) => this.log.warn(`delivery #${row.id} 处理异常`, e instanceof Error ? e.message : String(e)))
            .finally(() => {
              busyPaths.delete(row.target_path)
              this.active.delete(row.id)
              launch()
            })
          this.active.set(row.id, task)
        }
      }
      launch()
      while (this.active.size > 0) {
        await Promise.all([...this.active.values()])
      }
    } finally {
      this.ticking = false
    }
  }

  private async processDelivery(row: DeliveryRow): Promise<void> {
    const messageId = row.message_id
    const attachment = repos.getAttachment(row.attachment_id)
    if (!attachment || !attachment.tmp_path || !(await pathExists(attachment.tmp_path))) {
      const attempts = row.attempts + 1
      repos.markDeliveryFailed(row.id, {
        errorCode: 'TMP_MISSING',
        error: '本地临时附件已丢失，无法投递（可在这条记录上点重试）',
        attempts
      })
      this.log.warn(`delivery #${row.id} 临时文件缺失：${attachment?.tmp_path ?? '-'}`)
      this.afterDelivery(row, 'delivery:changed')
      return
    }

    // 1) 路径预检（不可用/空间不足不消耗 attempts）
    const size = attachment.size ?? 0
    const pre = await precheckTarget(row.target_path, size)
    if (!pre.ok) {
      repos.markDeliveryRetry(row.id, {
        errorCode: pre.code ?? 'PATH_UNAVAILABLE',
        error: pre.message ?? '目标路径不可用',
        nextRetryAt: this.now() + PATH_RECHECK_MS,
        attempts: row.attempts
      })
      this.afterDelivery(row, 'delivery:changed')
      return
    }

    // 2) 复制（临时文件 + 原子 rename 由 file-writer 负责）
    repos.updateDeliveryState(row.id, 'copying', { startedAt: this.now(), errorCode: null, error: null })
    this.deps.emit({ type: 'delivery:changed', messageId })
    const filename = sanitizeFilename(attachment.filename || basename(attachment.tmp_path), 'attachment')
    try {
      const copied = await copyIntoDir(attachment.tmp_path, row.target_path, filename)
      repos.markDeliveryDone(row.id, {
        savedPath: copied.savedPath,
        savedName: copied.savedName,
        size: copied.size,
        sha256: attachment.sha256
      })
      this.log.info(`已落盘 ${copied.savedPath}`)
      this.afterDelivery(row, 'delivery:changed')
      this.deps.emit({ type: 'dashboard:changed' })
      return
    } catch (e) {
      const { code, message } = classifyCopyError(e)
      if (PATH_CODES.has(code)) {
        // 路径/权限/空间问题：不消耗 attempts
        repos.markDeliveryRetry(row.id, {
          errorCode: code,
          error: message,
          nextRetryAt: this.now() + PATH_RECHECK_MS,
          attempts: row.attempts
        })
        this.log.warn(`投递 #${row.id} 路径不可用（不消耗重试次数）：${code} ${message}`)
      } else {
        const attempts = row.attempts + 1
        if (attempts >= this.maxAttempts()) {
          repos.markDeliveryFailed(row.id, { errorCode: code, error: message, attempts })
          this.log.error(`投递 #${row.id} 达到最大重试次数，标记失败：${message}`)
        } else {
          repos.markDeliveryRetry(row.id, {
            errorCode: code,
            error: message,
            nextRetryAt: this.now() + retryDelayMs(attempts),
            attempts
          })
          this.log.warn(`投递 #${row.id} 第 ${attempts} 次失败，将重试：${message}`)
        }
      }
      this.afterDelivery(row, 'delivery:changed')
      this.deps.emit({ type: 'dashboard:changed' })
    }
  }

  /** 状态变化后：刷新聚合状态，若全部进入终态则通知 pipeline（聚合 + 回信） */
  private afterDelivery(row: DeliveryRow, event: 'delivery:changed'): void {
    this.deps.emit({ type: event, messageId: row.message_id })
    this.refreshMessageStatus(row.message_id)
  }

  /** 聚合 messages.status 并推送记录行；全部终态时回调 onSettled */
  refreshMessageStatus(messageId: number): void {
    const agg = repos.deliveryAggregate(messageId)
    if (agg.total === 0) return
    const before = repos.getMessage(messageId)
    if (!before) return
    let next: typeof before.status
    if (agg.allTerminal) {
      if (agg.requiredFailed > 0 || (agg.failed > 0 && agg.done === 0)) next = 'failed'
      else next = 'done'
    } else if (agg.failed > 0 || agg.retryWait > 0 || (agg.done > 0 && (agg.pending > 0 || agg.copying > 0))) {
      next = 'partial'
    } else {
      next = 'queued'
    }
    if (next !== before.status) {
      repos.updateMessageStatus(messageId, next, next === 'failed' ? before.error ?? '存在未完成的必达路径' : null)
      const record = repos.getRecordById(messageId)
      if (record) this.deps.emit({ type: 'message:upserted', record })
      this.log.info(`邮件 #${messageId} 状态 ${before.status} → ${next}`)
    }
    if (agg.allTerminal && before.status !== next) {
      try {
        void this.onSettled?.(messageId)
      } catch (e) {
        this.log.warn(`settle 回调异常 #${messageId}`, e instanceof Error ? e.message : String(e))
      }
    }
  }

  /** 手动重试：deliveryId 省略时重试该邮件全部失败路径 */
  async retryDelivery(messageId: number, deliveryId?: number): Promise<void> {
    const changed = repos.resetDeliveriesForRetry(messageId, deliveryId)
    if (changed > 0) {
      repos.updateMessageStatus(messageId, 'queued', null)
      const record = repos.getRecordById(messageId)
      if (record) this.deps.emit({ type: 'message:upserted', record })
      this.schedule()
    } else {
      this.schedule()
    }
    this.deps.emit({ type: 'dashboard:changed' })
  }

  /**
   * 启动对账：
   *  1) copying 状态的投递——目标目录里已有 size+sha256 一致的文件则认领为 done，否则重置 pending 重做
   *  2) 清理 tmp 目录下 >24h 的 .part 残留
   */
  async reconcile(): Promise<{ adopted: number; reset: number; tmpCleaned: number }> {
    let adopted = 0
    let reset = 0
    const affectedMessages = new Set<number>()
    for (const row of repos.copyingDeliveries()) {
      affectedMessages.add(row.message_id)
      const attachment = repos.getAttachment(row.attachment_id)
      if (!attachment) {
        repos.markDeliveryFailed(row.id, { errorCode: 'ATTACHMENT_MISSING', error: '附件记录缺失', attempts: row.attempts })
        reset++
        continue
      }
      const found = await this.findAdoptableFile(
        row.target_path,
        sanitizeFilename(attachment.filename, 'attachment'),
        attachment.size ?? 0,
        attachment.sha256
      )
      if (found) {
        repos.markDeliveryDone(row.id, { savedPath: found.path, savedName: found.name, size: found.size, sha256: attachment.sha256 })
        this.log.info(`对账认领已落盘文件：${found.path}`)
        adopted++
      } else {
        reset++
      }
    }
    if (reset > 0) repos.resetCopyingDeliveries()
    const tmpCleaned = await this.cleanupTmp()
    // 对账后重新聚合受影响邮件的状态
    for (const messageId of affectedMessages) this.refreshMessageStatus(messageId)
    return { adopted, reset, tmpCleaned }
  }

  private async findAdoptableFile(
    dir: string,
    filename: string,
    expectedSize: number,
    sha256: string | null
  ): Promise<{ path: string; name: string; size: number } | null> {
    if (!dir || !(await pathExists(dir))) return null
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return null
    }
    const ext = extname(filename)
    const stem = filename.slice(0, filename.length - ext.length)
    const pattern = new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?${escapeRegExp(ext)}$`)
    for (const name of entries) {
      if (!pattern.test(name)) continue
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (!st.isFile()) continue
        if (expectedSize > 0 && st.size !== expectedSize) continue
        if (sha256) {
          const got = await sha256OfFile(full)
          if (got !== sha256) continue
        }
        return { path: full, name, size: st.size }
      } catch {
        continue
      }
    }
    return null
  }

  private async cleanupTmp(): Promise<number> {
    const dir = this.deps.tmpDir
    let count = 0
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return 0
    }
    const deadline = this.now() - TMP_MAX_AGE_MS
    for (const name of entries) {
      if (!name.endsWith('.part') && !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (st.mtimeMs < deadline) {
          await rm(full, { force: true })
          count++
        }
      } catch {
        /* ignore */
      }
    }
    if (count > 0) this.log.info(`清理临时文件 ${count} 个`)
    return count
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}
