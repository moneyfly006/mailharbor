/** 按钮组件：primary / ink / secondary / ghost / danger × sm / md / lg */
import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'
import { cls } from '../lib/format'
import { Icon, type IconName } from './Icon'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'primary' | 'ink' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  loading?: boolean
  children?: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  ink: 'btn-ink',
  secondary: '',
  ghost: 'btn-ghost',
  danger: 'btn-danger'
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg'
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 16 }

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={cls('btn', VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      disabled={disabled || loading}
    >
      {loading ? <span className="spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: IconName
  label: string
  tone?: 'default' | 'danger' | 'ok'
  size?: number
  tip?: string
}

export function IconButton({
  icon,
  label,
  tone = 'default',
  size = 15,
  tip,
  className,
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  const button = (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cls('icon-btn', tone !== 'default' ? tone : undefined, className)}
    >
      <Icon name={icon} size={size} />
    </button>
  )
  return tip ? (
    <Tooltip label={tip}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
