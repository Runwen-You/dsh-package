/** Release metadata used by the desktop update prompts. */
export interface DesktopUpdateInfo {
  version: string
}

/** Download progress reported by electron-updater. */
export interface DesktopUpdateProgress {
  percent: number
}

/** Small electron-updater surface kept injectable for deterministic tests. */
export interface DesktopAutoUpdater {
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  on: (event: string, listener: (...args: any[]) => void) => unknown
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

/** User interaction surface owned by Electron's main process. */
export interface DesktopUpdateUi {
  confirmDownload: (info: DesktopUpdateInfo) => Promise<boolean>
  confirmInstall: (info: DesktopUpdateInfo) => Promise<boolean>
  reportError: (message: string) => Promise<void>
  reportNoUpdate: (currentVersion: string) => Promise<void>
  setChecking: () => void
  setDownloadProgress: (percent: number | undefined) => void
}

export interface DesktopUpdateControllerOptions {
  checkTimeoutMs?: number
  currentVersion: string
  enabled: boolean
  prepareInstall: () => Promise<void>
  ui: DesktopUpdateUi
  updater: DesktopAutoUpdater
}

/** Return whether a semantic version opts into GitHub prerelease updates. */
export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 15_000
export const UPDATE_CHECK_TIMEOUT_MESSAGE = '检查更新超时，请检查网络连接后重试。'

async function waitForUpdateCheck<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(UPDATE_CHECK_TIMEOUT_MESSAGE)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Coordinate update checks without coupling policy to Electron dialogs. */
export class DesktopUpdateController {
  private checking = false
  private downloading = false
  private manualCheck = false
  private promptingForDownload = false
  private promptingForInstall = false
  private downloadedInfo: DesktopUpdateInfo | undefined

  constructor(private readonly options: DesktopUpdateControllerOptions) {
    const { updater } = options
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = isPrereleaseVersion(options.currentVersion)
    updater.on('update-available', (info: DesktopUpdateInfo) => {
      void this.handleUpdateAvailable(info)
    })
    updater.on('update-not-available', () => {
      const shouldReport = this.manualCheck
      this.manualCheck = false
      if (shouldReport) void this.options.ui.reportNoUpdate(this.options.currentVersion)
    })
    updater.on('download-progress', (progress: DesktopUpdateProgress) => {
      this.options.ui.setDownloadProgress(Math.max(0, Math.min(100, progress.percent)))
    })
    updater.on('update-downloaded', (info: DesktopUpdateInfo) => {
      void this.handleUpdateDownloaded(info)
    })
    updater.on('error', (error: unknown) => {
      const shouldReport = this.manualCheck || this.downloading
      this.manualCheck = false
      this.downloading = false
      this.options.ui.setDownloadProgress(undefined)
      if (shouldReport) void this.options.ui.reportError(errorMessage(error))
    })
  }

  /** Check GitHub Releases. Automatic network failures remain unobtrusive. */
  async check(manual = false): Promise<void> {
    if (!this.options.enabled) {
      if (manual) await this.options.ui.reportError('自动更新仅在已安装的正式应用中可用。')
      return
    }
    if (this.downloading || this.promptingForDownload || this.promptingForInstall) return
    this.manualCheck ||= manual
    if (this.checking) {
      if (manual) this.options.ui.setChecking()
      return
    }
    if (manual) this.options.ui.setChecking()
    this.checking = true
    try {
      const timeoutMs = Math.max(1, this.options.checkTimeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS)
      await waitForUpdateCheck(this.options.updater.checkForUpdates(), timeoutMs)
    } catch (error) {
      const shouldReport = this.manualCheck
      this.manualCheck = false
      if (shouldReport) await this.options.ui.reportError(errorMessage(error))
    } finally {
      this.checking = false
    }
  }

  /** Install a previously downloaded update after the Web settings UI asks to restart. */
  async installDownloaded(): Promise<void> {
    if (this.downloadedInfo === undefined || this.promptingForInstall) return
    this.promptingForInstall = true
    try {
      await this.options.prepareInstall()
      this.options.updater.quitAndInstall(false, true)
    } catch (error) {
      await this.options.ui.reportError(errorMessage(error))
    } finally {
      this.promptingForInstall = false
    }
  }

  private async handleUpdateAvailable(info: DesktopUpdateInfo): Promise<void> {
    this.manualCheck = false
    if (this.promptingForDownload || this.downloading) return
    this.promptingForDownload = true
    try {
      if (!await this.options.ui.confirmDownload(info)) return
      this.downloading = true
      this.options.ui.setDownloadProgress(0)
      await this.options.updater.downloadUpdate()
    } catch (error) {
      const shouldReport = this.downloading
      this.downloading = false
      this.options.ui.setDownloadProgress(undefined)
      if (shouldReport) await this.options.ui.reportError(errorMessage(error))
    } finally {
      this.promptingForDownload = false
    }
  }

  private async handleUpdateDownloaded(info: DesktopUpdateInfo): Promise<void> {
    this.downloading = false
    this.downloadedInfo = info
    this.options.ui.setDownloadProgress(undefined)
    if (this.promptingForInstall) return
    try {
      if (!await this.options.ui.confirmInstall(info)) return
      await this.installDownloaded()
    } catch (error) {
      await this.options.ui.reportError(errorMessage(error))
    }
  }
}
