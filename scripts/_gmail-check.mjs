import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

const USER = 'moneyflysubssr@gmail.com'
const PASS = process.env.MH_GMAIL_PASS
const mask = (s) => s.slice(0, 4) + '***' + s.slice(-2)

console.log('账号:', USER, '密码:', mask(PASS ?? ''), '(长度', PASS?.length, ')')

// IMAP 测试
try {
  const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false })
  await c.connect()
  const lock = await c.getMailboxLock('INBOX')
  console.log('IMAP 登录成功 · INBOX 共', c.mailbox.exists, '封 · UIDVALIDITY', String(c.mailbox.uidValidity))
  lock.release()
  await c.logout()
} catch (e) {
  console.log('IMAP 失败:', e.message)
}

// SMTP 测试（465 SSL）
for (const port of [465, 587]) {
  try {
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port, secure: port === 465, auth: { user: USER, pass: PASS } })
    await t.verify()
    console.log(`SMTP ${port} 登录成功`)
    t.close()
  } catch (e) {
    console.log(`SMTP ${port} 失败:`, e.message)
  }
}
