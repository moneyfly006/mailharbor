import type { JSX } from 'react'
/** 触发规则（业务核心）：左侧关键词列表 + 右侧规则编辑器（一条规则 → N 条目标路径） */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { MatchMode, MatchScope, RecordRow, Rule, RuleInput, RuleTarget, TargetHealth } from '@shared/types'
import { Button, IconButton } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { ConfirmDialog } from '../components/Modal'
import { PageHeader } from '../components/PageHeader'
import { PathChip } from '../components/PathChip'
import { SegmentedControl } from '../components/SegmentedControl'
import { StatusBadge } from '../components/StatusBadge'
import { Switch } from '../components/Switch'
import { Field, TextField } from '../components/TextField'
import { aggregateDeliveries } from '../lib/delivery'
import {
  cls, driveOf, errMsg, fmtBytesLoose, fmtDateTime, fmtMonthDay, fmtNumber, fmtTime, usedPercent
} from '../lib/format'

function hitWhen(ts: number | null): string {
  if (ts == null) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? fmtTime(ts) : fmtMonthDay(ts)
}
import { messageStatusMeta, modeLabel, scopeLabel } from '../lib/status'
import { useApp } from '../state/app-state'
import '../styles/screens/rules.css'

const ALL_FILE_TYPES = ['zip', 'rar', '7z', 'tar', 'tar.gz', 'tgz', 'gz', 'bz2', 'xz', 'tif', 'tiff', 'jpg', 'png', 'pdf']

const PRESET_RULES: Array<{ keyword: string; path: string; required: boolean }> = [
  { keyword: '原图+手机壳', path: 'D:\\POD\\生产\\手机壳', required: true },
  { keyword: '原图+卡套', path: 'D:\\POD\\生产\\卡套', required: true },
  { keyword: '原图+浴室垫', path: 'D:\\POD\\生产\\浴室垫', required: true }
]

interface TargetDraft {
  id?: number
  path: string
  required: boolean
  health: TargetHealth | null
  freeBytes: number | null
  totalBytes: number | null
}

interface Draft {
  id: number | null
  keyword: string
  enabled: boolean
  scope: MatchScope
  mode: MatchMode
  fileTypes: string[]
  autoReply: boolean
  priority: number
  targets: TargetDraft[]
  hitMessages: number
  hitFiles: number
  lastHitAt: number | null
  updatedAt: number | null
}

function targetDraftFrom(t: RuleTarget): TargetDraft {
  return {
    id: t.id,
    path: t.path,
    required: t.required,
    health: t.lastHealth,
    freeBytes: t.freeBytes,
    totalBytes: t.totalBytes
  }
}

function draftFromRule(rule: Rule): Draft {
  return {
    id: rule.id,
    keyword: rule.keyword,
    enabled: rule.enabled,
    scope: rule.scope,
    mode: rule.mode,
    fileTypes: [...rule.fileTypes],
    autoReply: rule.autoReply,
    priority: rule.priority,
    targets: rule.targets.map(targetDraftFrom),
    hitMessages: rule.hitMessages,
    hitFiles: rule.hitFiles,
    lastHitAt: rule.lastHitAt,
    updatedAt: rule.updatedAt
  }
}

function blankDraft(priority: number): Draft {
  return {
    id: null,
    keyword: '',
    enabled: true,
    scope: 'subject',
    mode: 'exact',
    fileTypes: [...ALL_FILE_TYPES],
    autoReply: true,
    priority,
    targets: [{ path: '', required: true, health: 'unknown', freeBytes: null, totalBytes: null }],
    hitMessages: 0,
    hitFiles: 0,
    lastHitAt: null,
    updatedAt: null
  }
}

function TargetRow({
  target,
  index,
  last,
  error,
  onChange,
  onBrowse,
  onOpen,
  onRemove,
  onProbe
}: {
  target: TargetDraft
  index: number
  last: boolean
  error: boolean
  onChange: (changes: Partial<TargetDraft>) => void
  onBrowse: () => void
  onOpen: () => void
  onRemove: () => void
  onProbe: () => void
}): JSX.Element {
  const bad = target.health === 'unavailable'
  const warn = target.health === 'low_space'
  const unknown = target.health == null || target.health === 'unknown'
  const pct = usedPercent(target.freeBytes, target.totalBytes)
  const drive = driveOf(target.path)
  const hasDrive = /^[A-Za-z]:/.test(target.path)
  const editablePath = hasDrive ? target.path.slice(2) : target.path
  return (
    <div className={cls('tgt', bad && 'is-bad', warn && 'is-warn', error && 'is-error')}>
      <span className="tgt-branch">{last ? '└' : '├'}</span>
      <span className="tgt-idx">{String(index + 1).padStart(2, '0')}</span>
      <div className="tgt-path">
        {hasDrive ? <span className="drv">{drive}:</span> : null}
        <input
          className="tgt-input"
          value={editablePath}
          placeholder="D:\POD\生产\卡套"
          aria-label={`目标路径 ${index + 1}`}
          aria-invalid={error || undefined}
          onChange={(e) => onChange({ path: hasDrive ? `${drive}:${e.target.value}` : e.target.value })}
          spellCheck={false}
        />
        <button type="button" className="tgt-browse" aria-label="浏览文件夹" title="浏览文件夹" onClick={onBrowse}>
          <Icon name="folder" size={11} />
        </button>
      </div>
      <div className="tgt-space">
        {bad ? (
          <>
            <div className="sp-bad">
              <Icon name="alert" size={12} />
              磁盘未连接 · 路径不可用
            </div>
            <div className="sp-note">该路径失败不影响其他路径</div>
          </>
        ) : unknown ? (
          <div className="sp-unknown">
            <span>未检测</span>
            <span className="tiny">保存后自动检测</span>
          </div>
        ) : (
          <>
            <span className="sp-txt">
              剩余 <b>{fmtBytesLoose(target.freeBytes)}</b>{' '}
              <small>/ {fmtBytesLoose(target.totalBytes)}</small>
            </span>
            <div className="meter thin">
              <i className={cls(warn && 'warn')} style={{ width: `${pct ?? 0}%` }} />
            </div>
            {warn ? <div className="sp-warn">空间偏低，建议清理或更换路径</div> : null}
          </>
        )}
      </div>
      <span className="tgt-req" title={target.required ? '必达：失败会标记待重试' : '非必达：失败只记录、不阻塞回信'}>
        <Switch
          size="sm"
          accent
          checked={target.required}
          onChange={(checked) => onChange({ required: checked })}
          ariaLabel="必达路径"
        />
        <span style={{ color: target.required ? undefined : 'var(--ink-500)' }}>
          {target.required ? '必达' : '尽力而为'}
        </span>
      </span>
      <div className="tgt-acts">
        {bad || unknown ? (
          <Button size="sm" variant="ghost" className="tgt-probe" onClick={onProbe}>
            检测
          </Button>
        ) : null}
        <IconButton icon="folder" size={14} label="打开文件夹" tip="打开文件夹" onClick={onOpen} />
        <IconButton icon="trash" size={13} tone="danger" label="删除路径" onClick={onRemove} />
      </div>
    </div>
  )
}

export function Rules(): JSX.Element {
  const { api, pushToast, refreshDashboard, bump, refresh, navigate } = useApp()
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const dirtyRef = useRef(false)
  const [hits, setHits] = useState<RecordRow[]>([])
  const [hitsLoading, setHitsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [busyRuleId, setBusyRuleId] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [keywordError, setKeywordError] = useState<string | null>(null)
  const [pathErrors, setPathErrors] = useState<number[]>([])
  const [discardOpen, setDiscardOpen] = useState(false)
  const afterDiscard = useRef<(() => void) | null>(null)

  const setDirty = (value: boolean): void => {
    dirtyRef.current = value
    setDirtyState(value)
  }

  const load = useCallback(async (): Promise<Rule[] | null> => {
    try {
      const list = await api.rules.list()
      setRules(list)
      setLoadError(null)
      return list
    } catch (e) {
      setLoadError(errMsg(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load().then((list) => {
      if (!list) return
      setSelectedId((prev) => {
        if (prev != null && list.some((r) => r.id === prev)) return prev
        const first = list.find((r) => r.enabled) ?? list[0]
        return first ? first.id : null
      })
    })
  }, [load, refresh.rules])

  // 选中规则 → 载入草稿；列表数据刷新时，未修改的草稿同步最新健康状态
  useEffect(() => {
    if (selectedId == null) return
    const rule = rules?.find((r) => r.id === selectedId)
    if (!rule) return
    if (dirtyRef.current) return
    setDraft(draftFromRule(rule))
    setDirty(false)
    setFormError(null)
    setKeywordError(null)
    setPathErrors([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rules])

  // 本规则最近命中
  useEffect(() => {
    const rule = rules?.find((r) => r.id === selectedId)
    if (!rule?.keyword) {
      setHits([])
      return
    }
    let alive = true
    setHitsLoading(true)
    api.records
      .list({ keyword: rule.keyword, page: 1, pageSize: 3 })
      .then((res) => {
        if (alive) setHits(res.rows)
      })
      .catch(() => {
        if (alive) setHits([])
      })
      .finally(() => {
        if (alive) setHitsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api, rules, selectedId])

  const orderedRules = useMemo(
    () => [...(rules ?? [])].sort((a, b) => a.priority - b.priority),
    [rules]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orderedRules
    return orderedRules.filter((r) => r.keyword.toLowerCase().includes(q))
  }, [orderedRules, search])
  const enabledRules = filtered.filter((r) => r.enabled)
  const disabledRules = filtered.filter((r) => !r.enabled)
  const enabledCount = (rules ?? []).filter((r) => r.enabled).length
  const selectedRule = rules?.find((r) => r.id === selectedId) ?? null

  const markDraft = (changes: Partial<Draft>): void => {
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev))
    setDirty(true)
    setFormError(null)
  }

  const requestDiscardThen = (action: () => void): void => {
    if (!dirtyRef.current) {
      action()
      return
    }
    afterDiscard.current = action
    setDiscardOpen(true)
  }

  const selectRule = (id: number): void => {
    if (id === selectedId) return
    requestDiscardThen(() => {
      setSelectedId(id)
    })
  }

  const startNew = (): void => {
    requestDiscardThen(() => {
      const priority = Math.max(0, ...(rules ?? []).map((r) => r.priority)) + 1
      setSelectedId(null)
      setDraft(blankDraft(priority))
      setDirty(false)
      setHits([])
      setFormError(null)
      setKeywordError(null)
      setPathErrors([])
    })
  }

  const reorderRules = async (next: Rule[]): Promise<void> => {
    const ids = next.map((r) => r.id)
    setRules(next.map((r, i) => ({ ...r, priority: i + 1 })))
    try {
      await api.rules.reorder(ids)
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '调整优先级失败', errMsg(e))
      void load()
    }
  }

  const moveBefore = (fromId: number, toId: number): void => {
    if (fromId === toId) return
    const list = orderedRules.slice()
    const from = list.findIndex((r) => r.id === fromId)
    const to = list.findIndex((r) => r.id === toId)
    if (from < 0 || to < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    void reorderRules(list)
  }

  const moveBy = (rule: Rule, direction: -1 | 1): void => {
    const list = orderedRules.slice()
    const index = list.findIndex((r) => r.id === rule.id)
    const target = list[index + direction]
    if (!target) return
    moveBefore(rule.id, target.id)
  }

  const handleRuleKey = (rule: Rule, e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      selectRule(rule.id)
      return
    }
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      moveBy(rule, -1)
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      moveBy(rule, 1)
    }
  }

  const toggleRule = async (rule: Rule, enabled: boolean): Promise<void> => {
    setBusyRuleId(rule.id)
    setRules((prev) => (prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled } : r)) : prev))
    try {
      await api.rules.toggle(rule.id, enabled)
      bump('rules')
      refreshDashboard()
    } catch (e) {
      setRules((prev) => (prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r)) : prev))
      pushToast('error', '切换规则状态失败', errMsg(e))
    } finally {
      setBusyRuleId(null)
    }
  }

  const copyRule = async (rule: Rule): Promise<void> => {
    if (!rule) return
    try {
      const created = await api.rules.create({
        keyword: `${rule.keyword} 副本`,
        enabled: false,
        scope: rule.scope,
        mode: rule.mode,
        fileTypes: rule.fileTypes,
        autoReply: rule.autoReply,
        targets: rule.targets.map((t) => ({ path: t.path, required: t.required }))
      })
      pushToast('success', '已复制规则', `${created.keyword}（默认停用，确认后再启用）`)
      const list = await load()
      if (list) setSelectedId(created.id)
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '复制规则失败', errMsg(e))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const target = deleteTarget
    if (!target) return
    try {
      await api.rules.remove(target.id)
      pushToast('success', '规则已删除', target.keyword)
      setDeleteTarget(null)
      setSelectedId(null)
      setDirty(false)
      const list = await load()
      if (list) {
        const first = list.find((r) => r.enabled) ?? list[0]
        setSelectedId(first ? first.id : null)
      }
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '删除规则失败', errMsg(e))
    }
  }

  const disableInstead = async (): Promise<void> => {
    const target = deleteTarget
    if (!target) return
    try {
      await api.rules.toggle(target.id, false)
      pushToast('success', '规则已停用', target.keyword)
      setDeleteTarget(null)
      await load()
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '停用规则失败', errMsg(e))
    }
  }

  const probe = async (): Promise<void> => {
    setProbing(true)
    try {
      const list = await api.rules.targetsHealth()
      setRules(list)
      pushToast('success', '已重新检测目标路径')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '检测路径失败', errMsg(e))
    } finally {
      setProbing(false)
    }
  }

  const updateTarget = (index: number, changes: Partial<TargetDraft>): void => {
    setDraft((prev) => {
      if (!prev) return prev
      const targets = prev.targets.map((t, i) => (i === index ? { ...t, ...changes } : t))
      return { ...prev, targets }
    })
    setDirty(true)
    setPathErrors((prev) => prev.filter((i) => i !== index))
    setFormError(null)
  }

  const addTarget = (): void => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            targets: [
              ...prev.targets,
              { path: '', required: true, health: 'unknown', freeBytes: null, totalBytes: null }
            ]
          }
        : prev
    )
    setDirty(true)
  }

  const browseForTarget = async (index: number): Promise<void> => {
    try {
      const picked = await api.pickFolder()
      if (!picked) return
      if (index < 0) {
        setDraft((prev) =>
          prev
            ? {
                ...prev,
                targets: [
                  ...prev.targets,
                  { path: picked, required: true, health: 'unknown', freeBytes: null, totalBytes: null }
                ]
              }
            : prev
        )
        setDirty(true)
      } else {
        updateTarget(index, { path: picked, health: 'unknown', freeBytes: null, totalBytes: null })
      }
    } catch (e) {
      pushToast('error', '选择文件夹失败', errMsg(e))
    }
  }

  /** 路径数量 -1（至少保留 1 条） */
  const removeLastTarget = (): void => {
    setDraft((prev) => {
      if (!prev || prev.targets.length <= 1) return prev
      return { ...prev, targets: prev.targets.slice(0, -1) }
    })
    setDirty(true)
  }

  const removeTarget = (index: number): void => {
    setDraft((prev) => (prev ? { ...prev, targets: prev.targets.filter((_, i) => i !== index) } : prev))
    setDirty(true)
  }

  const toggleFileType = (type: string): void => {
    setDraft((prev) => {
      if (!prev) return prev
      const has = prev.fileTypes.includes(type)
      return { ...prev, fileTypes: has ? prev.fileTypes.filter((t) => t !== type) : [...prev.fileTypes, type] }
    })
    setDirty(true)
  }

  const discardChanges = (): void => {
    const rule = rules?.find((r) => r.id === selectedId)
    if (rule) {
      setDraft(draftFromRule(rule))
      setDirty(false)
      setFormError(null)
      setKeywordError(null)
      setPathErrors([])
    } else {
      setDraft(null)
      setDirty(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const keyword = draft.keyword.trim()
    if (!keyword) {
      setKeywordError('请填写关键词')
      pushToast('warn', '关键词不能为空', '规则名 = 邮件标题里的关键词')
      return
    }
    const badPaths = draft.targets.map((t, i) => (t.path.trim() ? -1 : i)).filter((i) => i >= 0)
    if (draft.targets.length === 0) {
      setFormError('至少需要一条目标路径')
      pushToast('warn', '至少需要一条目标路径')
      return
    }
    if (badPaths.length > 0) {
      setPathErrors(badPaths)
      setFormError('目标路径不能为空')
      pushToast('warn', '目标路径不能为空')
      return
    }
    if (draft.fileTypes.length === 0) {
      setFormError('请至少选择一种附件类型')
      pushToast('warn', '请至少选择一种附件类型', '不选任何类型会让这条规则永远命中却无法归档')
      return
    }
    setSaving(true)
    setFormError(null)
    setKeywordError(null)
    setPathErrors([])
    const input: RuleInput = {
      keyword,
      enabled: draft.enabled,
      scope: draft.scope,
      mode: draft.mode,
      priority: draft.priority,
      fileTypes: draft.fileTypes,
      autoReply: draft.autoReply,
      targets: draft.targets.map((t) => ({ id: t.id, path: t.path.trim(), required: t.required }))
    }
    try {
      const saved = draft.id != null ? await api.rules.update(draft.id, input) : await api.rules.create(input)
      setDirty(false)
      setSelectedId(saved.id)
      const list = await load()
      if (!list) setDraft(draftFromRule(saved))
      pushToast('success', draft.id != null ? '规则已保存' : '规则已创建', `${saved.keyword} · 改动立即生效`)
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '保存规则失败', errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  const importPresets = async (): Promise<void> => {
    try {
      let firstId: number | null = null
      for (const item of PRESET_RULES) {
        const created = await api.rules.create({
          keyword: item.keyword,
          enabled: true,
          scope: 'subject',
          mode: 'exact',
          fileTypes: ALL_FILE_TYPES,
          autoReply: true,
          targets: [{ path: item.path, required: item.required }]
        })
        if (firstId == null) firstId = created.id
      }
      pushToast('success', '已导入 3 条预设规则', '可按需修改关键词与目标路径')
      const list = await load()
      if (list && firstId != null) setSelectedId(firstId)
      bump('rules')
      refreshDashboard()
    } catch (e) {
      pushToast('error', '导入预设失败', errMsg(e))
    }
  }

  const discardDialog = (
    <ConfirmDialog
      open={discardOpen}
      danger={false}
      title="放弃未保存的改动？"
      detail="当前规则的修改尚未保存，继续操作会丢失这些改动。"
      confirmText="放弃改动"
      cancelText="继续编辑"
      onCancel={() => {
        afterDiscard.current = null
        setDiscardOpen(false)
      }}
      onConfirm={() => {
        const action = afterDiscard.current
        afterDiscard.current = null
        setDiscardOpen(false)
        setDirty(false)
        action?.()
      }}
    />
  )

  const deleteDialog = (
    <ConfirmDialog
      open={deleteTarget != null}
      title={`删除规则「${deleteTarget?.keyword ?? ''}」？`}
      subtitle={
        deleteTarget
          ? `该规则含 ${deleteTarget.targets.length} 个目标路径，累计命中 ${fmtNumber(deleteTarget.hitMessages)} 封`
          : undefined
      }
      detail={
        <>
          删除后新邮件不再按此关键词归档；
          <b>
            已下载的 {fmtNumber(deleteTarget?.hitFiles ?? 0)} 个文件和 {fmtNumber(deleteTarget?.hitMessages ?? 0)}{' '}
            条记录会保留
          </b>
          ，可以随时重建规则。
        </>
      }
      confirmText="确认删除"
      extraText="停用而不删除"
      onCancel={() => setDeleteTarget(null)}
      onExtra={() => void disableInstead()}
      onConfirm={() => void confirmDelete()}
    />
  )

  const header = (
    <PageHeader
      eyebrow="Rules Engine"
      eyebrowCn="触发规则"
      title="触发规则"
      sub={
        <>
          标题命中关键词才下载，附件会复制到该规则配置的<b>全部目标路径</b>；改动立即生效。
        </>
      }
      actions={
        <>
          <Button size="sm" icon="refresh" loading={probing} disabled={probing} onClick={() => void probe()}>
            重新检测路径
          </Button>
          <Button size="md" variant="primary" icon="plus" onClick={startNew}>
            新增关键词
          </Button>
        </>
      }
    />
  )

  if (loading && !rules) {
    return (
      <>
        {header}
        <div className="rules-wrap">
          <div className="skeleton-card" style={{ height: '100%' }} />
          <div className="skeleton-card" style={{ height: '100%' }} />
        </div>
      </>
    )
  }

  if (loadError && !rules) {
    return (
      <>
        {header}
        <ErrorState message={loadError} onRetry={() => void load()} />
      </>
    )
  }

  const totalTargets = draft?.targets.length ?? 0
  const requiredTargets = draft?.targets.filter((t) => t.required).length ?? 0

  return (
    <>
      {header}
      <div className="rules-wrap">
        {/* 左：关键词规则列表 */}
        <div className="left-col">
          <section className="card rule-list-card">
            <div className="rl-hd">
              <div className="rl-title-row">
                <h2>关键词规则</h2>
                <span className="cnt">
                  {(rules ?? []).length} 条 · {enabledCount} 启用
                </span>
              </div>
              <div className="search">
                <Icon name="search" size={14} />
                <input
                  className="search-el"
                  value={search}
                  placeholder="搜索关键词，如「卡套」"
                  aria-label="搜索关键词规则"
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => setSearch('')}>
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="rl-body">
              <div className="rg">
                {filtered.length === 0 && search ? (
                  <div className="rl-empty-hint">
                    <Icon name="search" size={13} />
                    <span>
                      没有匹配「{search}」的规则
                      <button type="button" className="link" style={{ marginLeft: 6 }} onClick={() => setSearch('')}>
                        清除搜索
                      </button>
                    </span>
                  </div>
                ) : null}

                {enabledRules.map((rule) => (
                  <div
                    key={rule.id}
                    className={cls(
                      'rule-item',
                      selectedId === rule.id && 'is-active',
                      draggingId === rule.id && 'is-dragging'
                    )}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedId === rule.id}
                    onClick={() => selectRule(rule.id)}
                    onKeyDown={(e) => handleRuleKey(rule, e)}
                    draggable
                    onDragStart={(e: DragEvent<HTMLDivElement>) => {
                      setDraggingId(rule.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(rule.id))
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const fromId = Number(e.dataTransfer.getData('text/plain')) || draggingId
                      if (fromId) moveBefore(fromId, rule.id)
                      setDraggingId(null)
                    }}
                    onDragEnd={() => setDraggingId(null)}
                  >
                    <span className="ri-grip" title="拖拽调整优先级（或聚焦后 Alt+↑/↓）">
                      <Icon name="grip" size={13} />
                    </span>
                    <div className="ri-main">
                      <div className="ri-l1">
                        <span className="ri-prio">{rule.priority}</span>
                        <span className="ri-kw">{rule.keyword}</span>
                      </div>
                      <div className="ri-meta">
                        <span className={cls('paths', rule.targets.some((t) => t.lastHealth === 'unavailable') && 'warn')}>
                          <Icon name="folder" size={11} />
                          {rule.targets.length} 个路径
                        </span>
                        · 最近 <span className="m">{hitWhen(rule.lastHitAt)}</span> · 命中{' '}
                        <span className="m">{fmtNumber(rule.hitMessages)}</span> 封
                      </div>
                    </div>
                    <div className="ri-right" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        size="sm"
                        checked={rule.enabled}
                        disabled={busyRuleId === rule.id}
                        onChange={(checked) => void toggleRule(rule, checked)}
                        ariaLabel={`${rule.enabled ? '停用' : '启用'}规则 ${rule.keyword}`}
                      />
                    </div>
                  </div>
                ))}

                {disabledRules.length > 0 ? <div className="rl-sep">已停用 · Disabled</div> : null}
                {disabledRules.map((rule) => (
                  <div
                    key={rule.id}
                    className={cls(
                      'rule-item is-off',
                      selectedId === rule.id && 'is-active',
                      draggingId === rule.id && 'is-dragging'
                    )}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedId === rule.id}
                    onClick={() => selectRule(rule.id)}
                    onKeyDown={(e) => handleRuleKey(rule, e)}
                    draggable
                    onDragStart={(e: DragEvent<HTMLDivElement>) => {
                      setDraggingId(rule.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(rule.id))
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const fromId = Number(e.dataTransfer.getData('text/plain')) || draggingId
                      if (fromId) moveBefore(fromId, rule.id)
                      setDraggingId(null)
                    }}
                    onDragEnd={() => setDraggingId(null)}
                  >
                    <span className="ri-grip" title="拖拽调整优先级">
                      <Icon name="grip" size={13} />
                    </span>
                    <div className="ri-main">
                      <div className="ri-l1">
                        <span className="ri-prio">{rule.priority}</span>
                        <span className="ri-kw">{rule.keyword}</span>
                      </div>
                      <div className="ri-meta">
                        <span className="paths">
                          <Icon name="folder" size={11} />
                          {rule.targets.length} 个路径
                        </span>
                        · 命中 <span className="m">{fmtNumber(rule.hitMessages)}</span> 封
                      </div>
                    </div>
                    <div className="ri-right" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        size="sm"
                        checked={rule.enabled}
                        disabled={busyRuleId === rule.id}
                        onChange={(checked) => void toggleRule(rule, checked)}
                        ariaLabel={`${rule.enabled ? '停用' : '启用'}规则 ${rule.keyword}`}
                      />
                    </div>
                  </div>
                ))}

                {(rules ?? []).length === 0 ? (
                  <EmptyState
                    variant="compact"
                    title="还没有任何关键词规则"
                    desc="标题命中关键词才会下载附件。先导入预设 3 条或自建一条。"
                    actions={
                      <>
                        <Button size="sm" variant="primary" icon="plus" onClick={startNew}>
                          新增关键词
                        </Button>
                        <Button size="sm" onClick={() => void importPresets()}>
                          导入预设 3 条
                        </Button>
                      </>
                    }
                  />
                ) : null}

                <button type="button" className="rl-add-row" onClick={startNew}>
                  <Icon name="plus" size={13} />
                  新增关键词规则
                </button>
              </div>
            </div>
            <div className="rl-ft">
              <span>拖拽左侧手柄调整优先级</span>
              <span style={{ marginLeft: 'auto' }} className="mono">
                按优先级从上到下执行
              </span>
            </div>
          </section>

          <div className="logic-card">
            <div className="lc-t">Rule execution · 命中后发生什么</div>
            <div className="logic-steps">
              <div>
                <b>①</b>
                <span>命中关键词 → 所有命中的启用规则都执行（一封邮件可同时装多个品类）</span>
              </div>
              <div>
                <b>②</b>
                <span>附件在白名单内 → 下载到临时目录</span>
              </div>
              <div>
                <b>③</b>
                <span>
                  复制到全部目标路径，重名加 <span className="mono">(2)</span>
                </span>
              </div>
              <div>
                <b>④</b>
                <span>必达路径全部成功 → 回信 + 记录</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右：规则编辑面板 */}
        {draft ? (
          <section className="card editor">
            <div className="ed-hd">
              <div style={{ minWidth: 0 }}>
                <div className="ed-eyebrow">
                  {draft.id != null ? `RULE ${String(draft.priority).padStart(2, '0')}` : 'NEW RULE'}
                  <span className="dotsep" />
                  优先级 {draft.priority}
                  <span className="dotsep" />
                  {scopeLabel(draft.scope)} · {modeLabel(draft.mode)}
                </div>
                <h2 className="ed-title">{draft.keyword.trim() || '新建关键词规则'}</h2>
                <div className="ed-meta">
                  累计命中 <b>{fmtNumber(draft.hitMessages)}</b> 封 · 归档 <b>{fmtNumber(draft.hitFiles)}</b> 个文件 ·
                  最近命中 <span className="mono">{draft.lastHitAt ? fmtDateTime(draft.lastHitAt) : '尚未命中'}</span>
                </div>
              </div>
              <div className="ed-actions">
                <span className={cls('enable-pill', !draft.enabled && 'is-off')}>
                  <Switch
                    size="md"
                    checked={draft.enabled}
                    onChange={(checked) => markDraft({ enabled: checked })}
                    ariaLabel="启用这条规则"
                  />
                  {draft.enabled ? '已启用' : '已停用'}
                </span>
                {draft.id != null && selectedRule ? (
                  <>
                    <IconButton
                      icon="copy"
                      label="复制规则"
                      tip="复制规则"
                      onClick={() => void copyRule(selectedRule)}
                    />
                    <IconButton
                      icon="trash"
                      tone="danger"
                      label="删除规则"
                      tip="删除规则"
                      onClick={() => setDeleteTarget(selectedRule)}
                    />
                  </>
                ) : null}
              </div>
            </div>

            <div className="ed-body">
              {/* 01 匹配条件 */}
              <section className="sec">
                <div className="sec-hd">
                  <h3>
                    <span className="num">01</span>匹配条件
                  </h3>
                  <span className="note">规则名 = 邮件标题里的关键词</span>
                </div>
                <div className="match-grid">
                  <Field label="关键词" required error={keywordError}>
                    <TextField
                      value={draft.keyword}
                      onChange={(value) => {
                        markDraft({ keyword: value })
                        setKeywordError(null)
                      }}
                      error={Boolean(keywordError)}
                      placeholder="如：原图+卡套"
                      autoFocus={draft.id == null}
                      ariaLabel="关键词"
                    />
                  </Field>
                  <div className="field">
                    <span className="label">匹配范围</span>
                    <SegmentedControl<MatchScope>
                      value={draft.scope}
                      ariaLabel="匹配范围"
                      options={[
                        { value: 'subject', label: '仅标题' },
                        { value: 'subject_body', label: '标题+正文' }
                      ]}
                      onChange={(value) => markDraft({ scope: value })}
                    />
                  </div>
                  <div className="field">
                    <span className="label">匹配方式</span>
                    <SegmentedControl<MatchMode>
                      value={draft.mode}
                      ariaLabel="匹配方式"
                      options={[
                        { value: 'exact', label: '精确' },
                        { value: 'contains', label: '包含' }
                      ]}
                      onChange={(value) => markDraft({ mode: value })}
                    />
                  </div>
                </div>
                <div className="hint-line">
                  <Icon name="alert" size={11} />
                  去空格、全半角、<span className="mono">+</span> 与 <span className="mono">＋</span>{' '}
                  视为相同；开「包含」后 <span className="mono">RE: / FWD:</span> 前缀也能命中。
                </div>
              </section>

              {/* 02 目标路径 */}
              <section className="sec">
                <div className="sec-hd">
                  <h3>
                    <span className="num">02</span>目标路径
                  </h3>
                  <span className="tgt-count" role="group" aria-label="该规则的目标路径数量">
                    <button
                      type="button"
                      className="tgt-count-btn"
                      aria-label="减少一个目标路径"
                      title="减少一个目标路径"
                      disabled={draft.targets.length <= 1}
                      onClick={removeLastTarget}
                    >
                      −
                    </button>
                    <span className="tgt-count-num">{draft.targets.length}</span>
                    <span className="tgt-count-lbl">个路径</span>
                    <button
                      type="button"
                      className="tgt-count-btn"
                      aria-label="增加一个目标路径"
                      title="增加一个目标路径"
                      onClick={addTarget}
                    >
                      +
                    </button>
                  </span>
                  <span className="note">
                    <Icon name="folder" size={12} />1 个附件 <span className="hl">→ 复制 {totalTargets} 份</span> ·{' '}
                    {requiredTargets} 份必达
                  </span>
                </div>

                <div className="tgt-list">
                  {draft.targets.length === 0 ? (
                    <div className="rl-empty-hint">
                      <Icon name="alert" size={13} />
                      <span>还没有目标路径，至少添加一条才能保存。</span>
                    </div>
                  ) : (
                    draft.targets.map((target, index) => (
                      <TargetRow
                        key={target.id ?? `new-${index}`}
                        target={target}
                        index={index}
                        last={index === draft.targets.length - 1}
                        error={pathErrors.includes(index)}
                        onChange={(changes) => updateTarget(index, changes)}
                        onBrowse={() => void browseForTarget(index)}
                        onOpen={() => {
                          if (!target.path.trim()) {
                            pushToast('warn', '路径为空', '先填写或浏览一个文件夹')
                            return
                          }
                          void api.openPath(target.path).catch((e) => pushToast('error', '打开文件夹失败', errMsg(e)))
                        }}
                        onRemove={() => removeTarget(index)}
                        onProbe={() => void probe()}
                      />
                    ))
                  )}
                </div>

                <div className="tgt-add-row">
                  <span className="dashed-line" />
                  <Button size="sm" icon="plus" onClick={addTarget}>
                    添加一条路径
                  </Button>
                  <Button size="sm" variant="ghost" icon="folder" onClick={() => void browseForTarget(-1)}>
                    浏览文件夹…
                  </Button>
                  <span className="dashed-line" />
                </div>

                <div className="tgt-note">
                  <Icon name="folder" size={13} />
                  <span>
                    <b>必达路径</b>任一失败 → 该邮件标记「待重试」，只重试失败的路径；
                    <b style={{ color: 'var(--color-danger-strong)' }}>非必达</b>
                    路径失败只记录、不阻塞回信。已写入成功的文件夹不会重复写。
                  </span>
                </div>
              </section>

              {/* 03 附件类型 + 自动回信 */}
              <section className="sec">
                <div className="two-col">
                  <div>
                    <div className="sec-hd" style={{ marginBottom: 6 }}>
                      <h3>
                        <span className="num">03</span>接收的附件类型
                      </h3>
                      <span className="note" style={{ fontFamily: 'var(--type-body)', letterSpacing: 0 }}>
                        不在白名单内的附件会被忽略
                      </span>
                    </div>
                    <div className="ftypes">
                      {ALL_FILE_TYPES.map((type) => {
                        const on = draft.fileTypes.includes(type)
                        return (
                          <button
                            key={type}
                            type="button"
                            className={cls('ftype', on && 'is-on')}
                            aria-pressed={on}
                            onClick={() => toggleFileType(type)}
                          >
                            <span className={cls('checkbox', on && 'is-checked')}>
                              {on ? <Icon name="check" size={9} /> : null}
                            </span>
                            {type.toUpperCase()}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="ar-block">
                    <div className="ar-row">
                      <Switch
                        checked={draft.autoReply}
                        onChange={(checked) => markDraft({ autoReply: checked })}
                        ariaLabel="自动回信"
                      />
                      <div>
                        <div className="t">自动回信</div>
                        <div className="d">全部必达路径写入成功后才发送</div>
                      </div>
                    </div>
                    <div className="ar-link">
                      <span>模板：</span>
                      <button type="button" className="link" onClick={() => navigate('autoreply')}>
                        在「自动回复」中编辑模板 ›
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* 04 最近命中 */}
              <section className="sec sec-hits">
                <div className="sec-hd" style={{ marginBottom: 2 }}>
                  <h3>
                    <span className="num">04</span>本规则最近命中
                  </h3>
                  <span className="note">
                    <button type="button" className="link" onClick={() => navigate('records')}>
                      全部记录 ›
                    </button>
                  </span>
                </div>
                <div className="hits-summary">
                  最近 {hits.length} 次命中 ·{' '}
                  <button type="button" className="link" onClick={() => navigate('records')}>
                    查看全部 ›
                  </button>
                </div>
                {hitsLoading ? (
                  <div className="hits">
                    <div className="hit">
                      <span className="skeleton skeleton-line" style={{ width: 40 }} />
                      <span className="skeleton skeleton-line" style={{ width: '60%' }} />
                      <span className="skeleton skeleton-line" style={{ width: 80 }} />
                    </div>
                  </div>
                ) : hits.length === 0 ? (
                  <div className="hits-empty">这条规则还没有命中记录。</div>
                ) : (
                  <div className="hits">
                    {hits.map((row) => (
                      <div className="hit" key={row.id}>
                        <span className="t">{fmtTime(row.receivedAt)}</span>
                        <span className="subj ellipsis" title={row.subject}>
                          {row.subject}
                        </span>
                        <span className="pchips">
                          {aggregateDeliveries(row).map((d) => (
                            <PathChip key={d.key} state={d.state} path={d.targetPath} dense />
                          ))}
                        </span>
                        <StatusBadge meta={messageStatusMeta(row.status)} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="ed-ft">
              <span className="save-note">
                <Icon name="shield" size={12} />
                改动立即生效 · 上次保存{' '}
                <span className="mono">{draft.updatedAt ? fmtDateTime(draft.updatedAt) : '尚未保存'}</span>
              </span>
              {formError ? <span className="hint bad">{formError}</span> : null}
              <div className="right">
                <Button size="sm" variant="ghost" onClick={discardChanges} disabled={!dirty}>
                  放弃改动
                </Button>
                <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => void saveDraft()}>
                  保存规则
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <section className="card editor editor-empty">
            <EmptyState
              title="选择左侧规则开始编辑"
              desc="或点「新增关键词」创建一条规则；一条规则可以配置多个目标路径。"
              actions={
                <>
                  <Button size="sm" variant="primary" icon="plus" onClick={startNew}>
                    新增关键词
                  </Button>
                  <Button size="sm" onClick={() => void importPresets()}>
                    导入预设 3 条
                  </Button>
                </>
              }
            />
          </section>
        )}
      </div>

      {discardDialog}
      {deleteDialog}
    </>
  )
}
