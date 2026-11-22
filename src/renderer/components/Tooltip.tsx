/** 轻量 Tooltip：hover / 键盘聚焦时出现，内容走 title 文本 */
import type { JSX, ReactNode } from 'react'

export interface TooltipProps {
  label: ReactNode
  children: ReactNode
}

export function Tooltip({ label, children }: TooltipProps): JSX.Element {
  return (
    <span className="tip-wrap">
      {children}
      <span className="tip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  )
}
