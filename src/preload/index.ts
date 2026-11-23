/** preload：用 contextBridge 暴露白名单 API，渲染层拿不到 Node 对象 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { Api } from '../shared/ipc'
import type { MainEvent } from '../shared/types'

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: Api = {
  accounts: {
    list: () => invoke(IPC.accountList),
    create: (input) => invoke(IPC.accountCreate, input),
    update: (id, input) => invoke(IPC.accountUpdate, id, input),
    remove: (id) => invoke(IPC.accountDelete, id),
    test: (input) => invoke(IPC.accountTest, input),
    testSaved: (id) => invoke(IPC.accountTestSaved, id),
    toggle: (id, enabled) => invoke(IPC.accountToggle, id, enabled)
  },
  rules: {
    list: () => invoke(IPC.ruleList),
    create: (input) => invoke(IPC.ruleCreate, input),
    update: (id, input) => invoke(IPC.ruleUpdate, id, input),
    remove: (id) => invoke(IPC.ruleDelete, id),
    toggle: (id, enabled) => invoke(IPC.ruleToggle, id, enabled),
    reorder: (ids) => invoke(IPC.ruleReorder, ids),
    targetsHealth: () => invoke(IPC.ruleTargetsHealth)
  },
  records: {
    list: (q) => invoke(IPC.recordsList, q),
    retry: (messageId, deliveryId) => invoke(IPC.recordsRetry, messageId, deliveryId),
    retryDownload: (messageId) => invoke(IPC.recordsRetryDownload, messageId),
    openFolder: (messageId, deliveryId) => invoke(IPC.recordsOpenFolder, messageId, deliveryId),
    exportCsv: (q) => invoke(IPC.recordsExport, q),
    clear: () => invoke(IPC.recordsClear)
  },
  reply: {
    test: (to) => invoke(IPC.replyTest, to)
  },
  dashboard: () => invoke(IPC.dashboard),
  setListening: (on) => invoke(IPC.listeningSet, on),
  checkNow: () => invoke(IPC.checkNow),
  rescan: () => invoke(IPC.rescan),
  settings: {
    get: () => invoke(IPC.settingsGet),
    save: (s) => invoke(IPC.settingsSave, s),
    testProxy: (p) => invoke(IPC.proxyTest, p)
  },
  pickFolder: () => invoke(IPC.pickFolder),
  openPath: (p) => invoke(IPC.openPath, p),
  appInfo: () => invoke(IPC.appInfo),
  update: {
    check: () => invoke(IPC.updateCheck),
    install: () => invoke(IPC.updateInstall),
    state: () => invoke(IPC.updateState)
  },
  onEvent: (cb: (e: MainEvent) => void) => {
    const listener = (_event: unknown, payload: MainEvent): void => cb(payload)
    ipcRenderer.on(IPC.event, listener as never)
    return () => ipcRenderer.removeListener(IPC.event, listener as never)
  }
}

contextBridge.exposeInMainWorld('mailharbor', api)
