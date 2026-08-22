import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './desktop-api.ts'
import type {
  DesktopColorScheme,
  DesktopUpdateState,
  DshDesktopBridge,
} from './desktop-api.ts'

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
