import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { UpdateRow } from './UpdateRow.tsx'
import type {} from './types.ts'

export const inject = ['slots', 'theme']

export function apply(ctx: ClientContext): void {
  const syncWindowTheme = (snapshot: ThemeSnapshot): void => {
    window.dshDesktop?.setColorScheme(snapshot.active.colorScheme)
  }

  syncWindowTheme(ctx.theme.getTheme())
  ctx.effect(
    () => ctx.on('theme/change', syncWindowTheme),
    'ui-desktop: native title bar theme bridge',
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-update',
    order: 90,
  }, UpdateRow))
}
