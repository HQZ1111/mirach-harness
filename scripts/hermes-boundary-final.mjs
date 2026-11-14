// Final boundary pass: restore the four narrow adapters that upstream verbatim
// copies keep displacing (each re-copy re-opens a giant upstream dependency
// chain that this host cannot satisfy — Electron fs/git/relay). Then prune.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const SHIM = 'src/hermes-shim/'

const files = new Map()

files.set(
  'store/layout.ts',
  `/**
 * @/store/layout shim - sidebar row metadata.
 *
 * Upstream a 1,059-line store driving hermes sidebar/pane tree (pane-shell
 * zones, per-profile layout persistence, pull-request badge reads through the
 * Electron git bridge). The host pane layout is dockview and the sidebar is
 * components/panes/session-manage with its own catalog store. The capabilities
 * tree reads exactly one export here - $sidebarRowMeta - so that is what lives
 * here. The upstream file is one hermes-shim-fill.mjs run away if a
 * future feature needs a piece of it.
 */

import { map } from 'nanostores'

export interface SidebarRowMeta {
  label: string
}

export const $sidebarRowMeta = map<Record<string, SidebarRowMeta>>({})
`
)

files.set(
  'store/windows.ts',
  `/**
 * @/store/windows shim - main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts) and owns the
 * window-relay protocol between them (window.open sessions routed through
 * Electron). The host has one main window plus a settings window (which does not
 * mount the capabilities page), so both predicates are false and the relay
 * surface is absent - which every caller already treats as "single window".
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}
`
)

files.set(
  'store/free-tier.ts',
  `/**
 * @/store/free-tier shim - the hosted subscription tier.
 *
 * Upstream derives it from the sign-in/challenge stores and the interface mode.
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

files.set(
  'store/custom-models.ts',
  `/**
 * @/store/custom-models shim - user-added model endpoints.
 *
 * Upstream merges custom endpoints into the model picker, reading per-model
 * visibility from the model-visibility store. The host model list comes from
 * pi's models.json (written by the settings page); there is no custom-endpoint
 * store, so the merge is the identity function and add records that the store
 * does not exist rather than dropping the value.
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

for (const [path, body] of files) {
  const dest = SHIM + path
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, body, 'utf8')
}
console.log('restored', files.size, 'narrow adapters')

// Prune, then rewire, then prune again - the chains cut above leave orphans.
execFileSync('node', ['scripts/hermes-shim-prune2.mjs'], { stdio: 'inherit' })
