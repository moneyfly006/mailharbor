/**
 * IPC 入口：渲染层 → 主进程。所有 handler 做参数校验、错误兜底，并统一返回可序列化结构。
 * 账户/规则/记录等 CRUD 直接走 repos；网络类操作（测试连接、立即检查）走 backend。
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  Account, AccountInput, DashboardData, ListRecordsQuery, ListRecordsResult,
  MainEvent, Rule, RuleInput, Settings, TestResult
} from '@shared/types'
import * as repos from './repos'
import type { Backend } from './services'
import { getDb, getSetting, setSetting, DEFAULT_SETTINGS } from './db'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface IpcContext {
  getBackend: () => Backend | null
  getWindow: () => BrowserWindow | null
  broadcast: (e: MainEvent) => void
}

let ctx: IpcContext | null = null

function requireBackend(): Backend {
  const b = ctx?.getBackend()
  if (!b) throw new Error('后端尚未启动完成，请稍后再试')
  return b
}

function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  throw new Error(msg)
}

export function registerIpc(context: IpcContext): void {
  ctx = context

  // ---------------- 账户 ----------------
  ipcMain.handle(IPC.accountList, (): Account[] => repos.listAccounts())

  ipcMain.handle(IPC.accountCreate, async (_e, input: AccountInput): Promise<Account> => {
    try {
      const acc = repos.createAccount(input)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      ctx?.broadcast({ type: 'dashboard:changed' })
      return acc
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountUpdate, async (_e, id: number, input: AccountInput): Promise<Account> => {
    try {
      const acc = repos.updateAccount(id, input)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      return acc
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountDelete, async (_e, id: number): Promise<void> => {
    try {
      repos.deleteAccount(id)
      ctx?.broadcast({ type: 'dashboard:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountTest, async (_e, input: AccountInput): Promise<TestResult> => {
    try {
      return await requireBackend().testAccount(input)
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountTestSaved, async (_e, id: number): Promise<TestResult> => {
    try {
      return await requireBackend().testSavedAccount(id)
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.accountToggle, async (_e, id: number, enabled: boolean): Promise<Account> => {
    try {
      const acc = repos.setAccountEnabled(id, enabled)
      ctx?.broadcast({ type: 'account:changed', account: acc })
      if (enabled) void requireBackend().scheduler.resume()
      return acc
    } catch (e) { fail(e) }
  })

  // ---------------- 规则 ----------------
  ipcMain.handle(IPC.ruleList, (): Rule[] => repos.listRules())

  ipcMain.handle(IPC.ruleCreate, async (_e, input: RuleInput): Promise<Rule> => {
    try {
      const rule = repos.createRule(input)
      ctx?.broadcast({ type: 'rules:changed' })
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleUpdate, async (_e, id: number, input: RuleInput): Promise<Rule> => {
    try {
      const rule = repos.updateRule(id, input)
      ctx?.broadcast({ type: 'rules:changed' })
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleDelete, async (_e, id: number): Promise<void> => {
    try {
      repos.deleteRule(id)
      ctx?.broadcast({ type: 'rules:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleToggle, async (_e, id: number, enabled: boolean): Promise<Rule> => {
    try {
      const rule = repos.setRuleEnabled(id, enabled)
      ctx?.broadcast({ type: 'rules:changed' })
      return rule
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleReorder, async (_e, ids: number[]): Promise<void> => {
    try {
      repos.reorderRules(ids)
      ctx?.broadcast({ type: 'rules:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.ruleTargetsHealth, (): Rule[] => repos.listRulesWithHealth())

  // ---------------- 记录 ----------------
  ipcMain.handle(IPC.recordsList, (_e, q: ListRecordsQuery): ListRecordsResult => repos.listRecords(q))

  ipcMain.handle(IPC.recordsRetry, async (_e, messageId: number, deliveryId?: number): Promise<void> => {
    try {
      await requireBackend().retryMessage(messageId, deliveryId)
      ctx?.broadcast({ type: 'dashboard:changed' })
    } catch (e) { fail(e) }
  })

  ipcMain.handle(IPC.recordsOpenFolder, async (_e, messageId: number, deliveryId?: number): Promise<void> => {
    const dir = repos.folderOfRecord(messageId, deliveryId)
    if (!dir) throw new Error('没有可打开的文件夹')
    await shell.openPath(dir)
  })

  ipcMain.handle(IPC.recordsExport, async (_e, q: ListRecordsQuery): Promise<{ path: string } | null> => {
    const win = ctx?.getWindow()
    const res = await dialog.showSaveDialog(win!, {
      title: '导出下载记录',
      defaultPath: join(app.getPath('downloads'), `mailharbor-records-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    const all = repos.listRecords({ ...q, page: 1, pageSize: 100000 })
    const csv = repos.recordsToCsv(all.rows)
    await writeFile(res.filePath, '\ufeff' + csv, 'utf8') // BOM 便于 Excel 打开中文
    return { path: res.filePath }
  })

  ipcMain.handle(IPC.recordsClear, async (): Promise<void> => {
    getDb().prepare('DELETE FROM messages').run()
    ctx?.broadcast({ type: 'dashboard:changed' })
  })

  // ---------------- 概览 / 运行控制 ----------------
  ipcMain.handle(IPC.dashboard, (): DashboardData => buildDashboard())

  ipcMain.handle(IPC.listeningSet, async (_e, on: boolean): Promise<boolean> => {
    const b = requireBackend()
    if (on) {
      await b.scheduler.resume()
      b.bus.emit('event', { type: 'listening:changed', listening: true } satisfies MainEvent)
    } else {
      b.scheduler.pause()
      b.bus.emit('event', { type: 'listening:changed', listening: false } satisfies MainEvent)
    }
    return on
  })

  ipcMain.handle(IPC.checkNow, async (): Promise<void> => {
    await requireBackend().scheduler.checkNow()
  })

  // ---------------- 设置 ----------------
  ipcMain.handle(IPC.settingsGet, (): Settings => readSettings())

  ipcMain.handle(IPC.settingsSave, async (_e, s: Settings): Promise<Settings> => {
    for (const [k, v] of Object.entries(s)) setSetting(k, v)
    setSetting('pollIntervalSec', Math.max(15, Math.min(3600, Number(s.pollIntervalSec) || 30)))
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!s.autostart, args: ['--autostart'] })
    }
    ctx?.broadcast({ type: 'dashboard:changed' })
    return readSettings()
  })

  // ---------------- 通用 ----------------
  ipcMain.handle(IPC.pickFolder, async (): Promise<string | null> => {
    const win = ctx?.getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: '选择存储文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.openPath, async (_e, p: string): Promise<void> => {
    await shell.openPath(p)
  })

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    listening: ctx?.getBackend()?.scheduler.isListening() ?? false
  }))
}

export function readSettings(): Settings {
  const out = {} as Settings
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    ;(out as unknown as Record<string, unknown>)[key] = getSetting(key)
  }
  return out
}

export function buildDashboard(): DashboardData {
  const db = getDb()
  const dashboard = repos.dashboardStats()
  const accounts = repos.listAccounts()
  const recent = repos.listRecords({ page: 1, pageSize: 8 }).rows
  const b = ctx?.getBackend()
  const startedAt = (globalThis as Record<string, unknown>).__mhStartedAt as number | undefined
  void db
  return {
    listening: b?.scheduler.isListening() ?? false,
    accounts,
    todayMessages: dashboard.todayMessages,
    todayMatched: dashboard.todayMatched,
    todayFiles: dashboard.todayFiles,
    todayFailed: dashboard.todayFailed,
    pendingRetry: dashboard.pendingRetry,
    disks: repos.listDisks(),
    recent,
    pollIntervalSec: getSetting<number>('pollIntervalSec') ?? 30,
    nextCheckAt: b?.scheduler.nextCheckAt() ?? null,
    uptimeMs: startedAt ? Date.now() - startedAt : 0
  }
}

export function disposeIpc(): void {
  for (const ch of Object.values(IPC)) ipcMain.removeHandler(ch)
}
