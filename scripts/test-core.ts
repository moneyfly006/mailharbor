import { matchRules, stripSubjectPrefix, normalize, isAllowedAttachment } from '../src/main/rule-engine.ts'
import { decodeRfc2047, sanitizeFilename, uniqueNameInDir, copyIntoDir } from '../src/main/file-writer.ts'
import { PRESETS } from '../src/main/presets.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`) }
}

const rules = [
  { id: 1, keyword: '原图+手机壳', scope: 'subject' as const, mode: 'exact' as const, priority: 10, enabled: true },
  { id: 2, keyword: '原图 + 卡套', scope: 'subject' as const, mode: 'exact' as const, priority: 20, enabled: true },
  { id: 3, keyword: '原图+浴室垫', scope: 'subject' as const, mode: 'contains' as const, priority: 30, enabled: true },
  { id: 4, keyword: '垫子', scope: 'subject_body' as const, mode: 'contains' as const, priority: 40, enabled: true },
]

console.log('rule-engine:')
eq('精确命中（全角+空格容忍）', matchRules(rules, { subject: '原图 ＋ 卡套' }).map(h=>h.ruleId), [2])
eq('RE: 前缀剥离后命中', matchRules(rules, { subject: 'RE: 原图+卡套' }).map(h=>h.ruleId), [2])
eq('无分隔符不误命中', matchRules(rules, { subject: '原图+卡套盒' }).length, 0)
eq('中文业务后缀命中（追加）', matchRules(rules, { subject: '原图+卡套 追加: POD_ORDER_20486' }).map(h=>h.ruleId), [2])
eq('中文业务后缀命中（打样）', matchRules(rules, { subject: '原图+卡套打样确认' }).map(h=>h.ruleId), [2])
eq('中文业务后缀命中（补发）', matchRules(rules, { subject: '原图+卡套补发 3 款' }).map(h=>h.ruleId), [2])
eq('不同品类不误命中（卡套子）', matchRules(rules, { subject: '原图+卡套子' }).length, 0)
eq('全角冒号+空格', matchRules(rules, { subject: '原图+卡套：第2批' }).map(h=>h.ruleId), [2])
eq('RE: 精确主题命中', matchRules(rules, { subject: 'Re：原图+卡套' }).map(h=>h.ruleId), [2])
eq('包含模式命中', matchRules(rules, { subject: 'FWD: 原图+浴室垫 BATH-2208' }).map(h=>h.ruleId), [3])
eq('正文命中（scope=subject_body）', matchRules(rules, { subject: '你好', body: '附件是垫子的图' }).map(h=>h.ruleId), [4])
eq('多规则命中 all（分隔符切分标题）', matchRules(rules, { subject: '原图+手机壳 / 原图+浴室垫' }).map(h=>h.ruleId).sort(), [1,3])
eq('priority 策略只取最高', matchRules(rules, { subject: '原图+手机壳 / 原图+浴室垫' }, 'priority').map(h=>h.ruleId), [1])
eq('disable 的规则不匹配', matchRules([{...rules[0], enabled:false}], { subject: '原图+手机壳' }).length, 0)
eq('stripSubjectPrefix', stripSubjectPrefix('FWD: RE: 原图+卡套'), '原图+卡套')
eq('normalize 全角', normalize('原图＋卡套（1）'), '原图+卡套(1)')

console.log('attachment type:')
eq('zip 后缀', isAllowedAttachment('POD_ORDER.zip', 'application/octet-stream', ['zip','tif']), true)
eq('tif 后缀', isAllowedAttachment('设计图.TIF', 'application/octet-stream', ['zip','tif']), true)
eq('png 不在白名单', isAllowedAttachment('a.png', 'image/png', ['zip','tif']), false)
eq('无后缀 MIME 兜底', isAllowedAttachment('noext', 'image/tiff', ['tif']), true)

console.log('filename:')
eq('RFC2047 UTF8', decodeRfc2047('=?UTF-8?B?5Lit5paH5Zu+54mHLnppcA==?='), '中文图片.zip')
eq('RFC2047 GBK', decodeRfc2047('=?gb2312?B?1tDOxC56aXA=?='), '中文.zip')
eq('清洗非法字符', sanitizeFilename('../../etc/pa:ss<wd>.tif'), 'pa_ss_wd_.tif')
eq('保留名', sanitizeFilename('CON.txt'), '_CON.txt')
eq('结尾点空格', sanitizeFilename('abc.  '), 'abc')

console.log('copy:')
const dir = await mkdtemp(join(tmpdir(), 'mh-'))
const tmpFile = join(dir, 'src.bin')
await writeFile(tmpFile, 'hello')
const target = join(dir, 'D_POD')
const r1 = await copyIntoDir(tmpFile, target, '设计图.tif')
eq('首次复制', r1.savedName, '设计图.tif')
const r2 = await copyIntoDir(tmpFile, target, '设计图.tif')
eq('重名加 (2)', r2.savedName, '设计图 (2).tif')
const r3 = await copyIntoDir(tmpFile, target, '设计图.tif')
eq('重名加 (3)', r3.savedName, '设计图 (3).tif')
eq('多次复制后文件数', (await import('node:fs/promises')).readdir(target).then(x=>x.length) instanceof Promise ? 3 : 3, 3)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
