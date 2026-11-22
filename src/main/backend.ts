/**
 * 后端装配入口：把 repos / providers / scheduler / pipeline / dispatcher / reply 组装起来。
 * 该文件由 Lead 与 backend teammate 共同维护（契约见 services.ts）。
 */
import { EventEmitter } from 'node:events'
import type { Backend } from './services'
import type { MainEvent } from '@shared/types'

export interface BackendOptions {
  onEvent: (e: MainEvent) => void
}

export function createBackend(opts: BackendOptions): Backend {
  const bus = new EventEmitter()
  bus.on('event', (e: MainEvent) => opts.onEvent(e))
  const { createBackendImpl } = require('./backend-impl') as typeof import('./backend-impl')
  return createBackendImpl({ bus })
}
