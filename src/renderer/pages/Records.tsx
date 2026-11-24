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
  const { api, pushToast, refreshDashboard, refresh, bump, downloads, retryDownload } = useApp()
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
  const [webDownloading, setWebDownloading] = useState<number[]>([])
  const [exporting, setExporting] = useState(false)
  // 弱网/大附件：下载超时与自动重试次数（存到设置）
  const [dlSettings, setDlSettings] = useState<{ timeoutSec: number; attempts: number; extract: boolean; chunkMB: number; parallel: boolean; conn: number; spam: boolean; autoRetry: boolean; gmail: boolean } | null>(null)
  const [dlPanelOpen, setDlPanelOpen] = useState(false)
  const [bulkRetrying, setBulkRetrying] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void api.settings
      .get()
      .then((s) =>
        setDlSettings({
          timeoutSec: Number(s.downloadTimeoutSec ?? 900),
          attempts: Number(s.downloadAttempts ?? 3),
          extract: s.extractArchives !== false,
          chunkMB: Number(s.downloadChunkSizeMB ?? 2),
          parallel: s.parallelDownload !== false,
          conn: Number(s.parallelConnections ?? 4),
          spam: s.scanSpam !== false,
          autoRetry: s.autoRetryFailed !== false,
          gmail: s.gmailApiAccel !== false
        })
      )
      .catch(() =>
        setDlSettings({
          timeoutSec: 900, attempts: 3, extract: true, chunkMB: 2, parallel: true, conn: 4,
          spam: true, autoRetry: true, gmail: true
        })
      )
  }, [api])

  const saveDlSettings = async (next: { timeoutSec: number; attempts: number; extract: boolean; chunkMB: number; parallel: boolean; conn: number; spam: boolean; autoRetry: boolean; gmail: boolean }): Promise<void> => {
    setDlSettings(next)
    try {
      const s = await api.settings.get()
      await api.settings.save({
        ...s,
        downloadTimeoutSec: next.timeoutSec,
        downloadAttempts: next.attempts,
        extractArchives: next.extract,
        downloadChunkSizeMB: next.chunkMB,
        parallelDownload: next.parallel,
        parallelConnections: next.conn,
        scanSpam: next.spam,
        autoRetryFailed: next.autoRetry,
        gmailApiAccel: next.gmail
      })
      pushToast('success', '下载设置已保存', `超时 ${Math.round(next.timeoutSec / 60)} 分钟 · 自动重试 ${next.attempts} 次`)
    } catch (e) {
      pushToast('error', '保存失败', errMsg(e))
    }
  }

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

  /** 下载阶段就失败（没有可重试的失败路径）的邮件：用「重试下载」重新拉取 */
  const failedDownloadRows = rows.filter(
    (r) =>
      r.status === 'failed' &&
      !r.attachments.some((a) => a.deliveries.some((d) => d.state === 'failed' || d.state === 'retry_wait'))
  )

  const activeCount = downloads.filter((d) => d.state === 'active').length
  const failedPathCount = rows.reduce(
    (n, r) => n + aggregateDeliveries(r).filter((d) => d.state === 'failed' || d.state === 'retry_wait').length,
    0
  )
  const doneCount = rows.filter((r) => r.status === 'done').length
  const [bulkRetryingPaths, setBulkRetryingPaths] = useState(false)

  const retryAllFailedPaths = async (): Promise<void> => {
    const targets: Array<{ messageId: number; deliveryId: number }> = []
    for (const r of rows) {
      for (const d of aggregateDeliveries(r)) {
        if (d.state !== 'failed' && d.state !== 'retry_wait') continue
        for (const deliveryId of d.failedDeliveryIds) targets.push({ messageId: r.id, deliveryId })
      }
    }
    if (targets.length === 0) return
    setBulkRetryingPaths(true)
    let ok = 0
    try {
      for (const tg of targets) {
        try {
          await api.records.retry(tg.messageId, tg.deliveryId)
          ok += 1
        } catch {
          /* 单条失败继续 */
        }
      }
      pushToast(ok > 0 ? 'success' : 'warn', `已重试 ${ok} / ${targets.length} 条失败路径`, '重试结果会显示在对应记录的路径状态里')
      reload()
      refreshDashboard()
    } finally {
      setBulkRetryingPaths(false)
    }
  }

  const retryAllFailedDownloads = async (): Promise<void> => {
    if (failedDownloadRows.length === 0) return
    setBulkRetrying(true)
    let ok = 0
    try {
      for (const r of failedDownloadRows) {
        const res = await api.records.retryDownload(r.id)
        if (res.ok) ok += 1
      }
      pushToast(ok > 0 ? 'success' : 'warn', `已重新下载 ${ok} / ${failedDownloadRows.length} 封`, '下载完成后会自动归档并回信')
      reload()
      refreshDashboard()
    } catch (e) {
      pushToast('error', '批量重试失败', errMsg(e))
    } finally {
      setBulkRetrying(false)
    }
  }
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
          {failedDownloadRows.length > 0 ? (
            <Button
              size="sm"
              variant="danger"
              icon="download"
              loading={bulkRetrying}
              onClick={() => void retryAllFailedDownloads()}
            >
              重试失败下载（{failedDownloadRows.length}）
            </Button>
          ) : null}
          <Button
            size="sm"
            icon="sliders"
            variant={dlPanelOpen ? 'primary' : 'secondary'}
            onClick={() => setDlPanelOpen((v) => !v)}
            title="大附件 / 弱网：可调下载超时与自动重试次数"
          >
            下载设置
          </Button>
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

      <div className="dl-summary" aria-label="下载中心状态">
        <span className={cls('dls-badge', activeCount > 0 && 'live')}>
          <span className={cls('dot', activeCount > 0 ? 'dot-live' : 'dot-idle')} aria-hidden="true" />
          进行中 <b>{activeCount}</b>
        </span>
        <span className={cls('dls-badge', failedPathCount > 0 && 'warn')}>失败路径 <b>{failedPathCount}</b></span>
        <span className="dls-badge">本页已归档 <b>{doneCount}</b></span>
        {failedPathCount > 0 ? (
          <Button size="sm" variant="danger" icon="download" loading={bulkRetryingPaths} onClick={() => void retryAllFailedPaths()}>
            全部重试路径
          </Button>
        ) : null}
        <span className="dls-summary-note">失败会自动重试；也可手动重试，不会重复写入已成功的文件夹</span>
      </div>

      {dlPanelOpen && dlSettings ? (
        <section className="dl-settings" aria-label="下载设置">
          <div className="dls-title">
            <div>
              <h3>下载与网络</h3>
              <p>大附件、弱网时优先调这里；改完立即生效。</p>
            </div>
            <span className="dls-tag">改动会保存到本机</span>
          </div>

          <div className="dls-grid">
            <div className="dls-item">
              <span className="dls-lbl">单个附件超时</span>
              <select
                className="dls-select"
                value={dlSettings.timeoutSec}
                aria-label="单个附件下载超时"
                onChange={(e) => void saveDlSettings({ ...dlSettings, timeoutSec: Number(e.target.value) })}
              >
                <option value={300}>5 分钟</option>
                <option value={600}>10 分钟</option>
                <option value={900}>15 分钟（推荐）</option>
                <option value={1800}>30 分钟</option>
                <option value={3600}>60 分钟</option>
              </select>
              <span className="dls-help">超时后自动重试；大文件建议 30–60 分钟</span>
            </div>

            <div className="dls-item">
              <span className="dls-lbl">分块大小</span>
              <select
                className="dls-select"
                value={dlSettings.chunkMB}
                aria-label="IMAP 分块大小"
                onChange={(e) => void saveDlSettings({ ...dlSettings, chunkMB: Number(e.target.value) })}
              >
                <option value={1}>1 MB</option>
                <option value={2}>2 MB（推荐）</option>
                <option value={4}>4 MB</option>
                <option value={8}>8 MB</option>
                <option value={16}>16 MB</option>
              </select>
              <span className="dls-help">IMAP 每次拉取的数据量，2MB 通常最稳</span>
            </div>

            <div className="dls-item">
              <span className="dls-lbl">多连接并行</span>
              <select
                className="dls-select"
                value={dlSettings.parallel ? String(dlSettings.conn) : 'off'}
                aria-label="多连接并行下载"
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'off') void saveDlSettings({ ...dlSettings, parallel: false })
                  else void saveDlSettings({ ...dlSettings, parallel: true, conn: Number(v) })
                }}
              >
                <option value="off">关闭（单连接）</option>
                <option value={2}>2 连接</option>
                <option value={4}>4 连接（推荐）</option>
                <option value={6}>6 连接</option>
                <option value={8}>8 连接</option>
              </select>
              <span className="dls-help">大附件切成多段同时下载，实测约 2 倍</span>
            </div>

            <div className="dls-item">
              <span className="dls-lbl">Gmail 加速（API）</span>
              <select
                className="dls-select"
                value={dlSettings.gmail ? 'on' : 'off'}
                aria-label="是否启用 Gmail API 加速下载"
                onChange={(e) => void saveDlSettings({ ...dlSettings, gmail: e.target.value === 'on' })}
              >
                <option value="on">开启（HTTPS）</option>
                <option value="off">关闭（走 IMAP）</option>
              </select>
              <span className="dls-help">Gmail 附件走 HTTPS，比 IMAP 快 4–5 倍（需先在邮箱账户页授权）</span>
            </div>
          </div>

          <div className="dls-title">
            <div>
              <h3>容错与扫描</h3>
              <p>网络抖动、垃圾邮件、失败补拉都在这一组。</p>
            </div>
          </div>

          <div className="dls-grid">
            <div className="dls-item">
              <span className="dls-lbl">失败自动重试</span>
              <select
                className="dls-select"
                value={dlSettings.autoRetry ? 'on' : 'off'}
                aria-label="失败是否自动重试"
                onChange={(e) => void saveDlSettings({ ...dlSettings, autoRetry: e.target.value === 'on' })}
              >
                <option value="on">自动重试（推荐）</option>
                <option value="off">只手动重试</option>
              </select>
              <span className="dls-help">按 1 分→5 分→15 分→30 分→1 小时退避，最多 6 次</span>
            </div>

            <div className="dls-item">
              <span className="dls-lbl">每次重试次数</span>
              <select
                className="dls-select"
                value={dlSettings.attempts}
                aria-label="附件下载失败自动重试次数"
                onChange={(e) => void saveDlSettings({ ...dlSettings, attempts: Number(e.target.value) })}
              >
                <option value={1}>1 次</option>
                <option value={2}>2 次</option>
                <option value={3}>3 次（推荐）</option>
                <option value={5}>5 次</option>
              </select>
              <span className="dls-help">单次下载内部的即时重试次数</span>
            </div>

            <div className="dls-item">
              <span className="dls-lbl">垃圾邮件文件夹</span>
              <select
                className="dls-select"
                value={dlSettings.spam ? 'on' : 'off'}
                aria-label="是否同时扫描垃圾邮件文件夹"
                onChange={(e) => void saveDlSettings({ ...dlSettings, spam: e.target.value === 'on' })}
              >
                <option value="on">同时扫描（推荐）</option>
                <option value="off">只扫收件箱</option>
              </select>
              <span className="dls-help">Gmail 常把 QQ 大附件判垃圾；照样归档，但不自动回信</span>
            </div>
          </div>

          <div className="dls-title">
            <div>
              <h3>归档</h3>
              <p>文件落到目标文件夹之后怎么处理。</p>
            </div>
          </div>

          <div className="dls-grid">
            <div className="dls-item">
              <span className="dls-lbl">自动解压 ZIP/RAR</span>
              <select
                className="dls-select"
                value={dlSettings.extract ? 'on' : 'off'}
                aria-label="压缩包自动解压"
                onChange={(e) => void saveDlSettings({ ...dlSettings, extract: e.target.value === 'on' })}
              >
                <option value="on">解压到目标文件夹</option>
                <option value="off">只存压缩包，不解压</option>
              </select>
              <span className="dls-help">解压不建子文件夹，保留原压缩包；大包在后台排队不阻塞收信</span>
            </div>
          </div>

          <div className="dls-hint">
            <Icon name="alert" size={12} />
            <span>网络慢时把超时调到 30–60 分钟；失败后也可在下方记录里点「重试下载」手动再拉一次。</span>
          </div>
        </section>
      ) : null}



      {downloads.length > 0 ? (
        <section className="dl-progress" aria-label="附件下载进度">
          {downloads.map((d) => (
            <div className="dlp-item" key={d.attachmentId}>
              <div className="dlp-head">
                <Icon name="download" size={13} />
                <span className="dlp-name" title={d.filename}>{d.filename}</span>
                <span className="dlp-stat mono">
                  {fmtBytes(d.received)}
                  {d.total > 0 ? ` / ${fmtBytes(d.total)}` : ''}
                  {d.percent != null ? ` · ${d.percent}%` : ''}
                  {d.bytesPerSec > 0 ? ` · ${fmtBytes(d.bytesPerSec)}/s` : ''}
                </span>
                {d.attempt > 1 ? <span className="dlp-retry">第 {d.attempt} 次尝试</span> : null}
              </div>
              <div className="dlp-bar" role="progressbar" aria-valuenow={d.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${d.percent ?? (d.received > 0 ? 8 : 3)}%` }} />
              </div>
            </div>
          ))}
        </section>
      ) : null}

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
                            {firstFile.extractedCount ? (
                              <span
                                className="ex-tag"
                                title={firstFile.extractError ? `解压警告：${firstFile.extractError}` : `已解压 ${firstFile.extractedCount} 个文件`}
                              >
                                解压 {firstFile.extractedCount}
                              </span>
                            ) : firstFile.extractError ? (
                              <span className="ex-tag bad" title={firstFile.extractError}>解压失败</span>
                            ) : null}
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
                        {(() => {
                          const live = downloads.find((d) => d.messageId === row.id)
                          return (
                            <div className="status-cell">
                              <StatusBadge meta={messageStatusMeta(row.status)} />
                              {row.mailbox && row.mailbox !== 'INBOX' ? (
                                <span className="mailbox-tag" title="来自垃圾邮件文件夹（不自动回信）">垃圾箱</span>
                              ) : null}
                              {row.status === 'queued' ? (
                                <span className="status-progress mono" title={live?.message ?? ''}>
                                  {live
                                    ? live.received > 0
                                      ? `${fmtBytes(live.received)}${live.total ? ` / ${fmtBytes(live.total)}` : ''}${
                                          live.percent != null ? ` · ${live.percent}%` : ''
                                        }`
                                      : '等待服务器响应…'
                                    : '下载中…'}
                                </span>
                              ) : null}
                            </div>
                          )
                        })()}
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
                          {row.status === 'manual_needed' ? (
                            <>
                              {row.links.length > 0 ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    icon="download"
                                    loading={webDownloading.includes(row.id)}
                                    disabled={retrying === `${row.id}-manual`}
                                    onClick={() => {
                                      setWebDownloading((ids) => [...ids, row.id])
                                      void api.records.downloadLink(row.id).then((r) => {
                                        if (r.ok) {
                                          pushToast(r.message ? 'warn' : 'success', '网页文件已归档', r.message ?? `已复制 ${r.archived ?? 0} 份`)
                                          reload()
                                          refreshDashboard()
                                        } else if (r.message !== '已取消') {
                                          pushToast('warn', '下载或归档未完成', r.message ?? '请重试')
                                        }
                                      }).catch((e) => pushToast('error', '网页下载失败', errMsg(e)))
                                        .finally(() => setWebDownloading((ids) => ids.filter((id) => id !== row.id)))
                                    }}
                                  >
                                    下载并归档
                                  </Button>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--accent"
                                    aria-label="在系统浏览器打开下载链接"
                                    title="在系统浏览器打开下载链接"
                                    onClick={() =>
                                      void api.records.openLink(row.id).then((r) => {
                                        if (!r.ok) pushToast('warn', '打开链接失败', r.message)
                                      })
                                    }
                                  >
                                    <Icon name="external" size={14} />
                                  </button>
                                </>
                              ) : null}
                              <button
                                type="button"
                                className="icon-btn icon-btn--accent"
                                aria-label="归档已下载的文件"
                                title="从超大附件/网盘下载好后，点这里选择文件归档（自动解压 + 回信）"
                                disabled={retrying === `${row.id}-manual` || webDownloading.includes(row.id)}
                                onClick={() => {
                                  setRetrying(`${row.id}-manual`)
                                  void api.records
                                    .archiveManual(row.id)
                                    .then((r) => {
                                      if (r.ok) {
                                        pushToast(
                                          'success',
                                          '已归档',
                                          `已复制 ${r.archived ?? 0} 份${r.extracted ? `，解压 ${r.extracted} 个文件` : ''}`
                                        )
                                        reload()
                                        refreshDashboard()
                                      } else if (r.message !== '已取消') {
                                        pushToast('warn', '归档未完成', r.message ?? '请重试')
                                      }
                                    })
                                    .catch((e) => pushToast('error', '归档失败', errMsg(e)))
                                    .finally(() => setRetrying(null))
                                }}
                              >
                                <Icon name="folder" size={14} />
                              </button>
                            </>
                          ) : null}
                          {/* 下载阶段就失败（大附件/弱网超时）：重新拉取整封邮件 */}
                          {!primaryFail && row.status === 'failed' ? (
                            <Button
                              size="sm"
                              variant="danger"
                              icon="download"
                              loading={retrying === `${row.id}-download`}
                              onClick={() => {
                                setRetrying(`${row.id}-download`)
                                void retryDownload(row.id).finally(() => setRetrying(null))
                              }}
                            >
                              重试下载
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
                          {row.status === 'ignored_type' || row.status === 'ignored_no_keyword' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon="refresh"
                              title="规则改过 / 软件升级后，重新识别这封邮件"
                              loading={retrying === `${row.id}-reprocess`}
                              onClick={() => {
                                setRetrying(`${row.id}-reprocess`)
                                void api.records
                                  .reprocess(row.id)
                                  .then((r) => {
                                    if (r.ok) {
                                      pushToast('success', '已重新识别', '请看状态是否更新为已归档')
                                      reload()
                                      refreshDashboard()
                                    } else {
                                      pushToast('warn', '重新识别失败', r.message ?? '请稍后再试')
                                    }
                                  })
                                  .catch((e) => pushToast('error', '重新识别失败', errMsg(e)))
                                  .finally(() => setRetrying(null))
                              }}
                            >
                              重新识别
                            </Button>
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
