/**
 * 打包后瘦身：
 *  - 只保留当前平台需要的 7zip-bin 可执行文件（win/mac/linux 各 ~3-5MB）
 *  - 删除 Electron 里未使用的语言包之外的东西（electronLanguages 已在 electron-builder.yml 配置）
 */
const { rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName // darwin | win32 | linux
  const appOutDir = context.appOutDir
  const unpacked = [
    join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '7zip-bin'),
    join(appOutDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '7zip-bin')
  ].find((p) => existsSync(p))
  if (unpacked) {
    const keep = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
    for (const dir of ['win', 'mac', 'linux']) {
      if (dir === keep) continue
      rmSync(join(unpacked, dir), { recursive: true, force: true })
    }
    console.log(`[after-pack] 已裁剪 7zip-bin，仅保留 ${keep}`)
  }
}
