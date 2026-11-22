/**
 * 带 TLS 的模拟邮件服务器，用于验证「自签名证书 / STARTTLS / SSL」这些企业邮箱常见配置。
 *
 * 端口（默认）：
 *  - IMAP SSL     127.0.0.1:1993（自签名证书）
 *  - IMAP STARTTLS 127.0.0.1:1143（明文起，STARTTLS 升级）
 *  - SMTP SSL     127.0.0.1:2465（自签名证书）
 *  - SMTP STARTTLS 127.0.0.1:2587
 *
 * 账号：demo@mailharbor.test / demo-pass（任意密码也接受，方便测通配）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import hoodiecrow from 'hoodiecrow-imap'
import { SMTPServer } from 'smtp-server'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY = readFileSync(join(HERE, 'fixtures/tls/key.pem'))
const CERT = readFileSync(join(HERE, 'fixtures/tls/cert.pem'))

export const TLS_MOCK = {
  user: 'demo@mailharbor.test',
  pass: 'demo-pass',
  imapSsl: { host: '127.0.0.1', port: 1993 },
  imapStarttls: { host: '127.0.0.1', port: 1143 },
  smtpSsl: { host: '127.0.0.1', port: 2465 },
  smtpStarttls: { host: '127.0.0.1', port: 2587 },
  sent: []
}

function seedMessage(imap) {
  const boundary = '----TLSTEST'
  const raw = [
    `From: "TLS Tester" <tls@inkpressed.co>`,
    `To: ${TLS_MOCK.user}`,
    `Subject: =?UTF-8?B?${Buffer.from('原图+卡套 TLS测试', 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <tls-${Date.now()}@mailharbor.test>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'TLS 测试正文',
    '',
    `--${boundary}`,
    'Content-Type: application/zip',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="TLS_TEST.zip"',
    '',
    Buffer.from('PK\u0003\u0004tls-test').toString('base64'),
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n')
  imap.appendMessage('INBOX', [], false, new Uint8Array(Buffer.from(raw, 'utf8')))
}

export async function startTlsMockServers() {
  // IMAP：一个 SSL 实例 + 一个 STARTTLS 实例（共享同一份 storage）
  const mkImap = (secureConnection, plugins) =>
    hoodiecrow({
      secureConnection,
      credentials: { key: KEY, cert: CERT },
      plugins,
      users: { [TLS_MOCK.user]: { password: TLS_MOCK.pass } }
    })

  const imapSsl = mkImap(true, ['idle', 'auth-plain'])
  const imapStart = mkImap(false, ['idle', 'starttls', 'auth-plain'])
  await new Promise((r) => imapSsl.listen(TLS_MOCK.imapSsl.port, '127.0.0.1', () => r()))
  await new Promise((r) => imapStart.listen(TLS_MOCK.imapStarttls.port, '127.0.0.1', () => r()))
  seedMessage(imapSsl)

  const smtpHandler = (secure) => ({
    secure,
    key: KEY,
    cert: CERT,
    authOptional: true,
    // 接受任意账号密码（测试用），否则客户端 AUTH 会被拒
    onAuth(auth, session, cb) {
      cb(null, { user: auth.username || 'demo' })
    },
    logger: false,
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => {
        TLS_MOCK.sent.push(Buffer.concat(chunks).toString('utf8'))
        cb()
      })
    }
  })

  const smtpSsl = new SMTPServer(smtpHandler(true))
  const smtpStart = new SMTPServer(smtpHandler(false))
  // 客户端握手失败/断开会触发 error 事件，不接住会让测试进程直接崩
  for (const s of [smtpSsl, smtpStart]) {
    s.on('error', (e) => console.warn('[mock-tls] smtp:', e.message))
  }
  await new Promise((r) => smtpSsl.listen(TLS_MOCK.smtpSsl.port, '127.0.0.1', () => r()))
  await new Promise((r) => smtpStart.listen(TLS_MOCK.smtpStarttls.port, '127.0.0.1', () => r()))

  return {
    close: async () => {
      await new Promise((r) => smtpSsl.close(r))
      await new Promise((r) => smtpStart.close(r))
      await new Promise((r) => imapSsl.close(r))
      await new Promise((r) => imapStart.close(r))
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('mock-tls-mail-server.mjs')) {
  startTlsMockServers().then(() => console.log('TLS mock servers up:', TLS_MOCK))
}
