/** 页面头：英文小标签 + 宋体标题 + 副标题 + 监听状态 / 时间 / 操作按钮 */
import type { JSX, ReactNode } from 'react'
import { cls, fmtCountdown, fmtDateTime, secondsUntil } from '../lib/format'
import { useApp } from '../state/app-state'
import { useNow } from '../hooks/useNow'

export interface PageHeaderProps {
  eyebrow: string
  eyebrowCn: string
  title: string
  sub?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ eyebrow, eyebrowCn, title, sub, actions }: PageHeaderProps): JSX.Element {
  const { dashboard } = useApp()
  const now = useNow()
  const listening = dashboard?.listening ?? false
  const next = secondsUntil(dashboard?.nextCheckAt, now)

  return (
    <header className="page-head">
      <div className="ph-lead">
        <div className="eyebrow">
          {eyebrow} <span className="cn">/ {eyebrowCn}</span>
        </div>
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      <div className="ph-actions">
        <span className={cls('listen-pill', listening && 'is-live')}>
          <span className={cls('dot', listening ? 'dot-live' : 'dot-idle')} aria-hidden="true" />
          {listening ? '监听中' : '已暂停'}
          {listening && next != null ? (
            <span className="kv">{next <= 0 ? '· 即将检查' : `· 下次检查 ${fmtCountdown(next)}`}</span>
          ) : null}
        </span>
        <span className="ph-time">{fmtDateTime(now)}</span>
        {actions}
      </div>
    </header>
  )
}
