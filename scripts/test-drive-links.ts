/** Drive 链接识别单测 */
import { extractDriveFileIds } from '../src/main/gmail/drive.ts'

let pass = 0, fail = 0
const eq = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}\n    got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`))
}

const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
eq('file/d 链接', extractDriveFileIds([`https://drive.google.com/file/d/${id}/view?usp=sharing`]), [id])
eq('open?id 链接', extractDriveFileIds([`https://drive.google.com/open?id=${id}`]), [id])
eq('docs 链接', extractDriveFileIds([`https://docs.google.com/document/d/${id}/edit`]), [id])
eq('邮件里的多个链接（含非 Drive）', extractDriveFileIds([
  'https://res.mail.qq.com/icon.png',
  `https://drive.google.com/file/d/${id}/view`,
  'https://www.google.com/url?q=https://example.com'
]), [id])
eq('普通链接不误判', extractDriveFileIds(['https://example.com/file/d/abc']), [])
eq('空数组', extractDriveFileIds([]), [])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
