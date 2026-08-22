const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

type DesktopColorScheme = 'dark' | 'light' | 'system'

interface DesktopUpdateState {
  readonly currentVersion: string
  readonly error?: string
  readonly latestVersion?: string
  readonly progress?: number
  readonly status: 'checking' | 'downloading' | 'error' | 'idle' | 'ready' | 'up-to-date' | 'update-available'
}

interface DshDesktopBridge {
  readonly checkForUpdates: () => Promise<void>
  readonly getUpdateState: () => Promise<DesktopUpdateState>
  readonly installUpdate: () => Promise<void>
  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void
  readonly setColorScheme: (scheme: DesktopColorScheme) => void
}

// Keep these channel names in sync with desktop-api.ts. Sandboxed Electron
// preload scripts must remain a self-contained CommonJS entry point.
const DESKTOP_IPC = Object.freeze({
  checkForUpdates: 'dsh-desktop:update:check',
  getUpdateState: 'dsh-desktop:update:get-state',
  installUpdate: 'dsh-desktop:update:install',
  setColorScheme: 'dsh-desktop:window:set-color-scheme',
  updateState: 'dsh-desktop:update:state',
})

const bridge: DshDesktopBridge = Object.freeze({
  checkForUpdates: async () => await ipcRenderer.invoke(DESKTOP_IPC.checkForUpdates),
  getUpdateState: async () => await ipcRenderer.invoke(DESKTOP_IPC.getUpdateState) as DesktopUpdateState,
  installUpdate: async () => await ipcRenderer.invoke(DESKTOP_IPC.installUpdate),
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => {
      listener(state)
    }
    ipcRenderer.on(DESKTOP_IPC.updateState, handler)
    return () => { ipcRenderer.removeListener(DESKTOP_IPC.updateState, handler) }
  },
  setColorScheme: (scheme: DesktopColorScheme) => {
    ipcRenderer.send(DESKTOP_IPC.setColorScheme, scheme)
  },
})

contextBridge.exposeInMainWorld('dshDesktop', bridge)