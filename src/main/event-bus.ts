/**
 * 主进程内部事件总线：业务服务 →（IPC 广播）→ 渲染层。
 * ipc.ts 监听 bus 的 'event'，把 MainEvent 原样转发到窗口 webContents。
 * 独立成模块是为了让业务服务不依赖 electron（可直接在 node 下单测）。
 */
import { EventEmitter } from 'node:events'
import type { MainEvent } from '@shared/types'

/** 全局默认总线（非 electron 环境也可用；backend 装配时会用注入的 bus） */
export const bus = new EventEmitter()

/** 发一条 MainEvent（渲染层可订阅的全部事件，见 shared/types.ts） */
export function emitMainEvent(event: MainEvent): void {
  bus.emit('event', event)
}

/** 订阅 MainEvent；返回取消订阅函数 */
export function onMainEvent(cb: (e: MainEvent) => void): () => void {
  const listener = (e: MainEvent): void => cb(e)
  bus.on('event', listener)
  return () => bus.off('event', listener)
}

export function createEventBus(): EventEmitter {
  return new EventEmitter()
}

export type Emit = (e: MainEvent) => void

/** 包装成安全 emit：监听器抛错不影响业务流程 */
export function safeEmit(emitter: EventEmitter): Emit {
  return (e: MainEvent) => {
    try {
      emitter.emit('event', e)
    } catch {
      /* 渲染层未就绪不影响主流程 */
    }
  }
}
