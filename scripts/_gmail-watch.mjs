/** 启动软件 → 发一封测试邮件 → 打印所有主进程日志（不过滤） */
import { _electron as electron } from 'playwright'
import nodemailer from 'nodemailer'
const ROOT = '/Users/apple/Projects/mail-harbor'
const USER = 'moneyflysubssr@gmail.com', PASS = process.env.MH_GMAIL_PASS
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; env.MH_FORCE_NODE_SQLITE = '1'
const app = await electron.launch({ executablePath: `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, args: [ROOT, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/mh-gmail2'], env })
app.process().stdout?.on('data', (d) => process.stdout.write('[app] ' + d))
app.process().stderr?.on('data', (d) => { const s = String(d); if (!/Debugger|DevTools|Warning|NO_COLOR/.test(s)) process.stdout.write('[err] ' + s) })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(6000)
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const subject = `原图+卡套 追加: MAILTEST_${stamp}`
const m = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: USER, pass: PASS } })
import { execSync } from 'node:child_process'
execSync('cd /tmp && rm -rf mhzip && mkdir mhzip && printf "MailHarbor test\\n" > mhzip/readme.txt && rm -f MH_SELF_TEST.zip && cd mhzip && zip -q /tmp/MH_SELF_TEST.zip readme.txt')
await m.sendMail({ from: `"MoneyFly POD" <${USER}>`, to: USER, subject, text: `watch test ${stamp}`, attachments: [{ filename: 'MH_TEST.zip', path: '/tmp/MH_SELF_TEST.zip' }] })
m.close()
console.log('SENT:', subject)
await win.waitForTimeout(75000)
const recs = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
console.log('RECORDS:', JSON.stringify(recs.rows.map((r) => [r.subject?.slice(0, 30), r.status, r.replyStatus])))
await app.close()
