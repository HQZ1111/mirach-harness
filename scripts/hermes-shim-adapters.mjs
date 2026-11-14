/**
 * Regenerate the hand-written host adapters under `src/hermes-shim/`.
 *
 * These are NOT upstream copies — they are the host boundary, written against the
 * exact export list the mirror imports (`hermes-boundary.mjs`). The file bodies
 * are embedded here so the adapters can be recreated deterministically; each
 * body's header documents its upstream counterpart and what pi maps to.
 *
 * Embedded as arrays of lines (not template literals) because several bodies
 * contain backticks in prose.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'

// Each entry: [path, lines]
const FILES = [
  ['hermes.ts', HERMES_TS],
  ['bridge.ts', BRIDGE_TS],
  ['routes.ts', ROUTES_TS],
  ['react-router.ts', REACT_ROUTER_TS],
  ['global.ts', GLOBAL_TS],
  ['api/client.ts', API_CLIENT_TS],
  ['api/toolsets.ts', API_TOOLSETS_TS],
  ['api/mcp.ts', API_MCP_TS],
  ['store/gateway.ts', STORE_GATEWAY_TS],
  ['store/profile.ts', STORE_PROFILE_TS],
  ['store/session.ts', STORE_SESSION_TS],
  ['store/notifications.ts', STORE_NOTIFICATIONS_TS],
  ['store/session-states.ts', STORE_SESSION_STATES_TS],
  ['store/connection-request.ts', STORE_CONNECTION_REQUEST_TS],
  ['store/free-tier.ts', STORE_FREE_TIER_TS],
  ['store/free-tier-sign-in.ts', STORE_FREE_TIER_SIGN_IN_TS],
  ['store/hub-actions.ts', STORE_HUB_ACTIONS_TS],
  ['store/agent-plugins.ts', STORE_AGENT_PLUGINS_TS],
  ['store/activity.ts', STORE_ACTIVITY_TS],
  ['store/interface-mode.ts', STORE_INTERFACE_MODE_TS],
  ['store/panes.ts', STORE_PANES_TS],
  ['store/statusbar-prefs.ts', STORE_STATUSBAR_PREFS_TS],
  ['store/transcript-lightbox.ts', STORE_TRANSCRIPT_LIGHTBOX_TS],
  ['store/windows.ts', STORE_WINDOWS_TS],
  ['store/connections.ts', STORE_CONNECTIONS_TS],
  ['store/custom-models.ts', STORE_CUSTOM_MODELS_TS],
  ['store/session-gone-latch.ts', STORE_SESSION_GONE_LATCH_TS],
  ['store/layout.ts', STORE_LAYOUT_TS],
  ['store/plugin-catalog-install.ts', STORE_PLUGIN_CATALOG_INSTALL_TS],
  ['store/desktop-metrics.ts', STORE_DESKTOP_METRICS_TS],
  ['contrib/registry.ts', CONTRIB_REGISTRY_TS],
  ['contrib/types.ts', CONTRIB_TYPES_TS],
  ['contrib/plugins-store.ts', CONTRIB_PLUGINS_STORE_TS],
  ['contrib/react/boundary.tsx', CONTRIB_BOUNDARY_TSX],
  ['contrib/react/use-contributions.ts', CONTRIB_USE_CONTRIBUTIONS_TS],
  ['contrib/runtime-loader.ts', CONTRIB_RUNTIME_LOADER_TS],
  ['contrib/settings-pages.ts', CONTRIB_SETTINGS_PAGES_TS],
  ['app-gateway/hooks/use-gateway-request.ts', USE_GATEWAY_REQUEST_TS],
  ['lib/plugin-catalog.ts', LIB_PLUGIN_CATALOG_TS],
  ['lib/connector-tools.ts', LIB_CONNECTOR_TOOLS_TS],
  ['lib/slash-completion-cache.ts', LIB_SLASH_COMPLETION_CACHE_TS]
]

for (const [path, lines] of FILES) {
  const dest = SHIM + path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, lines.join('\n') + '\n', 'utf8')
}
console.log('wrote', FILES.length, 'adapters')
