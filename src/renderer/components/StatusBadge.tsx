/** 状态徽章：颜色只从 tokens 映射，页面不要自己写色值 */
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'
import type { BadgeMeta, BadgeTone } from '../lib/status'
import { Icon, type IconName } from './Icon'

export interface StatusBadgeProps {
  tone?: BadgeTone
  meta?: BadgeMeta
  icon?: IconName
  spinner?: boolean
  dot?: boolean
  title?: string
  className?: string
  children?: ReactNode
}

export function StatusBadge({
  tone,
  meta,
  icon,
  spinner,
  dot,
  title,
  className,
  children
}: StatusBadgeProps): JSX.Element {
  const resolvedTone = meta?.tone ?? tone ?? 'neutral'
  const resolvedIcon = meta?.icon ?? icon
  const resolvedSpinner = meta?.spinner ?? spinner
  const resolvedDot = meta?.dot ?? dot
  const content = children ?? meta?.label
  return (
    <span className={cls('badge', `badge-${resolvedTone}`, className)} title={title}>
      {resolvedSpinner ? <span className="spin" aria-hidden="true" /> : null}
      {resolvedIcon && !resolvedSpinner ? <Icon name={resolvedIcon} size={11} /> : null}
      {resolvedDot && !resolvedSpinner ? <span className="badge-dot" aria-hidden="true" /> : null}
      {content}
    </span>
  )
}
