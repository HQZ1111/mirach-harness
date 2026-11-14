/**
 * Regenerate the small host-boundary adapters. Bodies are plain (no template
 * literals inside), so they embed safely; each header carries its upstream
 * counterpart and what pi maps to. Run after `hermes-shim-pure-only.mjs`, which
 * copies the verbatim upstream modules and never deletes anything.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'

const FILES = new Map()

FILES.set(
  'store/session-states.ts',
  `/**
 * @/store/session-states shim - session tiles and owner-routed RPCs.
 *
 * Upstream: a 3,133-line store of per-session tile state (pinned panes, dock
 * layout, provider wait, preview status) plus requestForOwnedSession, which
 * routes a JSON-RPC call to the gateway that owns a given session.
 *
 * Host: pi is in-process - one engine, no per-session sockets, so there is no
 * owner routing to do. requestForOwnedSession fails loudly: the only caller in
 * the capabilities tree is lib/mcp-reload.ts (the live reload.mcp RPC), which the
 * MCP tab already treats as optional. An empty success would read as "reloaded
 * nothing", which is worse than saying the RPC does not exist.
 */

export type TileDock = 'bottom' | 'left' | 'right'

/** Upstream routes to the gateway that owns sessionId. One engine, and no RPC
 *  channel to route over. */
export function requestForOwnedSession<T>(
  sessionId: null | string | undefined,
  _ambient: unknown,
  method: string,
  _params?: unknown
): Promise<T> {
  return Promise.reject(
    new Error(
      '会话级 RPC「' + method + '」在本宿主不存在：pi 是进程内引擎，MCP 配置在会话创建时生效' +
        (sessionId ? '（会话 ' + sessionId + '）' : '')
    )
  )
}
`
)

FILES.set(
  'store/connection-request.ts',
  `/**
 * @/store/connection-request shim - the connector/install card model.
 *
 * Upstream this store holds the in-flight connection.request operation for a
 * chat: the backend (hermes) emits targets, the renderer draws a card, the user
 * answers, the backend settles it. The capabilities page uses only the pure
 * part - the target parser and its type - to render the hosted-connector
 * directory.
 *
 * Host: pi has no hosted connectors and no connection.request event, so there is
 * no operation to hold. The parser is kept because the connectors tab feeds it
 * rows from whatever source exists; with pi that source is empty and the page
 * shows "no hosted connectors" truthfully.
 */

import type {
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetState
} from '@/hermes-mirror/shared'

import type { SetupField } from '@/hermes-shim/components/ui/setup-field-list'

export type { ConnectionTargetAction, ConnectionTargetEnvField, ConnectionTargetKind, ConnectionTargetState }

export interface CatalogEntry {
  approved: null | unknown
  description: string
  display: string
  hasDesktopHalf: boolean
  phase: null | string
  platforms: string[]
  repo: null | string
  requiresHermes: null | string
  resolved: boolean
  scan: null | unknown
  sha: null | string
  skill: null | string
  subdir: null | string
  targetProfile: null | string
  tier: null | string
}

/** One target of the operation as the renderer knows it. */
export interface ConnectionTarget {
  action: ConnectionTargetAction
  alias?: null | string
  catalog?: CatalogEntry
  connectUrl: null | string
  connectionId: string
  detail: string
  discoveryError: null | string
  instructions: null | string
  kind: ConnectionTargetKind
  name: string
  requiredEnv: SetupField[]
  state: ConnectionTargetState
  tools: string[]
}

/** The wire shape the backend sends (kept so the parser has a real input type). */
export interface ConnectionOperationTarget {
  action?: string
  alias?: null | string
  approved?: null | unknown
  connect_url?: null | string
  connection_id?: null | string
  description?: string
  detail?: null | string
  discovery_error?: null | string
  display?: string
  has_desktop_half?: boolean
  instructions?: null | string
  kind?: string
  name: string
  phase?: null | string
  platforms?: string[]
  repo?: null | string
  required_env?: ConnectionTargetEnvField[] | null
  requires_hermes?: null | string
  resolved?: boolean
  scan?: null | unknown
  sha?: null | string
  skill?: null | string
  state?: string
  subdir?: null | string
  target_profile?: null | string
  tier?: null | string
  tools?: string[]
}

const KINDS: readonly ConnectionTargetKind[] = ['mcp', 'plugin', 'skill', 'connector']
const ACTIONS: readonly ConnectionTargetAction[] = ['connect', 'install', 'reconnect']
const STATES: readonly ConnectionTargetState[] = ['pending', 'running', 'failed', 'expired', 'done']

const pick = <T extends string>(values: readonly T[], value: string | undefined): T | null =>
  value !== undefined && (values as readonly string[]).includes(value) ? (value as T) : null

const envFields = (fields: ConnectionTargetEnvField[] | null | undefined): SetupField[] =>
  (fields ?? []).map(({ default: defaultValue, name, prompt, required, secret }) => ({
    default: defaultValue,
    name,
    prompt: prompt ?? undefined,
    required,
    secret
  }))

export function parseConnectionTarget(entry: ConnectionOperationTarget): ConnectionTarget | null {
  const name = entry.name.trim()

  if (!name) {
    return null
  }

  return {
    action: pick(ACTIONS, entry.action) ?? 'install',
    alias: entry.alias ?? null,
    connectUrl: entry.connect_url ?? null,
    connectionId: entry.connection_id ?? '',
    detail: entry.detail ?? '',
    discoveryError: entry.discovery_error ?? null,
    instructions: entry.instructions ?? null,
    // An unknown kind from a backend a version ahead renders as the generic MCP row.
    kind: pick(KINDS, entry.kind) ?? 'mcp',
    name,
    requiredEnv: envFields(entry.required_env),
    state: pick(STATES, entry.state) ?? 'pending',
    tools: entry.tools ?? []
  }
}
`
)

FILES.set(
  'store/free-tier.ts',
  `/**
 * @/store/free-tier shim - the hosted subscription tier.
 *
 * Upstream: the Hermes free tier - a Nous-hosted model allowance with a guest
 * identity, used by the connectors page to explain why hosted connectors need
 * sign-in.
 *
 * Host: no subscription, no guest identity, no hosted connectors, so the status
 * is a constant "not available". Upstream's field names are kept because the
 * connectors page reads has_guest; a constant false there is the truth.
 */

import { atom } from 'nanostores'

export interface FreeTierStatus {
  available: boolean
  has_guest: boolean
  signed_in: boolean
}

/** Never available on this host: pi is a local engine with no hosted offering. */
export const $freeTierStatus = atom<FreeTierStatus>({
  available: false,
  has_guest: false,
  signed_in: false
})

/** Upstream's managed model id. Absent here - nothing consumes it on a host with
 *  no free tier, and null keeps the import site honest. */
export const FREE_TIER_MODEL: null = null
`
)

FILES.set(
  'store/free-tier-sign-in.ts',
  `/**
 * @/store/free-tier-sign-in shim - the hosted-tier sign-in flow.
 *
 * Upstream: opens the Nous account sign-in window and tracks the completed-turn
 * counter that re-reads the connector list after an agent-side connect.
 *
 * Host: no hosted tier, so there is no sign-in to open and no turn counter that
 * would change anything. openFreeTierSignIn says so instead of opening a dead
 * window; the atoms stay so the connectors page can read "nothing pending".
 */

import { atom } from 'nanostores'

/** Nothing to re-read after a turn: the connector list is local config. */
export const $freeTierTurnCompleted = atom(0)

/** Called when an agent-side connect finishes. Deliberately empty: the host has
 *  no hosted tier, so a completed turn cannot change what the page shows. */
export function noteFreeTierAppConnected(): void {}

/** Upstream opens a sign-in window. This host has no account system. */
export function openFreeTierSignIn(): void {
  console.warn('[free-tier] 本宿主没有订阅账户体系，无法打开登录窗口')
}
`
)

FILES.set(
  'store/hub-actions.ts',
  `/**
 * @/store/hub-actions shim - Skills Hub install/update actions.
 *
 * Upstream the Skills Hub is hermes' community skill registry: install POSTs an
 * identifier to the backend, which fetches the skill and spawns a background
 * action whose log the UI tails.
 *
 * Host: pi has no hub. Skills are directories under ~/.pi/agent/skills that the
 * user (or the agent, via manage_skill) writes. Every install entry point fails
 * loudly with that reason - which is exactly what the Skills tab's catalog
 * banner copy already says.
 *
 * The three KEY constants are query keys, not behaviour: kept (same values) so
 * the mirrored query invalidation still works when those queries resolve empty.
 */

import { atom } from 'nanostores'

export const OFFICIAL_SKILLS_KEY = ['official-skills'] as const
export const HUB_SOURCES_KEY = ['skill-hub-sources'] as const
export const UPDATE_ALL_KEY = ['skill-hub-update-all'] as const

export type HubActionPhase = 'error' | 'idle' | 'running'

export interface HubActionState {
  message: string
  phase: HubActionPhase
}

export const $hubActions = atom<Record<string, HubActionState>>({})

const HUB_UNAVAILABLE = '本宿主没有 Skills Hub（pi 的技能是 ~/.pi/agent/skills 下的目录，没有中心仓库可安装）'

export function installHubSkill(_identifier: string, _profile?: unknown): Promise<never> {
  return Promise.reject(new Error(HUB_UNAVAILABLE))
}

export function updateHubSkills(_profile?: unknown): Promise<never> {
  return Promise.reject(new Error(HUB_UNAVAILABLE))
}

/** Upstream notifies with the hub's error copy; kept as a function so call sites
 *  typecheck. It logs the reason rather than pretending a notification fired. */
export function notifyHubActionFailed(error: unknown, _fallback: string, _name: string, _profile?: unknown): void {
  console.error('[hub-actions]', HUB_UNAVAILABLE, error)
}
`
)

FILES.set(
  'store/agent-plugins.ts',
  `/**
 * @/store/agent-plugins shim - the Plugins tab's agent-side list.
 *
 * Upstream hermes has a plugin runtime: plugins.manage RPCs over the gateway,
 * with manifests declaring settings schemas, app-backed MCP servers, git/catalog
 * provenance and update pins.
 *
 * Host: pi has extensions (~/.pi/agent/extensions/* + project .pi/extensions/*),
 * which are manifests (id/name/version/api/runtime/capabilities/description)
 * loaded at session start. There is no install/uninstall RPC, no settings schema,
 * no update pinning - those are upstream runtime features that do not exist here.
 *
 * So the list is real (mapped from pi_extensions) and every mutation fails loudly
 * with the reason. Nothing invents a plugin.
 */

import { atom } from 'nanostores'

import { invokeOnce } from '@/lib/ipc'

export type AgentPluginServerState =
  | 'app_not_running'
  | 'connected'
  | 'endpoint_unavailable'
  | 'hermes_not_connected'
  | 'missing_app'
  | 'no_interactive_session'
  | 'unknown'
  | 'unsupported_gpu'
  | 'version_too_old'

export interface AgentPluginServer {
  name: string
  sentence: string
  state: AgentPluginServerState
}

export type PluginSettingFieldType = 'boolean' | 'enum' | 'json' | 'number' | 'secret' | 'string'

export interface PluginSettingField {
  choices?: string[]
  default?: unknown
  description: string
  env?: string
  has_value?: boolean
  key: string
  label: string
  required: boolean
  type: PluginSettingFieldType
  value?: unknown
}

export interface AgentPluginRow {
  catalog_name?: string
  catalog_sha?: string
  catalog_tier?: string
  catalog_version?: null | string
  description: string
  has_desktop_half?: boolean
  install_dir?: string
  installed_sha?: string
  key?: string
  name: string
  pinned_sha?: string
  portable?: boolean
  settings_schema?: PluginSettingField[]
  servers?: AgentPluginServer[]
  source: string
  status: 'disabled' | 'enabled' | 'not enabled'
  update_available?: boolean
  update_target?: string
  version: string
}

export type AgentPluginsStatus = 'error' | 'idle' | 'loading' | 'ready'

export type GatewayRequest = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

export interface AgentPluginScanFinding {
  detail: string
  kind: string
  path: string
}

export type AgentPluginUpdateOutcome = { error: string; ok: false } | { ok: true; plugin: AgentPluginRow }

export interface AgentPluginUpdateOptions {
  ref?: string
}

export const $agentPlugins = atom<AgentPluginRow[]>([])
export const $agentPluginsStatus = atom<AgentPluginsStatus>('idle')
export const $agentPluginsError = atom<string | null>(null)
export const $agentPluginBusy = atom<string | null>(null)

interface PiExtensionRow {
  capabilities: string[]
  description: string
  entry: string
  extensionId: string
  name: string
  root: string
  runtime: string
  version: string
}

/** pi has no runtime plugin registry, so a row cannot be "desktop relevant". */
export const isDesktopRelevantPlugin = (_row: AgentPluginRow): boolean => false

/** Map a pi extension manifest onto the plugin row shape. status is 'enabled'
 *  because pi loads every manifest it finds - there is no disable flag to read. */
function toRow(extension: PiExtensionRow): AgentPluginRow {
  return {
    description: extension.description,
    install_dir: extension.root,
    key: extension.extensionId,
    name: extension.name,
    source: 'user',
    status: 'enabled',
    version: extension.version
  }
}

export async function loadAgentPlugins(_request: GatewayRequest, _profile?: null | string): Promise<void> {
  $agentPluginsStatus.set('loading')
  $agentPluginsError.set(null)

  try {
    const result = await invokeOnce<{
      diagnostics: { message: string; path: string }[]
      extensions: PiExtensionRow[]
    }>('pi_extensions', { cwd: null })
    // A manifest that failed to parse is pi's diagnostic, surfaced verbatim.
    if (result.diagnostics.length > 0) {
      $agentPluginsError.set(result.diagnostics.map(d => d.path + ': ' + d.message).join('\\n'))
    }
    $agentPlugins.set(result.extensions.map(toRow))
    $agentPluginsStatus.set('ready')
  } catch (err) {
    $agentPlugins.set([])
    $agentPluginsStatus.set('error')
    $agentPluginsError.set(err instanceof Error ? err.message : String(err))
  }
}

const NO_RUNTIME = '本宿主没有插件运行时：pi 的扩展在会话启动时装载，没有安装/开关/更新通道'

export async function toggleAgentPlugin(
  _request: GatewayRequest,
  _key: string,
  _enable: boolean,
  _fallback: string,
  _profile?: null | string
): Promise<boolean> {
  throw new Error(NO_RUNTIME)
}

export async function removeAgentPlugin(
  _request: GatewayRequest,
  _name: string,
  _fallback: string,
  _profile?: null | string
): Promise<boolean> {
  throw new Error(NO_RUNTIME)
}

export async function updateAgentPlugin(
  _request: GatewayRequest,
  _name: string,
  _fallback: string,
  _profile?: null | string,
  _options?: AgentPluginUpdateOptions
): Promise<AgentPluginUpdateOutcome> {
  return { error: NO_RUNTIME, ok: false }
}
`
)

FILES.set(
  'store/activity.ts',
  `/**
 * @/store/activity shim - the desktop action registry.
 *
 * Upstream records background-action rows (hub installs, updates) so a toast can
 * link to a live log. pi has no REST action ids to track; the capabilities page
 * calls this only after an install attempt, which this host cannot start. The
 * store stays so the mirrored code compiles and any future action source has a
 * home; nothing writes to it on its own.
 */

import { atom } from 'nanostores'

export interface DesktopActionTask {
  id: string
  kind: string
  label: string
  startedAt: number
}

export const $desktopActionTasks = atom<DesktopActionTask[]>([])

export function upsertDesktopActionTask(task: DesktopActionTask): void {
  const next = $desktopActionTasks.get().filter(entry => entry.id !== task.id)
  $desktopActionTasks.set([task, ...next])
}
`
)

FILES.set(
  'store/interface-mode.ts',
  `/**
 * @/store/interface-mode shim - the desktop's interface tier.
 *
 * Upstream picks a tier that drives layout density and which panes exist. The
 * host shell is dockview with its own density tokens, so the layout is constant.
 * The types survive because mirrored settings panels read them.
 */

export type InterfaceMode = 'comfortable' | 'compact'

export type InterfaceTier = 'desktop' | 'mobile'

/** The host renders the same layout in every window (one main window). */
export function modeLayout(): 'docked' {
  return 'docked'
}
`
)

FILES.set(
  'store/panes.ts',
  `/**
 * @/store/panes shim - pane size overrides.
 *
 * Upstream lets a pane remember a width/height override the user dragged. The
 * host pane sizing is dockview's (layout/column-constraints.ts + the serialized
 * layout), so these atoms exist for the mirrored imports and stay empty: nothing
 * writes to them and nothing overrides dockview's geometry.
 */

import { map } from 'nanostores'

export interface PaneState {
  id: string
  visible: boolean
}

export const $paneState = map<Record<string, PaneState>>({})
export const $paneWidthOverride = map<Record<string, number>>({})
export const $paneHeightOverride = map<Record<string, number>>({})

export function setPaneWidthOverride(id: string, width: number): void {
  $paneWidthOverride.setKey(id, width)
}

export function setPaneHeightOverride(id: string, height: number): void {
  $paneHeightOverride.setKey(id, height)
}

export function clearAllPaneSizeOverrides(): void {
  $paneWidthOverride.set({})
  $paneHeightOverride.set({})
}
`
)

FILES.set(
  'store/statusbar-prefs.ts',
  `/**
 * @/store/statusbar-prefs shim - which statusbar items the user hid.
 *
 * Upstream the statusbar lives in the app shell; this host has no statusbar, so
 * "nothing hidden" is the only true state. The setters stay (mirrored panels call
 * them) and are inert rather than pretending to persist.
 */

import { atom } from 'nanostores'

export const $statusbarHiddenIds = atom<ReadonlySet<string>>(new Set<string>())

export function isStatusbarLayoutDefault(): boolean {
  return true
}

export function resetStatusbarLayout(): void {
  $statusbarHiddenIds.set(new Set<string>())
}

export function setStatusbarItemVisible(_id: string, _visible: boolean): void {
  // No statusbar exists to hide items from. Deliberately inert: a silent "saved"
  // here would be a fake success (rule 12).
}

export function toggleStatusbarVisible(_id: string): void {
  setStatusbarItemVisible('', false)
}
`
)

FILES.set(
  'store/transcript-lightbox.ts',
  `/**
 * @/store/transcript-lightbox shim - the full-screen transcript overlay.
 *
 * Upstream opens a session transcript over the whole window. The host renders
 * transcripts inside dockview panes, so the overlay state exists but nothing
 * mounts it; open records the session for a future surface.
 */

import { atom } from 'nanostores'

export interface TranscriptLightboxState {
  sessionId: null | string
}

export const $transcriptLightbox = atom<TranscriptLightboxState>({ sessionId: null })

export function openTranscriptLightbox(sessionId: string): void {
  $transcriptLightbox.set({ sessionId })
}

export function closeTranscriptLightbox(): void {
  $transcriptLightbox.set({ sessionId: null })
}
`
)

FILES.set(
  'store/windows.ts',
  `/**
 * @/store/windows shim - main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts). The host has one
 * main window plus a settings window (which does not mount the capabilities
 * page), so both predicates are false.
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}
`
)

FILES.set(
  'store/connections.ts',
  `/**
 * @/store/connections shim - the multi-gateway registry.
 *
 * Upstream keeps registered gateways (local / remote / ssh / cloud) and the
 * active connection id the whole app routes through. pi is in-process: one
 * engine, no registry. null is the honest "local pool" value every caller already
 * handles (they all fall back to 'local').
 */

import { atom } from 'nanostores'

export const $activeConnectionId = atom<null | string>(null)
`
)

FILES.set(
  'store/custom-models.ts',
  `/**
 * @/store/custom-models shim - user-added model endpoints.
 *
 * Upstream merges custom endpoints into the model picker. The host model list
 * comes from pi's models.json (written by the settings page); there is no
 * separate custom-endpoint store, so the merge is the identity function and add
 * records that the store does not exist rather than dropping the value.
 */

import { atom } from 'nanostores'

export interface CustomModel {
  id: string
  label: string
  provider: string
}

export const $customModels = atom<CustomModel[]>([])

export function customModelSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Identity: no custom models exist, so nothing is added to the picker list. */
export function withCustomModels<T extends { id: string }>(models: readonly T[]): T[] {
  return [...models]
}

export function addCustomModel(_model: Omit<CustomModel, 'id'>): void {
  console.warn('[custom-models] 本宿主的模型清单来自 pi 的 models.json（设置页写入），没有自定义端点存储')
}
`
)

FILES.set(
  'store/session-gone-latch.ts',
  `/**
 * @/store/session-gone-latch shim - the ambient socket for a session.
 *
 * Upstream returns the gateway socket a session's RPCs should ride, latched so a
 * session whose socket is gone does not silently route to another profile. pi has
 * no sockets: null is the value the MCP reload path treats as "skip the live
 * reload".
 */

export function ambientRequestFor(_gateway: unknown): null {
  return null
}
`
)

FILES.set(
  'store/layout.ts',
  `/**
 * @/store/layout shim - sidebar row metadata.
 *
 * Upstream stamps each sidebar row with per-profile metadata (dots, labels,
 * archive state). The host sidebar is components/panes/session-manage, which owns
 * that state in its own catalog store, so this atom exists for the mirrored
 * imports and stays empty.
 */

import { map } from 'nanostores'

export interface SidebarRowMeta {
  label: string
}

export const $sidebarRowMeta = map<Record<string, SidebarRowMeta>>({})
`
)

FILES.set(
  'store/plugin-catalog-install.ts',
  `/**
 * @/store/plugin-catalog-install shim - the catalog install modal.
 *
 * Upstream opens a dual-target install dialog (agent half + desktop half) fed by
 * the catalog snapshot. pi's extensions are manifest directories under
 * .pi/extensions/<id>/ - there is no installer to drive, so the open call records
 * what was requested instead of mounting a dialog that could not work.
 */

export interface CatalogPluginInstallRequest {
  catalogName: string
  repo: string
  sha: string
  subdir?: string
}

export function openCatalogPluginInstall(request: CatalogPluginInstallRequest): void {
  console.warn('[plugin-catalog] 本宿主没有插件目录安装通道；pi 的扩展是 .pi/extensions/<id>/ 下的清单目录', request)
}
`
)

FILES.set(
  'store/desktop-metrics.ts',
  `/**
 * @/store/desktop-metrics shim - feature-use telemetry.
 *
 * Upstream a 1,000-line pipeline: batches feature-use and friction events, stamps
 * them with a machine profile and pane scope, ships them to the hermes backend's
 * metrics endpoint (shared_metrics.desktop_* RPCs, gated on the profile's consent
 * switch).
 *
 * Host: no metrics endpoint to ship to, so events are recorded in-memory only.
 * The type surface (ErrorToastCategory) is kept because the notification store's
 * error summaries are typed against it.
 *
 * NOT a silent drop: nothing here pretends to report. Telemetry that goes nowhere
 * is the honest state for an engine with no metrics backend; if one lands,
 * recordFeatureUse is the single write point to wire up.
 */

export type ErrorToastCategory =
  | 'api_key_missing'
  | 'api_key_rejected'
  | 'disk_full'
  | 'gateway_auth_failed'
  | 'method_not_allowed'
  | 'microphone_permission'
  | 'other'
  | 'restart_required'
  | 'rpc_out_of_sync'
  | 'storage_failure'
  | 'timeout'
  | 'unclassified'

export interface FeatureUseEvent {
  at: number
  detail?: string
  feature: string
}

export interface FrictionEvent {
  at: number
  category: ErrorToastCategory
  kind: 'error_toast'
}

const featureUses: FeatureUseEvent[] = []
const frictions: FrictionEvent[] = []

/** In-memory ring (last 200 of each). Nothing ships; see header. */
export function recordFeatureUse(feature: string, detail?: string): void {
  featureUses.push({ at: Date.now(), detail, feature })
  if (featureUses.length > 200) featureUses.shift()
}

export function recordFriction(kind: 'error_toast', category: ErrorToastCategory): void {
  frictions.push({ at: Date.now(), category, kind })
  if (frictions.length > 200) frictions.shift()
}

/** Read back for tests / a future surface. */
export function bufferedEvents(): { featureUses: readonly FeatureUseEvent[]; frictions: readonly FrictionEvent[] } {
  return { featureUses: [...featureUses], frictions: [...frictions] }
}
`
)

for (const [path, body] of FILES) {
  const dest = SHIM + path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, body, 'utf8')
}
console.log('wrote', FILES.size, 'store adapters')
