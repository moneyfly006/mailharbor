import { app, BrowserWindow, session } from 'electron'
import type { DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { renameSync, existsSync, rmSync } from 'node:fs'
import type { DownloadProgress } from '@shared/types'
import { sanitizeFilename } from './file-writer'
import { BUSINESS_DEFAULT_TYPES, isAllowedAttachment } from './rule-engine'
import { createLogger } from './log'
import { qqFileLink, qqWebSession } from './qq-web'

const log = createLogger('web-download')

function httpsUrl(value: string): URL | null {
  const url = URL.parse(value)
  return url?.protocol === 'https:' && !url.username && !url.password ? url : null
}

/** 让网页自行完成登录、跳转及签发下载地址。实际文件由同一 Chromium 会话接收。 */
export async function downloadLinkedFile(options: {
  url: string
  parent?: BrowserWindow
  accountId: number
  messageId: number
  background?: { dest: string; timeoutMs: number }
  onProgress: (progress: DownloadProgress) => void
}): Promise<{ path: string; filename: string } | null> {
  const url = httpsUrl(options.url)
  if (!url) throw new Error('应用内下载需要 HTTPS 链接，请用系统浏览器打开此链接')
  const isQq = qqFileLink(options.url)
  const background = options.background
  if (background && !isQq) throw new Error('此链接不属于 QQ 文件中转站')

  const browserSession = isQq ? qqWebSession(options.accountId) : session.fromPartition(`attachment-web-${options.accountId}`)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  const webPreferences = {
    session: browserSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    backgroundThrottling: !background
  }
  const win = new BrowserWindow({
    parent: options.parent,
    show: !background,
    width: 1080,
    height: 760,
    autoHideMenuBar: true,
    title: `文件下载 · ${url.hostname}`,
    webPreferences
  })
  const windows = new Set<BrowserWindow>()
  const configure = (window: BrowserWindow): void => {
    windows.add(window)
    window.on('closed', () => windows.delete(window))
    window.on('page-title-updated', (event) => event.preventDefault())
    window.webContents.on('will-navigate', (event) => {
      if (!httpsUrl(event.url)) event.preventDefault()
    })
    window.webContents.on('will-redirect', (event) => {
      if (event.isMainFrame && !httpsUrl(event.url)) event.preventDefault()
    })
    window.webContents.on('did-navigate', (_event, currentUrl) => {
      const current = httpsUrl(currentUrl)
      if (current) window.setTitle(`文件下载 · ${current.hostname}`)
    })
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!httpsUrl(target)) return { action: 'deny' }
      return { action: 'allow', overrideBrowserWindowOptions: { parent: window, show: !background, autoHideMenuBar: true, webPreferences } }
    })
    window.webContents.on('did-create-window', configure)
  }
  configure(win)

  // QQ 超大附件页面（wx.mail.qq.com/ftn/download）不会自己开始下载，
  // 需要点页面上的「下载」按钮。这里在页面加载后自动点击，省去用户手动操作。
  // 不抓真实下载链接：链接带时效签名，抓出来容易失效；点击按钮最稳。
  let clickTimer: NodeJS.Timeout | undefined
  let clickAttempts = 0
  let settled = false
  const stopAutoClick = (): void => {
    if (clickTimer) {
      clearInterval(clickTimer)
      clickTimer = undefined
    }
  }
  const autoClickDownload = async (): Promise<void> => {
    if (win.isDestroyed() || settled) return
    try {
      const clicked = (await win.webContents.executeJavaScript(
        `(() => {
          const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' };
          const nodes = [...document.querySelectorAll('a, button, [role="button"], div, span')];
          const cands = nodes.filter((el) => visible(el) && (el.textContent || '').trim() === '下载');
          const target = cands[0] || nodes.find((el) => visible(el) && (el.textContent || '').trim().startsWith('下载'));
          if (target) { target.click(); return true }
          return false;
        })()`,
        true
      )) as boolean
      if (clicked) {
        log.info('已自动点击页面「下载」按钮', { attempts: clickAttempts + 1 })
        clickAttempts++
        // 触发点击后停止继续点（避免重复下载）；下载事件会接住文件
        if (clickAttempts >= 2) stopAutoClick()
      }
    } catch {
      /* 页面还没加载好或已关闭 */
    }
    clickAttempts++
    if (clickAttempts > 30) stopAutoClick()
  }
  win.webContents.on('did-finish-load', () => {
    stopAutoClick()
    clickAttempts = 0
    clickTimer = setInterval(() => void autoClickDownload(), 2000)
    void autoClickDownload()
  })

  return new Promise<{ path: string; filename: string } | null>((resolve, reject) => {
    let item: DownloadItem | null = null
    let pageTimer: NodeJS.Timeout | undefined
    let totalTimer: NodeJS.Timeout | undefined
    const finish = (file: { path: string; filename: string } | null, error?: Error): void => {
      if (settled) return
      settled = true
      stopAutoClick()
      clearInterval(pageTimer)
      clearTimeout(totalTimer)
      browserSession.removeListener('will-download', onDownload)
      item?.cancel()
      for (const window of windows) if (!window.isDestroyed()) window.destroy()
      // 下载保存路径是临时 .part 名；这里改回真实文件名（如 原图.rar），
      // 否则后续归档会把 .part 当普通文件、不会解压。
      if (file && background) {
        try {
          const real = join(dirname(file.path), file.filename)
          if (real !== file.path) {
            if (existsSync(real)) rmSync(real, { force: true })
            renameSync(file.path, real)
            file = { ...file, path: real }
          }
        } catch {
          /* 重命名失败则保留原路径 */
        }
      }
      if (error) reject(error)
      else resolve(file)
    }
    const onDownload = (event: Electron.Event, download: DownloadItem, contents: Electron.WebContents): void => {
      if (![...windows].some((window) => window.webContents === contents)) return
      if (item) {
        event.preventDefault()
        return
      }
      const filename = sanitizeFilename(download.getFilename(), '附件')
      const actualUrl = download.getURLChain().at(-1) ?? download.getURL()
      const downloadable = httpsUrl(actualUrl) || (actualUrl.startsWith('blob:') && httpsUrl(actualUrl.slice(5)))
      const mimeType = download.getMimeType()
      if (!downloadable || mimeType === 'text/html' || !isAllowedAttachment(filename, undefined, BUSINESS_DEFAULT_TYPES)) {
        event.preventDefault()
        finish(null, new Error('此网页返回的文件类型无法自动归档，请使用系统浏览器下载'))
        return
      }
      item = download
      // 下载原件保留到系统下载目录，归档失败时可以直接选择该文件重试。
      const savePath = background?.dest ?? join(app.getPath('downloads'), 'MailHarbor', randomUUID(), filename)
      download.setSavePath(savePath)
      let lastReport = 0
      let resumeAttempts = 0
      let interrupted = false
      const report = (state: DownloadProgress['state']): void => {
        const received = download.getReceivedBytes()
        const total = download.getTotalBytes()
        const percent = total > 0 ? Math.min(99, Math.floor(100 * received / total)) : null
        options.onProgress({
          messageId: options.messageId,
          attachmentId: -options.messageId,
          filename,
          received,
          total: state === 'done' ? received : total,
          percent: state === 'done' ? 100 : percent,
          state,
          attempt: resumeAttempts + 1,
          bytesPerSec: state === 'active' ? download.getCurrentBytesPerSecond() : 0,
          updatedAt: Date.now()
        })
        if (state === 'active' && !win.isDestroyed()) win.setProgressBar(percent == null ? 2 : percent / 100)
      }
      download.on('updated', (_event, state) => {
        if (state === 'interrupted') {
          if (resumeAttempts < 2 && download.canResume()) {
            resumeAttempts++
            download.resume()
          } else {
            interrupted = true
            download.cancel()
            return
          }
        }
        if (Date.now() - lastReport < 250) return
        lastReport = Date.now()
        report('active')
      })
      download.once('done', (_event, state) => {
        item = null
        report(state === 'completed' ? 'done' : 'failed')
        if (state === 'completed') {
          log.info(`网页附件已下载 #${options.messageId}`, {
            host: downloadable.hostname,
            bytes: download.getReceivedBytes(),
            seconds: download.getEndTime() - download.getStartTime()
          })
          finish({ path: savePath, filename })
        } else if (state === 'cancelled' && !interrupted) finish(null)
        else finish(null, new Error('网页文件下载中断，请重新打开下载链接'))
      })
      report('active')
    }
    browserSession.on('will-download', onDownload)
    if (background) {
      totalTimer = setTimeout(() => finish(null, new Error('QQ 中转站下载超时')), background.timeoutMs)
      let clicked = false
      let checking = false
      const start = Date.now()
      pageTimer = setInterval(() => {
        if (settled || item || checking || win.isDestroyed()) return
        if (Date.now() - start > 45_000 && !win.webContents.isLoading()) {
          finish(null, new Error('QQ 中转站未发起下载，请检查网页登录和文件有效期'))
          return
        }
        if (clicked || win.webContents.isLoading() || !qqFileLink(win.webContents.getURL())) return
        checking = true
        void win.webContents.executeJavaScript(`(() => {
          const visible = (element) => element.getClientRects().length > 0
          const controls = [...document.querySelectorAll('button, a, [role="button"], .xmail-ui-btn, .ui-btn-text')]
          const download = controls.find((node) => visible(node) && !node.disabled
            && /^(下载|普通下载|立即下载|下载文件|下载附件|直接下载)$/.test((node.innerText || '').trim()))
          if (download) {
            if (download instanceof HTMLAnchorElement) download.target = '_self'
            download.click()
            return 'clicked'
          }
          const text = (document.body?.innerText || '').slice(0, 500)
          if (/登录态失效|请先登录|请重新登录|扫码登录/.test(text)) return 'login'
          if (/文件已过期|附件已过期|链接已失效|文件不存在/.test(text)) return 'expired'
          return 'wait'
        })()`, true).then((result) => {
          if (settled || item) return
          if (result === 'clicked') clicked = true
          if (result === 'login') finish(null, new Error('QQ 网页登录失效，请到账户页重新扫码'))
          if (result === 'expired') finish(null, new Error('QQ 中转站的文件或链接已失效'))
        }).catch(() => {}).finally(() => { checking = false })
      }, 750)
    }
    win.once('closed', () => {
      finish(null)
    })
    void win.loadURL(url.href).catch((error: { code?: string }) => {
      // 直接返回文件时，Chromium 会取消页面导航并触发 will-download。
      if (error.code !== 'ERR_ABORTED') finish(null, new Error('下载页面加载失败，请用系统浏览器打开'))
    })
  })
}
