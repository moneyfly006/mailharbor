/**
 * 关键词规则引擎（纯函数，便于单测）
 *
 * 匹配口径（见 REQUIREMENTS §3.3 / ARCHITECTURE C1）：
 *  - 归一化：去全部空白、全角→半角（+＋－/／、括号）、转小写
 *  - 去掉主题前缀：RE: / FWD: / FW: / 答复: / 转发:（可重复出现）
 *  - exact：归一化后主题与关键词完全相等
 *  - contains：归一化后主题包含关键词
 *  - scope=subject_body 时，正文命中也算
 *  - 一封邮件命中多条：multiRuleStrategy='all'（默认，符合客户业务：一封邮件可能同时要手机壳+卡套两套图）
 *    全部返回、全部落盘；'priority' 只返回优先级最高的一条（可配）
 */
import type { MatchMode, MatchScope, Rule } from '@shared/types'

export interface MatchableMessage {
  subject: string
  body?: string
}

export interface MatchHit {
  ruleId: number
  source: 'subject' | 'body'
}

const FULL_TO_HALF: Record<string, string> = {
  '＋': '+', '－': '-', '—': '-', '–': '-', '﹣': '-', '／': '/', '（': '(', '）': ')', '：': ':',
  '　': '', '\u00a0': '', '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': ''
}

export function normalize(s: string): string {
  if (!s) return ''
  let out = ''
  for (const ch of s) out += FULL_TO_HALF[ch] ?? ch
  return out
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim()
}

const SUBJECT_PREFIX = /^\s*(re|fw|fwd|aw|sv|答复|回复|转发)\s*[：:]\s*/i

/** 只做全角归一 + 小写 + 折叠空白（保留分隔信息，供 exact 匹配用） */
export function loosen(s: string): string {
  if (!s) return ''
  let out = ''
  for (const ch of s) out += FULL_TO_HALF[ch] ?? ch
  return out.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 去掉 RE:/FWD: 等前缀（可能多层嵌套） */
export function stripSubjectPrefix(subject: string): string {
  let s = subject ?? ''
  for (let i = 0; i < 6; i++) {
    const before = s
    s = s.replace(SUBJECT_PREFIX, '')
    if (s === before) break
  }
  return s
}

export function matchOne(rule: Pick<Rule, 'id' | 'keyword' | 'scope' | 'mode'>, msg: MatchableMessage): MatchHit | null {
  const kw = normalize(rule.keyword)
  if (!kw) return null
  const subjectStripped = stripSubjectPrefix(msg.subject)
  const subject = normalize(subjectStripped)
  if (subject) {
    const hit = rule.mode === 'exact' ? exactHit(loosen(subjectStripped), kw) : subject.includes(kw)
    if (hit) return { ruleId: rule.id, source: 'subject' }
  }
  if (rule.scope === 'subject_body' && msg.body) {
    const body = normalize(msg.body)
    const hit = rule.mode === 'exact' ? exactHit(loosen(msg.body), kw) : body.includes(kw)
    if (hit) return { ruleId: rule.id, source: 'body' }
  }
  return null
}

/**
 * 精确匹配：把"关键词"视为业务标记（标题里的品类标记），命中规则：
 *  1) 整个主题就是关键词：`原图+卡套`
 *  2) 主题以「关键词 + 分隔符」开头：`原图+卡套 追加: POD_ORDER_20486`、`原图+卡套-打样`、`原图+卡套: 第2批`
 *  3) 主题以「关键词 + 中文业务说明」开头（客户常写「原图+卡套追加」「原图+卡套打样」）：
 *     只要关键词后紧跟的是非字母数字（中文/标点/空格）就认为它是"关键词 + 说明"，仍算命中
 *  4) 反例：「原图+卡套盒」「原图+卡套子」不算（关键词后直接接字母/数字/汉字修饰，属于不同品类）
 * 实现要点：**不能先 normalize 掉空格**，否则 `原图+卡套 追加` 会变成 `原图+卡套追加` 丢失分隔信息。
 * 所以 subject 传入的是"只做全角归一 + 小写 + 折叠空白"的版本，再单独比较关键词的紧致形式。
 */
function exactHit(looseSubject: string, kw: string): boolean {
  const kwLoose = kw.replace(/\s+/g, '')
  // 客户常在标题前加装饰：`【原图+手机壳】`、`[原图+手机壳]`、`★原图+手机壳`、表情前缀
  // → 先剥掉开头连续的非字母/数字/汉字字符
  const loose = looseSubject.replace(/^[^0-9A-Za-z\u4e00-\u9fff]+/, '')

  const SEP = /^[\s\-_:：|/.、,()（）\[\]【】0-9A-Za-z]/
  const BIZ_SUFFIX = /^(追加|打样|补发|补|确认|收尾|返|重|新|老|加|第|再|更)/
  // `+` 与 `-` 混用视为同一分隔（原图-手机壳 / 原图—手机壳 也能命中）
  const plusify = (s: string): string => s.replace(/[-+]/g, '+')

  /** 在 target 里按"忽略空白"的方式匹配前缀 kw，返回关键词之后的原始剩余部分 */
  const matchPrefix = (target: string, needle: string): string | null => {
    let i = 0
    let j = 0
    while (i < target.length && j < needle.length) {
      if (/\s/.test(target[i]!)) {
        i++
        continue
      }
      if (target[i]!.toLowerCase() !== needle[j]!.toLowerCase()) return null
      i++
      j++
    }
    if (j < needle.length) return null
    return target.slice(i)
  }

  for (const [target, needle] of [
    [loose, kwLoose],
    [plusify(loose), plusify(kwLoose)]
  ] as Array<[string, string]>) {
    const rest = matchPrefix(target, needle)
    if (rest === null) continue
    if (rest.replace(/\s+/g, '') === '') return true
    // ① 分隔符 / 数字 / 字母开头 → 「关键词 + 说明」
    if (SEP.test(rest)) return true
    // ② 紧跟中文：只有业务说明词算同一关键词（避免「卡套盒」误命中）
    const restNoSpace = rest.replace(/\s+/g, '')
    if (/^[\u4e00-\u9fff]/.test(restNoSpace) && BIZ_SUFFIX.test(restNoSpace)) return true
  }
  return false
}

/** 返回命中的规则（已按 priority 升序排序，priority 数字小的优先） */
export function matchRules(
  rules: Array<Pick<Rule, 'id' | 'keyword' | 'scope' | 'mode' | 'priority' | 'enabled'>>,
  msg: MatchableMessage,
  strategy: 'all' | 'priority' = 'all'
): MatchHit[] {
  const active = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority)
  const hits: MatchHit[] = []
  for (const rule of active) {
    const hit = matchOne(rule, msg)
    if (hit) {
      hits.push(hit)
      if (strategy === 'priority') break
    }
  }
  return hits
}

/** 附件类型白名单判定：后缀优先、MIME 兜底（Gmail/QQ 的 zip、tif 常见 octet-stream） */
const MIME_OK: Record<string, string[]> = {
  zip: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'multipart/x-zip'],
  rar: ['application/x-rar-compressed', 'application/vnd.rar', 'application/octet-stream', 'application/x-rar'],
  '7z': ['application/x-7z-compressed', 'application/octet-stream'],
  tar: ['application/x-tar', 'application/octet-stream'],
  gz: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
  tgz: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
  bz2: ['application/x-bzip2', 'application/octet-stream'],
  xz: ['application/x-xz', 'application/octet-stream'],
  tif: ['image/tiff', 'image/tif', 'application/octet-stream'],
  tiff: ['image/tiff', 'image/tif', 'application/octet-stream'],
  jpg: ['image/jpeg', 'image/pjpeg', 'application/octet-stream'],
  jpeg: ['image/jpeg', 'image/pjpeg', 'application/octet-stream'],
  png: ['image/png', 'application/octet-stream'],
  pdf: ['application/pdf', 'application/octet-stream'],
  psd: ['image/vnd.adobe.photoshop', 'application/octet-stream'],
  ai: ['application/postscript', 'application/illustrator', 'application/octet-stream']
}

export function extOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : ''
}

export const BUSINESS_DEFAULT_TYPES = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'tif', 'tiff', 'jpg', 'jpeg', 'png', 'pdf', 'psd', 'ai']

export function isAllowedAttachment(filename: string, mimeType: string | undefined, fileTypes: string[]): boolean {
  // 规则没勾选任何类型时，视为"业务默认类型"，而不是拒绝一切（历史数据/误操作兜底）
  const source = fileTypes && fileTypes.length > 0 ? fileTypes : BUSINESS_DEFAULT_TYPES
  const allowed = source.map((t) => t.toLowerCase().replace(/^\./, ''))
  const ext = extOf(filename)
  if (ext && allowed.includes(ext)) return true
  // 无后缀（或后缀不在白名单）时按 MIME 兜底，但仍要求该 MIME 属于白名单内某类型
  const mime = (mimeType ?? '').toLowerCase()
  if (!mime) return false
  return allowed.some((t) => (MIME_OK[t] ?? []).includes(mime))
}
