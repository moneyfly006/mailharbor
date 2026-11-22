/** 加载失败提示（不打断操作，可重试） */
import type { JSX } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'

export function ErrorState({
  title = '加载失败',
  message,
  onRetry
}: {
  title?: string
  message: string
  onRetry?: () => void
}): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <span className="e-ico">
        <Icon name="alert" size={16} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="e-title">{title}</div>
        <div className="e-desc">{message}</div>
      </div>
      {onRetry ? (
        <div className="e-actions">
          <Button size="sm" icon="refresh" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : null}
    </div>
  )
}
