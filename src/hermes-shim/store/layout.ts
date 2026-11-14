/**
 * @/store/layout — sidebar row metadata, verbatim subset.
 *
 * Upstream this is a 1,059-line store driving the whole hermes sidebar and pane
 * tree (per-profile layout persistence, pull-request badges through the Electron
 * git bridge, session ordering, project/worktree dismissal). The host's sidebar
 * is `components/panes/session-manage` with its own catalog store and the pane
 * tree is dockview, so the only thing the mirrored tree still reads here is the
 * row-metadata preference (`app/chat/sidebar/chrome.tsx`) plus the
 * `SidebarRowMeta` type (`store/interface-mode.ts`).
 *
 * Both are reproduced EXACTLY as upstream declares them — same union, same
 * storage key, same default, same sanitizing codec, same `modeBound` wrapper —
 * because a drifted shape silently changes what the sidebar renders. The other
 * ~1,000 lines are not ported: nothing reachable from the capabilities page
 * reads them, and inventing them would be the "手写替身" AGENTS.md forbids.
 */

import { type Codec, Codecs, persistentAtom } from '@/hermes-shim/lib/persisted'
import { modeBound } from '@/hermes-shim/store/interface-mode'

const SIDEBAR_ROW_META_STORAGE_KEY = 'hermes.desktop.sidebarRowMeta'

/** Optional per-row metadata the user can switch on. `preview` is card-only:
 *  the one-line row has nowhere to put a second line. */
export type SidebarRowMeta = 'cost' | 'pr' | 'preview' | 'profile' | 'tokens' | 'updated'

function listOf<T extends string>(values: readonly T[]): Codec<T[]> {
  return {
    decode: raw => Codecs.stringArray.decode(raw).filter((item): item is T => values.includes(item as T)),
    encode: value => Codecs.stringArray.encode(value)
  }
}

const ROW_META: readonly SidebarRowMeta[] = ['cost', 'pr', 'preview', 'profile', 'tokens', 'updated']

const SIDEBAR_DEFAULT_ROW_META: SidebarRowMeta[] = ['preview', 'updated']

// Simple mode rests the rows on what was said and when, without touching
// this preference.
const $sidebarRowMetaPref = persistentAtom<SidebarRowMeta[]>(
  SIDEBAR_ROW_META_STORAGE_KEY,
  SIDEBAR_DEFAULT_ROW_META,
  listOf(ROW_META)
)

export const $sidebarRowMeta = modeBound('sidebarRowMeta', $sidebarRowMetaPref, meta => $sidebarRowMetaPref.set(meta))
