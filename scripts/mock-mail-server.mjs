#!/usr/bin/env node
/**
 * 本地模拟邮件服务器
 *  - IMAP：hoodiecrow（127.0.0.1:1143，明文，账号 demo@mailharbor.test / demo-pass）
 *  - SMTP：smtp-server（127.0.0.1:2525，明文无认证）→ 收到的"回信"存在 MOCK.sent 数组，供断言
 *
 * 用途：没有真实 Gmail/QQ 账号时，端到端验证「收信 → 关键词命中 → 多路径落盘 → 记录 → SMTP 回信」。
 * 用法：
 *   node scripts/mock-mail-server.mjs           # 启动并预置 3 封邮件（2 封命中关键词）
 *   node scripts/mock-mail-server.mjs --empty   # 只启动服务，不预置邮件
 */
import { SMTPServer } from 'smtp-server'
import hoodiecrow from 'hoodiecrow-imap'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const MOCK = {
  imap: { host: '127.0.0.1', port: 1143, secure: 'none', starttls: false },
  smtp: { host: '127.0.0.1', port: 2525, secure: 'none', starttls: false },
  user: 'demo@mailharbor.test',
  pass: 'demo-pass',
  /** 收到的发信内容（回信断言用） */
  sent: []
}

export const SEED = [
  {
    subject: '原图+卡套 追加: POD_ORDER_20486',
    from: { name: 'David Chen', address: 'david@inkpressed.co' },
    fileName: 'POD_ORDER_20486.zip',
    content: 'PK\u0003\u0004fake-zip-content-for-test-20486',
    date: new Date('2026-11-22T07:44:00Z')
  },
  {
    subject: '原图+手机壳 秋祭限定 12 款',
    from: { name: 'Mika Sato', address: 'mika@tokyoprint.jp' },
    fileName: '设计图_卡套_v3.tif',
    content: 'II*\u0000fake-tiff-content-v3',
    date: new Date('2026-11-22T07:38:00Z')
  },
  {
    subject: '关于报价的询问',
    from: { name: 'Someone', address: 'someone@example.com' },
    fileName: 'quote.pdf',
    content: '%PDF-1.4 fake quote',
    date: new Date('2026-11-22T06:00:00Z')
  }
]

/** 按 RFC 2047 编码非 ASCII 主题（真实邮件客户端都这么做） */
export function encodeHeader(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

export function encodeParam(s) {
  // RFC 2231：非 ASCII 文件名
  if (/^[\x20-\x7e]*$/.test(s)) return `filename="${s}"`
  const enc = encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `filename*=UTF-8''${enc}`
}

function mimeOfName(name = '') {
  const ext = String(name).toLowerCase().split('.').pop()
  const map = {
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    pdf: 'application/pdf',
    tar: 'application/x-tar',
    gz: 'application/gzip'
  }
  return map[ext] ?? 'application/octet-stream'
}

export function mimeFor(m) {
  const boundary = '----=MH_' + Math.random().toString(36).slice(2)
  const from = m.from ? `${m.from.name} <${m.from.address}>` : MOCK.user
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${MOCK.user}`,
      `Subject: ${encodeHeader(m.subject)}`,
      `Date: ${(m.date ?? new Date()).toUTCString()}`,
      `Message-ID: <${Date.now()}${Math.random().toString(36).slice(2)}@mailharbor.test>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: ${m.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
      'Content-Transfer-Encoding: 8bit',
      '',
      m.html ?? m.body ?? '定制需求：请按附件图稿生产，交期 12 月 5 日。',
      '',
      ...(m.noAttachment ? [] : [
        `--${boundary}`,
        `Content-Type: ${mimeOfName(m.fileName)}`,
        `Content-Disposition: attachment; ${encodeParam(m.fileName)}`,
        'Content-Transfer-Encoding: base64',
        '',
        (m.contentBuffer ? Buffer.from(m.contentBuffer) : Buffer.from(m.content ?? 'x')).toString('base64'),
        ''
      ]),
      `--${boundary}--`,
      ''
    ].join('\r\n'),
    'utf8'
  )
}

export async function startMockMailServer({
  seed = true,
  quiet = false,
  imapPort = MOCK.imap.port,
  smtpPort = MOCK.smtp.port
} = {}) {
  const imap = hoodiecrow({
    plugins: ['idle', 'auth-plain', 'x-gm-ext-1', 'literalplus', 'namespace'],
    users: {
      [MOCK.user]: { password: MOCK.pass }
    }
  })
  await new Promise((res, rej) => {
    imap.listen(imapPort, '127.0.0.1', (err) => (err ? rej(err) : res()))
  })

  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => {
        MOCK.sent.push(Buffer.concat(chunks).toString('utf8'))
        cb()
      })
    }
  })
  await new Promise((res, rej) => smtp.listen(smtpPort, '127.0.0.1', (err) => (err ? rej(err) : res())))

  if (seed) {
    // 传 Uint8Array，hoodiecrow 会保留原始字节（等价于真实邮件服务器上的 8-bit 邮件）
    for (const m of SEED) imap.appendMessage('INBOX', [], false, new Uint8Array(mimeFor(m)))
  }

  if (!quiet) {
    console.log('Mock mail server ready:')
    console.log(`  IMAP 127.0.0.1:${imapPort}  secure=false starttls=false`)
    console.log(`  SMTP 127.0.0.1:${smtpPort}  secure=false starttls=false authOptional`)
    console.log(`  login ${MOCK.user} / ${MOCK.pass}`)
    if (seed) console.log(`  seeded ${SEED.length} messages (2 命中关键词)`)
  }

  const close = async () => {
    await new Promise((r) => smtp.close(r))
    await new Promise((r) => imap.close(r))
  }
  return { imap, smtp, close }
}

const isMain = process.argv[1] && process.argv[1].endsWith('mock-mail-server.mjs')
if (isMain) {
  startMockMailServer({ seed: !process.argv.includes('--empty') }).then(() => {
    console.log('\nCtrl+C 退出')
  })
}
