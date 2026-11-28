/** 左侧导航 + 底部常驻运行卡 */
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
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
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagText, setDiagText] = useState('')

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

  const buildDiagnostics = (): string => {
    const lines = [
      `邮箱资料助手 · 诊断信息`,
      `时间：${new Date().toLocaleString('zh-CN')}`,
      `版本：v${version}`,
      `页面：${page}`,
      `监听：${dashboard?.listening ? '中' : '已暂停'}`,
      `概览数据：${dashboard ? '已加载' : '未加载'}${dashboardError ? `（错误：${dashboardError}）` : ''}`,
      `账户：${dashboard?.accounts.length ?? 0} 个；规则：${rulesCount} 条`,
      `下次检查：${dashboard?.checking ? '检查中' : '—'}`,
      '',
      `进行中的下载（${downloads.length}）：`
    ]
    if (downloads.length === 0) lines.push('  （无）')
    for (const d of downloads.slice(0, 8)) {
      const age = Math.round((Date.now() - d.updatedAt) / 1000)
      lines.push(
        `  - ${d.filename} | ${d.percent != null ? d.percent + '%' : '进度未知'} | ${(d.received / 1048576).toFixed(1)}MB${d.total > 0 ? '/' + (d.total / 1048576).toFixed(1) + 'MB' : ''} | ${age} 秒前更新 | 阶段：${d.message ?? '下载中'} | 状态：${d.state}`
      )
    }
    return lines.join('\n')
  }

  const showDiagnostics = (): void => {
    setDiagText(buildDiagnostics())
    setDiagOpen(true)
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

  const { page, navigate, dashboard, dashboardError, rulesCount, demo, pushToast, downloads } = useApp()
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
        <button type="button" className="sb-update" onClick={showDiagnostics} title="显示概览/规则加载状态，便于排查空白页">
          诊断
        </button>
      </div>
      <Modal
        open={diagOpen}
        onClose={() => setDiagOpen(false)}
        title="诊断信息"
        subtitle="点「复制到剪贴板」发给开发者，便于定位问题"
        icon="info"
        iconTone="info"
        width={620}
        footer={
          <>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(diagText)
                  .then(() => pushToast('success', '已复制到剪贴板', '可以直接粘贴发给开发者'))
                  .catch(() => pushToast('warn', '复制失败', '请手动选中文字复制'))
              }}
            >
              复制到剪贴板
            </Button>
            <Button size="sm" variant="primary" onClick={() => setDiagOpen(false)}>
              关闭
            </Button>
          </>
        }
      >
        <pre className="diag-pre">{diagText}</pre>
      </Modal>

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
