/**
 * Replace the last upstream-copied shim modules whose dependency chains (chat
 * runtime, preview, Electron fs) are not on the capabilities page's path, with
 * the narrow adapters that satisfy the mirror contract. Also widen the bridge
 * member types the copied modules need. Run, then `hermes-shim-prune2.mjs`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'
const files = new Map()

// store/layout — the mirror reads only $sidebarRowMeta. Upstream's 1,059-line
// layout store drives hermes' sidebar/pane tree (pane-shell), which this host
// replaces with dockview.
files.set(
  'store/layout.ts',
  `/**
 * @/store/layout shim - sidebar row metadata.
 *
 * Upstream a 1,059-line store driving hermes sidebar/pane tree (pane-shell
 * zones, per-profile layout persistence). The host pane layout is dockview
 * (dockview-column-constraints + the serialized layout), and the sidebar is
 * components/panes/session-manage with its own catalog store. The capabilities
 * tree reads exactly one export - $sidebarRowMeta - so that is what lives here.
 */

import { map } from 'nanostores'

export interface SidebarRowMeta {
  label: string
}

export const $sidebarRowMeta = map<Record<string, SidebarRowMeta>>({})
`
)

// store/windows — the mirror reads only the two predicates. Upstream also opens
// secondary windows and owns the window-relay protocol (Electron-only).
files.set(
  'store/windows.ts',
  `/**
 * @/store/windows shim - main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts) and owns the
 * window-relay protocol between them. The host has one main window plus a
 * settings window (which does not mount the capabilities page), so both
 * predicates are false and the relay surface is absent - which every caller
 * already treats as "single window".
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}
`
)

// contrib/runtime-loader — upstream evaluates desktop plugin.js in a sandboxed
// JS runtime (1,120 lines) against the plugin SDK. No renderer plugin runtime
// exists here (pi extensions run in the agent, not the renderer).
files.set(
  'contrib/runtime-loader.ts',
  `/**
 * @/contrib/runtime-loader shim - the desktop plugin JS runtime.
 *
 * Upstream 1,120 lines: scans the app plugin root, rewrites import specifiers,
 * evaluates plugin.js in a sandboxed module context, calls the plugin register()
 * against the plugin SDK, and watches the file for reloads.
 *
 * Host: no renderer plugin runtime - pi extensions run in the agent, not here.
 * Both exports report the true state: a scan finds nothing (nothing to watch),
 * and an uninstall has nothing to remove. The Plugins tab desktop column renders
 * from the plugins store, which stays empty.
 */

export async function discoverRuntimePlugins(): Promise<void> {
  // No plugin root, no runtime, no plugins. The mirrored callers await this
  // before (re)reading the plugin records; an immediate resolve is the truth.
}

export async function uninstallDiskPlugin(pluginId: string): Promise<{ error?: string; ok: boolean }> {
  return { error: '本宿主没有桌面插件运行时，无法卸载 ' + pluginId, ok: false }
}
`
)

// app/gateway/hooks/use-gateway-request — upstream keeps a live gateway socket
// ref and replays requests across reconnects. No socket exists here.
files.set(
  'app/gateway/hooks/use-gateway-request.ts',
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
`
)

// Upstream copies that only existed to serve chains now cut above.
for (const rel of [
  'store/preview.ts',
  'store/preview-ownership.ts',
  'store/preview-status.ts',
  'store/preview-explicit.ts',
  'store/composer.ts',
  'store/session-request-router.ts',
  'store/session-dot-state.ts',
  'store/pull-requests.ts',
  'store/send-diagnostics.ts',
  'store/onboarding-presence.ts',
  'store/session-focus.ts',
  'store/free-tier-challenge.ts',
  'lib/desktop-fs.ts',
  'lib/media.ts',
  'lib/generated-images.ts',
  'lib/image-resize.ts',
  'lib/gateway-ws-url.ts',
  'lib/session-link-title.ts',
  'lib/session-refs.ts',
  'lib/desktop-slash-commands.ts',
  'lib/chat-runtime.ts',
  'lib/draft-title.ts',
  'lib/preview-annotate/handoff.ts',
  'lib/preview-annotate/group.ts',
  'lib/preview-annotate/identity.ts',
  'lib/preview-annotate/pack.ts',
  'lib/preview-annotate/stack.ts',
  'lib/preview-annotate/tokens.ts',
  'lib/chat-messages/index.ts',
  'lib/chat-messages/types.ts',
  'lib/chat-messages/parts.ts',
  'lib/chat-messages/tool-parts.ts',
  'lib/chat-messages/hydration.ts',
  'lib/chat-messages/reconciliation.ts',
  'lib/chat-messages/attachment-turn.ts',
  'lib/keyed-timeouts.ts',
  'lib/lru-cache.ts',
  'lib/path-compare.ts',
  'lib/todos.ts',
  'lib/provider-setup-errors.ts',
  'lib/runtime-readiness.ts',
  'lib/hermes-open-target.ts',
  'lib/embedded-images.ts',
  'lib/spoken-reply.ts',
  'lib/session-signatures.ts',
  'lib/artifact-detect.ts',
  'lib/legacy-session-owner-backfill.ts',
  'lib/session-owner-stamp.ts',
  'lib/connection-scoped.ts',
  'lib/session-source.ts',
  'lib/session-timer-since.ts',
  'lib/wake-indicator.ts',
  'api/canonical-protocol.ts',
  'app/open-session.ts',
  'app/types.ts',
  'app/chat/composer/types.ts',
  'app/chat/composer/large-paste.ts',
  'app/chat/thread-loading.ts',
  'app/chat/transcript-backfill.ts',
  'app/chat/sidebar/projects/workspace-groups.ts',
  'app/session/hooks/use-session-actions/utils.ts',
  'app/session/hooks/use-prompt-actions/utils.ts',
  'app/contrib/hooks/use-background-sync.ts',
  'app/contrib/wiring-routing.ts',
  'components/assistant-ui/directive-text.tsx',
  'components/assistant-ui/reference-kinds.ts',
  'components/pane-shell/workspace-scope.ts',
  'components/ui/setup-field-list.tsx',
  'components/ui/field.tsx',
  'store/project-tree.ts',
  'store/starmap.ts',
  'store/shared-metrics.ts',
  'store/tool-view.ts',
  'store/session-removal.ts',
  'store/session-owner-resolution.ts',
  'store/session-unread.ts',
  'store/session-unread-remote.ts',
  'store/transcript-tail.ts',
  'store/transcript-tail-cache.ts',
  'store/provider-wait.ts',
  'store/recovery-requests.ts',
  'store/model-visibility.ts',
  'store/local-model-offer.ts',
  'store/onboarding-phase.ts',
  'store/subagents.ts',
  'store/external-links.ts',
  'store/notify-baseline.ts',
  'store/session-event-provenance.ts',
  'store/connection-registry-state.ts',
  'store/profile-remote-override.ts',
  'store/default-profile.ts',
  'store/chat-text-scale.ts',
  'store/workspace-events.ts',
  'store/parked-card-answers.ts',
  'store/haptics.ts'
]) {
  const target = SHIM + rel
  if (existsSync(target)) rmSync(target, { force: true })
}

console.log('adapters restored:', files.size)
