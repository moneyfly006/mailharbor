/**
 * 真实 Electron + 本机测试服务器：邮件链接 → 网页点击 → 带 Cookie 的重定向 → 文件归档。
 * 运行：pnpm build && node scripts/test-link-download.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import AdmZip from 'adm-zip'
import { MOCK, mimeFor, startMockMailServer } from './mock-mail-server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const testDir = await mkdtemp(join(tmpdir(), 'mh-web-e2e-'))
const archiveDir = join(testDir, 'archive')
const downloadsDir = join(testDir, 'downloads')
const profile = join(testDir, 'profile')
await Promise.all([mkdir(archiveDir), mkdir(downloadsDir), mkdir(profile)])
// 拦住启动时的旧版数据迁移，联调只使用自己创建的账户和邮件。
await writeFile(join(profile, 'mailharbor.db'), '')
const fixture = Buffer.alloc(3 * 1024 * 1024, 0x5a)
const zip = new AdmZip()
zip.addFile('content.txt', fixture)
const archiveFixture = zip.toBuffer()
const automatic = process.argv.includes('--automatic')
const entryPath = automatic ? '/ftn/download' : '/entry.tif'
const subject = automatic ? '原图+卡套 HTTPS 自动联调' : '原图+卡套 HTTPS E2E'
let actualFileRequests = 0
const requests = []
const server = createServer({
  cert: await readFile(join(root, 'scripts/fixtures/tls/cert.pem')),
  key: await readFile(join(root, 'scripts/fixtures/tls/key.pem'))
}, (req, res) => {
  requests.push(req.url)
  if (req.url === entryPath) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'file-session=fixture; Secure; HttpOnly; Path=/' })
    res.end(`<a href="/open" target="_blank" rel="noopener">${automatic ? '下载' : 'Download file'}</a>`)
  } else if (req.url === '/open') {
    res.writeHead(302, { Location: '/asset?signature=fixture' }).end()
  } else if (req.url === '/asset?signature=fixture' && req.headers.cookie === 'file-session=fixture') {
    actualFileRequests++
    const payload = automatic ? archiveFixture : fixture
    res.writeHead(200, {
      'Content-Type': automatic ? 'application/zip' : 'image/tiff',
      'Content-Length': payload.length,
      'Content-Disposition': `attachment; filename*=UTF-8''%E5%9B%BE%E7%A8%BF.${automatic ? 'zip' : 'tif'}`
    }).end(payload)
  } else {
    res.writeHead(403).end()
  }
})

let desktop
let mock
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const host = automatic ? 'wx.mail.qq.com' : '127.0.0.1'
  const url = `https://${host}:${server.address().port}${entryPath}`
  const imapPort = 20_000 + Math.floor(Math.random() * 15_000)
  const smtpPort = imapPort + 1
  mock = await startMockMailServer({ seed: false, quiet: true, imapPort, smtpPort })
  mock.imap.appendMessage('INBOX', [], false, new Uint8Array(mimeFor({
    subject,
    from: { name: 'Fixture', address: 'fixture@mailharbor.test' },
    noAttachment: true,
    html: `<p>详情 <a href="https://example.com/about">网站</a> <a href="${url}">下载附件</a></p>`
  })))
  const env = { ...process.env, MH_FORCE_NODE_SQLITE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const require = createRequire(import.meta.url)
  desktop = await _electron.launch({
    executablePath: require('electron'),
    args: [root, `--user-data-dir=${profile}`, ...(automatic ? ['--host-resolver-rules=MAP wx.mail.qq.com 127.0.0.1', '--no-proxy-server'] : [])],
    env
  })
  const win = await desktop.firstWindow()
  await win.waitForFunction(() => !!window.mailharbor)
  const accountId = await win.evaluate(async ({ archiveDir, imapPort, smtpPort, user, pass, automatic }) => {
    const { accounts, rules, settings } = window.mailharbor
    if ((await accounts.list()).length) throw new Error('测试数据目录包含已有账户')
    const config = await settings.get()
    await settings.save({ ...config, replyEnabled: false, extractArchives: automatic, proxy: { mode: 'none', host: '', port: 0 } })
    const rule = (await rules.list()).find((entry) => entry.keyword === '原图+卡套')
    await rules.update(rule.id, {
      ...rule,
      fileTypes: [automatic ? 'zip' : 'tif'],
      targets: [{ path: archiveDir, required: true }]
    })
    const account = await accounts.create({
      preset: automatic ? 'qq' : 'custom', email: user, displayName: 'Fixture', imapHost: '127.0.0.1', imapPort, imapSecure: 'none',
      imapUser: user, smtpHost: '127.0.0.1', smtpPort, smtpSecure: 'none', smtpUser: user,
      smtpSameAsImap: true, password: pass
    })
    return account.id
  }, { archiveDir, imapPort, smtpPort, user: MOCK.user, pass: MOCK.pass, automatic })
  await desktop.evaluate(({ app, session }, { accountId, downloadsDir, automatic, host }) => {
    app.setPath('downloads', downloadsDir)
    const partition = automatic ? `persist:qq-web-${accountId}` : `attachment-web-${accountId}`
    session.fromPartition(partition).setCertificateVerifyProc(({ hostname }, callback) => {
      callback(hostname === host ? 0 : -3)
    })
  }, { accountId, downloadsDir, automatic, host })
  if (automatic) {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profile, 'mailharbor.db'))
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run(`qqWebEnabled:${accountId}`, 'true', Date.now())
    db.close()
  }
  await win.evaluate((id) => window.mailharbor.accounts.testSaved(id), accountId)
  await win.evaluate(() => window.mailharbor.checkNow())
  if (automatic) {
    const deadline = Date.now() + 15_000
    let record
    while ((!record || record.status === 'queued') && Date.now() < deadline) {
      const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
      record = records.rows.find((entry) => entry.subject === subject)
      await delay(100)
    }
    assert.equal(record?.status, 'done', record?.error ?? JSON.stringify(requests))
    assert.deepEqual(await readFile(join(archiveDir, '图稿.zip')), archiveFixture)
    assert.deepEqual(await readFile(join(archiveDir, 'content.txt')), fixture)
    assert.equal(actualFileRequests, 1)
    console.log('通过：QQ 中转站链接在后台自动点击、带会话下载、归档和解压')
  } else {
    let recordId
    const deadline = Date.now() + 10_000
    while (!recordId && Date.now() < deadline) {
      const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
      recordId = records.rows.find((entry) => entry.status === 'manual_needed' && entry.links.includes(url))?.id
      if (!recordId) await delay(100)
    }
    assert.ok(recordId, '收件并识别测试下载链接')
    const childPromise = desktop.waitForEvent('window', { timeout: 10_000 })
    const archive = win.evaluate((id) => window.mailharbor.records.downloadLink(id), recordId)
      .catch((error) => ({ ok: false, message: String(error) }))
    const browser = await Promise.race([
      childPromise,
      archive.then((result) => { throw new Error(result.message ?? '下载窗口未打开') })
    ])
    await Promise.race([
      browser.getByRole('link', { name: 'Download file' }).click({ timeout: 10_000 }),
      archive.then((result) => assert.equal(result.ok, true, result.message))
    ]).catch(async (error) => {
      console.error({ host: URL.parse(browser.url())?.hostname, localhostRequests: requests.length })
      if (browser.isClosed()) assert.equal((await archive).ok, true, (await archive).message)
      throw error
    })
    const result = await archive
    assert.equal(result.ok, true, result.message)
    assert.equal(result.archived, 1)
    assert.equal(actualFileRequests, 1, '使用网页会话中的实际地址下载一次')
    assert.deepEqual(await readFile(join(archiveDir, '图稿.tif')), fixture)
    const [sourceFolder] = await readdir(join(downloadsDir, 'MailHarbor'))
    assert.deepEqual(await readFile(join(downloadsDir, 'MailHarbor', sourceFolder, '图稿.tif')), fixture)
    const records = await win.evaluate(() => window.mailharbor.records.list({ page: 1, pageSize: 10 }))
    assert.equal(records.rows.find((entry) => entry.id === recordId)?.status, 'done')
    console.log('通过：正文下载链接选取、会话 Cookie、弹窗跳转、HTTPS 中文文件名与归档内容')
  }
} finally {
  await desktop?.close()
  await mock?.close()
  server.close()
  await rm(testDir, { recursive: true, force: true })
}
