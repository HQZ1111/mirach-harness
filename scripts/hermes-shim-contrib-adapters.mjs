/**
 * Regenerate the `contrib/*` adapters and the remaining lib adapters. Same
 * discipline as the store batch: upstream contract, host rationale in the header.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'
const FILES = new Map()

FILES.set(
  'contrib/registry.ts',
  `/**
 * @/contrib/registry shim - the plugin contribution registry.
 *
 * Upstream contrib/ is hermes' JS plugin system: plugins register UI
 * contributions (panes, menu rows, commands) and data contributions (layout
 * presets, themes) into a versioned registry, loaded from disk by a JS runtime
 * (contrib/runtime-loader.ts, 1,120 lines) against a plugin SDK (sdk/).
 *
 * Host: pi has an extension system, but it is a different contract - extensions
 * run inside the agent (tools / slash commands / event hooks, JS/WASM/native
 * runtimes), not in the renderer. There is no renderer plugin runtime here, so
 * nothing can register.
 *
 * The registry therefore starts empty and stays empty. useContributions returns
 * an empty array - honest "no renderer plugins", which the Plugins tab renders as
 * its own empty state instead of a plugin that does not exist.
 */

import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import { atom } from 'nanostores'

export type ContributionSource = 'core' | (string & {})

export type WorkspaceMode = 'sessions' | 'bots'

export interface Contribution {
  area: string
  data?: unknown
  enabled?: boolean
  id: string
  order?: number
  render?: () => React.ReactNode
  source?: ContributionSource
  title?: string
  when?: () => boolean
}

export interface ContributionRegistry {
  register: (contribution: Contribution) => () => void
}

const contributions: Contribution[] = []

/** Bumped on every mutation; useContributions subscribes to it. */
export const $registryVersion = atom(0)

const keyOf = (entry: Contribution) => entry.area + '::' + entry.id

export const registry: ContributionRegistry = {
  register: (contribution: Contribution) => {
    const existing = contributions.findIndex(entry => keyOf(entry) === keyOf(contribution))
    if (existing >= 0) contributions[existing] = contribution
    else contributions.push(contribution)
    $registryVersion.set($registryVersion.get() + 1)
    return () => {
      const index = contributions.findIndex(entry => keyOf(entry) === keyOf(contribution))
      if (index >= 0) contributions.splice(index, 1)
      $registryVersion.set($registryVersion.get() + 1)
    }
  }
}

export function useContributions(area: string): Contribution[] {
  // Subscribing keeps the call correct if a runtime ever lands; today it always
  // reads an empty array.
  useStore($registryVersion)
  return useMemo(
    () => contributions.filter(entry => entry.area === area && entry.enabled !== false),
    [area]
  )
}
`
)

FILES.set(
  'contrib/types.ts',
  `/**
 * @/contrib/types shim - the contribution type contract.
 *
 * Upstream this file carries the full Contribution surface plus the plugin
 * manifest types the loader reads. The registry shim re-declares the shape it
 * actually enforces; re-exporting from there keeps one definition.
 */

export type {
  Contribution,
  ContributionRegistry,
  ContributionSource,
  WorkspaceMode
} from '@/hermes-shim/contrib/registry'
`
)

FILES.set(
  'contrib/plugins-store.ts',
  `/**
 * @/contrib/plugins-store shim - the desktop-half plugin records.
 *
 * Upstream a desktop plugin is a plugin.js dropped into the app plugins root;
 * Electron scans it, records provenance, and this store exposes those records
 * plus enable/disable persistence. Unified packages (agent half + desktop half)
 * are reconciled across the two stores.
 *
 * Host: there is no renderer plugin runtime, so there are no desktop plugin
 * records. The Plugins tab reads this store to build the desktop column - an
 * empty list is the truth, and enablePackageDesktopHalf (which copies a desktop
 * half into the app root) has nothing to act on.
 */

import { atom } from 'nanostores'

export interface PluginRecord {
  description: string
  /** Where the package came from (catalog sidecar / git remote), when known. */
  packageOrigin?: null | { catalogName?: string; repo?: string; sha?: string }
  path: string
  title: string
  version: string
}

export const $pluginRecords = atom<Record<string, PluginRecord>>({})

const NO_DESKTOP_RUNTIME = '本宿主没有桌面插件运行时（无 plugin.js 扫描与装载）'

/** Upstream writes a desktop half into the app root so the agent half can be
 *  installed into a profile. No runtime, no root, nothing to write. */
export function enablePackageDesktopHalf(_record: PluginRecord): void {
  console.warn('[contrib]', NO_DESKTOP_RUNTIME)
}

export function setPluginEnabled(_id: string, _enabled: boolean): void {
  console.warn('[contrib]', NO_DESKTOP_RUNTIME)
}
`
)

FILES.set(
  'contrib/react/boundary.tsx',
  `/**
 * @/contrib/react/boundary shim - the contribution blast wall.
 *
 * ContribRender mounts a contribution render callback as a component (behaviour
 * kept verbatim: its hooks and errors belong to the contribution, not the host
 * surface). The boundary itself is not carried over: it depends on upstream's
 * app-wide ErrorBoundary + ErrorState pair, and with no renderer plugin runtime
 * there is nothing to contain. If a runtime lands, port the boundary with it.
 */

import { createElement, type ReactNode } from 'react'

interface ContribRenderProps {
  render: () => ReactNode
}

export function ContribRender({ render }: ContribRenderProps) {
  return createElement(render)
}
`
)

FILES.set(
  'contrib/react/use-contributions.ts',
  `/**
 * @/contrib/react/use-contributions shim - the area subscription hook.
 *
 * Re-exports the registry hook; with an empty registry it always returns an
 * empty array, which is the honest state for a host with no renderer plugins.
 */

export { useContributions } from '@/hermes-shim/contrib/registry'
`
)

FILES.set(
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

FILES.set(
  'contrib/settings-pages.ts',
  `/**
 * @/contrib/settings-pages shim - Settings > Plugins routing helpers.
 *
 * This module is pure upstream code (no React, no stores): it turns the two
 * plugin-settings feeds into rail entries and resolves deep links. Nothing in it
 * touches the gateway or Electron, so the logic is kept verbatim. The one change:
 * pluginSettingsRouteHref builds a /settings?tab=... URL. The host settings
 * window has no URL router, so the href keeps its shape (it is only ever logged
 * or compared) while the deep link itself is a no-op - the same decision as
 * hermes-shim/react-router.ts at hook level.
 */

export const SETTINGS_PLUGINS_AREA = 'settings.plugins'

export const PLUGIN_SETTINGS_PROFILE_PARAM = 'profile'

export interface PluginSettingsSubpage {
  id: string
  render: () => React.ReactNode
  title: string
}

export interface PluginSettingsPage {
  children?: PluginSettingsSubpage[]
  icon?: string
  id: string
  order?: number
  render: () => React.ReactNode
  title: string
}

export interface PluginSettingsNode {
  agentKey?: string
  id: string
  render?: () => React.ReactNode
  title: string
}

export type PluginSettingsEntryKind = 'agent' | 'desktop'

export interface PluginSettingsEntry extends PluginSettingsNode {
  children: PluginSettingsNode[]
  icon?: string
  key: string
  kind: PluginSettingsEntryKind
  order: number
  pluginId?: string
  title: string
  uid: string
}

export interface PluginSettingsTarget {
  child?: PluginSettingsNode
  entry: PluginSettingsEntry
}

export type PluginSettingsRoute = { agent: string } | { page?: string; plugin: string }

export function pluginSettingsRouteOf(entry: PluginSettingsEntry, child?: PluginSettingsNode): PluginSettingsRoute {
  if (child?.agentKey) {
    return { agent: child.agentKey }
  }

  if (entry.kind === 'agent') {
    return { agent: entry.key }
  }

  return child ? { page: child.id, plugin: entry.key } : { plugin: entry.key }
}

export function pluginSettingsRouteFrom(params: URLSearchParams): null | PluginSettingsRoute {
  const agent = params.get('agent')

  if (agent) {
    return { agent }
  }

  const plugin = params.get('plugin')

  return plugin ? { page: params.get('ppage') ?? undefined, plugin } : null
}

export function pluginSettingsNavId(entry: PluginSettingsEntry, child?: PluginSettingsNode): string {
  if (child?.agentKey) {
    return 'plugins:agent:' + child.agentKey
  }

  return child ? 'plugins:' + entry.uid + ':' + child.id : 'plugins:' + entry.uid
}

type Contribution = import('@/hermes-shim/contrib/registry').Contribution

export function settingsPageContribution(page: PluginSettingsPage): Omit<Contribution, 'source'> {
  return {
    area: SETTINGS_PLUGINS_AREA,
    data: { children: page.children ?? [], icon: page.icon },
    id: page.id,
    order: page.order,
    render: page.render,
    title: page.title
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Runtime plugins are untrusted JS: validate the sub-page list rather than
 *  trusting the TypeScript shape. Malformed and duplicate ids are dropped. */
function subpagesOf(data: unknown): PluginSettingsNode[] {
  const raw = isRecord(data) && Array.isArray(data.children) ? data.children : []
  const seen = new Set<string>()
  const nodes: PluginSettingsNode[] = []

  for (const child of raw) {
    if (!isRecord(child) || !nonEmpty(child.id) || !nonEmpty(child.title) || typeof child.render !== 'function') {
      continue
    }

    if (seen.has(child.id)) {
      continue
    }

    seen.add(child.id)
    nodes.push({ id: child.id, render: child.render as () => React.ReactNode, title: child.title })
  }

  return nodes
}

const pluginIdOf = (source: string | undefined) =>
  source?.startsWith('plugin:') ? source.slice('plugin:'.length) : undefined

export interface PluginSettingsEntriesInput {
  configTitle: string
  contributions: readonly Contribution[]
  packageOf?: (pluginId: string) => null | string | undefined
  rows: readonly import('@/hermes-shim/store/agent-plugins').AgentPluginRow[]
}

export function pluginSettingsEntries({
  configTitle,
  contributions,
  packageOf,
  rows
}: PluginSettingsEntriesInput): PluginSettingsEntry[] {
  const entries: PluginSettingsEntry[] = []

  for (const contribution of contributions) {
    if (!nonEmpty(contribution.title) || typeof contribution.render !== 'function') {
      continue
    }

    const icon = isRecord(contribution.data) && nonEmpty(contribution.data.icon) ? contribution.data.icon : undefined

    entries.push({
      children: subpagesOf(contribution.data),
      icon,
      id: contribution.id,
      key: contribution.id,
      kind: 'desktop',
      order: typeof contribution.order === 'number' ? contribution.order : 0,
      pluginId: pluginIdOf(contribution.source),
      render: contribution.render,
      title: contribution.title,
      uid: 'desktop:' + contribution.id
    })
  }

  for (const row of rows) {
    if (!row.key || !row.settings_schema?.length) {
      continue
    }

    const owner = entries.find(entry => {
      if (!entry.pluginId || entry.agentKey) {
        return false
      }

      const pkg = packageOf?.(entry.pluginId)

      return row.name === pkg || row.name === entry.pluginId || row.key === entry.pluginId
    })

    if (owner) {
      if (!owner.children.some(child => child.agentKey)) {
        owner.children.push({ agentKey: row.key, id: row.key, title: configTitle })
      }

      continue
    }

    entries.push({
      agentKey: row.key,
      children: [],
      id: row.key,
      key: row.key,
      kind: 'agent',
      order: 0,
      title: row.name || row.key,
      uid: 'agent:' + row.key
    })
  }

  return entries.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export function resolvePluginSettingsTarget(
  entries: readonly PluginSettingsEntry[],
  route: null | PluginSettingsRoute
): null | PluginSettingsTarget {
  if (!route) {
    return null
  }

  if ('agent' in route) {
    const standalone = entries.find(entry => entry.kind === 'agent' && entry.key === route.agent)

    if (standalone) {
      return { entry: standalone }
    }

    for (const entry of entries) {
      const child = entry.kind === 'desktop' ? entry.children.find(node => node.agentKey === route.agent) : undefined

      if (child) {
        return { child, entry }
      }
    }

    return null
  }

  const desktop = entries.filter(entry => entry.kind === 'desktop')

  const entry =
    desktop.find(candidate => candidate.key === route.plugin) ??
    desktop.find(candidate => candidate.pluginId === route.plugin)

  if (!entry) {
    return null
  }

  return {
    child: route.page ? entry.children.find(child => !child.agentKey && child.id === route.page) : undefined,
    entry
  }
}

export function pluginSettingsRouteHref(route: null | PluginSettingsRoute, profile?: null | string): string {
  const params = new URLSearchParams({ tab: 'plugins' })

  if (route && 'agent' in route) {
    params.set('agent', route.agent)
  } else if (route) {
    params.set('plugin', route.plugin)

    if (route.page) {
      params.set('ppage', route.page)
    }
  }

  if (profile) {
    params.set(PLUGIN_SETTINGS_PROFILE_PARAM, profile)
  }

  return '/settings?' + params
}

export function pluginSettingsHref(plugin?: string, page?: string): string {
  return pluginSettingsRouteHref(plugin ? { page, plugin } : null)
}
`
)

FILES.set(
  'app-gateway/hooks/use-gateway-request.ts',
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

FILES.set(
  'lib/plugin-catalog.ts',
  `/**
 * @/lib/plugin-catalog shim - the public catalog origin.
 *
 * Upstream points the browser at hermes-agent.nousresearch.com, whose
 * docs/api/{skills,plugins}.json snapshots feed the Skills Hub and the plugin
 * catalog. Those snapshots are hermes own curated registry - skills and plugins
 * written for hermes runtime, with requiresHermes gates.
 *
 * Host (user decision 2026-10-27): point the same browser surface at the awesome
 * lists instead - community-maintained GitHub indexes that anyone can read and
 * that pi skills (plain SKILL.md directories) can actually be sourced from. The
 * catalog-data fetch in the mirror reads CATALOG_ORIGIN + /docs/api/<kind>.json,
 * so the docs host is swapped for the awesome repo and the doc links point at
 * those repositories.
 */

/** Base for catalog snapshots. The mirrored fetch appends /<kind>.json. */
export const CATALOG_ORIGIN = 'https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main'

/** Where the "learn more" links go. */
export const PLUGIN_CATALOG_DOCS_URL = 'https://github.com/punkpeye/awesome-mcp-servers'
export const SKILLS_DOCS_URL = 'https://github.com/hesreallyhim/awesome-claude-code'
/** Upstream submit-a-mod PR link; the awesome lists take PRs the same way. */
export const SUBMIT_MOD_URL = 'https://github.com/hesreallyhim/awesome-claude-code/blob/main/CONTRIBUTING.md'

export const PLUGIN_CATALOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
`
)

FILES.set(
  'lib/connector-tools.ts',
  `/**
 * @/lib/connector-tools shim - connector naming helpers.
 *
 * Upstream this module serves hermes hosted connectors (Nous accounts): slugs
 * like gmail map to Composio logos and connector/gmail/send_email tool names.
 * pi MCP tools are named <server>__<tool> by the engine, so only the two pure
 * helpers the capabilities tree imports are needed - behaviour kept verbatim,
 * pointed at pi naming.
 */

/** Upstream pulls brand art from Composio logo service, keyed by hosted-connector
 *  slugs pi does not have; an MCP server named gmail still gets its logo, and any
 *  other name gets the same deterministic host. */
export const connectorIconUrl = (slug: string): string => 'https://logos.composio.dev/api/' + slug

/** gmail_send_email -> "Gmail - Send Email" (upstream title casing). */
export function connectorTitle(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, ' ').trim()
  if (!cleaned) {
    return slug
  }

  return cleaned.replace(/\\b\\w/g, c => c.toUpperCase())
}
`
)

FILES.set(
  'lib/slash-completion-cache.ts',
  `/**
 * @/lib/slash-completion-cache shim - the composer completion cache.
 *
 * Upstream caches skill/plugin slash completions per profile and invalidates
 * them (plus the React Query layer) whenever a skill or plugin changes, so the
 * composer slash menu reflects the change immediately.
 *
 * Host: the composer is assistant-ui with its own completion pipeline; there is
 * no shared slash-completion cache to invalidate. The mirrored capabilities code
 * calls invalidateSlashCompletions() after every write for exactly that reason,
 * so the call is kept - and it invalidates the one cache this host does keep,
 * the React Query layer, which is what the skills list actually reads.
 */

import { queryClient } from '@/hermes-shim/lib/query-client'

export function invalidateSlashCompletions(): void {
  void queryClient.invalidateQueries({ queryKey: ['skills-list'] })
  void queryClient.invalidateQueries({ queryKey: ['skill-content'] })
  void queryClient.invalidateQueries({ queryKey: ['official-skills'] })
}
`
)

for (const [path, body] of FILES) {
  const dest = SHIM + path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, body, 'utf8')
}
console.log('wrote', FILES.size, 'adapters')
