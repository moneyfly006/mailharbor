/**
 * 压缩包解压（ZIP / RAR / 7Z / TAR / TAR.GZ / TGZ / GZ / BZ2 / XZ）：
 *   - 客户发来的压缩包下载完成后，解压到 **当前目标文件夹**（不新建子文件夹）
 *   - 保留原压缩包；重名文件自动加 " (2)" 后缀，不覆盖已有文件
 *   - 过滤 __MACOSX / .DS_Store / 目录项，拒绝 ../ 与绝对路径（防路径穿越）
 *
 * 实现：
 *   - ZIP 用 adm-zip（纯 JS，快，且能处理中文文件名）
 *   - RAR / 7Z / TAR / TAR.GZ / TGZ / GZ / BZ2 / XZ 用随包携带的 7za 二进制
 *     （7zip-bin；p7zip 支持的格式都能解，比内置 unrar 覆盖更广）
 *   - ZIP 用 adm-zip 解不开时（zip64/加密等）自动改用 7za 兜底
 */
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface ExtractResult {
  extracted: number
  skipped: number
  errors: string[]
  files: string[]
}

/** 支持的压缩包后缀（双后缀先匹配，如 .tar.gz） */
const ARCHIVE_SUFFIXES = [
  '.tar.gz',
  '.tar.bz2',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.tgz',
  '.tbz2',
  '.gz',
  '.bz2',
  '.xz'
]

export function archiveKind(filename: string): string | null {
  const lower = filename.toLowerCase()
  for (const suffix of ARCHIVE_SUFFIXES) if (lower.endsWith(suffix)) return suffix
  return null
}

export function isArchiveFile(filename: string): boolean {
  return archiveKind(filename) !== null
}

/** 把压缩包内的路径变安全：去掉盘符/绝对路径；含 .. 的一律丢弃；不可用时返回 null */
function safeEntryPath(name: string): string | null {
  const cleaned = name.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '')
  if (cleaned.split('/').includes('..')) return null
  const parts = cleaned.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0) return null
  const base = parts[parts.length - 1]
  if (base === '.DS_Store' || parts[0] === '__MACOSX') return null
  return parts.join('/')
}

function uniquePath(dir: string, rel: string): string {
  const target = join(dir, rel)
  if (!existsSync(target)) return target
  const ext = extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let i = 2; i < 500; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 6)}${ext}`
}

function writeEntry(targetDir: string, name: string, data: Uint8Array, result: ExtractResult): void {
  const rel = safeEntryPath(name)
  if (!rel) {
    result.skipped++
    return
  }
  const target = uniquePath(targetDir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, Buffer.from(data))
  result.extracted++
  result.files.push(rel)
}

// ---------------------------------------------------------------------------
// 7za（随包携带）：覆盖 rar / 7z / tar / gz / bz2 / xz
// ---------------------------------------------------------------------------
let cached7za: string | null | undefined

async function resolve7za(): Promise<string | null> {
  if (cached7za !== undefined) return cached7za
  try {
    // 7zip-bin 是 CJS：CJS 下 require 可用；ESM（如测试脚本）下用动态 import
    let raw: string | undefined
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      raw = (require('7zip-bin') as { path7za?: string }).path7za
    } catch {
      const mod = (await import('7zip-bin')) as unknown as { path7za?: string; default?: { path7za?: string } }
      raw = mod.path7za ?? mod.default?.path7za
    }
    if (!raw || !existsSync(raw)) {
      cached7za = null
      return null
    }
    cached7za = ensureExecutable(raw)
    return cached7za
  } catch {
    cached7za = null
    return null
  }
}

/** asar 内/无执行位时：先 chmod；不行就把二进制复制到临时目录再 chmod */
function ensureExecutable(binPath: string): string {
  if (process.platform === 'win32') return binPath
  try {
    chmodSync(binPath, 0o755)
    return binPath
  } catch {
    const dest = join(tmpdir(), `mh-7za-${process.pid}`)
    if (!existsSync(dest)) {
      copyFileSync(binPath, dest)
      chmodSync(dest, 0o755)
    }
    return dest
  }
}

function run7za(bin: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(new Error('解压超时（10 分钟）'))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
  })
}

async function extractWith7za(archivePath: string, targetDir: string, result: ExtractResult, tempOut: string): Promise<void> {
  const bin = await resolve7za()
  if (!bin) throw new Error('缺少解压组件（7za），请安装最新版本')
  mkdirSync(tempOut, { recursive: true })
  // x=解压（保留目录结构），-y 全部确认，-o 指定输出目录
  const { code, out } = await run7za(bin, ['x', '-y', `-o${tempOut}`, archivePath])
  if (code !== 0) {
    const tail = out.trim().split('\n').slice(-3).join(' ')
    throw new Error(`7za 解压失败（code ${code}）：${tail}`)
  }
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) walk(full, rel)
      else writeEntry(targetDir, rel, readFileSync(full), result)
    }
  }
  walk(tempOut, '')
}

async function extractZipDirect(archivePath: string, targetDir: string, result: ExtractResult): Promise<void> {
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip(archivePath)
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    try {
      writeEntry(targetDir, entry.entryName, entry.getData(), result)
    } catch (e) {
      result.errors.push(`${entry.entryName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** 解压压缩包到 targetDir（与压缩包同级）；非压缩包返回 null */
export async function extractArchiveTo(
  archivePath: string,
  targetDir: string,
  opts: { tempDir?: string } = {}
): Promise<ExtractResult | null> {
  const kind = archiveKind(archivePath)
  if (!kind) return null
  mkdirSync(targetDir, { recursive: true })
  const result: ExtractResult = { extracted: 0, skipped: 0, errors: [], files: [] }

  if (kind === '.zip') {
    try {
      await extractZipDirect(archivePath, targetDir, result)
      if (result.extracted > 0 || result.errors.length === 0) return result
    } catch (e) {
      result.errors.push(`ZIP 直读失败，改用 7za：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 其余格式（以及 ZIP 直读失败时）交给 7za
  const tempOut = join(
    opts.tempDir ?? tmpdir(),
    `mh-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  try {
    await extractWith7za(archivePath, targetDir, result, tempOut)
  } catch (e) {
    if (result.extracted === 0 && kind === '.rar') {
      // 7za 对个别 RAR5 变体支持不全 → 用 node-unrar-js 兜底再试一次
      try {
        await extractRarWithUnrarJs(archivePath, targetDir, result)
      } catch (e2) {
        throw new Error(
          `RAR 解压失败：${e instanceof Error ? e.message : String(e)}；备用解压也失败：${e2 instanceof Error ? e2.message : String(e2)}`
        )
      }
    } else if (result.extracted === 0) {
      throw e
    } else {
      result.errors.push(`部分文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  } finally {
    rmSync(tempOut, { recursive: true, force: true })
  }
  return result
}

async function extractRarWithUnrarJs(archivePath: string, targetDir: string, result: ExtractResult): Promise<void> {
  const { createExtractorFromData } = await import('node-unrar-js')
  const data = readFileSync(archivePath)
  const extractor = await createExtractorFromData({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  })
  const extracted = extractor.extract({ files: (h: { flags?: { directory?: boolean } }) => !h.flags?.directory })
  const files = Array.from(
    extracted.files as Iterable<{
      fileHeader: { name: string; flags?: { directory?: boolean } }
      extraction?: Uint8Array
    }>
  )
  for (const f of files) {
    if (f.fileHeader.flags?.directory || !f.extraction) continue
    writeEntry(targetDir, f.fileHeader.name, f.extraction, result)
  }
}
