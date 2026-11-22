import { mkdirSync } from 'node:fs'
import * as repos from './repos'
import { getSetting, setSetting } from './db'
import { defaultSeedRules, type SeedRule } from './seed-rules'

export type { SeedRule }
export { defaultPodRoots, defaultSeedRules } from './seed-rules'

const SEED_FLAG = 'rulesSeeded'

/**
 * 只在"一条规则都没有"且从未播种过时执行；返回新建的规则数。
 * 不会覆盖用户已修改的规则。
 */
export function seedDefaultRulesIfEmpty(): number {
  try {
    if (getSetting<boolean>(SEED_FLAG)) return 0
    const existing = repos.listRules()
    if (existing.length > 0) {
      setSetting(SEED_FLAG, true)
      return 0
    }
    let created = 0
    let priority = 10
    for (const seed of defaultSeedRules()) {
      // 目录能建就建，建不了也不阻塞（用户之后可改路径）
      for (const p of seed.paths) {
        try {
          mkdirSync(p, { recursive: true })
        } catch {
          /* 盘符不存在等情况：保留规则，界面上会显示"路径不可用" */
        }
      }
      repos.createRule({
        keyword: seed.keyword,
        enabled: true,
        scope: 'subject',
        mode: 'exact',
        priority,
        fileTypes: ['zip', 'tif', 'tiff', 'jpg', 'jpeg', 'png', 'pdf'],
        autoReply: true,
        targets: seed.paths.map((path) => ({ path, required: true }))
      })
      priority += 10
      created++
    }
    setSetting(SEED_FLAG, true)
    return created
  } catch {
    return 0
  }
}
