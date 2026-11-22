/** 开关：role="switch"，圆形唯一允许的圆形控件之一 */
import type { JSX, ReactNode } from 'react'
import { cls } from '../lib/format'

export interface SwitchProps {
  checked: boolean
  onChange?: (checked: boolean) => void
  size?: 'sm' | 'md' | 'lg'
  accent?: boolean
  disabled?: boolean
  label?: ReactNode
  ariaLabel?: string
  id?: string
  className?: string
}

export function Switch({
  checked,
  onChange,
  size = 'md',
  accent = false,
  disabled = false,
  label,
  ariaLabel,
  id,
  className
}: SwitchProps): JSX.Element {
  const button = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      disabled={disabled}
      className={cls('sw', size !== 'md' ? size : undefined, checked && 'on', accent && 'accent', className)}
      onClick={() => {
        if (!disabled) onChange?.(!checked)
      }}
    />
  )

  if (label == null) return button

  return (
    <label className={cls('sw-wrap', disabled && 'is-disabled')}>
      {button}
      <span>{label}</span>
    </label>
  )
}
