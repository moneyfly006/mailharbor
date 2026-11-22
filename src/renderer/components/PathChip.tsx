import type { JSX } from 'react'
/** 多路径结果 chip：盘符 + 状态图标，失败态可点击看原因 / 重试 */
import type { DeliveryState } from '@shared/types'
import { cls, driveOf } from '../lib/format'
import { deliveryMeta } from '../lib/status'
import { Icon } from './Icon'

export interface PathChipProps {
  state: DeliveryState
  path?: string
  drive?: string
  title?: string
  dense?: boolean
  onClick?: () => void
  ariaLabel?: string
}

export function PathChip({
  state,
  path,
  drive,
  title,
  dense = false,
  onClick,
  ariaLabel
}: PathChipProps): JSX.Element {
  const meta = deliveryMeta(state)
  const letter = drive ?? driveOf(path)
  const tip = title ?? `${path ?? letter} · ${meta.label}`
  const iconSize = dense ? 9 : 10
  const content = (
    <>
      <b>{letter}</b>
      {meta.icon ? <Icon name={meta.icon} size={iconSize} strokeWidth={2.2} /> : <span style={{ fontSize: 9 }}>–</span>}
    </>
  )
  const className = cls('pchip', `pchip-${meta.chip}`, onClick && 'is-clickable')

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        title={tip}
        aria-label={ariaLabel ?? tip}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }
  return (
    <span className={className} title={tip}>
      {content}
    </span>
  )
}
