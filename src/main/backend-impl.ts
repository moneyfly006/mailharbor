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

export function createBackendImpl(ctx: { bus: EventEmitter }): Backend {
  const db = openDb()
  return createBackendWith({
    db,
    bus: ctx.bus,
    codec: { encrypt: encryptSecret, decrypt: decryptSecret },
    getSetting,
    tmpDir: join(app.getPath('temp'), 'mailharbor'),
    linkedFiles: {
      supports: (account, url) => account.preset === 'qq' && !!getSetting(`qqWebEnabled:${account.id}`) && qqFileLink(url),
      download: (accountId, messageId, url, dest) => downloadLinkedFile({
        accountId,
        messageId,
        url,
        background: { dest, timeoutMs: Math.max(60, Number(getSetting('downloadTimeoutSec')) || 900) * 1000 },
        onProgress: (progress) => ctx.bus.emit('event', { type: 'download:progress', progress } satisfies MainEvent)
      })
    }
  })
}
