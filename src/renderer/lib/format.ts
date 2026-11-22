/** 格式化工具：时间 / 大小 / 数字 / 路径。全部输出中文口径，数字等宽由 CSS 保证。 */

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return '未知错误'
}

const pad = (n: number): string => String(n).padStart(2, '0')

function toDate(ts: number | Date | null | undefined): Date | null {
  if (ts == null) return null
  const d = ts instanceof Date ? ts : new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 2026-11-22 15:44 */
export function fmtDateTime(ts: number | Date | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 2026-11-22 */
export function fmtDate(ts: number | Date | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 11-22 */
export function fmtMonthDay(ts: number | Date | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 15:44 */
export function fmtTime(ts: number | Date | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 15:44:08 */
export function fmtTimeSec(ts: number | Date | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 1,284 */
export function fmtNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0'
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 18.4 MB · 1.2 GB · 512 KB */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const digits = i >= 3 ? 1 : v >= 10 || i === 0 ? 0 : 1
  return `${v.toFixed(digits)} ${units[i]}`
}

/** 剩余 178 GB（整数口径，卡片/盘位用） */
export function fmtBytesLoose(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 100) return `${Math.round(gb)} GB`
  if (gb >= 1) return `${gb.toFixed(0)} GB`
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(0)} MB`
}

/** 已用百分比（0–100） */
export function usedPercent(free: number | null | undefined, total: number | null | undefined): number | null {
  if (free == null || total == null || !Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null
  return Math.min(100, Math.max(0, Math.round(((total - free) / total) * 100)))
}

/** 6 天 3 小时 / 3 小时 12 分 / 12 分 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const sec = Math.floor(ms / 1000)
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const mins = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`
  if (hours > 0) return `${hours} 小时${mins > 0 ? ` ${mins} 分` : ''}`
  if (mins > 0) return `${mins} 分`
  return `${Math.max(1, sec)} 秒`
}

/** 3 分钟前 / 刚刚 */
export function fmtAgo(ts: number | null | undefined, now: number): string {
  if (ts == null) return '—'
  const diff = Math.max(0, now - ts)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 距离某个时间点还有多少秒（向下取整，最小 0） */
export function secondsUntil(ts: number | null | undefined, now: number): number | null {
  if (ts == null) return null
  return Math.max(0, Math.round((ts - now) / 1000))
}

/** D:\POD\生产\卡套 → D */
export function driveOf(path: string | null | undefined): string {
  if (!path) return '·'
  const m = /^([A-Za-z]):/.exec(path)
  return m ? m[1].toUpperCase() : '·'
}

/** D:\POD\生产\卡套 → \POD\生产\卡套 */
export function pathBody(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/^[A-Za-z]:/, '')
}

/** 邮箱 → 显示名（@ 前部分，用于窄列） */
export function mailLocal(email: string | null | undefined): string {
  if (!email) return '—'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** 端口输入解析：合法 1–65535 返回数字，否则 null */
export function parsePort(v: string): number | null {
  if (!/^\d{1,5}$/.test(v.trim())) return null
  const n = Number(v)
  return n >= 1 && n <= 65535 ? n : null
}

/** 秒数 → “12 秒后” */
export function fmtCountdown(sec: number | null): string {
  if (sec == null) return '—'
  if (sec <= 0) return '即将检查'
  if (sec < 60) return `${sec} 秒后`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒后`
}
