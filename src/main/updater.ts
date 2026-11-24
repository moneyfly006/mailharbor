/**
 * 自动更新（electron-updater + GitHub Releases）
 *
 * 流程：
 *  1. 启动 30 秒后静默检查一次；之后每 6 小时检查一次
 *  2. 发现新版本 → 后台下载（不打断用户）→ 下载完成发出通知
 *  3. 用户在界面点「重启更新」或下次退出时自动安装
 *
 * 版本来源：package.json version；CI 在打 tag 前自动 patch +1（见 .github/workflows）
 */
import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/types'

let win: BrowserWindow | null = null
let broadcast: ((s: UpdateState) => void) | null = null
let state: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progressPercent: null,
  message: null,
  checkedAt: null
}

const SIX_HOURS = 6 * 60 * 60 * 1000
let timer: NodeJS.Timeout | null = null

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast?.(state)
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

export function createUpdater(opts: {
  window: () => BrowserWindow | null
  broadcast: (s: UpdateState) => void
}): {
  check(manual?: boolean): Promise<UpdateState>
  installNow(): void
  dispose(): void
} {
  win = opts.window()
  broadcast = opts.broadcast

  if (!app.isPackaged) {
    // 开发环境没有安装包，直接返回说明，避免报错
    setState({ status: 'idle', message: '开发模式不检查更新' })
    return {
      check: async () => state,
      installNow: () => {},
      dispose: () => {}
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  // 弹窗提示（只弹一次，避免 6 小时轮询重复打扰）
  let promptedAvailable = false
  let promptedDownloaded = false
  const promptAvailable = (version: string): void => {
    if (promptedAvailable) return
    promptedAvailable = true
    const w = opts.window()
    if (!w) return
    void dialog
      .showMessageBox(w, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${version}`,
        detail: '软件已开始自动下载 GitHub 上的安装包，下载完成后会提示你重启安装。',
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true
      })
      .catch(() => {})
  }
  const promptRestart = (version: string): void => {
    if (promptedDownloaded) return
    promptedDownloaded = true
    const w = opts.window()
    if (!w) {
      // 没有窗口时直接静默安装（下次退出时也会自动安装）
      return
    }
    void dialog
      .showMessageBox(w, {
        type: 'info',
        title: '更新已下载',
        message: `新版本 v${version} 已下载完成`,
        detail: '点击「立即重启」会关闭软件并安装新版本；点「稍后」则在你下次退出时自动安装。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall(false, true)
      })
      .catch(() => {})
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', message: '正在检查更新…' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({
      status: 'available',
      availableVersion: info.version,
      message: `发现新版本 ${info.version}，正在后台下载…`
    })
    promptAvailable(info.version)
  })
  autoUpdater.on('update-not-available', () =>
    setState({ status: 'up-to-date', availableVersion: null, message: '已是最新版本', checkedAt: Date.now() })
  )
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', progressPercent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({
      status: 'downloaded',
      availableVersion: info.version,
      progressPercent: 100,
      message: `新版本 ${info.version} 已下载，重启后生效`
    })
    promptRestart(info.version)
  })
  autoUpdater.on('error', (e: Error) =>
    setState({ status: 'error', message: `检查更新失败：${e.message.slice(0, 160)}` })
  )

  const check = async (manual = false): Promise<UpdateState> => {
    try {
      setState({ checkedAt: Date.now(), message: manual ? '正在检查更新…' : state.message })
      await autoUpdater.checkForUpdates()
    } catch (e) {
      setState({
        status: 'error',
        message: `检查更新失败：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`
      })
    }
    return state
  }

  // 启动后 30 秒静默检查 + 每 6 小时
  setTimeout(() => void check(false), 30_000)
  timer = setInterval(() => void check(false), SIX_HOURS)

  return {
    check,
    installNow: () => {
      if (state.status !== 'downloaded') return
      autoUpdater.quitAndInstall(false, true)
    },
    dispose: () => {
      if (timer) clearInterval(timer)
    }
  }
}

/** 托盘/主进程可用的"发现新版本"提示 */
export function notifyUpdateReady(onClick: () => void): void {
  const w = win
  if (!w) return
  const r = dialog.showMessageBoxSync(w, {
    type: 'info',
    title: 'MailHarbor 有新版本',
    message: state.message ?? '新版本已下载',
    buttons: ['重启更新', '稍后'],
    defaultId: 0,
    cancelId: 1
  })
  if (r === 0) onClick()
}
