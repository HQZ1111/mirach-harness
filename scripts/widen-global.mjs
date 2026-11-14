import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/hermes-shim/global.ts'
let g = readFileSync(path, 'utf8')

// Upstream declares the bridge as REQUIRED on Window; the mirror mixes optional
// and required access, so optional here would fail the required sites.
g = g.replace('    hermesDesktop?: HermesDesktopBridge', '    hermesDesktop: HermesDesktopBridge')

// Bridge members the mirrored tree touches. `unknown` where only the presence
// matters (they are unreachable on this host — no Electron main to answer).
const additions = [
  '  cloud?: unknown',
  '  fetchLinkTitle?: (url: string) => Promise<string>',
  '  getMachineProfile?: () => Promise<unknown>',
  '  glassSupported?: () => boolean',
  '  localSkin?: () => unknown',
  '  logLine?: (line: string) => void',
  '  mcpOauth?: (payload: Record<string, unknown>) => Promise<unknown>',
  '  openBrowserWindow?: (url: string) => Promise<void>',
  '  openSessionInTerminal?: (payload: Record<string, unknown>) => Promise<void>',
  '  openSessionWindow?: (payload: Record<string, unknown>) => Promise<void>',
  '  openWindow?: (payload: Record<string, unknown>) => Promise<void>',
  '  resolveFavicon?: (url: string) => Promise<{ origin?: string }> | null',
  '  revealLogs?: () => Promise<void>',
  '  saveImageFromUrl?: (url: string, name?: string) => Promise<{ error?: string; ok: boolean }>',
  '  setNativeTheme?: (theme: string) => Promise<void>',
  '  setTitleBarTheme?: (theme: unknown) => Promise<void>',
  '  setTranslucency?: (state: unknown) => Promise<void>',
  '  settings?: unknown',
  '  stopPreviewFileWatch?: (payload: Record<string, unknown>) => Promise<void>',
  '  translucencySupported?: () => boolean',
  '  updates?: unknown',
  '  writeClipboard?: (text: string) => Promise<{ error?: string; ok: boolean }>'
]
if (!g.includes('  writeClipboard?')) {
  g = g.replace('  logLine?: (line: string) => void', additions.join('\n'))
}

writeFileSync(path, g, 'utf8')
console.log('global.ts widened: required bridge +', additions.length, 'members')
