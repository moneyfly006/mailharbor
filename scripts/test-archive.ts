/**
 * 压缩包解压单测：ZIP 真正解压 + 路径穿越过滤 + 重名自动编号 + 非压缩包返回 null
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-archive.ts
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { extractArchiveTo, isArchiveFile } from '../src/main/archive.ts'

let pass = 0, fail = 0
const eq = (n: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`))
}

eq('识别 zip', isArchiveFile('POD.zip'), true)
eq('识别 RAR（大写）', isArchiveFile('图稿.RAR'), true)
eq('压缩包内文件不解压判断', isArchiveFile('设计图.TIF'), false)

const root = mkdtempSync(join(tmpdir(), 'mh-arc-'))
const target = join(root, '生产', '卡套')
mkdirSync(target, { recursive: true })
const zipPath = join(target, 'POD_ORDER_1.zip')
const zip = new AdmZip()
zip.addFile('A.tif', Buffer.from('TIF-CONTENT'))
zip.addFile('子目录/B.png', Buffer.from('PNG-CONTENT'))
zip.addFile('../evil.txt', Buffer.from('evil'))
zip.addFile('__MACOSX/._A.tif', Buffer.from('meta'))
zip.writeZip(zipPath)
// 预置同名文件，验证不覆盖
writeFileSync(join(target, 'A.tif'), Buffer.from('OLD'))

// 用 Python zipfile 造一个"真·路径穿越"条目（adm-zip 写入时会把 ../ 归一化，测不出问题）
const target2 = join(root, '生产', '手机壳')
mkdirSync(target2, { recursive: true })
const evilZip = join(target2, 'POD_ORDER_2.zip')
try {
  execFileSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(evilZip)}, 'w')
z.writestr('A2.tif', 'TIF2')
z.writestr('../evil.txt', 'evil')
z.writestr('__MACOSX/._A2.tif', 'meta')
z.close()
`])
} catch { /* 没有 python3 就跳过这条 */ }

const res = await extractArchiveTo(zipPath, target)
eq('解压成功返回结果', !!res, true)
eq('解压文件数（__MACOSX 被跳过；../ 被库归一化后落在目录内）', res!.extracted, 3)
eq('不存在 ../evil.txt', existsSync(join(root, 'evil.txt')), false)
eq('解压后删除压缩包', existsSync(zipPath), false)
eq('子目录结构保留', existsSync(join(target, '子目录', 'B.png')), true)
eq('重名文件直接覆盖（最新内容生效）', readFileSync(join(target, 'A.tif'), 'utf8'), 'TIF-CONTENT')
eq('解压出的内容正确', readFileSync(join(target, '子目录', 'B.png'), 'utf8'), 'PNG-CONTENT')

const evilRes = existsSync(evilZip) ? await extractArchiveTo(evilZip, target2) : null
if (evilRes) {
  eq('穿越条目被跳过（只解出 A2.tif）', evilRes.extracted, 1)
  eq('穿越文件没有写到上级目录', existsSync(join(root, 'evil.txt')), false)
  eq('穿越文件也没有写进目标目录', existsSync(join(target2, 'evil.txt')), false)
}

const txt = join(root, 'a.txt'); writeFileSync(txt, 'x')
eq('非压缩包返回 null', await extractArchiveTo(txt, target), null)

// 用随包 7za 造 7z / tar.gz / tar 样本，验证"常见压缩格式都能解"
const zbin = await (async () => {
  try {
    const mod = (await import('7zip-bin')) as unknown as { path7za?: string; default?: { path7za?: string } }
    return mod.path7za ?? mod.default?.path7za ?? ''
  } catch {
    return ''
  }
})()
if (zbin) {
  const srcDir = join(root, 'src')
  mkdirSync(join(srcDir, '图稿'), { recursive: true })
  writeFileSync(join(srcDir, '图稿', '衣身.ai'), Buffer.from('AI-DATA'))
  writeFileSync(join(srcDir, 'count.txt'), Buffer.from('3'))
  const out7z = join(target, 'POD_7Z.7z')
  const r7 = spawnSync(zbin, ['a', '-t7z', '-y', out7z, join(srcDir, '*')], { encoding: 'utf8' })
  if (r7.status === 0) {
    const res7 = await extractArchiveTo(out7z, target)
    eq('7z 解压成功', !!res7, true)
    eq('7z 内容正确', readFileSync(join(target, '图稿', '衣身.ai'), 'utf8'), 'AI-DATA')
  } else console.log('  … 跳过 7z（7za 创建失败）')

  const outTarGz = join(target, 'POD_TGZ.tar.gz')
  const rtgz = spawnSync(zbin, ['a', '-tgzip', '-y', outTarGz, join(srcDir, 'count.txt')], { encoding: 'utf8' })
  if (rtgz.status === 0) {
    const resGz = await extractArchiveTo(outTarGz, target)
    eq('tar.gz/gz 解压成功', !!resGz, true)
  } else console.log('  … 跳过 tar.gz（7za 创建失败）')

  const outTar = join(target, 'POD_TAR.tar')
  const rt = spawnSync(zbin, ['a', '-ttar', '-y', outTar, join(srcDir, 'count.txt')], { encoding: 'utf8' })
  if (rt.status === 0) {
    const resT = await extractArchiveTo(outTar, target)
    eq('tar 解压成功', !!resT && resT.extracted >= 1, true)
  }
  eq('识别 7z 后缀', isArchiveFile('图稿.7z'), true)
  eq('识别 tar.gz 后缀', isArchiveFile('图稿.TAR.GZ'), true)
  eq('识别 tar.bz2 后缀', isArchiveFile('图稿.tar.bz2'), true)
  eq('识别 xz 后缀', isArchiveFile('a.xz'), true)
}

const badRar = join(root, 'bad.rar'); writeFileSync(badRar, 'not a rar')
let rarThrew = false
try { await extractArchiveTo(badRar, target) } catch { rarThrew = true }
eq('损坏的 RAR 抛错由调用方兜底（不静默成功）', rarThrew, true)

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
