/** Toast：由 IPC 事件 toast 与本地操作共同驱动，右上角 4 秒自动消失 */
import type { JSX } from 'react'
import { cls, fmtTime } from '../lib/format'
import { Icon } from './Icon'

export type ToastLevel = 'success' | 'warn' | 'error'

export interface ToastItem {
  id: number
  level: ToastLevel
  title: string
  body?: string
  at: number
}

const ICON = {
  success: 'check',
  warn: 'alert',
  error: 'alert'
} as const

export function ToastCard({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }): JSX.Element {
  return (
    <div className={cls('toast', item.level === 'error' && 'is-bad', item.level === 'warn' && 'is-warn')} role="status">
      <span className="t-ico">
        <Icon name={ICON[item.level]} size={15} />
      </span>
      <div className="t-body">
        <div className="t-title">{item.title}</div>
        {item.body ? <div className="t-desc">{item.body}</div> : null}
      </div>
      <span className="t-time">{fmtTime(item.at)}</span>
      <button type="button" className="t-x" aria-label="关闭提示" onClick={() => onClose(item.id)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

export function ToastViewport({
  items,
  onClose
}: {
  items: ToastItem[]
  onClose: (id: number) => void
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <ToastCard key={item.id} item={item} onClose={onClose} />
      ))}
    </div>
  )
}
