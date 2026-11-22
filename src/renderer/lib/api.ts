/** 渲染层访问数据层的唯一入口：优先真实 preload API，缺失时降级为内存演示 API。 */
import type { Api } from '@shared/ipc'
import { createDemoApi } from './demo-api'

type WindowWithApi = Window & { mailharbor?: Api }

let cached: Api | null = null

export function isDemoMode(): boolean {
  return typeof window !== 'undefined' && !(window as WindowWithApi).mailharbor
}

export function getApi(): Api {
  if (cached) return cached
  const real = typeof window !== 'undefined' ? (window as WindowWithApi).mailharbor : undefined
  cached = real ?? createDemoApi()
  return cached
}
