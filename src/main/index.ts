/**
 * MailHarbor 主进程入口：
 * 单实例锁 → 打开数据库 → 建窗口/托盘 → 注册 IPC → 启动 IMAP 调度（后台自动收信）。
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, powerMonitor } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDb, closeDb } from './db'
import { seedDefaultRulesIfEmpty } from './seed'
import { registerIpc, disposeIpc, buildDashboard } from './ipc'
import { createBackend } from './backend'
import { createUpdater, getUpdateState } from './updater'
import type { Backend } from './services'
import type { MainEvent } from '@shared/types'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let backend: Backend | null = null
let updater: ReturnType<typeof createUpdater> | null = null
let quitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  bootstrap()
}

function broadcast(e: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('main:event', e)
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  ;(globalThis as Record<string, unknown>).__mhStartedAt = Date.now()

  openDb()
  app.setAppUserModelId('com.mailharbor.app')

  backend = createBackend({
    onEvent: (e) => {
      broadcast(e)
      if (e.type === 'toast' && e.level !== 'success') refreshTray()
      if (e.type === 'account:changed' || e.type === 'dashboard:changed') refreshTray()
    }
  })
  try {
    await backend.init()
    // 首次运行预置「标题关键词规则」（不预置任何邮箱账号/密码）
    const seeded = seedDefaultRulesIfEmpty()
    if (seeded > 0) console.log(`[main] 已预置 ${seeded} 条默认标题规则`)
  } catch (e) {
    console.error('[main] backend init failed:', e)
  }

  // --self-check：装机自检（写 JSON 到指定路径后退出），用于远程/虚拟机验收
  const selfCheckIdx = process.argv.indexOf('--self-check')
  if (selfCheckIdx >= 0) {
    const outPath = process.argv[selfCheckIdx + 1] && !process.argv[selfCheckIdx + 1].startsWith('--')
      ? process.argv[selfCheckIdx + 1]
      : join(app.getPath('temp'), 'mailharbor-selfcheck.json')
    await runSelfCheck(outPath)
    app.exit(0)
    return
  }

  updater = createUpdater({
    window: () => mainWindow,
    broadcast: (state) => broadcast({ type: 'update:changed', state })
  })

  registerIpc({
    getBackend: () => backend,
    getWindow: () => mainWindow,
    broadcast,
    updater: {
      check: (manual) => updater!.check(manual),
      installNow: () => updater!.installNow(),
      state: () => getUpdateState()
    }
  })

  registerAppEvents()
  await createWindow()
  createTray()
  startAutostartArgs()

  // 启动后台收信（隐藏启动时也收）
  try {
    await backend.scheduler.startAll()
    await backend.reconcile()
  } catch (e) {
    console.error('[main] scheduler start failed:', e)
  }

  // 休眠恢复 / 网络恢复时补扫
  powerMonitor.on('resume', () => {
    void backend?.scheduler.checkNow()
  })
  powerMonitor.on('unlock-screen', () => {
    void backend?.scheduler.checkNow()
  })
}

/** 装机自检：不需要界面，输出关键状态，便于 Windows 虚拟机/远程验收 */
async function runSelfCheck(outPath: string): Promise<void> {
  try {
    const { writeFileSync } = await import('node:fs')
    const { openDb, getDbPath, getSetting } = await import('./db')
    const repos = await import('./repos')
    openDb()
    const rules = repos.listRules()
    const accounts = repos.listAccounts()
    const report = {
      ok: true,
      checkedAt: new Date().toISOString(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath('userData'),
      dbPath: getDbPath(),
      proxy: getSetting('proxy'),
      listen: { started: true },
      rules: rules.map((r) => ({ keyword: r.keyword, enabled: r.enabled, mode: r.mode, scope: r.scope, paths: r.targets.map((t) => t.path) })),
      accounts: accounts.map((a) => ({ email: a.email, sendOnly: a.sendOnly, status: a.status }))
    }
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
    console.log('[self-check] 已写入', outPath)
    console.log(JSON.stringify(report, null, 2))
  } catch (e) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2), 'utf8')
    console.error('[self-check] 失败', e)
  }
}

function startAutostartArgs(): void {
  if (process.argv.includes('--autostart')) {
    // 开机自启：不显示窗口，只进托盘（窗口仍创建好，点击托盘即显示）
    setTimeout(() => mainWindow?.hide(), 800)
  }
}

function registerAppEvents(): void {
  app.on('window-all-closed', () => {
    // 托盘常驻：不退出
    if (quitting) app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
    try {
      updater?.dispose()
      backend?.scheduler.stopAll()
      backend?.dispose()
      disposeIpc()
      closeDb()
    } catch (e) {
      console.error('[main] shutdown error:', e)
    }
  })
  app.on('activate', () => showWindow())
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 780,
    show: false,
    title: '邮箱资料助手',
    backgroundColor: '#FAF7F0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false, // preload 需要 node 的 ipcRenderer（仍不向页面暴露 Node）
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--autostart')) mainWindow?.show()
  })

  // 关闭 = 隐藏到托盘（除非真的退出）
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const iconPath = resolveTrayIcon()
  const img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('邮箱资料助手')
  tray.on('double-click', () => showWindow())
  tray.on('click', () => showWindow())
  refreshTray()
}

function refreshTray(): void {
  if (!tray) return
  const d = safeDashboard()
  const listening = d?.listening ?? false
  const menu = Menu.buildFromTemplate([
    { label: listening ? '● 监听中' : '○ 已暂停', enabled: false },
    { label: `今日收件 ${d?.todayMessages ?? 0} 封 · 待重试 ${d?.pendingRetry ?? 0}`, enabled: false },
    { type: 'separator' },
    { label: '打开主界面', click: () => showWindow() },
    {
      label: listening ? '暂停监听' : '恢复监听',
      click: async () => {
        if (!backend) return
        if (backend.scheduler.isListening()) backend.scheduler.pause()
        else await backend.scheduler.resume()
        refreshTray()
      }
    },
    { label: '立即检查新邮件', click: () => void backend?.scheduler.checkNow() },
    {
      label: '打开存储文件夹',
      click: () => {
        const first = d?.disks?.[0]?.path
        if (first) void shell.openPath(first)
      }
    },
    { type: 'separator' },
    {
      label: '退出邮箱资料助手',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function safeDashboard(): ReturnType<typeof buildDashboard> | null {
  try {
    return buildDashboard()
  } catch {
    return null
  }
}

function resolveTrayIcon(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', 'tray.png'),
    join(__dirname, '../../resources/tray.png'),
    join(app.getAppPath(), 'resources/tray.png')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}
