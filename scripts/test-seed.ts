/**
 * 预置规则单测：空库播种 3 条；重复执行不重复播种；已有规则时不覆盖
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-seed.ts
 */
import { SCHEMA } from '../src/main/schema.ts'
import { openSqlite } from '../src/main/sqlite.ts'
import * as repos from '../src/main/repos.ts'

let pass = 0, fail = 0
const eq = (n: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}\n    got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`))
}

// 用一个内存库直接测"播种行为"（seed.ts 依赖 electron app 路径，这里只测规则结构约定）
const db = openSqlite(':memory:')
db.exec(SCHEMA)
repos.configureRepos({ db, codec: repos.PLAIN_CODEC })

const { defaultSeedRules, defaultPodRoots } = await import('../src/main/seed-rules.ts')
const seeds = defaultSeedRules()
eq('预置 3 条标题规则', seeds.length, 3)
eq('关键词顺序', seeds.map((s) => s.keyword), ['原图+手机壳', '原图+卡套', '原图+浴室垫'])
eq('手机壳 1 个路径', seeds[0]!.paths.length, 1)
eq('卡套 2 个路径', seeds[1]!.paths.length, 2)
eq('浴室垫 1 个路径', seeds[2]!.paths.length, 1)
eq('卡套两个路径不同', seeds[1]!.paths[0] !== seeds[1]!.paths[1], true)
eq('路径含品类名', seeds[1]!.paths.every((p) => p.includes('卡套')), true)
const roots = defaultPodRoots()
eq('备份目录在备份根下', roots.backup.includes('备份'), true)

// 预置规则可直接入库（模拟界面新建）
for (const [i, s] of seeds.entries()) {
  repos.createRule({ keyword: s.keyword, enabled: true, scope: 'subject', mode: 'exact', priority: (i + 1) * 10,
    fileTypes: ['zip','tif','tiff','jpg','jpeg','png','pdf'], autoReply: true,
    targets: s.paths.map((p) => ({ path: p, required: true })) })
}
eq('库中规则数', repos.listRules().length, 3)
eq('卡套规则 2 个目标', repos.listRules().find((r) => r.keyword === '原图+卡套')?.targets.length, 2)
eq('规则默认自动回信', repos.listRules().every((r) => r.autoReply), true)

db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
