import type { WebContents } from 'electron'

/**
 * Desktop-only CSS guards for third-party Web UI plugins.
 *
 * The git graph plugin currently tightens its dock row with a negative bottom
 * margin. In the desktop shell that moves the branch chip into the composer
 * border, especially at fractional Windows display scaling. The data
 * attribute is the plugin's stable public marker; neutralizing the margin
 * leaves the host-owned composer gap in charge of vertical spacing.
 */
export const DESKTOP_UI_COMPATIBILITY_CSS = `
:root {
  --dsh-desktop-titlebar-height: 38px;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f7f8fa));
}

html {
  box-sizing: border-box;
  height: 100%;
  padding-top: var(--dsh-desktop-titlebar-height);
}

body {
  height: calc(100vh - var(--dsh-desktop-titlebar-height)) !important;
  min-height: 0 !important;
}

body::before {
  -webkit-app-region: drag;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f7f8fa));
  content: '';
  height: var(--dsh-desktop-titlebar-height);
  inset: 0 0 auto 0;
  position: fixed;
  z-index: 2147483646;
}

[data-gitgraph-chip-anchor] {
  margin-bottom: 0 !important;
}
`

/** Reapply compatibility CSS after navigation and user-triggered reloads. */
export function installDesktopUiCompatibility(webContents: Pick<WebContents, 'insertCSS' | 'on'>): void {
  webContents.on('did-finish-load', () => {
    void webContents.insertCSS(DESKTOP_UI_COMPATIBILITY_CSS)
  })
}
