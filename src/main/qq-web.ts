import { BrowserWindow, session } from 'electron'

const loginWindows = new Map<number, BrowserWindow>()

export function qqFileLink(value: string): boolean {
  const url = URL.parse(value)
  if (url?.protocol !== 'https:' || url.username || url.password) return false
  if (url.hostname === 'mail.qq.com') {
    return /^\/cgi-bin\/(?:ftn(?:ex)?|download)(?:\/|$)/i.test(url.pathname)
  }
  return (url.hostname === 'wx.mail.qq.com' && /^\/ftn(?:\/|$)/i.test(url.pathname))
    || url.hostname === 'ftn.qq.com'
}

export function qqWebSession(accountId: number): Electron.Session {
  const ses = session.fromPartition(`persist:qq-web-${accountId}`)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  return ses
}

function qqLoginUrl(value: string): boolean {
  const url = URL.parse(value)
  if (url?.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname
  return host === 'mail.qq.com' || host.endsWith('.mail.qq.com')
    || host === 'ptlogin2.qq.com' || host.endsWith('.ptlogin2.qq.com')
    || host === 'accounts.qq.com' || host === 'open.weixin.qq.com'
}

export async function openQqLogin(accountId: number, parent: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const window = new BrowserWindow({
    parent,
    width: 1120,
    height: 790,
    autoHideMenuBar: true,
    title: 'QQ 邮箱官网登录',
    webPreferences: {
      session: qqWebSession(accountId),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })
  loginWindows.set(accountId, window)
  window.once('closed', () => loginWindows.delete(accountId))
  window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event) => {
    if (!qqLoginUrl(event.url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => {
    if (event.isMainFrame && !qqLoginUrl(event.url)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (qqLoginUrl(url)) void window.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  try {
    await window.loadURL('https://mail.qq.com/')
  } catch {
    if (!window.isDestroyed()) window.destroy()
    throw new Error('QQ 邮箱登录页加载失败')
  }
}
