export const DESKTOP_IPC = {
  checkForUpdates: 'dsh-desktop:update:check',
  getUpdateState: 'dsh-desktop:update:get-state',
  installUpdate: 'dsh-desktop:update:install',
  setColorScheme: 'dsh-desktop:window:set-color-scheme',
  updateState: 'dsh-desktop:update:state',
} as const

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
