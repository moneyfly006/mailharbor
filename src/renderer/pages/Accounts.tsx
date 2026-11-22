import type { JSX } from 'react'
/** 邮箱账户：左侧账户卡列表（启用/停用/连接失败/待测试）+ 右侧手填 IMAP/SMTP 表单 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  Account, AccountInput, Encryption, ProviderPreset, ProxySettings, Settings, TestResult, TestResultLine
} from '@shared/types'
import { Button } from '../components/Button'
import { ConfirmDialog } from '../components/Modal'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Icon, type IconName } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { SegmentedControl } from '../components/SegmentedControl'
import { StatusBadge } from '../components/StatusBadge'
import { Switch } from '../components/Switch'
import { Field, PasswordField, TextField } from '../components/TextField'
import {
  cls, errMsg, fmtDate, fmtNumber, fmtTime, fmtTimeSec, parsePort
} from '../lib/format'
import { PRESETS, presetById, type PresetDef } from '../lib/presets'
import { accountStatusMeta, encryptionLabel, providerLabel } from '../lib/status'
import { useApp } from '../state/app-state'
import '../styles/screens/accounts.css'

const PROVIDER_TILE: Record<ProviderPreset, string> = {
  gmail: 'G',
  google_workspace: 'G',
  qq: 'Q',
  outlook: 'O',
  custom: '@'
}

const ENC_OPTIONS: Array<{ value: Encryption; label: string }> = [
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: '不加密' }
]

const ENC_DEFAULT_PORT: Record<Encryption, { imap: number; smtp: number }> = {
  ssl: { imap: 993, smtp: 465 },
  starttls: { imap: 143, smtp: 587 },
  none: { imap: 143, smtp: 25 }
}

interface FormState {
  id: number | null
  preset: ProviderPreset
  email: string
  displayName: string
  imapHost: string
  imapPort: string
  imapSecure: Encryption
  imapUser: string
  smtpHost: string
  smtpPort: string
  smtpSecure: Encryption
  smtpUser: string
  smtpSameAsImap: boolean
  sendOnly: boolean
  allowSelfSigned: boolean
  password: string
  smtpPassword: string
}

function blankForm(demo: boolean): FormState {
  const preset = presetById('gmail')
  return {
    id: null,
    preset: 'gmail',
    email: demo ? 'hello.haiyin.pod@gmail.com' : '',
    displayName: '',
    imapHost: preset.imapHost,
    imapPort: String(preset.imapPort),
    imapSecure: preset.imapSecure,
    imapUser: demo ? 'hello.haiyin.pod@gmail.com' : '',
    smtpHost: preset.smtpHost,
    smtpPort: String(preset.smtpPort),
    smtpSecure: preset.smtpSecure,
    smtpUser: demo ? 'hello.haiyin.pod@gmail.com' : '',
    smtpSameAsImap: true,
    sendOnly: false,
    allowSelfSigned: false,
    password: demo ? 'demoapppassword1' : '',
    smtpPassword: ''
  }
}

function formFromAccount(account: Account): FormState {
  return {
    id: account.id,
    preset: account.preset,
    email: account.email,
    displayName: account.displayName,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapSecure: account.imapSecure,
    imapUser: account.imapUser,
    smtpHost: account.smtpHost,
    smtpPort: String(account.smtpPort),
    smtpSecure: account.smtpSecure,
    smtpUser: account.smtpUser,
    smtpSameAsImap: account.smtpSameAsImap,
    sendOnly: account.sendOnly,
    allowSelfSigned: account.allowSelfSigned,
    password: '',
    smtpPassword: ''
  }
}

function ServerChip({
  protocol,
  host,
  port,
  secure,
  dim
}: {
  protocol: 'imap' | 'smtp'
  host: string
  port: number
  secure: Encryption
  dim?: boolean
}): JSX.Element {
  return (
    <span className={cls('srv', dim && 'dim')}>
      <Icon name={protocol === 'imap' ? 'serverDown' : 'serverUp'} size={11} />
      <b>{protocol.toUpperCase()}</b> {host}:{port} · {encryptionLabel(secure)}
    </span>
  )
}

function AccountCard({
  account,
  busy,
  onTest,
  onEdit,
  onCheck,
  onToggle,
  onDelete
}: {
  account: Account
  busy: boolean
  onTest: () => void
  onEdit: () => void
  onCheck: () => void
  onToggle: () => void
  onDelete: () => void
}): JSX.Element {
  const meta = accountStatusMeta(account.status)
  const bad = account.status === 'auth_failed' || account.status === 'conn_failed'
  const off = account.status === 'disabled'
  const pending = account.status === 'pending_test'
  const offline = account.status === 'offline'
  const isGmailLike = account.preset === 'gmail' || account.preset === 'google_workspace'
  const clsName = cls(
    'acct',
    account.status === 'enabled' && 'is-ok',
    bad && 'is-bad',
    off && 'is-off',
    pending && 'is-pending',
    offline && 'is-warn'
  )

  return (
    <article className={clsName}>
      <div className="acct-hd">
        <span className="acct-tile">{PROVIDER_TILE[account.preset]}</span>
        <div className="acct-main">
          <div className="acct-addr" title={account.email}>
            {account.email}
          </div>
          <div className="acct-meta">
            {providerLabel(account.preset)} · {account.displayName} · 添加于 {fmtDate(account.createdAt)}
          </div>
        </div>
        <StatusBadge meta={meta} />
        <div className="acct-actions">
          {bad ? (
            <Button size="sm" variant="primary" icon="pencil" onClick={onCheck}>
              检查设置
            </Button>
          ) : null}
          <Button size="sm" icon="refresh" loading={busy} onClick={onTest}>
            测试连接
          </Button>
          {off ? (
            <>
              <Button size="sm" icon="play" onClick={onToggle}>
                启用
              </Button>
              <Button size="sm" variant="danger" onClick={onDelete}>
                删除
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={onEdit}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={onToggle}>
                停用
              </Button>
            </>
          )}
        </div>
      </div>

      {bad ? (
        <div className="acct-alert">
          <Icon name="alert" size={14} />
          <div>
            <b>{account.lastError ?? 'IMAP 登录被拒绝：用户名或密码不正确'}</b>
            <span className="sub">
              {isGmailLike
                ? 'Gmail 请填「应用专用密码」（16 位），不是登录密码；改好后点「测试连接」即恢复并补收。'
                : '请核对账号、密码/授权码与服务器设置；改好后点「测试连接」恢复。'}
            </span>
          </div>
        </div>
      ) : null}

      {offline ? (
        <div className="acct-alert is-warn">
          <Icon name="alert" size={14} />
          <div>
            <b>网络不可达</b>
            <span className="sub">出站网络暂时不通，程序会自动重试，不会打扰操作。</span>
          </div>
        </div>
      ) : null}

      {pending ? (
        <div className="acct-alert is-info">
          <Icon name="info" size={14} />
          <div>
            <b>待测试</b>
            <span className="sub">刚添加或刚改过设置。测试连接通过后才会开始收信。</span>
          </div>
        </div>
      ) : null}

      <div className="srv-row">
        <ServerChip
          protocol="imap"
          host={account.imapHost}
          port={account.imapPort}
          secure={account.imapSecure}
          dim={bad || off}
        />
        <ServerChip
          protocol="smtp"
          host={account.smtpHost}
          port={account.smtpPort}
          secure={account.smtpSecure}
          dim={bad || off}
        />
        {bad && account.lastCheckAt ? (
          <span className="mono srv-error-time">最后错误 {fmtTimeSec(account.lastCheckAt)}</span>
        ) : null}
      </div>

      <div className="acct-stats">
        {bad ? (
          <>
            <div>
              <span className="k">今日收件</span>
              <span className="v bad">0 封</span>
            </div>
            <div>
              <span className="k">累计归档</span>
              <span className="v">{fmtNumber(account.totalFiles)} 个文件</span>
            </div>
            <div>
              <span className="k">上次成功</span>
              <span className="v dim">{account.lastOkAt ? fmtTime(account.lastOkAt) : '—'}</span>
            </div>
            <div>
              <span className="k">失败原因</span>
              <span className="v bad">{account.lastErrorCode ? `密码错误（${account.lastErrorCode}）` : '连接失败'}</span>
            </div>
          </>
        ) : off ? (
          <>
            <div>
              <span className="k">停用前累计</span>
              <span className="v">{fmtNumber(account.totalFiles)} 个文件</span>
            </div>
            <div>
              <span className="k">服务器设置</span>
              <span className="v dim">保留，重新启用无需重填</span>
            </div>
            <div>
              <span className="k">停用于</span>
              <span className="v dim">{fmtDate(account.updatedAt)}</span>
            </div>
          </>
        ) : pending ? (
          <>
            <div>
              <span className="k">今日收件</span>
              <span className="v">0 封</span>
            </div>
            <div>
              <span className="k">累计归档</span>
              <span className="v">{fmtNumber(account.totalFiles)} 个文件</span>
            </div>
            <div>
              <span className="k">最近一次测试</span>
              <span className="v dim">尚未测试</span>
            </div>
          </>
        ) : (
          <>
            <div>
              <span className="k">今日收件</span>
              <span className="v">{fmtNumber(account.todayCount)} 封</span>
            </div>
            <div>
              <span className="k">累计归档</span>
              <span className="v">{fmtNumber(account.totalFiles)} 个文件</span>
            </div>
            <div>
              <span className="k">上次检查</span>
              <span className="v">{account.lastCheckAt ? fmtTimeSec(account.lastCheckAt) : '—'}</span>
            </div>
            <div>
              <span className="k">上次成功</span>
              <span className={cls('v', account.lastOkAt ? 'ok' : 'dim')}>
                {account.lastOkAt ? fmtTimeSec(account.lastOkAt) : '—'}
              </span>
            </div>
          </>
        )}
      </div>
    </article>
  )
}

function TestLine({ protocol, line, fallbackHost }: { protocol: 'imap' | 'smtp'; line?: TestResultLine; fallbackHost: string }): JSX.Element {
  return (
    <div className="test-line">
      <span className="tag">{protocol.toUpperCase()}</span>
      {line ? (
        <>
          <span className={cls('res', line.ok ? 'ok' : 'bad')}>
            <Icon name={line.ok ? 'check' : 'x'} size={11} />
            {line.ok ? '登录成功' : line.message ?? '连接失败'}
          </span>
          <span style={{ color: 'var(--color-text-quaternary)' }}>
            {line.host}:{line.port}
          </span>
          <span className="ms">{line.ok ? `${line.latencyMs} ms` : line.errorCode ?? ''}</span>
        </>
      ) : (
        <>
          <span className="res" style={{ color: 'var(--color-text-quaternary)' }}>
            尚未测试
          </span>
          <span style={{ color: 'var(--color-text-quaternary)' }}>{fallbackHost}</span>
        </>
      )}
    </div>
  )
}

export function Accounts(): JSX.Element {
  const { api, demo, pushToast, refreshDashboard, bump, refresh } = useApp()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => blankForm(demo))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [test, setTest] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)
  const [faqOpen, setFaqOpen] = useState(false)
  const [autoFocusField, setAutoFocusField] = useState<'email' | 'password' | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [proxy, setProxy] = useState<ProxySettings>({ mode: 'system', host: '127.0.0.1', port: 7890 })
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyResult, setProxyResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [proxySaving, setProxySaving] = useState(false)

  const preset = useMemo<PresetDef>(() => presetById(form.preset), [form.preset])
  const editing = form.id != null
  const storedPassword = useMemo(() => {
    if (form.id == null) return false
    return accounts?.find((a) => a.id === form.id)?.hasPassword ?? false
  }, [accounts, form.id])

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([api.accounts.list(), api.settings.get()])
      setSettings(s)
      setProxy(s.proxy ?? { mode: 'system', host: '127.0.0.1', port: 7890 })
      setAccounts(list)
      setLoadError(null)
    } catch (e) {
      setLoadError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load, refresh.accounts])

  const resetForm = useCallback(() => {
    setForm(blankForm(demo))
    setTest(null)
    setTestError(null)
    setErrors({})
    setAutoFocusField('email')
  }, [demo])

  const update = (changes: Partial<FormState>): void => {
    setForm((prev) => ({ ...prev, ...changes }))
    setTest(null)
    setErrors({})
  }

  // 设计稿中「账号（邮箱地址）」就是邮箱地址本身，二者保持同步（真实后端 AccountInput 需要 email）
  const handleImapUser = (value: string): void => {
    setForm((prev) => {
      const next: FormState = { ...prev, email: value, imapUser: value }
      if (prev.smtpSameAsImap) next.smtpUser = value
      return next
    })
    setTest(null)
    setErrors({})
  }

  const applyPreset = (id: ProviderPreset): void => {
    const p = presetById(id)
    setForm((prev) => ({
      ...prev,
      preset: id,
      imapHost: p.imapHost,
      imapPort: String(p.imapPort),
      imapSecure: p.imapSecure,
      smtpHost: p.smtpHost,
      smtpPort: String(p.smtpPort),
      smtpSecure: p.smtpSecure,
      smtpUser: prev.smtpSameAsImap ? prev.imapUser : prev.smtpUser
    }))
    setTest(null)
    setErrors({})
  }

  const setImapSecure = (value: Encryption): void =>
    update({ imapSecure: value, imapPort: String(ENC_DEFAULT_PORT[value].imap) })

  const setSmtpSecure = (value: Encryption): void =>
    update({ smtpSecure: value, smtpPort: String(ENC_DEFAULT_PORT[value].smtp) })

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {}
    if (!form.email.trim()) next.email = '请填写邮箱地址'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = '邮箱地址格式不正确'
    if (!form.sendOnly) {
      if (!form.imapHost.trim()) next.imapHost = '请填写收件服务器地址（只发信的账户请勾选「仅发件」）'
      if (parsePort(form.imapPort) == null) next.imapPort = '端口需为 1–65535'
      if (!form.imapUser.trim()) next.imapUser = '请填写收件账号'
    }
    if (!form.smtpHost.trim()) next.smtpHost = '请填写发件服务器地址'
    if (parsePort(form.smtpPort) == null) next.smtpPort = '端口需为 1–65535'
    if (!form.smtpSameAsImap && !form.smtpUser.trim()) next.smtpUser = '请填写发件账号'
    if (!form.password && !storedPassword) next.password = '请填写密码 / 授权码'
    if (!form.smtpSameAsImap && !form.smtpPassword && !editing) next.smtpPassword = '请填写发件密码'
    return next
  }

  const buildInput = (): AccountInput => ({
    preset: form.preset,
    email: form.email.trim(),
    displayName: form.displayName.trim() || undefined,
    imapHost: form.imapHost.trim(),
    imapPort: parsePort(form.imapPort) ?? preset.imapPort,
    imapSecure: form.imapSecure,
    imapUser: form.imapUser.trim(),
    smtpHost: form.smtpHost.trim(),
    smtpPort: parsePort(form.smtpPort) ?? preset.smtpPort,
    smtpSecure: form.smtpSecure,
    smtpUser: form.smtpSameAsImap ? form.imapUser.trim() : form.smtpUser.trim(),
    smtpSameAsImap: form.smtpSameAsImap,
    sendOnly: form.sendOnly,
    allowSelfSigned: form.allowSelfSigned,
    password: form.password || undefined,
    smtpPassword: form.smtpSameAsImap ? form.password || undefined : form.smtpPassword || undefined
  })

  const runTest = async (): Promise<void> => {
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      pushToast('warn', '请先补全表单', Object.values(errs)[0])
      return
    }
    setTesting(true)
    setTestError(null)
    try {
      const res =
        editing && !form.password
          ? await api.accounts.testSaved(form.id as number)
          : await api.accounts.test(buildInput())
      setTest(res)
      if (res.ok) {
        pushToast('success', '连接测试通过', 'IMAP 与 SMTP 均登录成功')
      } else {
        const badLine = res.lines.find((l) => !l.ok)
        pushToast('error', '连接测试未通过', badLine?.message ?? '请检查服务器设置与密码')
      }
    } catch (e) {
      setTestError(errMsg(e))
      pushToast('error', '测试连接失败', errMsg(e))
    } finally {
      setTesting(false)
    }
  }

  const save = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      pushToast('warn', '请先补全表单', Object.values(errs)[0])
      return
    }
    if (!test?.ok) {
      pushToast('warn', '请先通过连接测试', 'IMAP 与 SMTP 两项都通过才能保存并启用')
      return
    }
    setSaving(true)
    try {
      const input = buildInput()
      const saved = editing
        ? await api.accounts.update(form.id as number, input)
        : await api.accounts.create(input)
      try {
        await api.accounts.toggle(saved.id, true)
      } catch {
        /* 保存成功但启用失败时，账户仍保留为待测试 */
      }
      pushToast('success', editing ? '账户已更新并启用' : '已保存并启用', form.email.trim())
      resetForm()
      await load()
      refreshDashboard()
      bump('accounts')
    } catch (err) {
      pushToast('error', '保存失败', errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  const editAccount = (account: Account, focusPassword = false): void => {
    setForm(formFromAccount(account))
    setTest(null)
    setTestError(null)
    setErrors({})
    setAutoFocusField(focusPassword ? 'password' : null)
  }

  const toggleAccount = async (account: Account): Promise<void> => {
    setBusyId(account.id)
    try {
      const next = await api.accounts.toggle(account.id, !account.enabled)
      pushToast('success', next.enabled ? '账户已启用' : '账户已停用', account.email)
      await load()
      refreshDashboard()
    } catch (err) {
      pushToast('error', '切换账户状态失败', errMsg(err))
    } finally {
      setBusyId(null)
    }
  }

  const testAccount = async (account: Account): Promise<void> => {
    setBusyId(account.id)
    try {
      const res = await api.accounts.testSaved(account.id)
      if (res.ok) {
        pushToast('success', '连接测试通过', `${account.email} · IMAP / SMTP 均通过`)
      } else {
        const badLine = res.lines.find((l) => !l.ok)
        pushToast('error', `${account.email} 连接失败`, badLine?.message ?? '请检查服务器设置')
      }
      await load()
      refreshDashboard()
    } catch (err) {
      pushToast('error', '测试连接失败', errMsg(err))
    } finally {
      setBusyId(null)
    }
  }

  const testAll = async (): Promise<void> => {
    const list = accounts ?? []
    if (list.length === 0) return
    setTestingAll(true)
    let ok = 0
    for (const account of list) {
      try {
        const res = await api.accounts.testSaved(account.id)
        if (res.ok) ok += 1
      } catch {
        /* 单个失败继续测下一个 */
      }
    }
    pushToast(ok === list.length ? 'success' : 'warn', `已测试 ${list.length} 个账户`, `${ok} 个通过 · ${list.length - ok} 个需要检查`)
    await load()
    refreshDashboard()
    setTestingAll(false)
  }

  const deleteAccount = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await api.accounts.remove(deleteTarget.id)
      pushToast('success', '账户已删除', deleteTarget.email)
      if (form.id === deleteTarget.id) resetForm()
      setDeleteTarget(null)
      await load()
      refreshDashboard()
    } catch (err) {
      pushToast('error', '删除账户失败', errMsg(err))
    }
  }

  const enabledCount = (accounts ?? []).filter((a) => a.enabled).length
  const failedCount = (accounts ?? []).filter((a) => a.status === 'auth_failed' || a.status === 'conn_failed').length

  const testProxyNow = async (): Promise<void> => {
    setProxyTesting(true)
    setProxyResult(null)
    try {
      const r = await api.settings.testProxy(proxy)
      setProxyResult({ ok: r.ok, message: r.message })
    } catch (e) {
      setProxyResult({ ok: false, message: errMsg(e) })
    } finally {
      setProxyTesting(false)
    }
  }

  const saveProxy = async (): Promise<void> => {
    if (!settings) return
    setProxySaving(true)
    try {
      const saved = await api.settings.save({ ...settings, proxy })
      setSettings(saved)
      pushToast('success', '网络代理已保存', '下一次收信/回信立即生效')
      void refreshDashboard()
    } catch (e) {
      pushToast('error', '保存失败', errMsg(e))
    } finally {
      setProxySaving(false)
    }
  }

  const header = (
    <PageHeader
      eyebrow="Accounts"
      eyebrowCn="邮箱账户"
      title="邮箱账户"
      sub="邮箱不写死：收信用 IMAP、回信用 SMTP，全部手填。随时可换一个邮箱，旧账户停用后立即停止收件。"
      actions={
        <>
          <Button size="sm" icon="refresh" loading={testingAll} disabled={testingAll || !accounts?.length} onClick={testAll}>
            全部测试连接
          </Button>
          <Button size="md" variant="primary" icon="plus" onClick={resetForm}>
            添加邮箱账户
          </Button>
        </>
      }
    />
  )

  const proxyCard = (
    <section className="card proxy-card" aria-label="网络代理">
      <button type="button" className="proxy-hd" onClick={() => setProxyOpen((v) => !v)}>
        <Icon name="serverUp" size={14} />
        <span className="proxy-title">网络代理</span>
        <span className="proxy-state">
          {proxy.mode === 'none'
            ? '不使用代理（直连）'
            : proxy.mode === 'system'
              ? '跟随系统代理'
              : `${proxy.mode.toUpperCase()} ${proxy.host}:${proxy.port}`}
        </span>
        <span className="proxy-hint">国内访问 Gmail 需要代理；国外可设为「不使用」</span>
        <span className="proxy-toggle">{proxyOpen ? '收起' : '设置'}</span>
      </button>
      {proxyOpen ? (
        <div className="proxy-bd">
          <div className="proxy-row">
            <SegmentedControl
              value={proxy.mode}
              onChange={(mode: string) => {
                setProxy((p: ProxySettings) => ({ ...p, mode: mode as ProxySettings['mode'] }))
                setProxyResult(null)
              }}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'none', label: '不使用' },
                { value: 'socks5', label: 'SOCKS5' },
                { value: 'http', label: 'HTTP' }
              ]}
              ariaLabel="代理模式"
            />
            {proxy.mode === 'socks5' || proxy.mode === 'http' ? (
              <div className="proxy-addr">
                <TextField
                  value={proxy.host}
                  onChange={(host) => setProxy((p: ProxySettings) => ({ ...p, host }))}
                  placeholder="127.0.0.1"
                  ariaLabel="代理地址"
                />
                <span className="proxy-colon">:</span>
                <TextField
                  value={String(proxy.port)}
                  onChange={(v) => {
                    const n = Number(v.replace(/[^\d]/g, ''))
                    setProxy((p: ProxySettings) => ({ ...p, port: Number.isFinite(n) ? Math.min(65535, n) : 0 }))
                  }}
                  placeholder="7890"
                  mono
                  ariaLabel="代理端口"
                />
              </div>
            ) : null}
            <Button size="sm" icon="refresh" loading={proxyTesting} onClick={() => void testProxyNow()}>
              测试代理
            </Button>
            <Button size="sm" variant="primary" loading={proxySaving} onClick={() => void saveProxy()}>
              保存
            </Button>
          </div>
          {proxyResult ? (
            <div className={cls('proxy-result', proxyResult.ok ? 'is-ok' : 'is-bad')}>
              <Icon name={proxyResult.ok ? 'check' : 'alert'} size={12} />
              <span>{proxyResult.message}</span>
            </div>
          ) : null}
          <div className="proxy-note">
            软件默认「跟随系统代理」：自动读取系统代理设置（macOS 系统设置 / Windows Internet 选项 / 环境变量）。
            国内不挂代理时 Gmail 的 IMAP 993 通常连不上，会提示「连接超时」。
          </div>
        </div>
      ) : null}
    </section>
  )

  const imapLine = test?.lines.find((l) => l.protocol === 'imap')
  const smtpLine = test?.lines.find((l) => l.protocol === 'smtp')
  const testPassed = test?.ok === true
  const unsupported = !preset.supported

  return (
    <>
      {header}
      {proxyCard}

      <div className="acct-wrap">
        <div className="left-col">
          <div className="section-title">
            <h2>已添加账户</h2>
            <span className="cnt">
              {accounts?.length ?? 0} 个 · {enabledCount} 个在用{failedCount > 0 ? ` · ${failedCount} 个连接失败` : ''}
            </span>
            <div className="right">
              <StatusBadge tone="neutral">收件 IMAP · 回信 SMTP</StatusBadge>
            </div>
          </div>

          {loading ? (
            <>
              <div className="skeleton-card" style={{ height: 130 }} />
              <div className="skeleton-card" style={{ height: 130 }} />
              <div className="skeleton-card" style={{ height: 100 }} />
            </>
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={load} />
          ) : (accounts ?? []).length === 0 ? (
            <EmptyState
              title="还没有邮箱账户"
              desc="添加一个邮箱后开始收信。收信用 IMAP，回信用 SMTP。"
              actions={
                <Button size="sm" variant="primary" icon="plus" onClick={resetForm}>
                  添加邮箱账户
                </Button>
              }
            />
          ) : (
            (accounts ?? []).map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                busy={busyId === account.id}
                onTest={() => void testAccount(account)}
                onEdit={() => editAccount(account)}
                onCheck={() => editAccount(account, true)}
                onToggle={() => void toggleAccount(account)}
                onDelete={() => setDeleteTarget(account)}
              />
            ))
          )}

          <div className="mini-card">
            <span className="m-ico">
              <Icon name="shield" size={15} />
            </span>
            <div>
              <div className="m-t">密码只保存在这台电脑上</div>
              <div className="m-d">
                IMAP / SMTP 密码用 Windows DPAPI 加密存本机，不上传服务器；日志与导出均不打印密码。
              </div>
            </div>
          </div>

          <div className="faq-card">
            <button
              type="button"
              className="faq-hd"
              aria-expanded={faqOpen}
              onClick={() => setFaqOpen((v) => !v)}
            >
              <span className="t">常见问题 · 收不到邮件先看这里</span>
              <span className="note">3 条 · {faqOpen ? '收起' : '展开'}</span>
              <Icon name={faqOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            </button>
            {faqOpen ? (
              <div className="faq-list">
                <div className="faq-item">
                  <Icon name="chevronRight" size={13} />
                  <div>
                    <div className="q">Gmail：怎么拿「应用专用密码」？</div>
                    <div className="a">Google 账号 → 安全性 → 两步验证 → 应用专用密码，生成 16 位密码。</div>
                  </div>
                </div>
                <div className="faq-item">
                  <Icon name="chevronRight" size={13} />
                  <div>
                    <div className="q">QQ 邮箱：「授权码」在哪里？</div>
                    <div className="a">
                      设置 → 账户 → 开启 <span className="mono">IMAP/SMTP</span> 服务，短信验证后得到 16 位授权码。
                    </div>
                  </div>
                </div>
                <div className="faq-item">
                  <Icon name="chevronRight" size={13} />
                  <div>
                    <div className="q">公司网络封了 993 / 465 端口？</div>
                    <div className="a">
                      改用 <span className="mono">STARTTLS</span>（IMAP 143 / SMTP 587），或让 IT 放行出站端口。
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <form className="card form-card" onSubmit={save} aria-label={editing ? '编辑邮箱账户' : '添加邮箱账户'}>
          <div className="fm-hd">
            <div style={{ minWidth: 0 }}>
              <h2>{editing ? '编辑邮箱账户' : '添加邮箱账户'}</h2>
              <div className="sub">选服务商自动填服务器，再填账号与应用专用密码；收发可同号也可分开。</div>
            </div>
            <span className="badge badge-info fm-preset">{preset.fullLabel}</span>
          </div>

          <div className="fm-bd">
            <div className="preset-row">
              <span className="lbl">服务商</span>
              <div className="preset-seg" role="group" aria-label="服务商预设">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cls('preset', form.preset === p.id && 'is-active')}
                    aria-pressed={form.preset === p.id}
                    onClick={() => applyPreset(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {unsupported ? (
              <div className="preset-warn">
                <Icon name="alert" size={12} />
                <span>{preset.unsupportedReason}</span>
              </div>
            ) : (
              <div className="preset-hint">
                <Icon name="check" size={10} />
                <span>
                  已自动填入 <span className="mono">{preset.imapHost}:{preset.imapPort}</span> 与{' '}
                  <span className="mono">{preset.smtpHost}:{preset.smtpPort}</span>（
                  {encryptionLabel(preset.imapSecure)}），下方均可手改。
                </span>
              </div>
            )}

            {/* 仅发件开关：阿里云 DirectMail 这类只有 SMTP、没有收件箱的服务 */}
            <div className="sendonly-row">
              <Switch
                checked={form.sendOnly}
                onChange={(v) => update({ sendOnly: v })}
                ariaLabel="此邮箱只用于发信"
              />
              <div>
                <div className="lbl">此邮箱只用于发信（没有收件箱）</div>
                <div className="sub">
                  阿里云 DirectMail、SendGrid 等「邮件推送」服务只能发信；收件请另配一个 Gmail / QQ 账户。
                </div>
              </div>
            </div>

            {/* 01 收件 IMAP */}
            <div className="srv-block" style={form.sendOnly ? { display: 'none' } : undefined}>
              <div className="srv-block-hd">
                <span className="idx">01</span>
                <Icon name="serverDown" size={11} />
                <span className="t">收件服务器</span>
                <span className="role">IMAP</span>
                <div className="right">
                  <StatusBadge tone="ok">收信</StatusBadge>
                </div>
              </div>
              <div className="fm-row">
                <Field label="服务器地址" error={errors.imapHost} className="grow">
                  <TextField
                    value={form.imapHost}
                    onChange={(v) => update({ imapHost: v })}
                    error={Boolean(errors.imapHost)}
                    mono
                    placeholder="imap.example.com"
                    ariaLabel="收件服务器地址"
                  />
                </Field>
                <Field label="端口" error={errors.imapPort} className="narrow">
                  <TextField
                    value={form.imapPort}
                    onChange={(v) => update({ imapPort: v.replace(/[^\d]/g, '') })}
                    error={Boolean(errors.imapPort)}
                    mono
                    inputMode="numeric"
                    maxLength={5}
                    placeholder="993"
                    ariaLabel="收件服务器端口"
                  />
                </Field>
              </div>
              <div className="fm-row" style={{ alignItems: 'flex-start' }}>
                <div className="field">
                  <span className="label">加密方式</span>
                  <div className="enc-seg" role="group" aria-label="收件加密方式">
                    {ENC_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={cls('enc', form.imapSecure === o.value && 'is-active')}
                        aria-pressed={form.imapSecure === o.value}
                        onClick={() => setImapSecure(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="fm-inline-hint">
                  {form.imapSecure === 'ssl' ? '993 端口固定用 SSL/TLS' : 'STARTTLS 端口通常为 143'}
                </span>
              </div>
              <div className="fm-row">
                <Field label="账号（邮箱地址）" error={errors.imapUser} className="grow">
                  <TextField
                    value={form.imapUser}
                    onChange={handleImapUser}
                    error={Boolean(errors.imapUser)}
                    placeholder="you@example.com"
                    autoFocus={autoFocusField === 'email'}
                    ariaLabel="收件账号"
                  />
                </Field>
                <Field label={`密码（${preset.passwordLabel}）`} error={errors.password} className="grow">
                  <PasswordField
                    value={form.password}
                    onChange={(v) => update({ password: v })}
                    error={Boolean(errors.password)}
                    placeholder={storedPassword ? '留空表示不修改' : '请输入密码 / 授权码'}
                    autoFocus={autoFocusField === 'password'}
                    ariaLabel="收件密码"
                  />
                </Field>
              </div>
              <div className="fm-hint">
                <Icon name="alert" size={10} />
                <span>{preset.passwordHint}</span>
              </div>
            </div>

            <div className="sendonly-row">
              <Switch
                checked={form.allowSelfSigned}
                onChange={(v) => update({ allowSelfSigned: v })}
                ariaLabel="允许自签名证书"
              />
              <div>
                <div className="lbl">允许自签名证书</div>
                <div className="sub">企业自建 IMAP / SMTP 常见；公共邮箱（Gmail/QQ/阿里云）不要打开。</div>
              </div>
            </div>

            {/* 02 发件 SMTP */}
            <div className="srv-block">
              <div className="srv-block-hd">
                <span className="idx">02</span>
                <Icon name="serverUp" size={11} />
                <span className="t">发件服务器</span>
                <span className="role">SMTP</span>
                <div className="right">
                  <Switch
                    checked={form.smtpSameAsImap}
                    onChange={(checked) =>
                      update({
                        smtpSameAsImap: checked,
                        smtpUser: checked ? form.imapUser : form.smtpUser
                      })
                    }
                    size="md"
                    label="与收件相同账号"
                    ariaLabel="与收件相同账号"
                  />
                  <StatusBadge tone="accent">回信</StatusBadge>
                </div>
              </div>
              <div className="fm-row">
                <Field label="服务器地址" error={errors.smtpHost} className="grow">
                  <TextField
                    value={form.smtpHost}
                    onChange={(v) => update({ smtpHost: v })}
                    error={Boolean(errors.smtpHost)}
                    mono
                    placeholder="smtp.example.com"
                    ariaLabel="发件服务器地址"
                  />
                </Field>
                <Field label="端口" error={errors.smtpPort} className="narrow">
                  <TextField
                    value={form.smtpPort}
                    onChange={(v) => update({ smtpPort: v.replace(/[^\d]/g, '') })}
                    error={Boolean(errors.smtpPort)}
                    mono
                    inputMode="numeric"
                    maxLength={5}
                    placeholder="465"
                    ariaLabel="发件服务器端口"
                  />
                </Field>
              </div>
              <div className="fm-row" style={{ alignItems: 'flex-start' }}>
                <div className="field">
                  <span className="label">加密方式</span>
                  <div className="enc-seg" role="group" aria-label="发件加密方式">
                    {ENC_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={cls('enc', form.smtpSecure === o.value && 'is-active')}
                        aria-pressed={form.smtpSecure === o.value}
                        onClick={() => setSmtpSecure(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="fm-inline-hint">
                  {form.smtpSecure === 'ssl' ? '465 配 SSL/TLS，587 配 STARTTLS' : 'STARTTLS 端口通常为 587'}
                </span>
              </div>
              <div className="fm-row">
                <Field
                  label={form.smtpSameAsImap ? '账号 / 密码' : '发件账号'}
                  error={errors.smtpUser}
                  className="grow"
                >
                  <TextField
                    value={form.smtpSameAsImap ? form.imapUser : form.smtpUser}
                    onChange={(v) => update({ smtpUser: v })}
                    disabled={form.smtpSameAsImap}
                    placeholder={form.smtpSameAsImap ? '沿用 01 账号' : 'you@example.com'}
                    ariaLabel="发件账号"
                  />
                </Field>
                <Field
                  label={form.smtpSameAsImap ? '发件密码' : `发件密码（${preset.passwordLabel}）`}
                  error={errors.smtpPassword}
                  className="grow"
                >
                  {form.smtpSameAsImap ? (
                    <TextField
                      value="沿用 01 账号"
                      onChange={() => undefined}
                      disabled
                      ariaLabel="发件密码沿用收件密码"
                    />
                  ) : (
                    <PasswordField
                      value={form.smtpPassword}
                      onChange={(v) => update({ smtpPassword: v })}
                      error={Boolean(errors.smtpPassword)}
                      placeholder={editing ? '留空表示不修改' : '请输入发件密码'}
                      ariaLabel="发件密码"
                    />
                  )}
                </Field>
              </div>
              <div className="fm-hint">
                <Icon name="alert" size={10} />
                <span>关掉「与收件相同账号」可单独填发件账号；465 配 SSL/TLS，587 配 STARTTLS。</span>
              </div>
            </div>

            {/* 连接测试 */}
            <div className="test-zone">
              <div className="test-top">
                <span className="test-title">
                  连接测试 {test ? <span className="mono">{fmtTimeSec(test.testedAt)}</span> : null}
                </span>
                <Button
                  size="sm"
                  icon="refresh"
                  loading={testing}
                  disabled={unsupported || testing}
                  onClick={() => void runTest()}
                >
                  测试连接
                </Button>
              </div>
              <TestLine protocol="imap" line={imapLine} fallbackHost={`${form.imapHost}:${form.imapPort}`} />
              <TestLine protocol="smtp" line={smtpLine} fallbackHost={`${form.smtpHost}:${form.smtpPort}`} />
              {testError ? (
                <div className="test-note" style={{ color: 'var(--color-danger)' }}>
                  {testError}
                </div>
              ) : (
                <div className="test-note">
                  失败会写明原因：<span className="mono">535 认证失败</span> / <span className="mono">IMAP 未开启</span> /{' '}
                  <span className="mono">端口超时</span>；两项都通过才能保存。
                </div>
              )}
            </div>
          </div>

          <div className="fm-ft">
            <span className="safe">
              <Icon name="shield" size={12} />
              密码仅存本机 · DPAPI 加密
            </span>
            <div className="right">
              <Button size="sm" variant="ghost" onClick={resetForm}>
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                type="submit"
                loading={saving}
                disabled={saving || !testPassed || unsupported}
                title={!testPassed ? '两项测试都通过后才能保存' : undefined}
              >
                保存并启用
              </Button>
            </div>
          </div>
        </form>
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        title={`删除账户「${deleteTarget?.email ?? ''}」？`}
        subtitle={deleteTarget ? `${providerLabel(deleteTarget.preset)} · 已归档 ${fmtNumber(deleteTarget.totalFiles)} 个文件` : undefined}
        detail={
          <>
            删除后不再用该邮箱收信；<b>已下载的文件与下载记录会保留</b>。如果只是暂时不用，建议改为「停用」。
          </>
        }
        confirmText="确认删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteAccount()}
      />
    </>
  )
}
