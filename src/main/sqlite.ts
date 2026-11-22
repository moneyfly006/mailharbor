/**
 * SQLite 适配层：优先用 better-sqlite3（开发/测试，同步 API 快），
 * 打包后没有原生模块时自动回退到 Electron 内置的 node:sqlite（Node 22+ / Electron 33+）。
 *
 * 这样 Windows 安装包不需要按平台重编译原生模块，macOS 上也能交叉打 exe。
 * 暴露的 API 是 repos.ts 用到的子集：exec / prepare(run|get|all) / transaction / close。
 */
import { createRequire } from 'node:module'

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Stmt {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface Db {
  exec(sql: string): void
  prepare(sql: string): Stmt
  /** better-sqlite3 风格：返回一个可重复调用的事务包装函数 */
  transaction<T>(fn: () => T): () => T
  close(): void
  /** 底层实现标识，便于日志/诊断 */
  readonly driver: 'better-sqlite3' | 'node:sqlite'
}

const requireCjs = createRequire(import.meta.url)

function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v
}

interface RawStmt {
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...p: unknown[]): unknown
  all(...p: unknown[]): unknown[]
}

interface RawBetterDb {
  exec(sql: string): void
  prepare(sql: string): RawStmt
  transaction<T>(fn: () => T): () => T
  close(): void
}

/** better-sqlite3 实现（存在就用它，行为最稳） */
function openBetterSqlite(path: string): Db | null {
  if (process.env.MH_FORCE_NODE_SQLITE === '1') return null
  try {
    const Database = requireCjs('better-sqlite3') as new (p: string) => RawBetterDb
    const raw = new Database(path)
    return {
      driver: 'better-sqlite3',
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql)
        return {
          run: (...params) => {
            const r = stmt.run(...params)
            return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) }
          },
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params)
        }
      },
      transaction: <T>(fn: () => T): (() => T) => raw.transaction(fn),
      close: () => raw.close()
    }
  } catch {
    return null
  }
}

interface RawNodeDb {
  exec(sql: string): void
  prepare(sql: string): RawStmt
  close(): void
}

/** node:sqlite 实现（Electron 内置，无需原生模块） */
function openNodeSqlite(path: string): Db {
  const { DatabaseSync } = requireCjs('node:sqlite') as { DatabaseSync: new (p: string) => RawNodeDb }
  const raw = new DatabaseSync(path)
  let depth = 0
  const exec = (sql: string): void => raw.exec(sql)
  return {
    driver: 'node:sqlite',
    exec,
    prepare: (sql) => {
      const stmt = raw.prepare(sql)
      return {
        run: (...params) => {
          const r = stmt.run(...params)
          return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) }
        },
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params)
      }
    },
    transaction<T>(fn: () => T): () => T {
      return (): T => {
        depth++
        const sp = depth
        const nested = sp > 1
        exec(nested ? `SAVEPOINT sp_${sp}` : 'BEGIN')
        try {
          const result = fn()
          exec(nested ? `RELEASE sp_${sp}` : 'COMMIT')
          return result
        } catch (e) {
          try {
            if (nested) {
              exec(`ROLLBACK TO sp_${sp}`)
              exec(`RELEASE sp_${sp}`)
            } else {
              exec('ROLLBACK')
            }
          } catch {
            /* ignore */
          }
          throw e
        } finally {
          depth--
        }
      }
    },
    close: () => raw.close()
  }
}

let activeDriver: Db['driver'] | null = null

export function openSqlite(path: string): Db {
  const better = openBetterSqlite(path)
  if (better) {
    activeDriver = better.driver
    return better
  }
  const node = openNodeSqlite(path)
  activeDriver = node.driver
  return node
}

export function currentDriver(): Db['driver'] | null {
  return activeDriver
}
