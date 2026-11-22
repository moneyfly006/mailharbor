/** 卡片容器（标题 / 备注 / 页脚），统一 1px 边 + 纸片阴影 */
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'

export interface CardProps {
  title?: ReactNode
  note?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  tight?: boolean
}

export function Card({
  title,
  note,
  actions,
  footer,
  children,
  className,
  bodyClassName,
  tight = false
}: CardProps): JSX.Element {
  return (
    <section className={cls('card', className)}>
      {title != null || note != null || actions != null ? (
        <div className="card-hd">
          {title != null ? <h2 className="card-title">{title}</h2> : null}
          {actions}
          {note != null ? <span className="card-note">{note}</span> : null}
        </div>
      ) : null}
      {children != null ? <div className={cls('card-bd', tight && 'tight', bodyClassName)}>{children}</div> : null}
      {footer != null ? <div className="card-ft">{footer}</div> : null}
    </section>
  )
}
