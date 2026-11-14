// Generate the small shell-state shim modules. Each mirrors one upstream module
// path; the bodies are written here so they can be reviewed as a set and the
// host rationale sits next to the code it explains.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHIM = 'src/hermes-shim/'

interface ShimFile {
  path: string
  body: string
}

const files: ShimFile[] = [
  {
    path: 'store/statusbar-prefs.ts',
    body: `/**
 * \`@/store/statusbar-prefs\` shim — which statusbar items the user hid.
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
  // No statusbar exists to hide items from. Deliberately inert (rule 12: a silent
  // "saved" here would be a fake success).
}

export function toggleStatusbarVisible(_id: string): void {
  setStatusbarItemVisible('', false)
}
`
  },
  {
    path: 'store/transcript-lightbox.ts',
    body: `/**
 * \`@/store/transcript-lightbox\` shim — the full-screen transcript overlay.
 *
 * Upstream opens a session transcript over the whole window. The host renders
 * transcripts inside dockview panes, so the overlay state exists but nothing
 * mounts it; \`open\` records the session for a future surface instead of
 * teleporting the user somewhere that does not exist.
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
  },
  {
    path: 'store/windows.ts',
    body: `/**
 * \`@/store/windows\` shim — main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts). The host has
 * one main window plus a settings window (which does not mount the capabilities
 * page), so both predicates are false.
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}
`
  },
  {
    path: 'store/connections.ts',
    body: `/**
 * \`@/store/connections\` shim — the multi-gateway registry.
 *
 * Upstream keeps registered gateways (local / remote / ssh / cloud) and the
 * active connection id the whole app routes through. pi is in-process: one
 * engine, no registry. \`null\` is the honest "local pool" value every caller
 * already handles (they all fall back to \`?? 'local'\`).
 */

import { atom } from 'nanostores'

export const $activeConnectionId = atom<null | string>(null)
`
  },
  {
    path: 'store/custom-models.ts',
    body: `/**
 * \`@/store/custom-models\` shim — user-added model endpoints.
 *
 * Upstream merges custom endpoints into the model picker. The host's model list
 * comes from pi's models.json (settings page writes it); there is no separate
 * custom-endpoint store, so the merge is the identity function and \`add\` records
 * that the store does not exist rather than dropping the value on the floor.
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
  },
  {
    path: 'store/session-gone-latch.ts',
    body: `/**
 * \`@/store/session-gone-latch\` shim — the ambient socket for a session.
 *
 * Upstream returns the gateway socket a session's RPCs should ride, latched so a
 * session whose socket is gone does not silently route to another profile's.
 * pi has no sockets: \`null\` is the value the MCP reload path treats as "skip the
 * live reload".
 */

export function ambientRequestFor(_gateway: unknown): null {
  return null
}
`
  },
  {
    path: 'store/layout.ts',
    body: `/**
 * \`@/store/layout\` shim — sidebar row metadata.
 *
 * Upstream stamps each sidebar row with per-profile metadata (dots, labels,
 * archive state). The host sidebar is \`components/panes/session-manage\`, which
 * owns that state in its own catalog store, so this atom exists for the mirrored
 * imports and stays empty.
 */

import { map } from 'nanostores'

export interface SidebarRowMeta {
  label: string
}

export const $sidebarRowMeta = map<Record<string, SidebarRowMeta>>({})
`
  },
  {
    path: 'store/plugin-catalog-install.ts',
    body: `/**
 * \`@/store/plugin-catalog-install\` shim — the catalog install modal.
 *
 * Upstream opens a dual-target install dialog (agent half + desktop half) fed by
 * the catalog snapshot. pi's extensions are manifest directories under
 * \`.pi/extensions/<id>/\` — there is no installer to drive, so the open call
 * records what was requested instead of mounting a dialog that could not work.
 */

export interface CatalogPluginInstallRequest {
  catalogName: string
  repo: string
  sha: string
  subdir?: string
}

export function openCatalogPluginInstall(request: CatalogPluginInstallRequest): void {
  console.warn(
    '[plugin-catalog] 本宿主没有插件目录安装通道；pi 的扩展是 .pi/extensions/<id>/ 下的清单目录',
    request
  )
}
`
  }
]

for (const file of files) {
  const dest = SHIM + file.path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, file.body, 'utf8')
}
console.log('wrote', files.length, 'shim modules')
