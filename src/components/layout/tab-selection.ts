/**
 * Multi-tab selection on a zone's tab strip — Chrome's tab-selection grammar:
 * 逐字移植 hermes pane-shell/tree/tab-selection.ts。
 *
 *   - ⌥-click (Ctrl-click off-Mac)  → toggle the tab in/out of the selection;
 *   - Shift-click                   → select the range from the anchor
 *                                     (the last explicitly clicked tab, else
 *                                     the active one) to the clicked tab;
 *   - plain click                   → collapse back to a single tab.
 *
 * ⌘-click stays CLOSE (middle-click) and ⌃-click stays the macOS context
 * menu, so the toggle chord is ⌥ on Mac / Ctrl elsewhere. One selection at a
 * time, scoped to one zone — dragging any selected tab carries the whole set
 * (drag-session resolves it), and ids are validated against the strip's
 * current tabs at use time, so closed/moved panes fall out on their own.
 */

import { createStore, useStore } from 'zustand'

export interface TabSelection {
  groupId: string
  ids: ReadonlySet<string>
  /** Range anchor: the last explicitly clicked tab (Chrome semantics). */
  anchor: string
}

/** Zustand vanilla store：事件回调（非 React 上下文）经 getState/setState
 * 读写，flex-layout 经 useTabSelection() 订阅。 */
export const tabSelectionStore = createStore<null | TabSelection>(() => null)

export const useTabSelection = () => useStore(tabSelectionStore)

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

/** The toggle-select chord: ⌥-click on Mac (⌘ closes, ⌃ is the context menu),
 *  Ctrl-click elsewhere — ⌥ is accepted everywhere for one muscle memory. */
export const isToggleSelectClick = (event: { altKey: boolean; button: number; ctrlKey: boolean; metaKey: boolean }) =>
  event.button === 0 && !event.metaKey && (event.altKey || (!isMac && event.ctrlKey))

export function clearTabSelection() {
  if (tabSelectionStore.getState()) {
    tabSelectionStore.setState(null)
  }
}

/** ⌥/Ctrl-click: toggle `paneId`. A fresh selection seeds with the active tab
 *  (it is implicitly selected, as in Chrome); collapsing to ≤1 dissolves the
 *  selection entirely — a single "selected" tab is just a tab. */
export function toggleTabSelected(groupId: string, paneId: string, activeId: string) {
  const current = tabSelectionStore.getState()
  const ids = new Set(current?.groupId === groupId ? current.ids : [activeId])

  if (ids.has(paneId)) {
    ids.delete(paneId)
  } else {
    ids.add(paneId)
  }

  if (ids.size <= 1) {
    tabSelectionStore.setState(null)

    return
  }

  tabSelectionStore.setState({ anchor: paneId, groupId, ids })
}

/** Shift-click: select the contiguous range anchor→`paneId` in strip order,
 *  replacing the previous range (the anchor holds, Chrome-style). */
export function selectTabRange(groupId: string, orderedPanes: readonly string[], paneId: string, activeId: string) {
  const current = tabSelectionStore.getState()
  const anchor = current?.groupId === groupId && orderedPanes.includes(current.anchor) ? current.anchor : activeId
  const a = orderedPanes.indexOf(anchor)
  const b = orderedPanes.indexOf(paneId)

  if (a === -1 || b === -1) {
    return
  }

  const ids = new Set(orderedPanes.slice(Math.min(a, b), Math.max(a, b) + 1))

  if (ids.size <= 1) {
    tabSelectionStore.setState(null)

    return
  }

  tabSelectionStore.setState({ anchor, groupId, ids })
}

/** The selection as an ordered slice of `orderedPanes` — but only when the
 *  pressed tab rides it (dragging an unselected tab is a single-tab drag).
 *  Stale ids (closed panes) drop out here. */
export function selectionFor(groupId: string, orderedPanes: readonly string[], paneId: string): null | string[] {
  const current = tabSelectionStore.getState()

  if (current?.groupId !== groupId || !current.ids.has(paneId)) {
    return null
  }

  const ids = orderedPanes.filter(id => current.ids.has(id))

  return ids.length > 1 ? ids : null
}
