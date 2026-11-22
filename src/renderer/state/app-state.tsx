/** 全局轻量状态：API 入口 / 概览数据 / 事件订阅 / 路由 / Toast */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode
} from 'react'
import type { Api } from '@shared/ipc'
import type { DashboardData } from '@shared/types'
import { getApi, isDemoMode } from '../lib/api'
import { errMsg } from '../lib/format'
import type { ToastItem, ToastLevel } from '../components/Toast'

export type Page = 'dashboard' | 'accounts' | 'rules' | 'autoreply' | 'records'
export type RefreshKey = 'accounts' | 'rules' | 'records'

const PAGE_KEYS: Page[] = ['dashboard', 'accounts', 'rules', 'autoreply', 'records']

function pageFromHash(): Page | null {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return (PAGE_KEYS as string[]).includes(raw) ? (raw as Page) : null
}

interface AppContextValue {
  api: Api
  demo: boolean
  page: Page
  navigate: (page: Page) => void
  dashboard: DashboardData | null
  dashboardLoading: boolean
  dashboardError: string | null
  refreshDashboard: () => void
  refresh: Record<RefreshKey, number>
  bump: (key: RefreshKey) => void
  rulesCount: number
  toasts: ToastItem[]
  pushToast: (level: ToastLevel, title: string, body?: string) => void
  dismissToast: (id: number) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const api = useMemo(() => getApi(), [])
  const demo = useMemo(() => isDemoMode(), [])
  const [page, setPage] = useState<Page>(() => pageFromHash() ?? 'dashboard')
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState<Record<RefreshKey, number>>({ accounts: 0, rules: 0, records: 0 })
  const [rulesCount, setRulesCount] = useState(0)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastSeq = useRef(0)
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const pushToast = useCallback(
    (level: ToastLevel, title: string, body?: string) => {
      toastSeq.current += 1
      const id = toastSeq.current
      const item: ToastItem = { id, level, title, body, at: Date.now() }
      setToasts((list) => [...list.slice(-3), item])
      const timer = setTimeout(() => {
        setToasts((list) => list.filter((t) => t.id !== id))
        timers.current.delete(id)
      }, 4200)
      timers.current.set(id, timer)
    },
    []
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const timer of map.values()) clearTimeout(timer)
      map.clear()
    }
  }, [])

  const loadDashboard = useCallback(async () => {
    try {
      const data = await api.dashboard()
      setDashboard(data)
      setDashboardError(null)
    } catch (e) {
      setDashboardError(errMsg(e))
    } finally {
      setDashboardLoading(false)
    }
  }, [api])

  const loadRulesCount = useCallback(async () => {
    try {
      const rules = await api.rules.list()
      setRulesCount(rules.length)
    } catch {
      /* 侧栏计数失败不打扰用户 */
    }
  }, [api])

  const refreshDashboard = useCallback(() => {
    void loadDashboard()
  }, [loadDashboard])

  const bump = useCallback((key: RefreshKey) => {
    setRefresh((prev) => ({ ...prev, [key]: prev[key] + 1 }))
  }, [])

  const navigate = useCallback((next: Page) => {
    setPage(next)
    window.location.hash = next
    document.querySelector('.content')?.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    void loadDashboard()
    void loadRulesCount()
  }, [loadDashboard, loadRulesCount])

  useEffect(() => {
    const onHash = (): void => setPage(pageFromHash() ?? 'dashboard')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    return api.onEvent((e) => {
      switch (e.type) {
        case 'toast':
          pushToast(e.level, e.title, e.body)
          break
        case 'account:changed':
          bump('accounts')
          void loadDashboard()
          break
        case 'rules:changed':
          bump('rules')
          void loadRulesCount()
          void loadDashboard()
          break
        case 'message:upserted':
        case 'delivery:changed':
          bump('records')
          void loadDashboard()
          break
        case 'dashboard:changed':
          void loadDashboard()
          break
        case 'listening:changed':
          void loadDashboard()
          break
        default:
          break
      }
    })
  }, [api, bump, loadDashboard, loadRulesCount, pushToast])

  const value = useMemo<AppContextValue>(
    () => ({
      api,
      demo,
      page,
      navigate,
      dashboard,
      dashboardLoading,
      dashboardError,
      refreshDashboard,
      refresh,
      bump,
      rulesCount,
      toasts,
      pushToast,
      dismissToast
    }),
    [
      api, demo, page, navigate, dashboard, dashboardLoading, dashboardError, refreshDashboard,
      refresh, bump, rulesCount, toasts, pushToast, dismissToast
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用')
  return ctx
}

export function useRefresh(key: RefreshKey): number {
  return useApp().refresh[key]
}
