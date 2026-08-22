import { createWriteStream } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { DESKTOP_IPC } from './desktop-api.ts'
import type { DesktopColorScheme, DesktopUpdateState } from './desktop-api.ts'
import {
  createBackendSpawnSpec,
  findAvailablePort,
  resolveDesktopPaths,
  stopProcessTree,
  waitForHttpReady,
} from './runtime.ts'
import type { BackendProcessHandle } from './runtime.ts'
import { installDesktopUiCompatibility } from './ui-compatibility.ts'
import { DesktopUpdateController } from './updater.ts'
import type { DesktopAutoUpdater } from './updater.ts'

const DEFAULT_PORT = 3080
const PORT_ATTEMPTS = 100
const STARTUP_TIMEOUT_MS = 45_000
const TITLE_BAR_HEIGHT = 38

const preloadPath = fileURLToPath(new URL('./preload.js', import.meta.url))

let backend: BackendProcessHandle | undefined
let backendReady = false
let desktopUpdater: DesktopUpdateController | undefined
let mainWindow: BrowserWindow | undefined
let shutdownStarted = false
let updateState: DesktopUpdateState = {
  currentVersion: app.getVersion(),
  status: 'idle',
}

let webColorScheme: DesktopColorScheme | undefined

function parseFirstPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DSH_DESKTOP_PORT must be an integer from 1 through 65535, got ${JSON.stringify(raw)}.`)
  }
  return port
}

function startupPage(): string {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSeek Harness</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { align-items: center; background: #f7f8fa; color: #202124; display: flex; height: 100vh; justify-content: center; margin: 0; }
    main { align-items: center; display: flex; flex-direction: column; gap: 18px; }
    h1 { font-size: 24px; font-weight: 600; letter-spacing: 0; margin: 0; }
    .spinner { animation: spin 0.9s linear infinite; border: 3px solid #d9dde5; border-radius: 50%; border-top-color: #3b6eea; height: 28px; width: 28px; }
    p { color: #687080; font-size: 14px; margin: 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #17181b; color: #f4f5f7; }
      p { color: #a9afba; }
      .spinner { border-color: #3b3e45; border-top-color: #7ea2ff; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body><main><h1>DeepSeek Harness</h1><div class="spinner" aria-label="正在启动"></div><p>正在启动本地服务...</p></main></body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(null)
}

function publishUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch }
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  window.webContents.send(DESKTOP_IPC.updateState, updateState)
}

function applyWindowColorScheme(scheme: DesktopColorScheme): void {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  const dark = scheme === 'dark'
  window.setBackgroundColor(dark ? '#17181b' : '#f7f8fa')
  window.setTitleBarOverlay({
    color: '#00000000',
    height: TITLE_BAR_HEIGHT,
    symbolColor: dark ? '#e6e8eb' : '#30343b',
  })
}

function configureDesktopIpc(): void {
  ipcMain.handle(DESKTOP_IPC.getUpdateState, () => updateState)
  ipcMain.handle(DESKTOP_IPC.checkForUpdates, async () => {
    publishUpdateState({ error: undefined, progress: undefined, status: 'checking' })
    await desktopUpdater?.check(true)
  })
  ipcMain.handle(DESKTOP_IPC.installUpdate, async () => {
    await desktopUpdater?.installDownloaded()
  })
  ipcMain.on(DESKTOP_IPC.setColorScheme, (_event, scheme: unknown) => {
    if (scheme !== 'light' && scheme !== 'dark') return
    webColorScheme = scheme
    applyWindowColorScheme(scheme)
  })
  nativeTheme.on('updated', () => {
    if (webColorScheme !== undefined) return
    applyWindowColorScheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })
}

async function prepareUpdateInstall(): Promise<void> {
  shutdownStarted = true
  try {
    await stopBackend()
  } catch (error) {
    shutdownStarted = false
    throw error
  }
}

function configureDesktopUpdates(): void {
  desktopUpdater = new DesktopUpdateController({
    currentVersion: app.getVersion(),
    enabled: app.isPackaged && process.env.DSH_DESKTOP_DISABLE_AUTO_UPDATE !== '1',
    prepareInstall: prepareUpdateInstall,
    ui: {
      confirmDownload: async (info) => {
        publishUpdateState({
          availableVersion: info.version,
          error: undefined,
          progress: 0,
          status: 'downloading',
        })
        return true
      },
      confirmInstall: async (info) => {
        publishUpdateState({ availableVersion: info.version, progress: undefined, status: 'ready' })
        return false
      },
      reportError: async error => publishUpdateState({ error, progress: undefined, status: 'error' }),
      reportNoUpdate: async currentVersion => {
        publishUpdateState({ currentVersion, error: undefined, progress: undefined, status: 'up-to-date' })
      },
      setDownloadProgress: percent => {
        const window = mainWindow
        if (window !== undefined && !window.isDestroyed()) {
          window.setProgressBar(percent === undefined ? -1 : percent / 100)
        }
        if (percent !== undefined) publishUpdateState({ progress: percent, status: 'downloading' })
      },
    },
    updater: electronUpdater.autoUpdater as unknown as DesktopAutoUpdater,
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    backgroundColor: '#f7f8fa',
    height: 900,
    minHeight: 640,
    minWidth: 900,
    show: false,
    title: 'DeepSeek Harness',
    titleBarOverlay: {
      color: '#00000000',
      height: TITLE_BAR_HEIGHT,
      symbolColor: nativeTheme.shouldUseDarkColors ? '#e6e8eb' : '#30343b',
    },
    titleBarStyle: 'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
    width: 1440,
  })
  installDesktopUiCompatibility(window.webContents)
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow = window
  applyWindowColorScheme(nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  return window
}

function focusWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function backendExitHandle(child: ChildProcess): { handle: BackendProcessHandle; startupFailure: Promise<never> } {
  if (child.pid === undefined) throw new Error('DeepSeek Harness backend started without a process id.')
  const pid = child.pid
  let exited = false
  let resolveExit: (() => void) | undefined
  const exit = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise
  })
  const startupFailure = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => {
      exited = true
      resolveExit?.()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      exited = true
      resolveExit?.()
      const detail = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`
      if (!backendReady && !shutdownStarted) reject(new Error(`DeepSeek Harness backend stopped during startup (${detail}).`))
      if (backendReady && !shutdownStarted) {
        dialog.showErrorBox('DeepSeek Harness 已停止', `本地服务意外退出（${detail}）。应用将关闭。`)
        app.quit()
      }
    })
  })
  return {
    handle: {
      get exited() {
        return exited
      },
      pid,
      terminate: () => child.kill('SIGTERM'),
      waitForExit: async () => await exit,
    },
    startupFailure,
  }
}

async function startBackend(): Promise<string> {
  const dshHome = process.env.DSH_DESKTOP_HOME ?? join(app.getPath('userData'), 'dsh-home')
  const workspaceRoot = process.env.DSH_DESKTOP_WORKSPACE
    ?? join(app.getPath('documents'), 'DeepSeek Harness Workspace')
  await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])

  const firstPort = parseFirstPort(process.env.DSH_DESKTOP_PORT)
  const attempts = Math.min(PORT_ATTEMPTS, 65_536 - firstPort)
  const port = await findAvailablePort(firstPort, attempts)
  const paths = resolveDesktopPaths({
    appPath: app.getAppPath(),
    developmentNodePath: process.env.DSH_DESKTOP_NODE ?? process.env.npm_node_execpath ?? 'node',
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  await access(paths.cliEntry)
  if (paths.nodeExecutable.includes('\\') || paths.nodeExecutable.includes('/')) await access(paths.nodeExecutable)

  const spec = createBackendSpawnSpec({
    baseEnv: process.env,
    cliEntry: paths.cliEntry,
    dshHome,
    nodeExecutable: paths.nodeExecutable,
    port,
    workspaceRoot,
  })
  const logsDirectory = join(app.getPath('userData'), 'logs')
  await mkdir(logsDirectory, { recursive: true })
  const log = createWriteStream(join(logsDirectory, 'desktop-backend.log'), { flags: 'a' })
  log.write(`\n[${new Date().toISOString()}] starting ${spec.command} ${spec.args.join(' ')}\n`)
  const child = spawn(spec.command, spec.args, spec.options)
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  child.once('exit', () => log.end())
  const lifecycle = backendExitHandle(child)
  backend = lifecycle.handle
  const url = `http://127.0.0.1:${port}/`
  await Promise.race([
    waitForHttpReady(url, { timeoutMs: STARTUP_TIMEOUT_MS }),
    lifecycle.startupFailure,
  ])
  backendReady = true
  return url
}

async function startApplication(): Promise<void> {
  installApplicationMenu()
  const window = createWindow()
  await window.loadURL(startupPage())
  try {
    const url = await startBackend()
    window.webContents.on('will-navigate', (event, target) => {
      if (target.startsWith(url)) return
      event.preventDefault()
      if (target.startsWith('https://') || target.startsWith('http://')) void shell.openExternal(target)
    })
    await window.loadURL(url)
    const updateTimer = setTimeout(() => void desktopUpdater?.check(false), 10_000)
    updateTimer.unref()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', `${message}\n\n日志：${join(app.getPath('userData'), 'logs', 'desktop-backend.log')}`)
    app.quit()
  }
}

async function stopBackend(): Promise<void> {
  if (backend !== undefined) await stopProcessTree(backend)
  backend = undefined
}

app.setName('DeepSeek Harness')
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shutdownStarted || backend === undefined || backend.exited) return
    event.preventDefault()
    shutdownStarted = true
    void stopBackend().finally(() => app.exit(0))
  })
  void app.whenReady().then(async () => {
    configureDesktopUpdates()
    configureDesktopIpc()
    await startApplication()
  })
}
