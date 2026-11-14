/**
 * @/store/agent-plugins shim - the Plugins tab's agent-side list.
 *
 * Upstream hermes has a plugin runtime: plugins.manage RPCs over the gateway,
 * with manifests declaring settings schemas, app-backed MCP servers, git/catalog
 * provenance and update pins.
 *
 * Host: rpi's extensions are native cdylib plugins (`~/.rpi/agent/extensions/*.dll`,
 * registered in `native-packages.json`). They carry no manifest - no description,
 * capabilities, settings schema or install/update pinning. The list itself is real
 * (file metadata merged with the install registry by `pi_extensions`); everything
 * a manifest would have declared is reported as empty/null rather than invented.
 *
 * Every mutation fails loudly with the reason (installs/removals/updates belong to
 * the engine-side CLI). Nothing invents a plugin.
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
  category: string
  description: string
  file: string
  line: number
  severity: string
}

/** Outcome of updateAgentPlugin: `applied` when the update landed, `unchanged`
 *  when already current, `consent` when a new catalog pin widens the plugin
 *  (retry with acceptCapabilities), `scan` when the security scan blocked the
 *  new code (a caution verdict can be retried with `force`). */
export type AgentPluginUpdateOutcome =
  | { kind: 'applied' | 'failed' | 'unchanged' }
  | { deltaLines: string[]; kind: 'consent'; sha: string }
  | { findings: AgentPluginScanFinding[]; kind: 'scan'; verdict: string }

export interface AgentPluginUpdateOptions {
  /** Apply a catalog re-pin the user confirmed after a `consent` outcome. */
  acceptCapabilities?: boolean
  /** Apply an update whose scan returned caution, after the user saw the findings. */
  force?: boolean
}

export const $agentPlugins = atom<AgentPluginRow[]>([])
export const $agentPluginsStatus = atom<AgentPluginsStatus>('idle')
export const $agentPluginsError = atom<string | null>(null)
export const $agentPluginBusy = atom<string | null>(null)

interface PiExtensionRow {
  /** Empty: cdylib extensions have no manifest to declare capabilities. */
  capabilities: string[]
  description: string
  entry: string
  extensionId: string
  name: string
  root: string
  runtime: string
  version: string
  /** ABI version from `native-packages.json` (null for hand-dropped dlls). */
  abi?: null | number
  file?: string
  modifiedMs?: number
  registered?: boolean
  repository?: null | string
  sizeBytes?: number
  source?: null | string
  target?: null | string
}

/** pi has no runtime plugin registry, so a row cannot be "desktop relevant". */
export const isDesktopRelevantPlugin = (_row: AgentPluginRow): boolean => false

/** Map an rpi extension row onto the plugin row shape. status is 'enabled'
 *  because the engine loads every library it finds in the extension directory
 *  (registered artifacts and hand-dropped ones alike) - there is no disable flag. */
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
      $agentPluginsError.set(result.diagnostics.map(d => d.path + ': ' + d.message).join('\n'))
    }
    $agentPlugins.set(result.extensions.map(toRow))
    $agentPluginsStatus.set('ready')
  } catch (err) {
    $agentPlugins.set([])
    $agentPluginsStatus.set('error')
    $agentPluginsError.set(err instanceof Error ? err.message : String(err))
  }
}

const NO_RUNTIME =
  '本宿主没有插件运行时：rpi 扩展是引擎侧 cdylib 插件，安装/卸载/更新走引擎 CLI（rpi install / rpi uninstall / rpi extension update）'

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
  return { kind: 'failed' }
}
