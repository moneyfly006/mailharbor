/**
 * 下载控制（暂停 / 继续 / 取消）：按消息 id 维护一个轻量状态。
 * HTTP 大文件下载（Google Drive / QQ 中转站）在分块循环里轮询这里的状态。
 */
export interface DownloadControlState {
  paused: boolean
  cancelled: boolean
}

const states = new Map<number, DownloadControlState>()

function ensure(messageId: number): DownloadControlState {
  let s = states.get(messageId)
  if (!s) {
    s = { paused: false, cancelled: false }
    states.set(messageId, s)
  }
  return s
}

export const downloadControl = {
  /** 开始一次新的下载：清空旧状态 */
  begin(messageId: number): void {
    states.set(messageId, { paused: false, cancelled: false })
  },
  pause(messageId: number): void {
    ensure(messageId).paused = true
  },
  resume(messageId: number): void {
    ensure(messageId).paused = false
  },
  cancel(messageId: number): void {
    const s = ensure(messageId)
    s.cancelled = true
    s.paused = false
  },
  clear(messageId: number): void {
    states.delete(messageId)
  },
  isPaused(messageId: number): boolean {
    return states.get(messageId)?.paused === true
  },
  isCancelled(messageId: number): boolean {
    return states.get(messageId)?.cancelled === true
  },
  state(messageId: number): DownloadControlState {
    return states.get(messageId) ?? { paused: false, cancelled: false }
  }
}
