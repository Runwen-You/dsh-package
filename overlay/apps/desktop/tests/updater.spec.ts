import { describe, expect, it, vi } from 'vitest'
import {
  DesktopUpdateController,
  isPrereleaseVersion,
} from '../src/updater.ts'
import type {
  DesktopAutoUpdater,
  DesktopUpdateUi,
} from '../src/updater.ts'

class FakeUpdater implements DesktopAutoUpdater {
  allowPrerelease = false
  autoDownload = true
  autoInstallOnAppQuit = true
  readonly checkForUpdates = vi.fn(async () => undefined)
  readonly downloadUpdate = vi.fn(async () => undefined)
  readonly quitAndInstall = vi.fn()
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function createUi(overrides: Partial<DesktopUpdateUi> = {}): DesktopUpdateUi {
  return {
    confirmDownload: vi.fn(async () => true),
    confirmInstall: vi.fn(async () => true),
    reportError: vi.fn(async () => undefined),
    reportNoUpdate: vi.fn(async () => undefined),
    setChecking: vi.fn(),
    setDownloadProgress: vi.fn(),
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('desktop updater', () => {
  it('follows prerelease releases only from a prerelease installation', () => {
    expect(isPrereleaseVersion('0.1.1-rc.2')).toBe(true)
    expect(isPrereleaseVersion('0.1.1')).toBe(false)

    const prereleaseUpdater = new FakeUpdater()
    new DesktopUpdateController({
      currentVersion: '0.1.1-rc.2',
      enabled: true,
      prepareInstall: vi.fn(async () => undefined),
      ui: createUi(),
      updater: prereleaseUpdater,
    })
    expect(prereleaseUpdater.allowPrerelease).toBe(true)
    expect(prereleaseUpdater.autoDownload).toBe(false)
    expect(prereleaseUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('reports a manual no-update result but keeps automatic checks quiet', async () => {
    const updater = new FakeUpdater()
    const ui = createUi()
    const controller = new DesktopUpdateController({
      currentVersion: '1.2.3',
      enabled: true,
      prepareInstall: vi.fn(async () => undefined),
      ui,
      updater,
    })

    await controller.check(false)
    updater.emit('update-not-available', { version: '1.2.3' })
    await settle()
    expect(ui.reportNoUpdate).not.toHaveBeenCalled()

    await controller.check(true)
    updater.emit('update-not-available', { version: '1.2.3' })
    await settle()
    expect(ui.reportNoUpdate).toHaveBeenCalledWith('1.2.3')
  })

  it('times out a stuck automatic check after a manual request and allows retrying', async () => {
    vi.useFakeTimers()
    try {
      const updater = new FakeUpdater()
      updater.checkForUpdates.mockImplementationOnce(async () => await new Promise(() => undefined))
      const ui = createUi()
      const controller = new DesktopUpdateController({
        checkTimeoutMs: 1_000,
        currentVersion: '1.2.3',
        enabled: true,
        prepareInstall: vi.fn(async () => undefined),
        ui,
        updater,
      })

      const automaticCheck = controller.check(false)
      await controller.check(true)
      expect(ui.setChecking).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1_000)
      await automaticCheck
      expect(ui.reportError).toHaveBeenCalledWith('检查更新超时，请检查网络连接后重试。')

      await controller.check(true)
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads with consent and stops the backend before installing', async () => {
    const updater = new FakeUpdater()
    const ui = createUi()
    const prepareInstall = vi.fn(async () => undefined)
    new DesktopUpdateController({
      currentVersion: '1.2.3',
      enabled: true,
      prepareInstall,
      ui,
      updater,
    })

    updater.emit('update-available', { version: '1.3.0' })
    await settle()
    expect(ui.confirmDownload).toHaveBeenCalledWith({ version: '1.3.0' })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()

    updater.emit('download-progress', { percent: 37.5 })
    expect(ui.setDownloadProgress).toHaveBeenCalledWith(37.5)
    updater.emit('update-downloaded', { version: '1.3.0' })
    await settle()
    expect(prepareInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('can defer installation until the Web settings row requests a restart', async () => {
    const updater = new FakeUpdater()
    const ui = createUi({ confirmInstall: vi.fn(async () => false) })
    const prepareInstall = vi.fn(async () => undefined)
    const controller = new DesktopUpdateController({
      currentVersion: '1.2.3',
      enabled: true,
      prepareInstall,
      ui,
      updater,
    })

    updater.emit('update-available', { version: '1.3.0' })
    await settle()
    updater.emit('update-downloaded', { version: '1.3.0' })
    await settle()

    expect(prepareInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    await controller.installDownloaded()

    expect(prepareInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('explains why updates are unavailable in a development launch', async () => {
    const updater = new FakeUpdater()
    const ui = createUi()
    const controller = new DesktopUpdateController({
      currentVersion: '1.2.3',
      enabled: false,
      prepareInstall: vi.fn(async () => undefined),
      ui,
      updater,
    })

    await controller.check(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(ui.reportError).toHaveBeenCalledWith('自动更新仅在已安装的正式应用中可用。')
  })
})
