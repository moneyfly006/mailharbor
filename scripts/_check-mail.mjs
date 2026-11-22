import { ImapFlow } from 'imapflow'
const USER='moneyflysubssr@gmail.com', PASS=process.env.MH_GMAIL_PASS
const c = new ImapFlow({ host:'imap.gmail.com', port:993, secure:true, auth:{user:USER,pass:PASS}, logger:false })
await c.connect()
const lock = await c.getMailboxLock('INBOX')
console.log('INBOX:', c.mailbox.exists, 'uidNext:', String(c.mailbox.uidNext))
// 和 provider 完全一致的查询
const from = 8164
const found = await c.search({ uid: `${from}:*` }, { uid: true })
console.log('UID 8164:* 搜索到:', found)
for (const uid of found.slice(-3)) {
  const m = await c.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true })
  console.log('  uid', uid, '|', m.envelope?.subject)
}
lock.release(); await c.logout(); process.exit(0)
