import type { Api } from '../shared/ipc'

declare global {
  interface Window {
    mailharbor: Api
  }
}

export {}
