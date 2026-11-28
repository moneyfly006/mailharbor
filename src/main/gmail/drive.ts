/**
 * Google Drive 附件下载（Gmail 超大附件：大于 25MB 时 Gmail 会把文件放到 Drive，邮件里只有链接）。
 *
 * 需要 OAuth scope：drive.readonly（与 gmail.readonly 一起授权）。
 * 下载走 HTTPS（alt=media），流式写盘，400MB 也不占内存。
 */
import { createWriteStream, existsSync, renameSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { sanitizeFilename } from '../file-writer'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { httpsRequestText, httpsRequest, type ProxyTarget } from '../net/http-proxy-client'
import { refreshAccessToken } from './oauth'

const DRIVE = 'https://www.googleapis.com/drive/v3'

/** 从邮件正文链接里找出 Google Drive 文件 */
export function extractDriveFileIds(links: string[]): string[] {
  const ids = new Set<string>()
  for (const raw of links) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    if (u.protocol !== 'https:') continue
    const host = u.hostname
    if (host === 'drive.google.com') {
      const m = /^\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)
      if (m) ids.add(m[1]!)
      const q = u.searchParams.get('id')
      if (q) ids.add(q)
    } else if (host === 'docs.google.com') {
      const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)
      if (m) ids.add(m[1]!)
    }
  }
  return [...ids]
}

export interface DriveDownloadResult {
  path: string
  filename: string
  size: number
  sha256: string
}

export class DriveDownloader {
  private opts: { clientId: string; clientSecret: string; refreshToken: string; proxy?: ProxyTarget | null }
  private accessToken: string | null = null
  private expiry = 0
  private refreshing: Promise<string> | null = null

  constructor(opts: { clientId: string; clientSecret: string; refreshToken: string; proxy?: ProxyTarget | null }) {
    this.opts = opts
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiry - 60_000) return this.accessToken
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const r = await refreshAccessToken({
          clientId: this.opts.clientId,
          clientSecret: this.opts.clientSecret,
          refreshToken: this.opts.refreshToken,
          proxy: this.opts.proxy ?? null
        })
        this.accessToken = r.accessToken
        this.expiry = r.expiry
        return r.accessToken
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** 连通性检查：能列出 Drive 文件即说明 drive.readonly 权限已生效 */
  async ping(): Promise<{ ok: boolean; message?: string }> {
    try {
      const token = await this.token()
      const { status, text } = await httpsRequestText(`${DRIVE}/files?pageSize=1&fields=files(id,name)`, {
        headers: { Authorization: `Bearer ${token}` },
        proxy: this.opts.proxy ?? null
      })
      if (status >= 400) {
        const needReauth = status === 403 || /insufficient|scope/i.test(text)
        return { ok: false, message: needReauth ? '尚未获得 Drive 权限，请点「重新授权」并勾选 Drive 只读' : `Drive API ${status}: ${text.slice(0, 120)}` }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async meta(fileId: string): Promise<{ name: string; size: number; mimeType: string }> {
    const token = await this.token()
    const { status, text } = await httpsRequestText(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=name,size,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` }, proxy: this.opts.proxy ?? null }
    )
    if (status >= 400) throw new Error(`读取 Drive 文件信息失败：HTTP ${status} ${text.slice(0, 160)}`)
    const json = JSON.parse(text) as { name?: string; size?: string; mimeType?: string }
    return { name: json.name ?? 'drive-file', size: Number(json.size ?? 0), mimeType: json.mimeType ?? '' }
  }

  /**
   * 多线程分段下载（HTTP Range）。
   * Drive 的 alt=media 通常支持 Range：切成 N 段并发拉取，速度可提升 2–3 倍。
   * 若服务器忽略 Range（返回 200 全量），自动回退单线程，避免下错文件。
   */
  async downloadParallel(
    fileId: string,
    destPath: string,
    opts: {
      connections?: number
      chunkBytes?: number
      onProgress?: (received: number, total: number) => void
      /** 返回 true 时暂停（分块之间等待）；抛错表示取消 */
      isPaused?: () => boolean
      isCancelled?: () => boolean
    } = {}
  ): Promise<DriveDownloadResult> {
    const t0 = Date.now()
    const token = await this.token()
    const info = await this.meta(fileId).catch(() => ({ name: 'drive-file', size: 0, mimeType: '' }))
    const total = Number(info.size) || 0
    const conns = Math.max(2, Math.min(8, opts.connections ?? 4))
    const chunk = Math.max(1 * 1024 * 1024, Math.min(16 * 1024 * 1024, opts.chunkBytes ?? 8 * 1024 * 1024))
    if (total <= 0 || total <= chunk * 2) return this.download(fileId, destPath, opts.onProgress)

    const fh = await (await import('node:fs/promises')).open(destPath, 'w')
    try {
      await fh.truncate(total)
      const offsets: Array<[number, number]> = []
      for (let start = 0; start < total; start += chunk) {
        offsets.push([start, Math.min(start + chunk, total) - 1])
      }
      let received = 0
      let lastReport = 0
      let nextIndex = 0
      let rangeSupported = true
      const workers = Array.from({ length: Math.min(conns, offsets.length) }, async () => {
        for (;;) {
          const idx = nextIndex++
          const seg = offsets[idx]
          if (!seg) return
          // 暂停/取消检查（每块开始前）
          while (opts.isPaused?.()) {
            if (opts.isCancelled?.()) throw new Error('下载已取消')
            await new Promise((r) => setTimeout(r, 400))
          }
          if (opts.isCancelled?.()) throw new Error('下载已取消')
          const [start, end] = seg
          // 单块 60 秒超时 + 最多 3 次重试：避免「最后 1%」因为一块卡住而长时间停住
          let res: Awaited<ReturnType<typeof httpsRequest>> | null = null
          let lastErr: Error | null = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              res = await httpsRequest(
                `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
                {
                  headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
                  proxy: this.opts.proxy ?? null,
                  timeoutMs: 60_000
                }
              )
              break
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e))
              if (opts.isCancelled?.()) throw new Error('下载已取消')
              await new Promise((r) => setTimeout(r, 1000))
            }
          }
          if (!res) throw lastErr ?? new Error('分段请求失败')
          const status = res.statusCode ?? 0
          if (status !== 206) {
            // 服务器不支持 Range：丢掉这次下载，回退单线程
            res.resume()
            rangeSupported = false
            throw new Error('Drive 服务器不支持分段下载')
          }
          const expected = end - start + 1
          let written = 0
          let offset = start
          // 边收边写边上报：进度按 300ms 节流，不再是「整块完成才跳一次」
          for await (const c of res) {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array)
            await fh.write(b, 0, b.length, offset)
            offset += b.length
            written += b.length
            received += b.length
            const now = Date.now()
            if (now - lastReport > 300) {
              lastReport = now
              try {
                opts.onProgress?.(received, total)
              } catch {
                /* ignore */
              }
            }
          }
          if (written !== expected) throw new Error(`分段大小不符：收到 ${written}，期望 ${expected}`)
        }
      })
      try {
        await Promise.all(workers)
      } catch (e) {
        if (!rangeSupported) {
          await fh.close().catch(() => {})
          await rm(destPath, { force: true }).catch(() => {})
          return this.download(fileId, destPath, opts.onProgress)
        }
        throw e
      }
      try {
        opts.onProgress?.(total, total)
      } catch {
        /* ignore */
      }
      console.log(
        `[drive-parallel] ${info.name} ${(total / 1048576).toFixed(1)}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s · ${conns} 连接 · ${(total / 1048576 / ((Date.now() - t0) / 1000)).toFixed(2)} MB/s`
      )
      // 改回真实文件名（与单线程一致，保证后续识别为压缩包并解压）
      const { basename, dirname, join } = await import('node:path')
      const { sanitizeFilename } = await import('../file-writer')
      let finalPath = destPath
      if (info.name && info.name !== basename(destPath)) {
        try {
          const real = join(dirname(destPath), sanitizeFilename(info.name, 'drive-file'))
          if (existsSync(real)) rmSync(real, { force: true })
          renameSync(destPath, real)
          finalPath = real
        } catch {
          /* ignore */
        }
      }
      return { path: finalPath, filename: info.name, size: total, sha256: '' }
    } finally {
      await fh.close().catch(() => {})
    }
  }

  /** 下载到指定路径（流式） */
  async download(
    fileId: string,
    destPath: string,
    onProgress?: (received: number, total: number) => void
  ): Promise<DriveDownloadResult> {
    const token = await this.token()
    const info = await this.meta(fileId).catch(() => ({ name: 'drive-file', size: 0, mimeType: '' }))
    const res = await httpsRequest(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
        proxy: this.opts.proxy ?? null,
        timeoutMs: 30 * 60_000
      }
    )
    if ((res.statusCode ?? 0) >= 400) {
      throw new Error(`下载 Drive 文件失败：HTTP ${res.statusCode}`)
    }
    const hash = createHash('sha256')
    let received = 0
    let last = 0
    const total = info.size
    res.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (onProgress && now - last > 300) {
        last = now
        try {
          onProgress(received, total)
        } catch {
          /* ignore */
        }
      }
    })
    await pipeline(res, createWriteStream(destPath))
    // Gmail Drive 文件下载后必须改回真实文件名（如 原图.rar），否则后续不会识别为压缩包、不会解压
    let finalPath = destPath
    if (info.name && info.name !== basename(destPath)) {
      try {
        const real = join(dirname(destPath), sanitizeFilename(info.name, 'drive-file'))
        if (existsSync(real)) rmSync(real, { force: true })
        renameSync(destPath, real)
        finalPath = real
      } catch {
        /* 改名失败则保留临时名 */
      }
    }
    try {
      onProgress?.(received, received)
    } catch {
      /* ignore */
    }
    return { path: finalPath, filename: info.name, size: received, sha256: hash.digest('hex') }
  }
}
