import { defineConfig } from 'tsdown'

// Upstream build:lib enumerates apps/desktop alongside its library workspaces.
// TypeScript also emits the standalone CommonJS preload; keep it in lib.
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['electron', 'electron-updater'] },
})
