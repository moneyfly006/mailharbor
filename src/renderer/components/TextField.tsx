/** 表单控件：Field / TextField / PasswordField / TextArea / Select */
import type { InputHTMLAttributes, JSX, ReactNode } from 'react'
import { useState } from 'react'
import { cls } from '../lib/format'
import { Icon, type IconName } from './Icon'

export interface FieldProps {
  label?: ReactNode
  required?: boolean
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  className?: string
  children: ReactNode
}

export function Field({ label, required, hint, error, htmlFor, className, children }: FieldProps): JSX.Element {
  return (
    <div className={cls('field', className)}>
      {label != null ? (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="req">*</span> : null}
        </label>
      ) : null}
      {children}
      {error != null ? (
        <span className="hint bad" role="alert">
          {error}
        </span>
      ) : hint != null ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  )
}

interface BaseInputProps {
  id?: string
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  error?: boolean
  icon?: IconName
  suffix?: ReactNode
  autoFocus?: boolean
  name?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode']
  onFocus?: () => void
  onBlur?: () => void
  onKeyDown?: InputHTMLAttributes<HTMLInputElement>['onKeyDown']
  ariaLabel?: string
  className?: string
  inputRef?: (el: HTMLInputElement | null) => void
}

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  mono = false,
  disabled = false,
  error = false,
  icon,
  suffix,
  autoFocus,
  name,
  maxLength,
  inputMode,
  onFocus,
  onBlur,
  onKeyDown,
  ariaLabel,
  className,
  inputRef
}: BaseInputProps): JSX.Element {
  return (
    <div
      className={cls(
        'input',
        mono && 'mono-input',
        error && 'is-error',
        disabled && 'is-disabled',
        className
      )}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <input
        id={id}
        ref={inputRef}
        className="input-el"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        name={name}
        maxLength={maxLength}
        inputMode={inputMode}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        onChange={(e) => onChange?.(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      {suffix}
    </div>
  )
}

interface PasswordFieldProps extends Omit<BaseInputProps, 'mono' | 'type'> {
  toggleLabel?: string
}

export function PasswordField({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  error = false,
  autoFocus,
  name,
  maxLength,
  onFocus,
  onBlur,
  ariaLabel,
  className,
  suffix
}: PasswordFieldProps): JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div
      className={cls('input', error && 'is-error', disabled && 'is-disabled', className)}
    >
      <Icon name="lock" size={13} />
      <input
        id={id}
        className="input-el"
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        name={name}
        maxLength={maxLength}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        onChange={(e) => onChange?.(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        spellCheck={false}
        autoComplete="new-password"
      />
      {suffix}
      <button
        type="button"
        className="suffix-btn"
        aria-label={visible ? '隐藏密码' : '显示密码'}
        title={visible ? '隐藏密码' : '显示密码'}
        onClick={() => setVisible((v) => !v)}
      >
        <Icon name={visible ? 'eyeOff' : 'eye'} size={13} />
      </button>
    </div>
  )
}

interface TextAreaProps {
  id?: string
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  error?: boolean
  rows?: number
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  ariaLabel?: string
  className?: string
  inputRef?: (el: HTMLTextAreaElement | null) => void
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  error = false,
  rows = 6,
  autoFocus,
  onFocus,
  onBlur,
  ariaLabel,
  className,
  inputRef
}: TextAreaProps): JSX.Element {
  return (
    <div className={cls('input', error && 'is-error', disabled && 'is-disabled', className)}>
      <textarea
        id={id}
        ref={inputRef}
        className="input-el"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-invalid={error || undefined}
        onChange={(e) => onChange?.(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        spellCheck={false}
      />
    </div>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  id?: string
  value: string
  onChange?: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

export function Select({ id, value, onChange, options, disabled, ariaLabel, className }: SelectProps): JSX.Element {
  return (
    <select
      id={id}
      className={cls('select', className)}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
