import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { ToastViewport } from './components/Toast'
import { Accounts } from './pages/Accounts'
import { AutoReply } from './pages/AutoReply'
import { Dashboard } from './pages/Dashboard'
import { Records } from './pages/Records'
import { Rules } from './pages/Rules'
import { AppProvider, useApp } from './state/app-state'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] 未捕获异常', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app">
          <div className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="error-state" style={{ maxWidth: 560 }}>
              <div>
                <div className="e-title">界面出现异常</div>
                <div className="e-desc">{this.state.error.message}</div>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                    重新加载
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Shell(): JSX.Element {
  const { page, toasts, dismissToast } = useApp()

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="content">
          {page === 'dashboard' ? <Dashboard /> : null}
          {page === 'accounts' ? <Accounts /> : null}
          {page === 'rules' ? <Rules /> : null}
          {page === 'autoreply' ? <AutoReply /> : null}
          {page === 'records' ? <Records /> : null}
        </div>
      </main>
      <ToastViewport items={toasts} onClose={dismissToast} />
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ErrorBoundary>
  )
}
