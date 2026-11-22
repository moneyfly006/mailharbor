/**
 * 默认业务规则定义（纯函数，不依赖 electron，便于单测）。
 * 客户业务：邮件标题 =「原图+品类名」。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SeedRule {
  keyword: string
  paths: string[]
}

/** Windows 用 D:/E: 盘；macOS/Linux 用用户目录下的 POD 文件夹 */
export function defaultPodRoots(platform: NodeJS.Platform = process.platform): { prod: string; backup: string } {
  if (platform === 'win32') {
    return { prod: 'D:\\POD\\生产', backup: 'E:\\POD\\备份' }
  }
  const home = homedir()
  return { prod: join(home, 'POD', '生产'), backup: join(home, 'POD', '备份') }
}

export function defaultSeedRules(platform: NodeJS.Platform = process.platform): SeedRule[] {
  const { prod, backup } = defaultPodRoots(platform)
  return [
    { keyword: '原图+手机壳', paths: [join(prod, '手机壳')] },
    { keyword: '原图+卡套', paths: [join(prod, '卡套'), join(backup, '卡套')] },
    { keyword: '原图+浴室垫', paths: [join(prod, '浴室垫')] }
  ]
}
