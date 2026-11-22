import type { JSX } from 'react'
/** 自动回复：总开关 / 中英模板编辑 / 变量插入 / 实时邮件预览 / 防轰炸设置 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Settings } from '@shared/types'
import { Button } from '../components/Button'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import { Switch } from '../components/Switch'
import { SegmentedControl } from '../components/SegmentedControl'
import { TextArea, TextField } from '../components/TextField'
import { Tooltip } from '../components/Tooltip'
import { cls, errMsg, fmtBytes, fmtDateTime, fmtTimeSec } from '../lib/format'
import { replyLanguageLabel } from '../lib/status'
import { useApp } from '../state/app-state'
import '../styles/screens/autoreply.css'

const VAR_TOKENS = ['{关键词}', '{文件名}', '{数量}', '{时间}', '{工厂名}'] as const

const DEFAULT_TEMPLATES = {
  replySubjectZh: '图稿已收到 — {关键词} / {文件名}',
  replyBodyZh: [
    '您好，',
    '',
    '图稿已收到，感谢！我们已按「{关键词}」归档。',
    '',
    '收到文件（{数量}）：',
    '  · {文件名}',
    '',
    '归档时间：{时间}',
    '',
    '印前组会在 24 小时内检查尺寸与色彩配置；如需重发，直接回复本邮件即可。',
    '',
    '海印 POD · 印前组'
  ].join('\n'),
  replySubjectEn: 'Artwork received — {关键词} / {文件名}',
  replyBodyEn: [
    'Hi there,',
    '',
    "Received — thanks! We've filed your artwork for {关键词}.",
    '',
    'Files received ({数量}):',
    '  · {文件名}',
    '',
    'Logged at {时间}',
    '',
    'Our prepress team will check print size and colour profile within 24 hours. If you need to resend, just reply to this email.',
    '',
    'Best regards,',
    'Haiyin POD · Prepress'
  ].join('\n')
}

const FALLBACK_SAMPLE = {
  keyword: '原图+卡套',
  filename: 'POD_ORDER_20486.zip',
  size: 18.4 * 1024 * 1024,
  from: 'david@inkpressed.co',
  fromName: 'David Chen',
  subject: '原图+卡套 追加：POD_ORDER_20486',
  receivedAt: Date.now() - 2 * 60_000
}

function substitute(text: string, vars: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(vars)) out = out.split(key).join(value)
  return out
}

export function AutoReply(): JSX.Element {
  const { api, dashboard, pushToast, navigate } = useApp()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editLang, setEditLang] = useState<'zh' | 'en'>('en')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [focusField, setFocusField] = useState<'subject' | 'body'>('body')
  const subjectRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  const reload = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.settings.get(), api.accounts.list()])
      setSettings(s)
      setDraft(structuredClone(s))
      setAccounts(list)
      setError(null)
      setEditLang(s.replyLanguage === 'zh' ? 'zh' : 'en')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!draft) return
    if (draft.replyLanguage === 'zh') setEditLang('zh')
    else if (draft.replyLanguage === 'en') setEditLang('en')
  }, [draft?.replyLanguage])

  const markDraft = (changes: Partial<Settings>): void => {
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev))
    setDirty(true)
  }

  const subjectValue = draft ? (editLang === 'zh' ? draft.replySubjectZh : draft.replySubjectEn) : ''
  const bodyValue = draft ? (editLang === 'zh' ? draft.replyBodyZh : draft.replyBodyEn) : ''

  const setSubject = (value: string): void => {
    markDraft(editLang === 'zh' ? { replySubjectZh: value } : { replySubjectEn: value })
  }

  const setBody = (value: string): void => {
    markDraft(editLang === 'zh' ? { replyBodyZh: value } : { replyBodyEn: value })
  }

  const insertVar = (token: string): void => {
    if (!draft) return
    const isSubject = focusField === 'subject'
    const el = isSubject ? subjectRef.current : bodyRef.current
    const value = isSubject ? subjectValue : bodyValue
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    if (isSubject) setSubject(next)
    else setBody(next)
    requestAnimationFrame(() => {
      const node = isSubject ? subjectRef.current : bodyRef.current
      node?.focus()
      const pos = start + token.length
      node?.setSelectionRange(pos, pos)
    })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = await api.settings.save(draft)
      setSettings(saved)
      setDraft(structuredClone(saved))
      setDirty(false)
      setLastSavedAt(Date.now())
      pushToast('success', '模板已保存', draft.replyEnabled ? '新邮件命中后会按新模板回信' : '自动回复当前为关闭状态')
    } catch (e) {
      pushToast('error', '保存模板失败', errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  const restoreDefaults = (): void => {
    setDraft((prev) => (prev ? { ...prev, ...DEFAULT_TEMPLATES } : prev))
    setDirty(true)
    pushToast('warn', '已恢复默认模板', '记得点「保存模板」才会生效')
  }

  const sample = useMemo(() => {
    const recent = dashboard?.recent ?? []
    return recent.find((r) => r.matchedKeyword) ?? recent[0] ?? null
  }, [dashboard])

  const replyAccount = useMemo(
    () => accounts.find((a) => a.status === 'enabled' && a.enabled) ?? accounts[0] ?? null,
    [accounts]
  )

  const [sendingTest, setSendingTest] = useState(false)
  const sendTestReply = useCallback(async () => {
    if (sendingTest) return
    const to = replyAccount?.email
    if (!to) {
      pushToast('warn', '还没有可用账户', '请先在「邮箱账户」里添加账户并测试连接')
      return
    }
    setSendingTest(true)
    try {
      const res = await api.reply.test(to)
      if (res.ok) pushToast('success', '测试信已发送', res.message)
      else pushToast('error', '测试信发送失败', res.message)
    } catch (e) {
      pushToast('error', '测试信发送失败', errMsg(e))
    } finally {
      setSendingTest(false)
    }
  }, [api, pushToast, replyAccount, sendingTest])

  const previewVars = useMemo(() => {
    const attachments = sample?.attachments ?? []
    const first = attachments[0]
    return {
      '{关键词}': sample?.matchedKeyword ?? FALLBACK_SAMPLE.keyword,
      '{文件名}': first?.filename ?? FALLBACK_SAMPLE.filename,
      '{数量}': String(attachments.length || 1),
      '{时间}': fmtDateTime(sample?.receivedAt ?? FALLBACK_SAMPLE.receivedAt),
      '{工厂名}': (draft?.factoryName || '海印 POD · 印前组').trim()
    }
  }, [sample])

  const previewSubject = draft
    ? substitute(editLang === 'zh' ? draft.replySubjectZh : draft.replySubjectEn, previewVars)
    : ''
  const previewBody = draft
    ? substitute(editLang === 'zh' ? draft.replyBodyZh : draft.replyBodyEn, previewVars)
    : ''
  const previewFrom = sample?.fromAddr || FALLBACK_SAMPLE.from
  const previewFromName = sample?.fromName || FALLBACK_SAMPLE.fromName
  const previewSubjectSource = sample?.subject ?? FALLBACK_SAMPLE.subject
  const previewFile = sample?.attachments[0]?.filename ?? FALLBACK_SAMPLE.filename
  const previewSize = sample?.attachments[0]?.size ?? FALLBACK_SAMPLE.size

  const copyPreview = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`主题：${previewSubject}\n\n${previewBody}`)
      pushToast('success', '已复制预览内容')
    } catch (e) {
      pushToast('error', '复制失败', errMsg(e))
    }
  }

  const header = (
    <PageHeader
      eyebrow="Auto Reply"
      eyebrowCn="自动回复"
      title="自动回复"
      sub="文件写入成功后自动给客户回一封「已收到」。模板可改，同一线程只回一次。"
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            disabled={!dirty}
            title="放弃未保存的改动"
            onClick={() => {
              if (!settings) return
              setDraft(structuredClone(settings))
              setDirty(false)
            }}
          >
            放弃改动
          </Button>
          <Button
            size="md"
            variant="primary"
            icon="check"
            loading={saving}
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            保存模板
          </Button>
        </>
      }
    />
  )

  if (loading || !draft) {
    return (
      <>
        {header}
        {error ? (
          <ErrorState message={error} onRetry={() => void reload()} />
        ) : (
          <div className="ar-wrap">
            <div className="skeleton-card" style={{ height: 80 }} />
            <div className="skeleton-card" style={{ height: '100%' }} />
            <div className="skeleton-card" style={{ height: 150 }} />
            <div className="skeleton-card" style={{ height: '100%' }} />
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {header}
      <div className="ar-wrap">
        <div className="left-col">
          {/* 总开关 */}
          <section className="card ar-switch-card">
            <div className="ar-switch-row">
              <Switch
                size="lg"
                checked={draft.replyEnabled}
                onChange={(checked) => markDraft({ replyEnabled: checked })}
                ariaLabel="自动回复总开关"
              />
              <div>
                <div className="t">{draft.replyEnabled ? '自动回复已开启' : '自动回复已关闭'}</div>
                <div className="d">
                  回信地址：
                  {replyAccount ? `${replyAccount.email}（${replyAccount.displayName}）` : '尚未添加邮箱账户'}
                </div>
              </div>
              <div className="ar-stats">
                <div>
                  <span className="k">回复语言</span>
                  <span className="v ok">{replyLanguageLabel(draft.replyLanguage)}</span>
                </div>
                <div>
                  <span className="k">回复延迟</span>
                  <span className="v">{draft.replyDelaySec} 秒</span>
                </div>
                <div>
                  <span className="k">每小时上限</span>
                  <span className="v">{draft.replyHourlyCap} 封</span>
                </div>
                <div>
                  <span className="k">模板状态</span>
                  <span className={cls('v', dirty ? 'warn' : 'ok')}>{dirty ? '未保存' : '已保存'}</span>
                </div>
              </div>
            </div>
          </section>

          {/* 模板 */}
          <section className="card tpl-card">
            <div className="tpl-hd">
              <h2>回信模板</h2>
              <SegmentedControl<'zh' | 'en' | 'both'>
                value={draft.replyLanguage}
                ariaLabel="回复语言"
                options={[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                  { value: 'both', label: '中英双语' }
                ]}
                onChange={(value) => markDraft({ replyLanguage: value })}
              />
              <span className="note">
                {draft.replyLanguage === 'both' ? '双语：中文与英文模板都会发送' : `当前编辑：${editLang === 'zh' ? '中文' : 'English'}`}
                {lastSavedAt ? (
                  <>
                    {' '}
                    · 上次保存 <span className="mono">{fmtTimeSec(lastSavedAt)}</span>
                  </>
                ) : null}
              </span>
            </div>

            <div className="tpl-bd">
              {draft.replyLanguage === 'both' ? (
                <div className="lang-tabs" role="tablist" aria-label="编辑语言">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editLang === 'zh'}
                    className={cls('lang-tab', editLang === 'zh' && 'is-active')}
                    onClick={() => setEditLang('zh')}
                  >
                    中文模板
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editLang === 'en'}
                    className={cls('lang-tab', editLang === 'en' && 'is-active')}
                    onClick={() => setEditLang('en')}
                  >
                    English 模板
                  </button>
                </div>
              ) : null}

              <div className="subject-row">
                <span className="lab">主题</span>
                <div className="subject-wrap">
                  <TextField
                    value={subjectValue}
                    onChange={setSubject}
                    onFocus={() => setFocusField('subject')}
                    inputRef={(el) => {
                      subjectRef.current = el
                    }}
                    ariaLabel="回信主题模板"
                    placeholder="Artwork received — {关键词} / {文件名}"
                  />
                </div>
              </div>

              <div className="tpl-editor">
                <TextArea
                  value={bodyValue}
                  onChange={setBody}
                  onFocus={() => setFocusField('body')}
                  inputRef={(el) => {
                    bodyRef.current = el
                  }}
                  ariaLabel="回信正文模板"
                  rows={10}
                  placeholder="输入邮件正文，点击下方变量按钮插入 {关键词} 等变量。"
                />
              </div>

              <div className="var-bar">
                <span className="k">插入变量</span>
                {VAR_TOKENS.map((token) => (
                  <button key={token} type="button" className="var-btn" onClick={() => insertVar(token)}>
                    <span className="plus">＋</span>
                    {token}
                  </button>
                ))}
                <span className="var-hint">
                  {focusField === 'subject' ? '将插入到主题' : '将插入到正文'}
                  {' · '}
                  {'{时间}'} 用归档完成时刻 · 客户收到的是纯文本邮件
                </span>
              </div>
            </div>

            <div className="tpl-ft">
              <StatusBadge tone="ok" icon="check">
                5 个变量全部可用
              </StatusBadge>
              <span className="tpl-note">模板区分中英文，切换语言不会丢失已编辑内容</span>
              <span style={{ marginLeft: 'auto' }}>
                <Button size="sm" variant="ghost" onClick={restoreDefaults}>
                  恢复默认
                </Button>
              </span>
            </div>
          </section>

          {/* 发送设置 */}
          <section className="card send-card">
            <h2>发送设置</h2>
            <div className="send-grid">
              <div className="send-item">
                <div>
                  <div className="lbl">回复延迟</div>
                  <div className="sub">等附件写入完成再发</div>
                </div>
                <div className="delay-input">
                  <TextField
                    value={String(draft.replyDelaySec)}
                    onChange={(value) => {
                      const n = Number(value.replace(/[^\d]/g, ''))
                      markDraft({ replyDelaySec: Number.isFinite(n) ? Math.min(600, n) : 0 })
                    }}
                    inputMode="numeric"
                    mono
                    ariaLabel="回复延迟（秒）"
                    className="delay-field"
                  />
                  <span>秒</span>
                </div>
              </div>
              <div className="send-item">
                <div>
                  <div className="lbl">每小时上限</div>
                  <div className="sub">防账号被风控</div>
                </div>
                <div className="delay-input">
                  <TextField
                    value={String(draft.replyHourlyCap)}
                    onChange={(value) => {
                      const n = Number(value.replace(/[^\d]/g, ''))
                      markDraft({ replyHourlyCap: Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1 })
                    }}
                    inputMode="numeric"
                    mono
                    ariaLabel="每小时回信上限"
                    className="delay-field"
                  />
                  <span>封/时</span>
                </div>
              </div>
              <div className="send-item">
                <Switch
                  checked={draft.replyThreadOnce}
                  onChange={(checked) => markDraft({ replyThreadOnce: checked })}
                  ariaLabel="同一线程只回一次"
                />
                <div>
                  <div className="lbl">同一线程只回一次</div>
                  <div className="sub">防回信轰炸（按 thread_key 去重）</div>
                </div>
              </div>
              <div className="send-item send-item--wide">
                <div>
                  <div className="lbl">回信署名（工厂名）</div>
                  <div className="sub">模板里的 {'{工厂名}'} 用它替换</div>
                </div>
                <TextField
                  value={draft.factoryName ?? ''}
                  onChange={(value) => markDraft({ factoryName: value })}
                  placeholder="海印 POD · 印前组"
                  ariaLabel="回信署名（工厂名）"
                  className="factory-field"
                />
              </div>
            </div>
            <div className="test-row">
              <Tooltip
                label={
                  replyAccount
                    ? `用 ${replyAccount.email} 的 SMTP 发一封样张邮件到你自己`
                    : '先在「邮箱账户」里添加账户并测试连接'
                }
              >
                <Button
                  size="sm"
                  icon="send"
                  disabled={!replyAccount || sendingTest}
                  onClick={() => void sendTestReply()}
                >
                  {sendingTest ? '发送中…' : '发送测试信'}
                </Button>
              </Tooltip>
              <span className="mono">
                {replyAccount ? `将发送到 ${replyAccount.email}` : '还没有可用账户'}
              </span>
              {replyAccount ? (
                <StatusBadge tone="ok" className="test-badge">
                  已接入
                </StatusBadge>
              ) : (
                <StatusBadge tone="warn" className="test-badge">
                  需先配置账户
                </StatusBadge>
              )}
            </div>
          </section>
        </div>

        {/* 右侧实时预览 */}
        <section className="card preview-card">
          <div className="pv-hd">
            <h2>实时预览</h2>
            <StatusBadge tone="info">变量已用最近一封邮件填充</StatusBadge>
            <span className="note">纯文本 · 无图片</span>
          </div>
          <div className="pv-bd">
            <div className="pv-context">
              <span>预览数据来自</span>
              <span className="mono ellipsis">
                {fmtDateTime(sample?.receivedAt ?? FALLBACK_SAMPLE.receivedAt)} · {previewFrom}
              </span>
              <button type="button" className="link" onClick={() => navigate('records')}>
                换一封 ›
              </button>
            </div>

            <div className="mail-sheet">
              <div className="mail-head">
                <div className="mail-subject">{previewSubject}</div>
                <div className="mail-meta">
                  <div className="row">
                    <span className="k">发件人</span>
                    <span className="v">
                      MailHarbor 自动回复 &lt;{replyAccount?.email ?? '未配置邮箱'}&gt;
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">收件人</span>
                    <span className="v mono">
                      {previewFromName} &lt;{previewFrom}&gt;
                    </span>
                  </div>
                  <div className="row">
                    <span className="k">时间</span>
                    <span className="v mono">{fmtDateTime(sample?.receivedAt ?? Date.now())}</span>
                    <span className="mail-lag mono">归档后 {draft.replyDelaySec} 秒发送</span>
                  </div>
                </div>
              </div>
              <div className="mail-divider" />
              <div className="mail-body">
                <div className="mail-text">{previewBody}</div>
                <div className="orig">
                  <div className="orig-h">----- 原始邮件 · Original message -----</div>
                  <div className="orig-l">
                    <span className="k">From:</span> {previewFromName} &lt;{previewFrom}&gt;
                  </div>
                  <div className="orig-l">
                    <span className="k">Subject:</span> {previewSubjectSource}
                  </div>
                  <div className="orig-l">
                    <span className="k">Attach:</span> {previewFile} ({fmtBytes(previewSize)})
                  </div>
                </div>
              </div>
              <div className="mail-foot">
                <Icon name="shield" size={11} />
                <span>由 MailHarbor 自动发送 · 回复此邮件会直接到达工厂邮箱</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>
                  plain text
                </span>
              </div>
            </div>

            <div className="warn-strip">
              <Icon name="alert" size={11} />
              <span>主题里的变量会按实际邮件替换。客户回信时主题保持不变，便于线程归并、避免重复回复。</span>
            </div>
          </div>
          <div className="pv-ft">
            <span className="mono">预计送达 &lt; 1 分钟</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button size="sm" variant="ghost" icon="copy" onClick={() => void copyPreview()}>
                复制预览
              </Button>
              <Tooltip label={replyAccount ? `发送到 ${replyAccount.email}` : '先在「邮箱账户」里添加账户'}>
                <Button
                  size="sm"
                  icon="send"
                  disabled={!replyAccount || sendingTest}
                  onClick={() => void sendTestReply()}
                >
                  {sendingTest ? '发送中…' : '发送测试信'}
                </Button>
              </Tooltip>
            </span>
          </div>
        </section>
      </div>
    </>
  )
}
