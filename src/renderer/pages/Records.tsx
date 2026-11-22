import type { JSX } from 'react'
/** 下载记录：筛选 + 搜索 + 账户筛选 + 多路径结果表格 + 行内单路径重试 + 导出 + 分页 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ListRecordsQuery, ListRecordsResult, MessageStatus, RecordRow } from '@shared/types'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { PathChip } from '../components/PathChip'
import { SegmentedControl } from '../components/SegmentedControl'
import { Select } from '../components/TextField'
import { StatusBadge } from '../components/StatusBadge'
import { aggregateDeliveries } from '../lib/delivery'
import {
  cls, driveOf, errMsg, fmtBytes, fmtDateTime, fmtNumber, mailLocal
} from '../lib/format'
import { deliveryMeta, messageStatusMeta } from '../lib/status'
import { useApp } from '../state/app-state'
import '../styles/screens/records.css'

type StatusFilter = 'all' | 'done' | 'partial' | 'ignored'

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'done', label: '已归档' },
  { value: 'partial', label: '待重试' },
  { value: 'ignored', label: '已忽略' }
]

const STATUS_TO_QUERY: Record<StatusFilter, MessageStatus | 'all'> = {
  all: 'all',
  done: 'done',
  partial: 'partial',
  ignored: 'ignored_no_keyword'
}

function buildPages(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: Array<number | '…'> = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  if (start > 2) pages.push('…')
  for (let p = start; p <= end; p += 1) pages.push(p)
  if (end < total - 1) pages.push('…')
  pages.push(total)
  return pages
}

export function Records(): JSX.Element {
  const { api, pushToast, refreshDashboard, refresh, bump } = useApp()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [result, setResult] = useState<ListRecordsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [accountId, setAccountId] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void api.accounts
      .list()
      .then(setAccounts)
      .catch(() => setAccounts([]))
  }, [api, refresh.accounts])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 280)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const query = useMemo<ListRecordsQuery>(
    () => ({
      page,
      pageSize,
      status: STATUS_TO_QUERY[status],
      accountId: accountId === 'all' ? null : Number(accountId),
      search: debouncedSearch.trim() || undefined
    }),
    [page, pageSize, status, accountId, debouncedSearch]
  )

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.records
      .list(query)
      .then((res) => {
        if (!alive) return
        setResult(res)
        setLoadError(null)
      })
      .catch((e) => {
        if (alive) setLoadError(errMsg(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api, query, refresh.records])

  const reload = useCallback(() => {
    bump('records')
    refreshDashboard()
  }, [bump, refreshDashboard])

  const setFilterStatus = (value: StatusFilter): void => {
    setStatus(value)
    setPage(1)
  }

  const clearFilters = (): void => {
    setStatus('all')
    setAccountId('all')
    setSearch('')
    setPage(1)
  }

  const retryDelivery = async (row: RecordRow, deliveryId: number, drive: string): Promise<void> => {
    const key = `${row.id}-${deliveryId}`
    setRetrying(key)
    try {
      await api.records.retry(row.id, deliveryId)
      pushToast('success', `已重试 ${drive}: 路径`, row.subject)
      reload()
    } catch (e) {
      pushToast('error', '重试失败', errMsg(e))
    } finally {
      setRetrying(null)
    }
  }

  const openFolder = async (row: RecordRow, deliveryId?: number): Promise<void> => {
    try {
      await api.records.openFolder(row.id, deliveryId)
    } catch (e) {
      pushToast('error', '打开文件夹失败', errMsg(e))
    }
  }

  const exportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const res = await api.records.exportCsv(query)
      if (res) pushToast('success', '已导出 CSV', res.path)
    } catch (e) {
      pushToast('error', '导出 CSV 失败', errMsg(e))
    } finally {
      setExporting(false)
    }
  }

  const rows = result?.rows ?? []
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasFilters = status !== 'all' || accountId !== 'all' || search.trim() !== ''
  const showTotalCount = status === 'all' && accountId === 'all' && search.trim() === ''
  const failedCount = rows.reduce(
    (n, r) => n + aggregateDeliveries(r).filter((d) => d.state === 'failed' || d.state === 'retry_wait').length,
    0
  )
  const driveLetters = useMemo(
    () =>
      Array.from(
        new Set(
          rows.flatMap((r) =>
            r.attachments.flatMap((a) => a.deliveries.map((d) => driveOf(d.targetPath)))
          )
        )
      ).sort(),
    [rows]
  )

  const header = (
    <PageHeader
      eyebrow="Records"
      eyebrowCn="下载记录"
      title="下载记录"
      sub="每封邮件、每条目标路径的结果都留痕。哪条路径失败就只重试哪条。"
      actions={
        <>
          <Button size="sm" icon="refresh" disabled={loading} onClick={() => reload()}>
            刷新
          </Button>
          <Button size="sm" icon="upload" loading={exporting} onClick={() => void exportCsv()}>
            导出 CSV
          </Button>
        </>
      }
    />
  )

  return (
    <>
      {header}

      {/* 筛选条 */}
      <div className="card filters">
        <div className="f-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            className="f-search-el"
            value={search}
            placeholder="搜索主题 / 文件 / 发件人"
            aria-label="搜索下载记录"
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
          {search ? (
            <button type="button" className="f-clear" aria-label="清除搜索" onClick={() => setSearch('')}>
              <Icon name="x" size={12} />
            </button>
          ) : (
            <span className="kbd">Ctrl K</span>
          )}
        </div>
        <SegmentedControl<StatusFilter>
          value={status}
          ariaLabel="按状态筛选"
          options={STATUS_OPTIONS.map((o) => ({
            value: o.value,
            label:
              o.value === 'all' ? (
                <>
                  全部{' '}
                  {showTotalCount ? <span className="mono">{fmtNumber(total)}</span> : null}
                </>
              ) : (
                o.label
              )
          }))}
          onChange={setFilterStatus}
        />
        <span className="f-div" />
        <Select
          className="f-select"
          value={accountId}
          onChange={(value) => {
            setAccountId(value)
            setPage(1)
          }}
          ariaLabel="按账户筛选"
          options={[
            { value: 'all', label: '全部账户' },
            ...accounts.map((a) => ({ value: String(a.id), label: a.email }))
          ]}
        />
        {hasFilters ? (
          <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>
            清除筛选
          </Button>
        ) : null}
        <span className="f-spacer" />
        <span className="f-hint">
          <Icon name="info" size={12} />
          点击失败路径 chip 可看原因
        </span>
      </div>

      {/* 表格 */}
      <section className="card rec-card">
        <div className="rec-hd">
          <h2>全部记录</h2>
          <span className="cnt">
            {fmtNumber(total)} 条{loading ? ' · 加载中…' : ''}
          </span>
          <div className="right">
            {failedCount > 0 ? <StatusBadge tone="warn">本页 {failedCount} 条路径待重试</StatusBadge> : null}
            {hasFilters ? <StatusBadge tone="outline">已筛选</StatusBadge> : null}
          </div>
        </div>

        <div className="rec-table-wrap">
          {loading && !result ? (
            <div className="rec-skeleton">
              {Array.from({ length: 7 }, (_, i) => (
                <div className="skeleton-row" key={i}>
                  <span className="skeleton skeleton-line" style={{ width: 92 }} />
                  <span className="skeleton skeleton-line" style={{ width: 60 }} />
                  <span className="skeleton skeleton-line" style={{ width: 120 }} />
                  <span className="skeleton skeleton-line" style={{ flex: 1 }} />
                  <span className="skeleton skeleton-line" style={{ width: 78 }} />
                </div>
              ))}
            </div>
          ) : loadError && !result ? (
            <ErrorState message={loadError} onRetry={reload} />
          ) : rows.length === 0 ? (
            <div className="rec-empty">
              <EmptyState
                title="没有符合条件的记录"
                desc={hasFilters ? '换一个筛选条件或清除筛选再试。' : '收到邮件并命中规则后，这里会显示归档结果。'}
                actions={
                  hasFilters ? (
                    <Button size="sm" onClick={clearFilters}>
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <table className="rec-table">
              <colgroup>
                <col style={{ width: 122 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 150 }} />
                <col />
                <col style={{ width: 98 }} />
                <col style={{ width: 126 }} />
                <col style={{ width: 86 }} />
                <col style={{ width: 118 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    时间 <span className="sort">↓</span>
                  </th>
                  <th>账户</th>
                  <th>发件人</th>
                  <th>主题 / 附件</th>
                  <th>命中规则</th>
                  <th>各目标路径</th>
                  <th>状态</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const deliveries = aggregateDeliveries(row)
                  const failed = deliveries.filter((d) => d.state === 'failed' || d.state === 'retry_wait')
                  const primaryFail = failed[0]
                  const firstFile = row.attachments[0]
                  const savedDelivery = deliveries.find((d) => d.savedPath)
                  const isProcessing = row.status === 'queued'
                  return (
                    <tr key={row.id} className={cls(isProcessing && 'is-new')}>
                      <td>
                        <span className="t-time">{fmtDateTime(row.receivedAt)}</span>
                      </td>
                      <td>
                        <span className="t-acct" title={row.accountEmail}>
                          {mailLocal(row.accountEmail)}
                        </span>
                      </td>
                      <td>
                        <div className="t-sender" title={`${row.fromName} <${row.fromAddr}>`}>
                          {row.fromAddr || '—'}
                        </div>
                        {row.fromName ? <div className="t-sender-name">{row.fromName}</div> : null}
                      </td>
                      <td>
                        <div className="t-subj" title={row.subject}>
                          {row.subject}
                        </div>
                        {firstFile ? (
                          <div className="t-file" title={row.attachments.map((a) => a.filename).join('\n')}>
                            <Icon name="image" size={11} />
                            <span className="nm">{firstFile.filename}</span>
                            {row.attachments.length > 1 ? <span className="more">等 {row.attachments.length} 个</span> : null}
                            <span className="sz">{fmtBytes(firstFile.size)}</span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {row.matchedKeyword ? (
                          <span className="kchip record-kchip">{row.matchedKeyword}</span>
                        ) : (
                          <span className="mono t-dim">未命中</span>
                        )}
                      </td>
                      <td>
                        {deliveries.length > 0 ? (
                          <div className="pchips">
                            {deliveries.map((d) => (
                              <PathChip
                                key={d.key}
                                state={d.state}
                                path={d.targetPath}
                                dense
                                title={`${d.targetPath} · ${deliveryMeta(d.state).label}${d.error ? `\n${d.error}` : ''}`}
                                onClick={
                                  d.state === 'failed' || d.state === 'retry_wait'
                                    ? () =>
                                        pushToast(
                                          'warn',
                                          `${d.drive}: 路径未完成 · ${deliveryMeta(d.state).label}`,
                                          `${d.targetPath}${d.error ? `\n${d.error}` : ''}`
                                        )
                                    : undefined
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="mono t-dim">—</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge meta={messageStatusMeta(row.status)} />
                      </td>
                      <td>
                        <div className="row-actions">
                          {primaryFail ? (
                            <Button
                              size="sm"
                              variant={primaryFail.required ? 'danger' : 'secondary'}
                              icon="refresh"
                              loading={retrying === `${row.id}-${primaryFail.failedDeliveryIds[0]}`}
                              className="retry-btn"
                              onClick={() =>
                                void retryDelivery(row, primaryFail.failedDeliveryIds[0], primaryFail.drive)
                              }
                            >
                              重试 {primaryFail.drive}
                            </Button>
                          ) : null}
                          {savedDelivery ? (
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="打开文件夹"
                              title={`打开 ${savedDelivery.savedPath ?? savedDelivery.targetPath}`}
                              onClick={() =>
                                void openFolder(row, savedDelivery.savedDeliveryId ?? savedDelivery.deliveryIds[0])
                              }
                            >
                              <Icon name="folder" size={14} />
                            </button>
                          ) : null}
                          {row.matchedRuleId == null ? (
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="查看记录详情"
                              title="未命中关键词，未下载附件"
                              onClick={() =>
                                pushToast(
                                  'warn',
                                  '这封邮件未命中关键词',
                                  row.error ?? '标题不包含任何启用规则的关键词，已忽略并留痕。'
                                )
                              }
                            >
                              <Icon name="eye" size={13} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="rec-ft">
          <span className="mono">
            共 {fmtNumber(total)} 条 · 本页 {rows.length} 条
          </span>
          <span className="legend">
            {driveLetters.map((drive) => (
              <span className="lg" key={drive}>
                <span className="dr">{drive}:</span>
              </span>
            ))}
            <span className="legend-note">绿=已写入 · 红=失败 · 蓝=处理中</span>
          </span>
          <div className="pager">
            <button
              type="button"
              className="pg"
              aria-label="上一页"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <Icon name="chevronLeft" size={12} />
            </button>
            {buildPages(page, totalPages).map((p, index) =>
              p === '…' ? (
                <span className="pg dim" key={`e-${index}`}>
                  …
                </span>
              ) : (
                <button
                  type="button"
                  key={p}
                  className={cls('pg', p === page && 'is-active')}
                  aria-current={p === page ? 'page' : undefined}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              className="pg"
              aria-label="下一页"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <Icon name="chevronRight" size={12} />
            </button>
            <span className="pager-size">
              <Select
                value={String(pageSize)}
                onChange={(value) => {
                  setPageSize(Number(value))
                  setPage(1)
                }}
                ariaLabel="每页条数"
                options={[
                  { value: '20', label: '每页 20' },
                  { value: '50', label: '每页 50' },
                  { value: '100', label: '每页 100' }
                ]}
              />
            </span>
          </div>
        </div>
      </section>
    </>
  )
}
