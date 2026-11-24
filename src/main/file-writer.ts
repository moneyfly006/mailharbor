/**
 * 附件文件名解码 + 安全清洗 + 落盘（临时文件 + 原子改名）。
 *
 * 中文文件名三大来源（ARCHITECTURE §2.5）：
 *  1) RFC 2047 encoded-word：=?UTF-8?B?...?= / =?GBK?Q?...?=
 *  2) RFC 2231：filename*=UTF-8''%E4%B8%AD...
 *  3) 客户端直接发 GBK/GB18030 原始字节
 */
import { mkdir, rename, rm, stat, copyFile, access } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** RFC 2047 解码 */
export function decodeRfc2047(input: string): string {
  if (!input) return ''
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      let buf: Buffer
      if (enc.toUpperCase() === 'B') buf = Buffer.from(text, 'base64')
      else buf = Buffer.from(
        text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
        'binary'
      )
      const cs = charset.toLowerCase().replace('gb2312', 'gbk').replace('gb18030', 'gbk')
      try {
        return new TextDecoder(cs === 'gbk' ? 'gb18030' : cs, { fatal: true }).decode(buf)
      } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(buf)
      }
    } catch {
      return text
    }
  })
}

/** RFC 2231 解码：filename*=UTF-8''%E4%B8%AD%... */
export function decodeRfc2231(value: string): string {
  const m = value.match(/^([^']*)''(.*)$/)
  if (!m) return decodeURIComponentSafe(value)
  const charset = (m[1] || 'utf-8').toLowerCase()
  const rest = decodeURIComponentSafe(m[2])
  if (charset === 'utf-8' || charset === 'us-ascii') return rest
  try {
    const bytes = Buffer.from(unescapePercent(m[2]), 'binary')
    return new TextDecoder(charset === 'gbk' || charset === 'gb2312' ? 'gb18030' : charset).decode(bytes)
  } catch {
    return rest
  }
}

function unescapePercent(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)))
}
function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** 综合解码：先 RFC 2047，再 RFC 2231，最后尝试 GBK 原始字节 */
export function decodeFilename(raw: string | Buffer | undefined, mimeParam?: string): string {
  if (!raw) return ''
  if (Buffer.isBuffer(raw)) {
    // 原始 8-bit 字节：先试 UTF-8，失败回退 GB18030
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { /* fallthrough */ }
    try { return new TextDecoder('gb18030').decode(raw) } catch { return raw.toString('latin1') }
  }
  let name = raw
  if (/=\?.*\?[BbQq]\?.*\?=/.test(name)) name = decodeRfc2047(name)
  if (/^[^']*''/.test(name) || /%[0-9A-Fa-f]{2}/.test(name)) name = decodeRfc2231(name)
  if (mimeParam) name = name || mimeParam
  // 若仍是乱码（如 "ÖÐÎÄ.zip"），尝试 latin1→GBK 还原
  if (/[\u0080-\u00ff]/.test(name) && !/[\u4e00-\u9fff]/.test(name)) {
    try {
      const gbk = new TextDecoder('gb18030').decode(Buffer.from(name, 'latin1'))
      if (/[\u4e00-\u9fff]/.test(gbk)) name = gbk
    } catch { /* ignore */ }
  }
  return name.trim()
}

/** 安全清洗：去掉路径、非法字符、保留名、结尾点空格，UTF-16 截断 */
export function sanitizeFilename(name: string, fallback = 'attachment'): string {
  let base = basename((name ?? '').replace(/\\/g, '/'))
  base = base.replace(ILLEGAL, '_').replace(/[\s.]+$/g, '').trim()
  if (!base || base === '.' || base === '..') base = fallback
  if (RESERVED.test(base)) base = `_${base}`
  const ext = extname(base)
  let stem = base.slice(0, base.length - ext.length)
  if (stem.length > 160) stem = stem.slice(0, 160)
  return stem + ext.toLowerCase()
}

/** 目标目录里重名时生成 "name (2).ext"、"name (3).ext"… */
export async function uniqueNameInDir(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? filename : `${stem} (${i})${ext}`
    try {
      await access(join(dir, candidate), FS.F_OK)
      continue // 已存在
    } catch {
      return candidate
    }
  }
  return `${stem} (${Date.now()})${ext}`
}

export async function pathExists(p: string): Promise<boolean> {
  try { await access(p, FS.F_OK); return true } catch { return false }
}

/** 磁盘剩余空间（字节）；不可用时返回 null */
export async function diskFree(path: string): Promise<{ free: number; total: number } | null> {
  try {
    await mkdir(path, { recursive: true })
    const s = await stat(path)
    if (!s.isDirectory()) return null
    const { statfs } = await import('node:fs/promises')
    const fsStat = await statfs(path)
    return { free: fsStat.bavail * fsStat.bsize, total: fsStat.blocks * fsStat.bsize }
  } catch {
    return null
  }
}

export interface CopyResult {
  savedPath: string
  savedName: string
  size: number
}

/**
 * 把临时文件复制到目标目录：同目录写 .part → 原子 rename → 返回最终文件名。
 * 重名自动加 (2)。空间不足/无权限抛指定错误码。
 */
export async function copyIntoDir(
  tmpFile: string,
  targetDir: string,
  filename: string,
  minFreeBytes = 0
): Promise<CopyResult> {
  const dir = resolve(targetDir)
  try {
    await mkdir(dir, { recursive: true })
  } catch (e) {
    throw Object.assign(new Error(`目标目录不可用：${dir}`), { code: 'PATH_UNAVAILABLE' })
  }
  const space = await diskFree(dir)
  if (!space) throw Object.assign(new Error(`目标目录不可用：${dir}`), { code: 'PATH_UNAVAILABLE' })
  const src = await stat(tmpFile)
  if (space.free < Math.max(src.size * 1.2, minFreeBytes)) {
    throw Object.assign(new Error('目标磁盘空间不足'), { code: 'NO_SPACE' })
  }
  // 需求：同名文件直接覆盖（无论是解压出来的，还是直接下载的 PNG/TIF/压缩包）
  const finalName = filename
  const finalPath = join(dir, finalName)
  const partPath = join(dir, `.mh-${process.pid}-${Date.now()}.part`)
  try {
    await copyFile(tmpFile, partPath)
    await rename(partPath, finalPath)
  } catch (e: unknown) {
    await rm(partPath, { force: true }).catch(() => {})
    const code = (e as NodeJS.ErrnoException).code
    const mapped = code === 'ENOSPC' ? 'NO_SPACE' : code === 'EACCES' || code === 'EPERM' ? 'ACCESS_DENIED' : 'COPY_FAILED'
    throw Object.assign(e as Error, { code: mapped })
  }
  return { savedPath: finalPath, savedName: finalName, size: src.size }
}
