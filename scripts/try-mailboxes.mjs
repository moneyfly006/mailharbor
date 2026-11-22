import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
const cases = [
  { name: '阿里云 DirectMail (moneyfly.top)', host: 'smtpdm.aliyun.com', port: 465, user: 'noreply@moneyfly.top', pass: process.env.P1 },
  { name: '阿里云 DirectMail (moneyfly.club)', host: 'smtpdm.aliyun.com', port: 465, user: 'notice@moneyfly.club', pass: process.env.P2 },
  { name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, user: 'moneyflysubssr@qq.com', pass: process.env.P3, imap: { host: 'imap.qq.com', port: 993 } }
]
for (const c of cases) {
  console.log('\n===', c.name, '===')
  // SMTP
  try {
    const t = nodemailer.createTransport({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass } })
    await t.verify()
    console.log('  SMTP 登录: OK (465 SSL)')
    t.close()
  } catch (e) { console.log('  SMTP 登录: 失败 →', e.message.slice(0, 120)) }
  // IMAP
  if (c.imap) {
    try {
      const cl = new ImapFlow({ host: c.imap.host, port: c.imap.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false, clientInfo: { name: 'MailHarbor', version: '1.0' } })
      await cl.connect()
      const lock = await cl.getMailboxLock('INBOX')
      console.log('  IMAP 登录: OK，INBOX', cl.mailbox.exists, '封')
      lock.release(); await cl.logout()
    } catch (e) { console.log('  IMAP 登录: 失败 →', e.message.slice(0, 120)) }
  } else {
    console.log('  IMAP: 该服务商是「邮件推送」服务，不提供收件箱（只能发，不能收）')
  }
}
