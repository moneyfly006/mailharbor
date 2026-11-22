/**
 * SQLite 适配层单测：强制走 node:sqlite（打包后的运行时），验证 repos 全链路可用。
 * 运行：MH_FORCE_NODE_SQLITE=1 node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-sqlite-adapter.ts
 */
import { SCHEMA } from '../src/main/schema.ts'
import { openSqlite, currentDriver } from '../src/main/sqlite.ts'
import * as repos from '../src/main/repos.ts'

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

const db = openSqlite(':memory:')
console.log('驱动:', db.driver)
eq('驱动为 node:sqlite', db.driver, 'node:sqlite')
eq('currentDriver', currentDriver(), 'node:sqlite')

db.exec(SCHEMA)
repos.configureRepos({ db, codec: repos.PLAIN_CODEC })

// 基础 CRUD
const acc = repos.createAccount({
  preset: 'custom',
  email: 'demo@mailharbor.test',
  displayName: '',
  imapHost: '127.0.0.1',
  imapPort: 1143,
  imapSecure: 'none',
  imapUser: 'demo@mailharbor.test',
  smtpHost: '127.0.0.1',
  smtpPort: 2525,
  smtpSecure: 'none',
  smtpUser: 'demo@mailharbor.test',
  smtpFromName: 'MailHarbor',
  smtpSameAsImap: true,
  password: 'demo-pass'
})
eq('createAccount 返回 id', typeof acc.id, 'number')
eq('listAccounts 数量', repos.listAccounts().length, 1)
eq('密码可解密', repos.getAccountSecrets(acc.id).imapPass, 'demo-pass')

// 事务：嵌套 + 回滚
const t = db.transaction((): number => {
  repos.createRule({ keyword: '原图+卡套', enabled: true, scope: 'subject', mode: 'exact', fileTypes: ['zip'], autoReply: true, targets: [{ path: '/tmp/a', required: true }] })
  return repos.listRules().length
})
eq('事务内创建规则', t(), 1)
eq('事务外可见', repos.listRules().length, 1)
try {
  db.transaction(() => {
    repos.createRule({ keyword: '要回滚', enabled: true, scope: 'subject', mode: 'exact', fileTypes: ['zip'], autoReply: true, targets: [{ path: '/tmp/b', required: true }] })
    throw new Error('rollback')
  })()
} catch {
  /* expected */
}
eq('事务回滚后规则数不变', repos.listRules().length, 1)

// 设置读写 + 记录查询（走 LIMIT/OFFSET/EXISTS 子查询）
const listed = repos.listRecords({ page: 1, pageSize: 10 })
eq('listRecords 空库 total', listed.total, 0)
eq('dashboardStats 可查询', typeof repos.dashboardStats().todayMessages, 'number')
eq('listDisks 可查询', Array.isArray(repos.listDisks()), true)

db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
