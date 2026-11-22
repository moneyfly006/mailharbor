/** 空状态（含分拣托盘线稿） */
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'

export function TrayArt({ width = 104, height = 72 }: { width?: number; height?: number }): JSX.Element {
  return (
    <svg width={width} height={height} viewBox="0 0 104 72" fill="none" aria-hidden="true" className="art-tray">
      <rect x="10.5" y="30.5" width="83" height="30" rx="3" stroke="currentColor" opacity=".8" />
      <path d="M10.5 44.5h18l4 6h39l4-6h18" stroke="currentColor" opacity=".55" />
      <rect x="30.5" y="10.5" width="40" height="26" rx="2" stroke="currentColor" opacity=".8" />
      <path d="M31 12l19.5 13L70 12" stroke="currentColor" opacity=".55" />
      <path d="M10.5 67.5h83" stroke="currentColor" opacity=".3" strokeDasharray="2 4" />
      <circle cx="86" cy="18" r="4.5" stroke="#C8422D" opacity=".85" />
      <path d="M86 15.5v3.4M86 20.6v.4" stroke="#C8422D" opacity=".85" strokeLinecap="round" />
    </svg>
  )
}

export interface EmptyStateProps {
  variant?: 'full' | 'compact'
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
  art?: boolean
  className?: string
}

export function EmptyState({
  variant = 'full',
  title,
  desc,
  actions,
  art = true,
  className
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cls('empty', variant === 'compact' && 'compact', className)}>
      {art ? (
        <div className="art">
          <TrayArt width={variant === 'compact' ? 72 : 104} height={variant === 'compact' ? 50 : 72} />
        </div>
      ) : null}
      <h3>{title}</h3>
      {desc ? <p>{desc}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  )
}
