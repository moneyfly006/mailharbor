/**
 * 单测加载钩子：让 Node 的 --experimental-strip-types 能解析 TS 源码里的无扩展名相对导入
 * （src/main 下的 import './xxx' 由 electron-vite/tsc 解析；纯 node 跑测试时补 .ts / /index.ts）。
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) && context.parentURL) {
        const base = new URL(specifier, context.parentURL)
        for (const ext of ['.ts', '.tsx', '/index.ts']) {
          const candidate = new URL(base.href + ext)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw err
    }
  }
})
