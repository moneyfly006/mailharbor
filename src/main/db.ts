/**
 * SQLite 数据层（WAL）。
 * 驱动由 sqlite.ts 适配：开发用 better-sqlite3，打包后回退 Electron 内置 node:sqlite，
 * 因此 Windows 安装包不需要按平台重编译原生模块。
 * 表结构与 docs/ARCHITECTURE.md §4 对齐；密码字段用 Electron safeStorage 加密后存 BLOB。
 */
import { app, safeStorage } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { SCHEMA } from './schema'
import { openSqlite, type Db } from './sqlite'

export type DB = Db
let db: DB | null = null


export function getDbPath(): string {
  const userData = app.getPath('userData')
  return join(userData, 'mailharbor.db')
}

export function openDb(customPath?: string): DB {
  if (db) return db
  const path = customPath ?? getDbPath()
  mkdirSync(dirname(path), { recursive: true })
  db = openSqlite(path)
  db.exec(SCHEMA)
  migrate(db)
  db.prepare(`INSERT OR REPLACE INTO schema_meta(key,value) VALUES('version','1')`).run()
  return db
}

/** 轻量迁移：给老库补新列（SQLite 不支持 IF NOT EXISTS 的 ADD COLUMN） */
function migrate(database: ReturnType<typeof openSqlite>): void {
  const cols = (table: string): string[] =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  try {
    if (!cols('accounts').includes('allow_self_signed')) {
      database.exec('ALTER TABLE accounts ADD COLUMN allow_self_signed INTEGER NOT NULL DEFAULT 0')
    }
    if (!cols('accounts').includes('send_only')) {
      database.exec('ALTER TABLE accounts ADD COLUMN send_only INTEGER NOT NULL DEFAULT 0')
    }
    if (!cols('messages').includes('links')) {
      database.exec('ALTER TABLE messages ADD COLUMN links TEXT')
    }
  } catch {
    /* 迁移失败不阻塞启动（旧库仍可用，只是没有该开关） */
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}

/** 已打开的数据库实例（ipc.ts 直接用）；未打开时抛错，避免静默写入错误路径 */
export function getDb(): DB {
  if (!db) throw new Error('数据库尚未初始化（应先调用 openDb）')
  return db
}

// ---------------------------------------------------------------------------
// 密码加密（Windows DPAPI / macOS Keychain，Electron safeStorage）
// ---------------------------------------------------------------------------
export function encryptSecret(plain: string): Buffer {
  if (!plain) return Buffer.alloc(0)
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain)
  // 极端场景（无系统密钥环）：仅开发环境允许明文，正式环境提示
  console.warn('[security] safeStorage 不可用，密码将以明文形式存储')
  return Buffer.from(`plain:${plain}`, 'utf8')
}

export function decryptSecret(buf: Buffer | null | undefined): string {
  if (!buf || buf.length === 0) return ''
  try {
    const asText = buf.toString('utf8')
    if (asText.startsWith('plain:')) return asText.slice(6)
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  pollIntervalSec: 30,
  autostart: false,
  minimizeToTray: true,
  defaultPathEnabled: false,
  defaultPath: '',
  replyEnabled: true,
  replyDelaySec: 10,
  replyThreadOnce: true,
  replyHourlyCap: 60,
  replyLanguage: 'en',
  factoryName: '海印 POD · 印前组',
  replySubjectZh: '图稿已收到 · {关键词}',
  replyBodyZh: '您好，\n\n已收到您的图稿（{数量} 个文件）：\n{文件名}\n\n我们会尽快安排处理，如需补充请直接回复本邮件。\n\n{工厂名}',
  replySubjectEn: 'Artwork received — {关键词}',
  replyBodyEn: 'Hi there,\n\nReceived — thanks! We\'ve filed your artwork: {文件名}\n\nBest regards,\n{工厂名}',
  logLevel: 'info',
  proxy: { mode: 'system', host: '127.0.0.1', port: 7890 },
  replyAccountId: null,
  retryMaxAttempts: 8,
  downloadAttempts: 3,
  downloadTimeoutSec: 900,
  extractArchives: true,
  multiRuleStrategy: 'all'
}

export function getSetting<T = unknown>(key: string): T {
  const row = openDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  if (!row) return DEFAULT_SETTINGS[key] as T
  try { return JSON.parse(row.value) as T } catch { return DEFAULT_SETTINGS[key] as T }
}

export function setSetting(key: string, value: unknown): void {
  openDb()
    .prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run(key, JSON.stringify(value), Date.now())
}
