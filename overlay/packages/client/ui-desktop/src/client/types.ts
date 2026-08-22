export type DesktopColorScheme = 'light' | 'dark'

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export interface DesktopUpdateState {
  availableVersion?: string | undefined
  currentVersion: string
  error?: string | undefined
  progress?: number | undefined
  status: DesktopUpdateStatus
}

export interface DshDesktopBridge {
  checkForUpdates: () => Promise<void>
  getUpdateState: () => Promise<DesktopUpdateState>
  installUpdate: () => Promise<void>
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void
  setColorScheme: (scheme: DesktopColorScheme) => void
}

declare global {
  interface Window {
    dshDesktop?: DshDesktopBridge
  }
}
