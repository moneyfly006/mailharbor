import type { JSX } from 'react'
/** 模态框 / 危险确认对话框（Esc 关闭、焦点环、默认焦点在「取消」） */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cls } from '../lib/format'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  icon?: IconName
  iconTone?: 'danger' | 'warn' | 'info'
  children?: ReactNode
  footer?: ReactNode
  width?: number
  initialFocus?: 'cancel' | 'confirm' | 'first'
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  iconTone = 'danger',
  children,
  footer,
  width,
  initialFocus = 'first'
}: ModalProps): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !cardRef.current) return
      const nodes = Array.from(cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current
      if (!card) return
      const preferred =
        initialFocus === 'cancel'
          ? card.querySelector<HTMLElement>('[data-modal-cancel]')
          : initialFocus === 'confirm'
            ? card.querySelector<HTMLElement>('[data-modal-confirm]')
            : null
      ;(preferred ?? card.querySelector<HTMLElement>(FOCUSABLE) ?? card).focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      restoreRef.current?.focus?.()
    }
  }, [open, onClose, initialFocus])

  if (!open) return null

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '对话框'}
        style={width ? { width } : undefined}
        tabIndex={-1}
      >
        <div className="modal-hd">
          {icon ? (
            <span className={cls('m-ico', `tone-${iconTone}`)} style={{ color: `var(--color-${iconTone})`, marginTop: 2 }}>
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <div style={{ minWidth: 0 }}>
            <h3>{title}</h3>
            {subtitle ? <div className="m-sub">{subtitle}</div> : null}
          </div>
        </div>
        {children ? <div className="modal-bd">{children}</div> : null}
        {footer ? <div className="modal-ft">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  detail?: ReactNode
  confirmText?: string
  cancelText?: string
  extraText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
  onExtra?: () => void
}

export function ConfirmDialog({
  open,
  title,
  subtitle,
  detail,
  confirmText = '确认',
  cancelText = '取消',
  extraText,
  danger = true,
  onConfirm,
  onCancel,
  onExtra
}: ConfirmDialogProps): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      subtitle={subtitle}
      icon={danger ? 'alert' : 'info'}
      iconTone={danger ? 'danger' : 'info'}
      footer={
        <>
          <Button size="sm" onClick={onCancel} data-modal-cancel>
            {cancelText}
          </Button>
          {extraText && onExtra ? (
            <Button size="sm" variant="primary" onClick={onExtra}>
              {extraText}
            </Button>
          ) : null}
          <Button size="sm" variant={danger ? 'danger' : 'primary'} onClick={onConfirm} data-modal-confirm>
            {confirmText}
          </Button>
        </>
      }
      initialFocus="cancel"
    >
      {detail}
    </Modal>
  )
}
