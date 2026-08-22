import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateState } from './types.ts'
import css from './UpdateRow.module.css'

const UNAVAILABLE: DesktopUpdateState = {
  currentVersion: '—',
  error: '桌面更新服务不可用。',
  status: 'error',
}

function statusText(state: DesktopUpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查更新…'
    case 'downloading': return '正在下载' + (state.progress === undefined ? '' : ' ' + Math.round(state.progress) + '%') + '…'
    case 'ready': return '版本 ' + (state.availableVersion ?? '') + ' 已下载，可以安装。'
    case 'up-to-date': return '当前已是最新版本。'
    case 'error': return state.error ?? '无法检查更新。'
    default: return '通过 GitHub Releases 获取桌面端更新。'
  }
}

export function UpdateRow(_props: PropsRuntime<'settings.general.item'>) {
  const [state, setState] = useState<DesktopUpdateState>(UNAVAILABLE)
  const bridge = window.dshDesktop

  useEffect(() => {
    if (bridge === undefined) return
    let active = true
    void bridge.getUpdateState().then((next) => {
      if (active) setState(next)
    })
    const unsubscribe = bridge.onUpdateState((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  const busy = state.status === 'checking' || state.status === 'downloading'
  const ready = state.status === 'ready'
  return (
    <div className={css.group}>
      <div className={css.headingRow}>
        <div>
          <div className={css.title}>桌面应用更新</div>
          <div className={css.version}>当前版本 {state.currentVersion}</div>
        </div>
        <button
          className={css.button}
          disabled={bridge === undefined || busy}
          type="button"
          onClick={() => {
            if (ready) void bridge?.installUpdate()
            else void bridge?.checkForUpdates()
          }}
        >
          {ready ? '重启并更新' : busy ? '处理中…' : '检查更新'}
        </button>
      </div>
      <div aria-live="polite" className={state.status === 'error' ? css.error : css.status}>
        {statusText(state)}
      </div>
      {state.status === 'error' && state.error?.includes('404') === true && (
        <div className={css.hint}>
          GitHub 私有仓库不能被已安装客户端匿名读取；请改用公开的 Release 仓库。
        </div>
      )}
    </div>
  )
}
