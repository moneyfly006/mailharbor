/**
 * smtp.ts + providers/imap.ts 纯函数单测（不连邮箱）
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-mail.ts
 */
import { simpleParser } from 'mailparser'
import {
  buildReferences, buildReplyMime, buildReplyVars, composeReply, encodeHeaderWord,
  formatAddress, normalizeReplySubject, normalizeMessageId, renderTemplate, sanitizeHeader,
  sendReply, formatLocalTime, makeReplyMessageId
} from '../src/main/smtp.ts'
import {
  extractAttachments, findBodyPart, htmlToText, parseHeaderBlock, parseReferences, threadKeyOf, testConnection
} from '../src/main/providers/imap.ts'
import { classifyMailError, FIX_HINTS, errDetail } from '../src/main/providers/errors.ts'
import { redact } from '../src/main/log.ts'

// ---------------------------------------------------------------------------
// 附件识别：Content-Disposition: inline 但有文件名，也要当附件（QQ/转发邮件常见）
// ---------------------------------------------------------------------------
function struct(over: Record<string, unknown>): any {
  return { type: 'application/octet-stream', part: '2', size: 1024, ...over }
}

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}

const settings = {
  replyEnabled: true,
  replyDelaySec: 0,
  replySubjectZh: '图稿已收到 · {关键词}',
  replyBodyZh: '您好，\n\n已收到您的图稿（{数量} 个文件）：\n{文件名}\n\n{工厂名}',
  replySubjectEn: 'Artwork received — {关键词}',
  replyBodyEn: "Hi,\n\nReceived {数量} file(s): {文件名}\n\n{工厂名}",
  replyLanguage: 'en' as const
}
const vars = buildReplyVars({
  filenames: ['POD_ORDER_20486.zip', '设计图_卡套_v3.tif'],
  keyword: '原图+卡套',
  sentAt: new Date('2026-11-22T08:00:00+08:00').getTime(),
  factoryName: '宁波印点工厂'
})

console.log('template:')
eq('变量 数量', vars['数量'], '2')
eq('变量 文件名', vars['文件名'], 'POD_ORDER_20486.zip、设计图_卡套_v3.tif')
eq('变量 关键词', vars['关键词'], '原图+卡套')
eq('变量 工厂名', vars['工厂名'], '宁波印点工厂')
eq('变量 时间格式', vars['时间'], '2026-11-22 08:00')
eq('renderTemplate 替换全部', renderTemplate('{文件名}|{数量}|{关键词}|{时间}|{工厂名}', vars),
  'POD_ORDER_20486.zip、设计图_卡套_v3.tif|2|原图+卡套|2026-11-22 08:00|宁波印点工厂')
eq('renderTemplate 未知占位符保留', renderTemplate('你好 {不存在的}', vars), '你好 {不存在的}')
eq('renderTemplate 空模板', renderTemplate('', vars), '')
eq('默认时区时间非空', formatLocalTime().length, 16)

const zh = composeReply(settings, vars, 'zh')
eq('composeReply zh 主题', zh.subject, 'Re: 图稿已收到 · 原图+卡套')
eq('composeReply zh 不含英文', zh.body.includes('Received'), false)
const en = composeReply(settings, vars, 'en')
eq('composeReply en 主题', en.subject, 'Re: Artwork received — 原图+卡套')
eq('composeReply en 正文变量', en.body.includes('2 file(s)'), true)
const both = composeReply(settings, vars, 'both')
eq('composeReply both 含中英', both.body.includes('您好') && both.body.includes('Received'), true)

console.log('headers:')
eq('sanitizeHeader 去 CRLF 注入', sanitizeHeader('abc\r\nBcc: evil@x.com'), 'abc Bcc: evil@x.com')
eq('normalizeReplySubject 加 Re', normalizeReplySubject('原图+卡套 追加'), 'Re: 原图+卡套 追加')
eq('normalizeReplySubject 不重复', normalizeReplySubject('Re: 原图+卡套'), 'Re: 原图+卡套')
eq('normalizeReplySubject 中文前缀不重复', normalizeReplySubject('答复: 原图+卡套'), '答复: 原图+卡套')
eq('normalizeMessageId 补尖括号', normalizeMessageId('abc@x.com'), '<abc@x.com>')
eq('normalizeMessageId 去 CRLF 注入', /[\r\n]/.test(normalizeMessageId('<a@b>\r\nX: 1')), false)
eq('buildReferences 去重且追加原信', buildReferences(['<r1@x>', '<r2@x>', '<r1@x>'], '<r3@x>'), ['<r1@x>', '<r2@x>', '<r3@x>'])
eq('buildReferences 空', buildReferences([], null), [])
eq('encodeHeaderWord ASCII 原样', encodeHeaderWord('Artwork received'), 'Artwork received')
eq('encodeHeaderWord 中文编码', /^=\?UTF-8\?B\?/.test(encodeHeaderWord('原图+卡套')), true)
eq('formatAddress 中文名', /=\?UTF-8\?B\?/.test(formatAddress({ name: '收货助手', address: 'a@b.c' })), true)
eq('formatAddress 无名称', formatAddress({ address: 'a@b.c' }), 'a@b.c')
eq('makeReplyMessageId 带域名', makeReplyMessageId('demo@mailharbor.test').endsWith('@mailharbor.test>'), true)

console.log('日志脱敏:')
eq('密码被掩码', redact('login password=abc123 user=demo@x.com').includes('abc123'), false)
eq('token 被掩码', redact('Authorization: Bearer abcdef0123456789abcdef0123456789').includes('abcdef0123456789abcdef0123456789'), false)
eq('普通路径不被掩码', redact('已落盘 /tmp/foo/POD_ORDER_20486.zip'), '已落盘 /tmp/foo/POD_ORDER_20486.zip')

console.log('mime:')
const req = {
  from: { name: 'MailHarbor 收货助手', address: 'demo@mailharbor.test' },
  to: { name: 'David Chen', address: 'david@inkpressed.co' },
  subject: '原图+卡套 追加: POD_ORDER_20486',
  body: '您好，已收到 2 个文件：POD_ORDER_20486.zip',
  inReplyTo: '<orig-1@mailharbor.test>',
  references: ['<root@mailharbor.test>', '<orig-1@mailharbor.test>']
}
const mime = buildReplyMime(req, new Date('2026-11-22T08:00:00Z').getTime())
eq('mime 有 In-Reply-To', mime.raw.includes('In-Reply-To: <orig-1@mailharbor.test>'), true)
eq('mime References 去重', mime.raw.includes('References: <root@mailharbor.test> <orig-1@mailharbor.test>'), true)
eq('mime 主题 Re:', mime.subject, 'Re: 原图+卡套 追加: POD_ORDER_20486')
eq('mime Auto-Submitted', mime.raw.includes('Auto-Submitted: auto-replied'), true)
eq('mime 纯文本 UTF-8', mime.raw.includes('Content-Type: text/plain; charset=utf-8'), true)
eq('mime base64 正文', mime.raw.includes('Content-Transfer-Encoding: base64'), true)
const parsed = await simpleParser(mime.raw)
eq('mime 可被邮件库解析：正文', parsed.text.includes('已收到 2 个文件'), true)
eq('mime 可被邮件库解析：In-Reply-To', parsed.inReplyTo, '<orig-1@mailharbor.test>')
eq('mime 可被邮件库解析：References 数量', (Array.isArray(parsed.references) ? parsed.references : [parsed.references]).length, 2)
eq('mime 可被邮件库解析：主题', parsed.subject, 'Re: 原图+卡套 追加: POD_ORDER_20486')

console.log('errors:')
eq('ECONNREFUSED → PORT_BLOCKED', classifyMailError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'imap').code, 'PORT_BLOCKED')
eq('ENOTFOUND imap → IMAP_UNREACHABLE', classifyMailError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'imap').code, 'IMAP_UNREACHABLE')
eq('ENOTFOUND smtp → SMTP_UNREACHABLE', classifyMailError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'smtp').code, 'SMTP_UNREACHABLE')
eq('authenticationFailed → IMAP_AUTH_FAILED', classifyMailError(Object.assign(new Error('LOGIN failed'), { authenticationFailed: true }), 'imap').code, 'IMAP_AUTH_FAILED')
eq('App Password 文案', classifyMailError(new Error('Invalid credentials (Application-specific password required)'), 'imap').code, 'IMAP_APP_PASSWORD_REQUIRED')
eq('IMAP disabled 文案', classifyMailError(new Error('IMAP access is disabled for this account'), 'imap').code, 'IMAP_DISABLED')
eq('证书错误 → IMAP_TLS_ERROR', classifyMailError(Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'imap').code, 'IMAP_TLS_ERROR')
eq('证书错误 → SMTP_TLS_ERROR', classifyMailError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), 'smtp').code, 'SMTP_TLS_ERROR')
eq('超时 → TIMEOUT', classifyMailError(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }), 'imap').code, 'TIMEOUT')
eq('SMTP 535 → SMTP_AUTH_FAILED', classifyMailError(Object.assign(new Error('Invalid login'), { responseCode: 535 }), 'smtp').code, 'SMTP_AUTH_FAILED')
eq('SMTP 550 → SMTP_SENDER_REJECTED', classifyMailError(Object.assign(new Error('Sender rejected'), { responseCode: 550 }), 'smtp').code, 'SMTP_SENDER_REJECTED')
eq('未知错误 → UNKNOWN', classifyMailError(new Error('weird thing happened'), 'imap').code, 'UNKNOWN')
eq('FIX_HINTS 全部有文案', Object.values(FIX_HINTS).every((s) => s.length > 10), true)
eq('errDetail 截断长响应', errDetail(Object.assign(new Error('x'), { responseText: 'A'.repeat(900) })).length <= 500, true)

console.log('bodystructure:')
const bodyStructure = {
  type: 'multipart/mixed',
  parameters: { boundary: 'b1' },
  childNodes: [
    { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' }, size: 28 },
    {
      part: '2',
      type: 'application/octet-stream',
      disposition: 'attachment',
      dispositionParameters: { filename: '=?UTF-8?B?6K6+6K6h5Zu+X+WNoeWll192My50aWY=?=' },
      size: 34,
      encoding: 'base64'
    },
    {
      part: '3',
      type: 'image/png',
      disposition: 'inline',
      dispositionParameters: { filename: 'logo.png' },
      size: 100
    },
    {
      part: '4',
      type: 'multipart/alternative',
      childNodes: [
        { part: '4.1', type: 'text/plain', size: 10 },
        { part: '4.2', type: 'text/html', size: 20 }
      ]
    }
  ]
}
const atts = extractAttachments(bodyStructure as never)
eq('extractAttachments 数量（跳过 inline 与容器）', atts.length, 1)
eq('extractAttachments partId', atts[0]!.partId, '2')
eq('extractAttachments RFC2047 文件名解码', atts[0]!.filename, '设计图_卡套_v3.tif')
eq('extractAttachments mimeType', atts[0]!.mimeType, 'application/octet-stream')
eq('extractAttachments size', atts[0]!.size, 34)
eq('extractAttachments 空结构', extractAttachments(undefined).length, 0)
eq('findBodyPart text/plain', findBodyPart(bodyStructure as never, 'text/plain')?.part, '1')
eq('findBodyPart text/html', findBodyPart(bodyStructure as never, 'text/html')?.part, '4.2')
eq('htmlToText 去标签', htmlToText('<p>你好<br>世界</p><script>x</script>'), '你好\n世界')

console.log('headers parse:')
const hdr = parseHeaderBlock(Buffer.from('Auto-Submitted: auto-replied\r\nReferences: <r1@x>\r\n <r2@x>\r\nIn-Reply-To: <r2@x>\r\n'))
eq('parseHeaderBlock auto-submitted', hdr.get('auto-submitted'), 'auto-replied')
eq('parseHeaderBlock 折行合并', parseReferences(hdr.get('references')), ['<r1@x>', '<r2@x>'])
eq('parseReferences 无尖括号', parseReferences('a@x b@y'), ['<a@x>', '<b@y>'])
eq('threadKeyOf 优先 References 根', threadKeyOf('<m@x>', ['<root@x>', '<m@x>']), '<root@x>')
eq('threadKeyOf 无 References 用 Message-ID', threadKeyOf('<m@x>', []), '<m@x>')
eq('threadKeyOf 兜底 uid', threadKeyOf('', [], 'uid:1:42'), 'uid:1:42')

console.log('testConnection 不可达（不联网也能快速失败）:')
const badCfg = {
  email: 'x@y.z', imapHost: '127.0.0.1', imapPort: 9, imapSecure: 'none' as const,
  imapUser: 'x', imapPass: 'p', smtpHost: '127.0.0.1', smtpPort: 9, smtpSecure: 'none' as const,
  smtpUser: 'x', smtpPass: 'p'
}
const bad = await testConnection(badCfg)
eq('testConnection ok=false', bad.ok, false)
eq('testConnection 两行', bad.lines.length, 2)
eq('IMAP 错误码有值', typeof bad.lines[0]!.errorCode, 'string')
eq('IMAP 有中文 message', /[\u4e00-\u9fff]/.test(bad.lines[0]!.message ?? ''), true)
eq('SMTP 错误码有值', typeof bad.lines[1]!.errorCode, 'string')
eq('testedAt 是数字', typeof bad.testedAt, 'number')

// sendReply 不可达：必须抛出带稳定错误码的 ReplySendError（而不是静默）
let sendErr: { code?: string; message?: string } = {}
try {
  await sendReply(
    { host: '127.0.0.1', port: 9, secure: 'none', user: 'x', pass: 'p', timeoutMs: 1500 },
    { from: { address: 'x@y.z', name: 'x' }, to: { address: 'a@b.c' }, subject: 's', body: 'b' }
  )
} catch (e) {
  sendErr = e as { code?: string; message?: string }
}
eq('sendReply 失败有错误码', typeof sendErr.code, 'string')
eq('sendReply 失败中文提示', /[\u4e00-\u9fff]/.test(sendErr.message ?? ''), true)

// 附件识别：inline vs attachment vs 正文
{
  const inlineNamed = struct({ disposition: 'inline', dispositionParameters: { filename: '1.rar' } })
  const attachNamed = struct({ disposition: 'attachment', dispositionParameters: { filename: '2 (2).zip' } })
  const inlineLogo = struct({ type: 'image/png', disposition: 'inline', dispositionParameters: { filename: 'image001.png' } })
  const textPart = struct({ type: 'text/plain', part: '1' })
  const root = { type: 'multipart/mixed', childNodes: [textPart, inlineNamed, attachNamed, inlineLogo] } as any
  const parts = extractAttachments(root)
  eq('inline 带文件名的 .rar 也算附件', parts.some((p) => p.filename === '1.rar'), true)
  eq('attachment 的 zip 正常识别', parts.some((p) => p.filename === '2 (2).zip'), true)
  eq('正文 text/plain 不算附件', parts.some((p) => p.partId === '1'), false)
  eq('inline 签名小图被跳过', parts.some((p) => p.filename === 'image001.png'), false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
