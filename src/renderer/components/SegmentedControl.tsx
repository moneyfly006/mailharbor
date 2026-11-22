/** 分段控件（匹配范围 / 匹配方式 / 语言 / 记录状态筛选） */
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
  size?: 'sm' | 'md'
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <div className={cls('seg', className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          title={o.title}
          className={cls('seg-item', o.value === value && 'is-active')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
