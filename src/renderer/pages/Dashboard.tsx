import type { JSX } from 'react'
/** 概览：监听状态 + 今日工单条 + 三卡（运行 / 邮箱 / 目标盘）+ 最近收件 + 失败待重试 */
import { useState } from 'react'
import type { Account, DiskInfo, RecordRow, RulePathSummary } from '@shared/types'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { PathChip } from '../components/PathChip'
import { StatusBadge } from '../components/StatusBadge'
import { useNow } from '../hooks/useNow'
import { aggregateDeliveries, failedDeliveryItems, type FailedDeliveryItem } from '../lib/delivery'
import {
  cls, driveOf, errMsg, fmtBytesLoose, fmtCountdown, fmtDate, fmtDuration, fmtNumber, fmtTime,
  fmtTimeSec, pathBody, secondsUntil, usedPercent
} from '../lib/format'
import { accountStatusMeta, deliveryMeta, messageStatusMeta, providerLabel } from '../lib/status'
import { useApp } from '../state/app-state'
import '../styles/screens/dashboard.css'

const PROVIDER_TILE: Record<string, string> = {
  gmail: 'G',
  google_workspace: 'G',
  qq: 'Q',
  outlook: 'O',
  custom: '@'
}

function diskLabel(disk: DiskInfo): string {
  const body = pathBody(disk.path) || disk.path
  return body.replace(/^\\/, '')
}

function AccountRow({ account }: { account: Account }): JSX.Element {
  const { navigate } = useApp()
  const meta = accountStatusMeta(account.status)
  const failed = account.status === 'auth_failed' || account.status === 'conn_failed'
  const warning = failed || account.status === 'offline'
  return (
    <div className="mail-row">
      <span className={cls('mail-mark', warning && 'warn')}>
        <Icon name={warning ? 'alert' : 'mail'} size={warning ? 13 : 14} />
      </span>
      <div className="mail-id">
        <div className="mail-addr" title={account.email}>
          {account.email}
        </div>
        <div className="mail-meta">
          {account.displayName} · {providerLabel(account.preset)} · 今日 {fmtNumber(account.todayCount)} 封
        </div>
      </div>
      {failed ? (
        <Button size="sm" variant="danger" onClick={() => navigate('accounts')}>
          检查设置
        </Button>
      ) : account.status === 'pending_test' ? (
        <Button size="sm" onClick={() => navigate('accounts')}>
          去测试
        </Button>
      ) : (
        <StatusBadge meta={meta} />
      )}
    </div>
  )
}

function RecentRow({ row }: { row: RecordRow }): JSX.Element {
  const { pushToast } = useApp()
  const deliveries = aggregateDeliveries(row)
  return (
    <tr>
      <td className="mono" style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        {fmtTime(row.receivedAt)}
      </td>
      <td>
        <div className="cell-title ellipsis" title={row.subject}>
          {row.subject}
        </div>
        <div className="cell-sub ellipsis" title={row.fromAddr}>
          {row.fromAddr || '—'}
        </div>
      </td>
      <td>
        {row.matchedKeyword ? (
          <span className="kchip">{row.matchedKeyword}</span>
        ) : (
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>
            未命中
          </span>
        )}
      </td>
      <td>
        {deliveries.length > 0 ? (
          <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
            {deliveries.map((d) => (
              <PathChip
                key={d.key}
                state={d.state}
                path={d.targetPath}
                dense
                title={`${d.targetPath} · ${deliveryMeta(d.state).label}${d.error ? `\n${d.error}` : ''}`}
                onClick={
                  d.state === 'failed' || d.state === 'retry_wait'
                    ? () => pushToast('warn', `${d.drive}: 路径未完成`, d.error ?? `${d.targetPath} 等待重试`)
                    : undefined
                }
              />
            ))}
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-quaternary)' }}>
            —
          </span>
        )}
      </td>
      <td>
        <StatusBadge meta={messageStatusMeta(row.status)} />
      </td>
    </tr>
  )
}

function RetryItem({
  item,
  retrying,
  onRetry
}: {
  item: FailedDeliveryItem
  retrying: boolean
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="retry-item">
      <div className="ri-top">
        <span style={{ color: 'var(--color-danger)' }}>
          <Icon name="alert" size={13} />
        </span>
        <span className="ri-file" title={item.filename}>
          {item.filename}
        </span>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--color-danger-strong)' }}>
          {fmtBytesLoose(item.size ?? null)}
        </span>
      </div>
      <div className="ri-path" title={item.targetPath}>
        <Icon name="folder" size={12} />
        {item.targetPath}
      </div>
      <div className="ri-reason">
        {item.error ?? '写入失败'} · 已重试 {item.attempts} 次
      </div>
      <div className="ri-actions">
        <Button size="sm" variant="danger" icon="refresh" loading={retrying} onClick={onRetry}>
          重试这条路径
        </Button>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-quaternary)' }}>
          {item.nextRetryAt ? `${fmtTime(item.nextRetryAt)} 再试` : '等待手动重试'}
        </span>
      </div>
    </div>
  )
}

/** 概览「触发规则 · 存储路径」：一眼看清每个关键词落到哪几个文件夹，点路径直接打开 */
function RulePathsCard({
  rules,
  onOpen,
  onManage
}: {
  rules: RulePathSummary[]
  onOpen: (path: string) => void
  onManage: () => void
}): JSX.Element {
  const active = rules.filter((r) => r.enabled)
  const pathCount = active.reduce((n, r) => n + r.paths.length, 0)
  return (
    <section className="card rulepaths" aria-label="触发规则与存储路径">
      <div className="card-hd">
        <h2 className="card-title">触发规则 · 存储路径</h2>
        <span className="card-note">
          {active.length} 条规则 · {pathCount} 个路径
        </span>
        <button type="button" className="card-note link" style={{ marginLeft: 12 }} onClick={onManage}>
          管理规则 ›
        </button>
      </div>
      <div className="rp-body">
        {active.length === 0 ? (
          <div className="rp-empty">
            还没有启用任何规则。
            <button type="button" className="rp-empty-link" onClick={onManage}>
              去添加关键词与路径 ›
            </button>
          </div>
        ) : (
          active.map((r) => (
            <div className="rp-rule" key={r.ruleId}>
              <button
                type="button"
                className="rp-kw"
                title={`${r.keyword}（点击管理规则）`}
                onClick={onManage}
              >
                {r.keyword}
              </button>
              <span className="rp-arrow" aria-hidden="true">
                →
              </span>
              <div className="rp-paths">
                {r.paths.length === 0 ? (
                  <span className="rp-nopath">未设置路径</span>
                ) : (
                  r.paths.map((p) => (
                    <button
                      type="button"
                      key={p.path}
                      className="rp-path"
                      title={`点击在资源管理器中打开：${p.path}`}
                      onClick={() => onOpen(p.path)}
                    >
                      <Icon name="folder" size={12} />
                      <span className="rp-path-text">{p.path}</span>
                      {r.paths.length > 1 && p.required ? <em className="rp-must">必达</em> : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {pathCount > 0 ? <div className="rp-foot">点路径可直接在资源管理器中打开查看文件</div> : null}
    </section>
  )
}

export function Dashboard(): JSX.Element {
  const { dashboard, dashboardLoading, dashboardError, refreshDashboard, api, pushToast, navigate } = useApp()
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [retrying, setRetrying] = useState<number | null>(null)

  const pageHeader = (
    <PageHeader
      eyebrow="Overview"
      eyebrowCn="今日值班"
      title="概览"
      sub={
        dashboard
          ? `监听 ${dashboard.accounts.length} 个邮箱 · ${dashboard.accounts.filter((a) => a.status === 'enabled').length} 个在用 · 今日已归档 ${fmtNumber(dashboard.todayFiles)} 个文件`
          : '监听状态、今日归档与目标盘健康一屏掌握。'
      }
      actions={
        <>
          <Button
            size="sm"
            icon="refresh"
            loading={checking}
            disabled={checking || !dashboard}
            onClick={async () => {
              setChecking(true)
              try {
                await api.checkNow()
                pushToast('success', '已开始检查新邮件')
                refreshDashboard()
              } catch (e) {
                pushToast('error', '检查新邮件失败', errMsg(e))
              } finally {
                setChecking(false)
              }
            }}
          >
            检查新邮件
          </Button>
          <Button
            size="md"
            variant="ink"
            icon={dashboard?.listening ? 'pause' : 'play'}
            loading={busy}
            disabled={busy || !dashboard}
            onClick={async () => {
              setBusy(true)
              try {
                const next = await api.setListening(!(dashboard?.listening ?? false))
                pushToast('success', next ? '已恢复监听' : '已暂停监听', next ? '将按轮询间隔继续收信' : '队列中的任务仍会完成')
                refreshDashboard()
              } catch (e) {
                pushToast('error', '切换监听状态失败', errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {dashboard?.listening ? '暂停监听' : '恢复监听'}
          </Button>
        </>
      }
    />
  )

  if (!dashboard) {
    return (
      <>
        {pageHeader}
        {dashboardError ? (
          <ErrorState message={dashboardError} onRetry={refreshDashboard} />
        ) : (
          <div className="grid" style={{ gap: 14 }}>
            <div className="skeleton-card" style={{ height: 70 }} />
            <div className="grid cols-3">
              <div className="skeleton-card" style={{ height: 208 }} />
              <div className="skeleton-card" style={{ height: 208 }} />
              <div className="skeleton-card" style={{ height: 208 }} />
            </div>
            <div className="skeleton-card" style={{ height: 240 }} />
            {dashboardLoading ? null : <div className="hint">暂无可展示的数据</div>}
          </div>
        )}
      </>
    )
  }

  const d = dashboard
  const lastCheck = d.accounts.reduce<number | null>((max, a) => (a.lastCheckAt && (!max || a.lastCheckAt > max) ? a.lastCheckAt : max), null)
  const lastReceived = d.recent[0]?.receivedAt ?? null
  const next = secondsUntil(d.nextCheckAt, now)
  const failedAccounts = d.accounts.filter((a) => a.status === 'auth_failed' || a.status === 'conn_failed')
  const unavailableDisks = d.disks.filter((x) => x.health === 'unavailable').length
  const retryItems = d.recent.flatMap((row) => failedDeliveryItems(row)).slice(0, 3)
  const listening = d.listening

  return (
    <>
      {pageHeader}

      {/* 日报工单条 */}
      <section className="ticket" aria-label="今日统计">
        <div className="ticket-id">
          <div className="k">Daily Ticket · 今日</div>
          <div className="v">{fmtDate(now)}</div>
        </div>
        <div className="ticket-stats">
          <div className="tstat">
            <span className="k">收到邮件</span>
            <span className="v">
              <span className="n">{fmtNumber(d.todayMessages)}</span>
              <span className="u">件</span>
            </span>
          </div>
          <div className="tstat">
            <span className="k">命中规则</span>
            <span className="v">
              <span className="n">{fmtNumber(d.todayMatched)}</span>
              <span className="u">封</span>
            </span>
          </div>
          <div className="tstat">
            <span className="k">归档文件</span>
            <span className="v">
              <span className="n">{fmtNumber(d.todayFiles)}</span>
              <span className="u">个</span>
            </span>
          </div>
          <div className="tstat">
            <span className="k">失败待重试</span>
            <span className="v">
              <span className={cls('n', d.pendingRetry > 0 && 'bad')}>{fmtNumber(d.pendingRetry)}</span>
              <span className="u">个路径</span>
            </span>
          </div>
        </div>
        <div className="ticket-stamp">
          <span className={cls('stamp', !listening && 'is-paused')}>{listening ? '监听中' : '已暂停'}</span>
        </div>
      </section>

      {/* 顶部三卡 */}
      <div className="cards-top">
        <section className="card listen">
          <div>
            <div className="listen-head">
              <span className={cls('dot', 'big', listening ? 'dot-live' : 'dot-idle')} aria-hidden="true" />
              <div>
                <div className="listen-title">{listening ? '监听中' : '已暂停'}</div>
                <div className="listen-sub">
                  每 {d.pollIntervalSec} 秒检查一次收件箱
                  <br />
                  已连续运行 {fmtDuration(d.uptimeMs)}
                </div>
                <div className="listen-quiet">轮询正常 · 无异常</div>
              </div>
              <span className="listen-badge">
                <StatusBadge tone={listening ? 'ok' : 'neutral'}>{listening ? '正常' : '暂停'}</StatusBadge>
              </span>
            </div>
          </div>
          <div className="listen-stats">
            <div>
              <span className="k">上次检查</span>
              <span className="v">{lastCheck ? fmtTimeSec(lastCheck) : '—'}</span>
            </div>
            <div>
              <span className="k">下次检查</span>
              <span className="v">{listening ? fmtCountdown(next) : '暂停中'}</span>
            </div>
            <div>
              <span className="k">上次收件</span>
              <span className="v">{lastReceived ? fmtTime(lastReceived) : '—'}</span>
            </div>
          </div>
        </section>

        <section className="card mail-card">
          <div className="card-hd">
            <h2 className="card-title">邮箱账户</h2>
            {failedAccounts.length > 0 ? (
              <StatusBadge tone="bad">{failedAccounts.length} 个连接失败</StatusBadge>
            ) : (
              <StatusBadge tone="ok">全部正常</StatusBadge>
            )}
            <button type="button" className="card-note link" onClick={() => navigate('accounts')}>
              管理账户 ›
            </button>
          </div>
          <div className="card-bd">
            {d.accounts.length === 0 ? (
              <EmptyState
                variant="compact"
                art={false}
                title="还没有邮箱账户"
                desc="添加一个邮箱后开始收信。"
                actions={
                  <Button size="sm" variant="primary" icon="plus" onClick={() => navigate('accounts')}>
                    添加邮箱账户
                  </Button>
                }
              />
            ) : (
              d.accounts.slice(0, 3).map((account) => <AccountRow key={account.id} account={account} />)
            )}
          </div>
        </section>

        <section className="card drive-card">
          <div className="card-hd">
            <h2 className="card-title">目标盘剩余空间</h2>
            <span className="card-note">
              {d.disks.length} 个位置{unavailableDisks > 0 ? ` · ${unavailableDisks} 个不可用` : ''}
            </span>
          </div>
          <div className="card-bd" style={{ paddingTop: 4 }}>
            {d.disks.length === 0 ? (
              <div className="hint">还没有配置目标路径。到「触发规则」里添加。</div>
            ) : (
              d.disks.map((disk) => {
                const bad = disk.health === 'unavailable'
                const warn = disk.health === 'low_space'
                const pct = usedPercent(disk.freeBytes, disk.totalBytes)
                return (
                  <div className="drive-row" key={disk.path}>
                    <span className={cls('drive-letter', bad && 'bad')}>{driveOf(disk.path)}</span>
                    <div className="drive-main">
                      <div className="drive-name">
                        <span>{diskLabel(disk)}</span>
                        <span className="p" title={disk.path}>
                          {disk.path}
                        </span>
                        {warn ? (
                          <StatusBadge tone="warn" className="drive-badge">
                            空间不足
                          </StatusBadge>
                        ) : null}
                      </div>
                      {bad ? (
                        <div className="drive-bad-text">
                          磁盘未连接
                          {disk.ruleKeywords.length > 0 ? ` · ${disk.ruleKeywords.length} 条规则受影响` : ''}
                        </div>
                      ) : (
                        <div className="meter thin" style={{ marginTop: 5, width: 120 }}>
                          <i className={cls(warn && 'warn')} style={{ width: `${pct ?? 0}%` }} />
                        </div>
                      )}
                    </div>
                    {bad ? (
                      <Button size="sm" variant="ghost" onClick={refreshDashboard}>
                        检测
                      </Button>
                    ) : (
                      <div className="drive-val">
                        {fmtBytesLoose(disk.freeBytes)}
                        <small> / {fmtBytesLoose(disk.totalBytes)}</small>
                      </div>
                    )}
                  </div>
                )
              })
            )}
            <div className="drive-foot">剩余空间低于 20 GB 时会在托盘提醒，避免大图静默丢件。</div>
          </div>
        </section>
      </div>

      {/* 规则 → 存储路径：整行展示，规则再多也能滚动看全 */}
      <RulePathsCard
        rules={d.rulePaths}
        onOpen={(path) => {
          void api.openPath(path).catch(() => pushToast('error', '打开失败', path))
        }}
        onManage={() => navigate('rules')}
      />

      {/* 底部：最近记录 + 待重试 */}
      <div className="cards-bottom">
        <section className="card recent">
          <div className="card-hd">
            <h2 className="card-title">最近收件</h2>
            <span className="card-note">最近 {Math.min(d.recent.length, 4)} 封 · 全部在「下载记录」</span>
            <button
              type="button"
              className="card-note link"
              style={{ marginLeft: 12 }}
              onClick={() => navigate('records')}
            >
              全部记录 ›
            </button>
          </div>
          <div className="card-bd">
            {d.recent.length === 0 ? (
              <EmptyState
                variant="compact"
                title="还没有收到邮件"
                desc="监听中，新邮件到达后会显示在这里。"
              />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 74 }}>时间</th>
                    <th>发件人与主题</th>
                    <th style={{ width: 104 }}>命中规则</th>
                    <th style={{ width: 124 }}>目标路径</th>
                    <th style={{ width: 84 }}>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent.slice(0, 4).map((row) => (
                    <RecentRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card-ft">
            <span>按时间倒序 · 悬停路径可看完整位置</span>
            <span style={{ marginLeft: 'auto' }} className="mono">
              显示 {Math.min(d.recent.length, 4)} / 今日 {fmtNumber(d.todayMessages)}
            </span>
          </div>
        </section>

        <section className="card retry-card">
          <div className="card-hd">
            <h2 className="card-title">失败待重试</h2>
            <StatusBadge tone={d.pendingRetry > 0 ? 'bad' : 'ok'}>{fmtNumber(d.pendingRetry)}</StatusBadge>
            <span className="card-note">仅重试未完成的路径</span>
          </div>
          <div className="card-bd">
            {retryItems.length === 0 ? (
              <EmptyState variant="compact" title="没有待重试的路径" desc="所有目标路径都已写入成功。" />
            ) : (
              retryItems.map((item) => (
                <RetryItem
                  key={`${item.messageId}-${item.deliveryId}`}
                  item={item}
                  retrying={retrying === item.deliveryId}
                  onRetry={async () => {
                    setRetrying(item.deliveryId)
                    try {
                      await api.records.retry(item.messageId, item.deliveryId)
                      pushToast('success', `已重试 ${item.drive}: 路径`, item.targetPath)
                      refreshDashboard()
                    } catch (e) {
                      pushToast('error', '重试失败', errMsg(e))
                    } finally {
                      setRetrying(null)
                    }
                  }}
                />
              ))
            )}
            <div className="retry-note">
              <span style={{ color: 'var(--ink-400)' }}>
                <Icon name="shield" size={14} />
              </span>
              <span>
                已写入成功的文件夹不会重复写，
                <br />
                重试只补写失败的那条路径。
              </span>
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
