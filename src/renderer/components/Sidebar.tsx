/** 左侧导航 + 底部常驻运行卡 */
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { cls, fmtCountdown, fmtDuration, secondsUntil } from '../lib/format'
import { useApp, type Page } from '../state/app-state'
import { useNow } from '../hooks/useNow'
import { BrandMark, Icon, type IconName } from './Icon'

const NAV: Array<{ page: Page; label: string; icon: IconName }> = [
  { page: 'dashboard', label: '概览', icon: 'grid' },
  { page: 'rules', label: '触发规则', icon: 'filter' },
  { page: 'accounts', label: '邮箱账户', icon: 'mail' },
  { page: 'autoreply', label: '自动回复', icon: 'reply' },
  { page: 'records', label: '下载记录', icon: 'list' }
]

export function Sidebar(): JSX.Element {
  const [version, setVersion] = useState('0.1.0')
  const [updateState, setUpdateState] = useState<import('@shared/types').UpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const info = await window.mailharbor?.appInfo?.()
        if (alive && info) setVersion(info.version)
        const st = await window.mailharbor?.update?.state?.()
        if (alive && st) setUpdateState(st)
      } catch {
        /* 演示模式 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const checkUpdate = async (): Promise<void> => {
    if (!window.mailharbor?.update) return
    setUpdateBusy(true)
    try {
      const st = await window.mailharbor.update.check()
      if (st) setUpdateState(st)
      if (st?.status === 'downloaded') await window.mailharbor.update.install()
    } finally {
      setUpdateBusy(false)
    }
  }

  const updateLabel =
    updateState?.status === 'downloaded'
      ? `重启更新 v${updateState.availableVersion ?? ''}`
      : updateState?.status === 'downloading'
        ? `下载中 ${updateState.progressPercent ?? 0}%`
        : updateState?.status === 'error'
          ? '检查更新失败'
          : updateState?.status === 'up-to-date'
            ? '已是最新'
            : '检查更新'

  const { page, navigate, dashboard, rulesCount, demo } = useApp()
  const now = useNow()
  const listening = dashboard?.listening ?? false
  const accounts = dashboard?.accounts ?? []
  const failedAccounts = accounts.filter((a) => a.status === 'auth_failed' || a.status === 'conn_failed').length
  const next = secondsUntil(dashboard?.nextCheckAt, now)
  const poll = dashboard?.pollIntervalSec ?? 30
  const checking = dashboard?.checking ?? false
  const lastCheck = dashboard?.lastCheckAt ?? null
  const elapsed =
    checking || lastCheck == null
      ? 0
      : Math.max(0, Math.min(100, Math.round(((now - lastCheck) / (poll * 1000)) * 100)))

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="sb-brand">
        <span className="mark">
          <BrandMark size={26} />
        </span>
        <div>
          <div className="brand-name">邮箱资料助手</div>
          <div className="brand-sub">客户邮件自动归档</div>
        </div>
      </div>

      <div className="sb-label">
        工作台 <em>Workspace</em>
      </div>
      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.page}
            type="button"
            className={cls('nav-item', page === item.page && 'is-active')}
            aria-current={page === item.page ? 'page' : undefined}
            onClick={() => navigate(item.page)}
          >
            <Icon name={item.icon} size={17} />
            <span>{item.label}</span>
            {item.page === 'rules' && rulesCount > 0 ? <span className="nav-count">{rulesCount}</span> : null}
            {item.page === 'accounts' && failedAccounts > 0 ? (
              <span className="nav-dot warn" title={`${failedAccounts} 个账户连接失败`} />
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sb-spacer" />

      <div className="run-card">
        <div className="run-head">
          <span className={cls('dot', listening ? 'dot-live' : 'dot-idle')} aria-hidden="true" />
          <span>{listening ? '监听中' : '已暂停'}</span>
          <span className="run-since mono">已运行 {dashboard ? fmtDuration(dashboard.uptimeMs) : '—'}</span>
        </div>
        <div className="run-rows">
          <div className="row">
            <span>轮询间隔</span>
            <b>{poll} 秒</b>
          </div>
          <div className="row">
            <span>下次检查</span>
            <b>{!listening ? '暂停中' : checking ? '检查中…' : fmtCountdown(next)}</b>
          </div>
        </div>
        <div className={cls('run-meter', (checking || !listening) && 'is-scanning')} aria-hidden="true">
          <i style={{ width: checking || !listening ? '100%' : `${elapsed}%` }} />
        </div>
      </div>
      <div className="sb-version">
        <span className="mono">v{version}</span>
        <button type="button" className="sb-update" onClick={() => void checkUpdate()}>
          {updateBusy ? '检查中…' : updateLabel}
        </button>
      </div>
      <div className="sb-hint">
        {listening ? '关闭窗口后仍在托盘运行 · 收到邮件会提示' : '暂停期间：已在队列中的任务仍会完成'}
        {demo ? (
          <>
            <br />
            演示数据 · 仅浏览器预览
          </>
        ) : null}
      </div>
    </aside>
  )
}
