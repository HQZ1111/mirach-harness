/**
 * Round-2 shape fixes: mirror call sites read these bridge members unguarded or
 * as functions, so the shim types must match those exact shapes. Each entry cites
 * the reading site.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'
const edits = []

function patch(path, pairs) {
  const p = SHIM + path
  let t = readFileSync(p, 'utf8')
  let changed = false
  for (const [from, to] of pairs) {
    if (!t.includes(from)) continue
    t = t.split(from).join(to)
    changed = true
  }
  if (changed) {
    writeFileSync(p, t, 'utf8')
    edits.push(path)
  }
}

// getMachineProfile: i18n/context.tsx awaits `.getMachineProfile?.().catch()`
// → it is a function returning a Promise.
patch('global.ts', [
  ['  getMachineProfile?: { locale?: unknown }', '  getMachineProfile?: () => Promise<{ locale?: unknown }>'],
  // localSkin: themes/backend-sync reads `.localSkin?.skin?.name` → a payload object.
  ['  localSkin?: { profile?: unknown; skin?: unknown }', '  localSkin?: { profile?: unknown; skin?: { name?: unknown } | null } | null'],
  // favicon: components/ui/favicon expects a resolved URL string.
  ['  resolveFavicon?: (url: string) => Promise<null | string> | null', '  resolveFavicon?: (url: string) => Promise<string>'],
  // openExternal: lib/mcp-dashboard-oauth calls it unguarded.
  ['  openExternal?: (url: string) => Promise<void>', '  openExternal: (url: string) => Promise<void>'],
  // cloud: connectors/data/portal calls `window.hermesDesktop.cloud.status(...)` unguarded.
  ['  cloud?: { status?: string }', '  cloud?: { status: (payload?: Record<string, unknown>) => Promise<unknown> }'],
  // mcpOauth: lib/mcp-dashboard-oauth awaits listen() and calls wait/cancel with an id.
  [
    `  mcpOauth?: {
    cancel: (id: string) => Promise<unknown>
    listen: () => Promise<{ id: string; redirectUri: string } | undefined>
    start: (payload: Record<string, unknown>) => Promise<unknown>
    wait: (id: string) => Promise<{ error?: string; iss?: string; state?: unknown }>
  }`,
    `  mcpOauth?: {
    cancel: (id: string) => Promise<void>
    listen: () => Promise<{ id: string; redirectUri: string } | null>
    start: (payload: Record<string, unknown>) => Promise<unknown>
    wait: (id: string) => Promise<{ error?: string; iss?: string; state?: unknown }>
  }`
  ]
])

// interface-mode: the mirror's pane-shell tree store consumes the upstream store
// API (modeLayout.atom/.mode/.restoring/.write/.has/.onRestore). Restore the
// upstream module; its deps are present (layout-persistence, persisted, tool-view,
// windows). store/layout's narrow adapter only needs to keep exporting
// $sidebarRowMeta for the contract — interface-mode reads its OWN copy.
mkdirSync(SHIM + 'store/', { recursive: true })
writeFileSync(SHIM + 'store/tool-view.ts', readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/store/tool-view.ts', 'utf8'))

// upstream interface-mode needs these; copy upstream layout (1,059 lines) only if
// interface-mode actually imports it — it imports store/layout for the sidebar
// row meta computed. The mirror contract needs $sidebarRowMeta from store/layout,
// and interface-mode reads store/layout's own export. So restore upstream layout.
writeFileSync(
  SHIM + 'store/layout.ts',
  readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/store/layout.ts', 'utf8')
)

// interface-mode upstream deps:
for (const rel of ['store/windows.ts']) {
  // windows stays the narrow adapter (already present)
}
// Restore upstream panes (interface-mode reads it) and the reasoning-disclosure /
// statusbar-prefs that read modeBound from interface-mode.
for (const rel of ['store/panes.ts', 'store/reasoning-disclosure.ts', 'store/statusbar-prefs.ts']) {
  writeFileSync(SHIM + rel, readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/' + rel, 'utf8'))
}

// Upstream layout/interface-mode/panes/tool-view chains need these stores back:
for (const rel of ['store/pull-requests.ts', 'store/session-dot-state.ts', 'lib/chat-runtime.ts']) {
  const dest = SHIM + rel
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/' + rel, 'utf8'))
}

// model-visibility for custom-models:
writeFileSync(
  SHIM + 'store/model-visibility.ts',
  readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/store/model-visibility.ts', 'utf8')
)

// free-tier chain (upstream free-tier reads these):
for (const rel of ['store/free-tier-challenge.ts', 'store/onboarding-presence.ts']) {
  const dest = SHIM + rel
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/' + rel, 'utf8'))
}

// external-links + preview: external-link.tsx (upstream) reads both.
for (const rel of ['store/external-links.ts', 'store/preview.ts']) {
  const dest = SHIM + rel
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/' + rel, 'utf8'))
}

// app/gateway hook at the path the mirror imports:
{
  const dest = SHIM + 'app/gateway/hooks/use-gateway-request.ts'
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(
    dest,
    `/**
 * @/app/gateway/hooks/use-gateway-request shim - the dial-a-request hook.
 *
 * Upstream keeps a live gateway socket ref, reconnects with backoff when the
 * transport drops (re-minting single-use OAuth tickets), and replays the request
 * on the recovered socket.
 *
 * Host: no socket, no reconnection, no RPC channel. requestGateway rejects with
 * the reason; the plugins tab's callers surface that through their existing
 * notifyError paths, which is the honest failure mode - a returned-but-empty
 * result would render as "no plugins installed" and hide the gap.
 */

import { useMemo } from 'react'

export interface GatewayRequest {
  <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>
}

export function useGatewayRequest(): {
  connectionRef: { current: null }
  gateway: null
  gatewayRef: { current: null }
  requestGateway: GatewayRequest
} {
  return useMemo(() => {
    const gatewayRef: { current: null } = { current: null }
    const connectionRef: { current: null } = { current: null }

    const requestGateway: GatewayRequest = <T,>(method: string) =>
      Promise.reject<T>(new Error('网关 RPC「' + method + '」在本宿主不存在：pi 是进程内引擎，没有 JSON-RPC 通道'))

    return { connectionRef, gateway: null, gatewayRef, requestGateway }
  }, [])
}
`,
    'utf8'
  )
}

// The old path copy is redundant now.
rmSync(SHIM + 'app-gateway', { recursive: true, force: true })

// setup-field-list: the connection-request parser imports SetupField from it.
writeFileSync(
  SHIM + 'components/ui/setup-field-list.tsx',
  readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/components/ui/setup-field-list.tsx', 'utf8')
)

console.log('round-2 fixes applied to:', edits.join(', '))
