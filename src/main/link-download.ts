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
  /** 多线程分段下载连接数（2–32），用于 QQ 中转站 CDN 加速 */
  connections?: number
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
  let firstClickAt = 0
  let settled = false
  let finishRef: ((file: { path: string; filename: string } | null, error?: Error) => void) | null = null
  let rangeDisabled = false
  const stopAutoClick = (): void => {
    if (clickTimer) {
      clearInterval(clickTimer)
      clickTimer = undefined
    }
  }
  const autoClickDownload = async (): Promise<void> => {
    if (win.isDestroyed() || settled) return
    try {
      // 先拿到按钮在页面里的坐标，再用真实鼠标事件点击：
      // 纯 JS click() 没有用户手势，Chromium 会拦截由此触发的下载。
      const loginNeeded = (await win.webContents.executeJavaScript(
        `(() => {
          const t = (document.body && document.body.innerText) || '';
          return /登录QQ邮箱|登录 QQ 邮箱|请先登录/.test(t);
        })()`,
        true
      )) as boolean
      if (loginNeeded) {
        stopAutoClick()
        finishRef?.(null, new Error('QQ 网页登录已过期，请到「邮箱账户」页点「登录 QQ 网页」重新扫码登录后再试'))
        return
      }
      const rect = (await win.webContents.executeJavaScript(
        `(() => {
          const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' };
          const nodes = [...document.querySelectorAll('a, button, [role="button"], div, span')];
          const exact = nodes.filter((el) => visible(el) && (el.textContent || '').trim() === '下载' && el.children.length === 0);
          const target = exact[0] || nodes.find((el) => visible(el) && (el.textContent || '').trim() === '下载');
          if (!target) return null;
          const r = target.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        true
      )) as { x: number; y: number } | null
      if (rect && rect.x > 0 && rect.y > 0) {
        if (!firstClickAt) firstClickAt = Date.now()
        win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
        win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        log.info('已用真实鼠标点击页面「下载」按钮', { x: rect.x, y: rect.y })
        clickAttempts++
        if (clickAttempts >= 2) stopAutoClick()
        return
      }
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
        if (!firstClickAt) firstClickAt = Date.now()
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
    let noDownloadTimer: NodeJS.Timeout | undefined
    const finish = (file: { path: string; filename: string } | null, error?: Error): void => {
      finishRef = finish
      if (settled) return
      settled = true
      stopAutoClick()
      clearInterval(pageTimer)
      clearTimeout(totalTimer)
      if (noDownloadTimer) clearInterval(noDownloadTimer)
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
      const savePath = background?.dest ?? join(app.getPath('downloads'), 'MailHarbor', randomUUID(), filename)

      // 多线程分段下载：QQ 中转站的真实下载地址（gzc-dfsdown.mail.ftn.qq.com 等）通常支持 Range，
      // 用 N 条连接并行拉取能显著提速。失败则回退 Chromium 原生下载。
      const realUrl = actualUrl.startsWith('blob:') ? actualUrl.slice(5) : actualUrl
      const totalBytes = download.getTotalBytes()
      if (background && rangeDisabled !== true && totalBytes > 8 * 1024 * 1024) {
        event.preventDefault()
        void (async () => {
          try {
            const cookies = await browserSession.cookies.get({ url: realUrl })
            const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
            const ok = await rangeDownload({
              url: realUrl,
              cookies: cookieHeader,
              dest: savePath,
              connections: Math.max(2, Math.min(32, options.connections ?? 8)),
              onProgress: (received, total) => {
                options.onProgress({
                  messageId: options.messageId,
                  attachmentId: -options.messageId,
                  filename,
                  received,
                  total,
                  percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null,
                  state: 'active',
                  attempt: 1,
                  bytesPerSec: 0,
                  message: `多线程下载（${Math.max(2, Math.min(32, options.connections ?? 8))} 连接）`,
                  updatedAt: Date.now()
                })
              }
            })
            if (ok) {
              log.info('QQ 中转站多线程下载完成', { url: realUrl.slice(0, 80), bytes: totalBytes })
              finish({ path: savePath, filename })
              return
            }
          } catch (e) {
            log.warn('多线程下载失败，回退浏览器下载', e instanceof Error ? e.message : String(e))
          }
          // 回退：标记后重新点页面下载按钮，让 Chromium 接管
          rangeDisabled = true
          try {
            await win.webContents.executeJavaScript(
              `(() => { const nodes=[...document.querySelectorAll('a,button,[role="button"]')]; const t=nodes.find(el=>(el.textContent||'').trim()==='下载'); if(t){t.click(); return true} return false })()`,
              true
            )
          } catch {
            finish(null, new Error('多线程下载失败且无法回退，请在系统浏览器打开链接下载'))
          }
        })()
        return
      }

      item = download
      // 下载原件保留到系统下载目录，归档失败时可以直接选择该文件重试。
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
    // 自动点击「下载」后，90 秒内没有触发浏览器下载 → 判定失败，避免用户以为软件卡死
    noDownloadTimer = setInterval(() => {
      if (settled) return
      if (!item && firstClickAt && Date.now() - firstClickAt > 90_000) {
        finish(null, new Error('自动点击「下载」后 90 秒仍未开始下载，请点「在系统浏览器打开链接」手动下载后归档'))
      }
    }, 5000)
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


/**
 * 用 HTTP Range 多线程分段下载一个直链（QQ 中转站 CDN 等）。
 * 先探测服务器是否支持 206；不支持返回 false 由调用方回退。
 */
async function rangeDownload(opts: {
  url: string
  cookies: string
  dest: string
  connections: number
  onProgress: (received: number, total: number) => void
}): Promise<boolean> {
  const https = await import('node:https')
  const { open } = await import('node:fs/promises')
  const u = new URL(opts.url)
  if (u.protocol !== 'https:') return false
  const conns = Math.max(2, Math.min(32, opts.connections))
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(opts.cookies ? { Cookie: opts.cookies } : {}),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    Accept: '*/*',
    ...extra
  })

  const request = (range?: string): Promise<import('node:http').IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: u.hostname,
          port: 443,
          path: u.pathname + u.search,
          method: 'GET',
          headers: headers(range ? { Range: range } : {}),
          timeout: 60_000
        },
        (res) => resolve(res)
      )
      req.once('error', reject)
      req.once('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      req.end()
    })

  // 探测 Range 支持
  const probe = await request('bytes=0-1')
  if (probe.statusCode !== 206) {
    probe.resume()
    return false
  }
  const contentRange = String(probe.headers['content-range'] ?? '')
  const total = Number(contentRange.split('/')[1] ?? 0)
  probe.resume()
  if (!total || total < 1024) return false

  const chunk = Math.max(2 * 1024 * 1024, Math.ceil(total / (conns * 2)))
  const ranges: Array<[number, number]> = []
  for (let start = 0; start < total; start += chunk) {
    ranges.push([start, Math.min(start + chunk, total) - 1])
  }
  const fh = await open(opts.dest, 'w')
  try {
    await fh.truncate(total)
    let received = 0
    let next = 0
    let failed = false
    const workers = Array.from({ length: Math.min(conns, ranges.length) }, async () => {
      for (;;) {
        const idx = next++
        const range = ranges[idx]
        if (!range) return
        const [start, end] = range
        const res = await request(`bytes=${start}-${end}`)
        if (res.statusCode !== 206) {
          res.resume()
          failed = true
          throw new Error(`分段 ${idx} 状态 ${res.statusCode}`)
        }
        const buf: Buffer[] = []
        for await (const c of res) buf.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array))
        const data = Buffer.concat(buf)
        if (data.length !== end - start + 1) {
          failed = true
          throw new Error(`分段 ${idx} 长度不符`)
        }
        await fh.write(data, 0, data.length, start)
        received += data.length
        try {
          opts.onProgress(received, total)
        } catch {
          /* ignore */
        }
      }
    })
    try {
      await Promise.all(workers)
    } catch {
      /* 失败由上层回退 */
    }
    try {
      opts.onProgress(total, total)
    } catch {
      /* ignore */
    }
    return !failed && received === total
  } finally {
    await fh.close().catch(() => {})
  }
}
