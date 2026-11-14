/**
 * Final shape fixes for the shim boundary. One pass, then tsc.
 * Each edit is a type/shape correction derived from a tsc error against the
 * mirrored (untouched) call sites.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'
const edits = []

function write(path, body) {
  const dest = SHIM + path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, body, 'utf8')
  edits.push(path)
}

function patch(path, pairs) {
  const p = SHIM + path
  let t = readFileSync(p, 'utf8')
  for (const [from, to] of pairs) {
    if (!t.includes(from)) {
      console.log('MISS', path, '::', String(from).slice(0, 60))
      continue
    }
    t = t.split(from).join(to)
  }
  writeFileSync(p, t, 'utf8')
  edits.push(path + ' (patched)')
}

// ── store/layout → narrow adapter (mirror reads only $sidebarRowMeta) ───────
write(
  'store/layout.ts',
  `/**
 * @/store/layout shim - sidebar row metadata.
 *
 * Upstream a 1,059-line store driving hermes sidebar/pane tree (pane-shell
 * zones, per-profile layout persistence, pull-request badges). The host pane
 * layout is dockview and the sidebar is components/panes/session-manage with its
 * own catalog store. The capabilities tree reads exactly one export here.
 */

import { map } from 'nanostores'

export interface SidebarRowMeta {
  label: string
}

export const $sidebarRowMeta = map<Record<string, SidebarRowMeta>>({})
`
)

// ── store/windows → narrow adapter (mirror reads the two predicates) ────────
write(
  'store/windows.ts',
  `/**
 * @/store/windows shim - main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts) and owns the
 * window-relay protocol between them. The host has one main window plus a
 * settings window (which does not mount the capabilities page), so both
 * predicates are false and the relay surface is absent.
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}
`
)

// ── store/free-tier → narrow adapter (no hosted tier) ───────────────────────
write(
  'store/free-tier.ts',
  `/**
 * @/store/free-tier shim - the hosted subscription tier.
 *
 * Upstream: the Hermes free tier - a Nous-hosted model allowance with a guest
 * identity, derived from the sign-in/challenge stores.
 *
 * Host: no subscription, no guest identity, no hosted connectors, so the status
 * is a constant "not available". Upstream field names are kept because the
 * connectors page reads has_guest; false there is the truth.
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

/** Upstream's managed model id. Absent here - nothing consumes it. */
export const FREE_TIER_MODEL: null = null
`
)

// ── store/custom-models → narrow adapter ────────────────────────────────────
write(
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

// ── store/interface-mode → narrow adapter ───────────────────────────────────
write(
  'store/interface-mode.ts',
  `/**
 * @/store/interface-mode shim - the desktop interface tier.
 *
 * Upstream picks a tier that drives layout density and which layout preset the
 * pane tree uses. The host shell is dockview with its own density tokens, so the
 * tier is a constant and modeLayout reports the host layout. The types survive
 * because mirrored settings panels read them.
 */

export type InterfaceMode = 'simple' | 'advanced'

export type InterfaceTier = 'desktop' | 'mobile'

/** The host renders the same layout in every window (one main window). */
export function modeLayout(): 'docked' {
  return 'docked'
}
`
)

// ── components/ui/setup-field-list → the SetupField type the parser needs ───
write(
  'components/ui/setup-field-list.tsx',
  `/**
 * @/components/ui/setup-field-list shim - the credential prompt field type.
 *
 * Upstream this is a form component for plugin/connection install prompts. The
 * capabilities tree reads only the SetupField type (the connection-request
 * parser); the form itself has no mount point here yet, so the type lives alone.
 */

export interface SetupField {
  default?: unknown
  name: string
  prompt?: string
  required: boolean
  secret?: boolean
}
`
)

// ── contrib/react/boundary → adapter (no app error-boundary to lean on) ─────
write(
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

// ── lib/external-link → narrow adapter ──────────────────────────────────────
write(
  'lib/external-link.tsx',
  `/**
 * @/lib/external-link shim - the outbound link surface.
 *
 * Upstream a 477-line module: URL normalization, title fetching through the
 * Electron bridge, brand favicons, and three link components. The capabilities
 * tree imports openExternalLink (connector "open provider" actions) and the
 * ExternalLink component (catalog detail links). Both route through the host
 * openExternal bridge member, which bridge.ts wires to pi's shell opener.
 */

import { type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/hermes-shim/lib/utils'

/** Open a URL outside the app. Delegates to the bridge's openExternal. */
export function openExternalLink(href: string): void {
  void window.hermesDesktop?.openExternal?.(href)
}

export interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  /** Show the external-link glyph after the label (upstream default). */
  showExternalIcon?: boolean
  children?: ReactNode
}

/** An anchor that always opens outside the app (upstream behaviour). */
export function ExternalLink({ children, className, href, showExternalIcon = true, ...rest }: ExternalLinkProps) {
  return (
    <a
      className={cn('wrap-break-word', className)}
      href={href}
      onClick={event => {
        event.preventDefault()
        openExternalLink(href)
      }}
      rel="noreferrer noopener"
      target="_blank"
      title={href}
      {...rest}
    >
      {children}
      {showExternalIcon && <span aria-hidden> ↗</span>}
    </a>
  )
}
`
)

// ── store/model-visibility → narrow adapter (custom-models imports it) ──────
write(
  'store/model-visibility.ts',
  `/**
 * @/store/model-visibility shim - per-model picker visibility.
 *
 * Upstream hides/shows models in the picker, persisted per profile. The host
 * model list comes from pi; there is no visibility surface yet, so the set is
 * empty and the toggle records that it has nowhere to persist.
 */

import { atom } from 'nanostores'

export const $hiddenModels = atom<ReadonlySet<string>>(new Set<string>())

export function setModelHidden(_id: string, _hidden: boolean): void {
  console.warn('[model-visibility] 本宿主模型清单来自 pi，暂无可见性存储')
}
`
)

// ── store/haptics → trigger flag (lib/haptics imports it) ───────────────────
write(
  'store/haptics.ts',
  `/**
 * @/store/haptics shim - the haptics mute flag.
 *
 * Upstream a per-device mute persisted through the backend settings. The host
 * stores it locally; the flag shape is what lib/haptics reads.
 */

import { atom } from 'nanostores'

export const $hapticsMuted = atom(false)

export function setHapticsMuted(muted: boolean): void {
  $hapticsMuted.set(muted)
}
`
)

// ── global.ts patches ───────────────────────────────────────────────────────
const gpath = SHIM + 'global.ts'
let g = readFileSync(gpath, 'utf8')
g = g.replace(
  "  cloud?: { status?: unknown }",
  "  cloud?: { status?: string }"
)
g = g.replace(
  `  mcpOauth?: {
    cancel?: (payload: Record<string, unknown>) => Promise<unknown>
    listen?: (callback: (payload: unknown) => void) => () => void
    poll?: (payload: Record<string, unknown>) => Promise<unknown>
    start?: (payload: Record<string, unknown>) => Promise<unknown>
    wait?: (payload: Record<string, unknown>, callback: (payload: unknown) => void) => () => void
  }`,
  `  mcpOauth?: {
    cancel: (id: string) => Promise<unknown>
    listen: () => Promise<{ id: string; redirectUri: string } | undefined>
    start: (payload: Record<string, unknown>) => Promise<unknown>
    wait: (id: string) => Promise<{ error?: string; iss?: string; state?: unknown }>
  }`
)
g = g.replace(
  "  localSkin?: () => { profile?: unknown; skin?: unknown }",
  "  localSkin?: { profile?: unknown; skin?: unknown }"
)
g = g.replace(
  "  getMachineProfile?: () => Promise<{ locale?: unknown }>",
  "  getMachineProfile?: { locale?: unknown }"
)
g = g.replace(
  "  resolveFavicon?: (url: string) => Promise<{ origin?: string } | string> | null",
  "  resolveFavicon?: (url: string) => Promise<null | string> | null"
)
g = g.replace("  setNativeTheme?: (theme: string) => void", "  setNativeTheme?: (theme: 'dark' | 'light' | 'system') => void")
g = g.replace(
  "  connectionId?: string\n  remoteHost?: string",
  "  connectionId?: string\n  registryScoped?: boolean\n  remoteHost?: string"
)
writeFileSync(gpath, g, 'utf8')
edits.push('global.ts (patched)')

// ── store/session.ts: registryScoped is read off the connection by the i18n
//    profile provider; it is declared in global's HermesConnection.
{
  const p = SHIM + 'store/session.ts'
  let t = readFileSync(p, 'utf8')
  if (!t.includes('registryScoped')) {
    t = t.replace(
      "export const $connection = atom<HermesConnection | null>(null)",
      "export const $connection = atom<HermesConnection & { registryScoped?: boolean } | null>(null)"
    )
    writeFileSync(p, t, 'utf8')
    edits.push('store/session.ts (patched)')
  }
}

// ── store/connection-request → use the SHARED types (mirror passes shared
//    payloads in; a locally-narrowed shape misaligns) ─────────────────────────
write(
  'store/connection-request.ts',
  `/**
 * @/store/connection-request shim - the connector/install card model.
 *
 * Upstream this store holds the in-flight connection.request operation for a
 * chat: the backend (hermes) emits targets, the renderer draws a card, the user
 * answers, the backend settles it. The capabilities page uses only the pure
 * part - the target parser and its type - for the hosted-connector directory.
 *
 * Host: pi has no hosted connectors and no connection.request event, so there is
 * no operation to hold. The parser reuses the SHARED wire types (the mirror
 * passes those exact payloads in) and keeps upstream's normalization.
 */

import type {
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetState,
  ConnectionOperationTarget
} from '@/hermes-mirror/shared'

import type { SetupField } from '@/hermes-shim/components/ui/setup-field-list'

export type {
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetState
}

export interface ConnectionTarget {
  action: ConnectionTargetAction
  alias?: null | string
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
    action: entry.action ?? 'install',
    alias: entry.alias ?? null,
    connectUrl: entry.connect_url ?? null,
    connectionId: entry.connection_id ?? '',
    detail: entry.detail ?? '',
    discoveryError: entry.discovery_error ?? null,
    instructions: entry.instructions ?? null,
    // An unknown kind from a backend a version ahead renders as the generic MCP row.
    kind: entry.kind ?? 'mcp',
    name,
    requiredEnv: envFields(entry.required_env),
    state: entry.state ?? 'pending',
    tools: entry.tools ?? []
  }
}
`
)

// ── hermes.ts: restore the two local interfaces the bulk edit removed, and
//    OAuth return shapes the toolset panel reads. ─────────────────────────────
{
  const p = SHIM + 'hermes.ts'
  let t = readFileSync(p, 'utf8')

  if (!t.includes('export interface LearningNodeDetail')) {
    t = t.replace(
      '/** Upstream `api/mcp.ts` declares its own `McpTestResult`',
      `/** Upstream api/skills.ts declares LearningNodeDetail inline (not part of the
 *  shared contract); the mirrored skills editor reads it via @/hermes. */
export interface LearningNodeDetail {
  content: string
  kind: 'memory' | 'skill'
  label: string
  ok: boolean
}

/** Upstream api/models.ts declares ModelOptionsResult inline (shared with the
 *  model picker, which this host does not drive through here). */
export interface ModelOptionsResult {
  providers: {
    models?: { id?: string; name?: string; slug?: string }[]
    name?: string
    slug?: string
  }[]
}

/** Upstream api/mcp.ts declares its own McpTestResult`
    )
  }

  // startOAuthLogin / pollOAuthSession: return the shared OAuth shapes instead
  // of never - the toolset panel reads session fields off them.
  t = t.replace(
    `export async function startOAuthLogin(_provider: string, _profile?: ProfileScope): Promise<never> {
  unsupported('oauth.login', 'pi 的提供方 OAuth 走设置页「提供方凭据」，不是工具集面板')
  throw new Error('提供方登录请到设置页「提供方凭据」完成（pi_login）')
}

export async function pollOAuthSession(_sessionId: string, _profile?: ProfileScope): Promise<never> {
  unsupported('oauth.poll', 'pi 的提供方 OAuth 走设置页「提供方凭据」，不是工具集面板')
  throw new Error('提供方登录请到设置页「提供方凭据」完成（pi_login）')
}`,
    `export async function startOAuthLogin(
  _provider: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').OAuthStartResponse> {
  unsupported('oauth.login', 'pi 的提供方 OAuth 走设置页「提供方凭据」，不是工具集面板')
  throw new Error('提供方登录请到设置页「提供方凭据」完成（pi_login）')
}

export async function pollOAuthSession(
  _sessionId: string,
  _profile?: ProfileScope
): Promise<import('@/hermes-mirror/types/hermes').OAuthPollResponse> {
  unsupported('oauth.poll', 'pi 的提供方 OAuth 走设置页「提供方凭据」，不是工具集面板')
  throw new Error('提供方登录请到设置页「提供方凭据」完成（pi_login）')
}`
  )

  writeFileSync(p, t, 'utf8')
  edits.push('hermes.ts (patched)')
}

// ── capabilities-pane: sessionProjectCwd returns string | undefined ─────────
{
  const p = 'src/components/panes/capabilities-pane.tsx'
  let t = readFileSync(p, 'utf8')
  t = t.replace('  return sessionProjectCwd(entry, state.pendingCwd)', '  return sessionProjectCwd(entry, state.pendingCwd) ?? null')
  writeFileSync(p, t, 'utf8')
  edits.push('capabilities-pane.tsx (patched)')
}

console.log('edits applied to:', edits.length, 'files')
