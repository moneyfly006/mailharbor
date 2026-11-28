/**
 * 生产后端装配入口：由 backend.ts 懒加载。
 * 只做 electron 相关注入（DB 路径、safeStorage 密码编解码、临时目录），业务逻辑全在 backend-core.ts。
 */
import type { EventEmitter } from 'node:events'
import { app } from 'electron'
import { join } from 'node:path'
import { openDb, getSetting, encryptSecret, decryptSecret } from './db'
import { createBackendWith } from './backend-core'
import type { Backend } from './services'
import type { MainEvent } from '@shared/types'
import { qqFileLink } from './qq-web'
import { downloadLinkedFile } from './link-download'
import { downloadControl } from './download-control'

export function createBackendImpl(ctx: { bus: EventEmitter }): Backend {
  const db = openDb()
  /** 找一个已登录 QQ 网页的账户 id（settings 里 qqWebEnabled:<id>=true） */
  const qqSessionAccountId = (): number | null => {
    try {
      const row = db
        .prepare("SELECT key FROM settings WHERE key LIKE 'qqWebEnabled:%' AND (value='true' OR value='1' OR value LIKE '%true%') LIMIT 1")
        .get() as { key?: string } | undefined
      const id = row?.key ? Number(String(row.key).split(':')[1]) : NaN
      return Number.isFinite(id) ? id : null
    } catch {
      return null
    }
  }
  return createBackendWith({
    db,
    bus: ctx.bus,
    codec: { encrypt: encryptSecret, decrypt: decryptSecret },
    getSetting,
    tmpDir: join(app.getPath('temp'), 'mailharbor'),
    linkedFiles: {
      // QQ 超大附件链接（wx.mail.qq.com / ftn.qq.com）只要本机有任一已登录的 QQ 网页会话即可下载，
      // 不要求「收到这封邮件的账户」是 QQ 账户——Gmail 收到 QQ 超大附件链接也能自动下载。
      supports: (_account, url) => qqFileLink(url) && qqSessionAccountId() !== null,
      download: (_accountId, messageId, url, dest) => {
        const sid = qqSessionAccountId()
        if (!sid) throw new Error('还没有登录 QQ 网页，请到「邮箱账户」页点「登录 QQ 网页」')
        return downloadLinkedFile({
          accountId: sid,
          messageId,
          url,
          connections: Math.max(2, Math.min(32, Number(getSetting<number>('downloadConnections')) || 8)),
          isPaused: () => downloadControl.isPaused(messageId),
          isCancelled: () => downloadControl.isCancelled(messageId),
          background: { dest, timeoutMs: Math.max(60, Number(getSetting('downloadTimeoutSec')) || 900) * 1000 },
          onProgress: (progress) => ctx.bus.emit('event', { type: 'download:progress', progress } satisfies MainEvent)
        })
      }
    }
  })
}
