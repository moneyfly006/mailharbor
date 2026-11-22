/**
 * 统一日志：分级 + 作用域 + 脱敏。
 *
 * 安全约束（ARCHITECTURE §8）：**任何日志都不得出现密码 / 授权码 / SMTP 认证串 / token**。
 * 本模块的 redact() 是所有日志出口的最后一道闸；业务代码仍应避免把密码拼进 message。
 */
import type { Settings } from '@shared/types'

export type LogLevel = Settings['logLevel']

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 当前全局日志级别（可由 settings.logLevel 热更新） */
let currentLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel | string | undefined): void {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/((?:pass(?:word)?|pwd|authorization|auth|token|secret|授权码|密码)\s*[=:：]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1***'],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic ***'],
  [/(?<![A-Za-z0-9+/=_-])([A-Za-z0-9=_-]{32,})(?![A-Za-z0-9+/=_-])/g, '***']

]

/** 日志脱敏：密码/授权码/认证串/token 一律掩码 */
export function redact(input: string): string {
  let out = input ?? ''
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

export interface Logger {
  debug(msg: string, detail?: unknown): void
  info(msg: string, detail?: unknown): void
  warn(msg: string, detail?: unknown): void
  error(msg: string, detail?: unknown): void
  setLevel(level: LogLevel): void
}

function serializeDetail(detail: unknown): string {
  if (detail === undefined) return ''
  if (detail instanceof Error) return ` ${detail.name}: ${detail.message}`
  try {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return s ? ` ${s.length > 2000 ? s.slice(0, 2000) + '…' : s}` : ''
  } catch {
    return ''
  }
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, msg: string, detail?: unknown): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${redact(msg)}${redact(serializeDetail(detail))}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    setLevel: (l) => setLogLevel(l)
  }
}
