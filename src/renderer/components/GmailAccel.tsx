/** Gmail API 加速卡片：对 Gmail/Workspace 账户做 OAuth 授权，附件下载走 HTTPS（比 IMAP 快 3–6 倍） */
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account } from '@shared/types'
import { Button } from './Button'
import { Icon } from './Icon'
import { errMsg } from '../lib/format'
import { useApp } from '../state/app-state'
import '../styles/screens/gmail-accel.css'

interface StatusRow {
  accountId: number
  email: string
  provider: string
  expiry: number | null
  daysLeft: number | null
  needsReauth: boolean
  lastError: string | null
}

export function GmailAccel({ accounts }: { accounts: Account[] }): JSX.Element | null {
  const { api, pushToast } = useApp()
  const [status, setStatus] = useState<StatusRow[]>([])
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const gmailAccounts = accounts.filter((a) => a.preset === 'gmail' || a.preset === 'google_workspace')

  const load = useCallback(async () => {
    try {
      setStatus(await api.gmail.status())
    } catch {
      /* ignore */
    }
  }, [api])

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [load])

  if (gmailAccounts.length === 0) return null

  const statusOf = (id: number): StatusRow | undefined => status.find((s) => s.accountId === id)

  const authorize = async (account: Account): Promise<void> => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setOpen(true)
      pushToast('warn', '先填 OAuth 客户端 ID / 密钥', '在 Google Cloud → 客户端（桌面应用）里创建')
      return
    }
    setBusy(account.id)
    try {
      await api.gmail.startAuth(account.id, clientId.trim(), clientSecret.trim())
      pushToast('success', '已打开授权页面', '在浏览器登录并点「允许」，完成后这里会自动刷新')
      let elapsed = 0
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        elapsed += 2000
        const rows = await api.gmail.status().catch(() => [])
        setStatus(rows)
        if (rows.some((r) => r.accountId === account.id) || elapsed > 180_000) {
          if (pollRef.current) clearInterval(pollRef.current)
          setBusy(null)
          if (rows.some((r) => r.accountId === account.id)) {
            pushToast('success', 'Gmail 加速已启用', '之后的附件优先走 HTTPS 下载')
          }
        }
      }, 2000)
    } catch (e) {
      setBusy(null)
      pushToast('error', '启动授权失败', errMsg(e))
    }
  }

  const test = async (account: Account): Promise<void> => {
    setBusy(account.id)
    try {
      const r = await api.gmail.test(account.id)
      if (r.ok) pushToast('success', 'Gmail API 连通', r.email ?? '')
      else pushToast('warn', 'Gmail API 不通', r.message ?? '请重新授权')
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (account: Account): Promise<void> => {
    await api.gmail.revoke(account.id)
    await load()
    pushToast('success', '已关闭 Gmail 加速', '该账户附件下载恢复走 IMAP')
  }

  return (
    <section className="card gmail-accel" aria-label="Gmail 加速">
      <div className="ga-hd">
        <h2>Gmail 加速（API）</h2>
        <span className="ga-note">附件走 HTTPS 下载，实测比 IMAP 快 3–6 倍；收信/回信逻辑不变</span>
        <button type="button" className="ga-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '收起配置' : '配置 OAuth 客户端'}
        </button>
      </div>

      {open ? (
        <div className="ga-config">
          <label>
            <span>客户端 ID</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
          </label>
          <label>
            <span>客户端密钥</span>
            <input
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-…"
              type="password"
            />
          </label>
          <p className="ga-hint">
            Google Cloud →「API 和服务 → 客户端」创建类型为「桌面应用」的 OAuth 客户端；测试模式下授权 7 天后需重新授权。
          </p>
        </div>
      ) : null}

      <div className="ga-list">
        {gmailAccounts.map((account) => {
          const st = statusOf(account.id)
          return (
            <div className="ga-row" key={account.id}>
              <div className="ga-who">
                <Icon name="mail" size={13} />
                <span className="mono">{account.email}</span>
                {st ? (
                  <span className={st.needsReauth ? 'ga-badge bad' : 'ga-badge ok'}>
                    {st.needsReauth ? '授权已过期，请重新授权' : `已授权${st.daysLeft != null ? ` · 剩 ${st.daysLeft} 天` : ''}`}
                  </span>
                ) : (
                  <span className="ga-badge idle">未授权（走 IMAP）</span>
                )}
              </div>
              <div className="ga-actions">
                {st ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                      填写客户端
                    </Button>
                    <Button size="sm" variant="secondary" loading={busy === account.id} onClick={() => void test(account)}>
                      测试
                    </Button>
                    <Button size="sm" variant="secondary" loading={busy === account.id} onClick={() => void authorize(account)}>
                      重新授权
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void revoke(account)}>
                      关闭加速
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" loading={busy === account.id} onClick={() => void authorize(account)}>
                    授权 Gmail 加速
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
