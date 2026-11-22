/**
 * 用真实邮箱验证「账户配置 + 测试连接」这条路径（不发送任何邮件）。
 *
 * 用法（凭据只从环境变量读，不写进仓库）：
 *   MH_QQ_USER=xxx@qq.com MH_QQ_PASS=授权码 \
 *   MH_ALI_USER=noreply@yourdomain MH_ALI_PASS=SMTP密码 \
 *   MH_GMAIL_USER=you@gmail.com MH_GMAIL_PASS=应用专用密码 \
 *   node scripts/real-provider-check.mjs
 *
 * 每个变量缺失就跳过对应邮箱。
 */
import { _electron as electron } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.MH_FORCE_NODE_SQLITE = '1'
const electronBin =
  process.platform === 'darwin'
    ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(ROOT, 'node_modules/electron/dist/electron.exe')

const app = await electron.launch({
  executablePath: electronBin,
  args: [ROOT, '--no-sandbox', '--disable-gpu', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mh-real-'))}`],
  env
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const cases = []
if (process.env.MH_GMAIL_USER && process.env.MH_GMAIL_PASS) {
  cases.push({
    name: 'Gmail',
    input: {
      preset: 'gmail', email: process.env.MH_GMAIL_USER, displayName: 'Gmail',
      imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: 'ssl', imapUser: process.env.MH_GMAIL_USER,
      smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: process.env.MH_GMAIL_USER,
      smtpFromName: 'Gmail', smtpSameAsImap: true, password: process.env.MH_GMAIL_PASS
    }
  })
}
if (process.env.MH_QQ_USER && process.env.MH_QQ_PASS) {
  cases.push({
    name: 'QQ 邮箱（IMAP+SMTP，授权码）',
    input: {
      preset: 'qq', email: process.env.MH_QQ_USER, displayName: 'QQ',
      imapHost: 'imap.qq.com', imapPort: 993, imapSecure: 'ssl', imapUser: process.env.MH_QQ_USER,
      smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: process.env.MH_QQ_USER,
      smtpFromName: 'QQ', smtpSameAsImap: true, password: process.env.MH_QQ_PASS
    }
  })
}
if (process.env.MH_ALI_USER && process.env.MH_ALI_PASS) {
  cases.push({
    name: '阿里云 DirectMail（仅发件）',
    input: {
      preset: 'custom', email: process.env.MH_ALI_USER, displayName: 'Aliyun',
      imapHost: '', imapPort: 993, imapSecure: 'ssl', imapUser: '',
      smtpHost: 'smtpdm.aliyun.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: process.env.MH_ALI_USER,
      smtpFromName: '通知', smtpSameAsImap: true, sendOnly: true,
      password: process.env.MH_ALI_PASS
    }
  })
}

console.log(`待测邮箱：${cases.length} 个`)
for (const c of cases) {
  const r = await win.evaluate(async (input) => {
    try {
      const res = await window.mailharbor.accounts.test(input)
      return { lines: res.lines.map((l) => ({ p: l.protocol, ok: l.ok, code: l.errorCode ?? '', msg: l.message ?? '' })) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, c.input)
  if (r.error) {
    console.log(`\n✗ ${c.name}：${r.error}`)
    continue
  }
  console.log(`\n${c.name}`)
  for (const l of r.lines) {
    const mark = l.ok ? '✓' : '✗'
    console.log(`  ${mark} ${l.p.toUpperCase()} ${l.ok ? '通过' : `失败 [${l.code}]`} — ${l.msg}`)
  }
}
await app.close()
