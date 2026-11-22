/**
 * 后端全部单测/联调入口（逐个文件独立进程，互不污染 DB/端口）：
 *   node scripts/run-backend-tests.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'test-repos.ts',
  'test-mail.ts',
  'test-dispatcher.ts',
  'test-reply.ts',
  'test-scheduler.ts',
  'test-e2e-backend.ts'
]

const failed = []
for (const file of files) {
  console.log(`\n========== ${file} ==========`)
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--import', './scripts/ts-resolve.mjs', join('scripts', file)],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_NO_WARNINGS: '1' }
    }
  )
  if (res.status !== 0) failed.push({ file, status: res.status, error: res.error?.message })
}

console.log('\n========== 汇总 ==========')
for (const f of files) {
  const bad = failed.find((x) => x.file === f)
  console.log(bad ? `✗ ${f}（exit ${bad.status ?? bad.error}）` : `✓ ${f}`)
}
if (failed.length > 0) {
  console.error(`\n${failed.length} 个测试文件失败`)
  process.exit(1)
}
console.log('\n全部后端测试通过')
