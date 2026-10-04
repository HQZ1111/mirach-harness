/**
 * THE in-app drag primitive —— 移植 hermes
 * pane-shell/tree/renderer/drag-session.ts，flexlayout 适配版。
 *
 * One pointer-capture session (`startDragSession`) owns the machinery every
 * in-app drag shares — threshold, rAF-coalesced moves, cursor/user-select
 * chrome, ghost chip, Esc-as-top-escape-layer, hint publishing, teardown —
 * and a per-kind RESOLVER supplies the semantics: what the pointer is over
 * (`resolveMove` → DropHint) and what a release does (`onCommit`).
 *
 * Pane drags use the FancyZones engine (zones-engine.ts, ported verbatim):
 * sensitivity-radius hit testing, HighlightedZones state machine, Shift =
 * select-many (combined zone range), ClosestCenter primary on drop. The
 * LAYOUT STAYS FIXED and every zone lights up as a whole-region drop target;
 * NOTHING moves until release (tab reorder included — the strip shows an
 * insertion divider, not a live shuffle). Over a zone's TAB STRIP the drop
 * stacks at the divider's slot; elsewhere the radial position picks
 * center/edge.
 *
 * PERFORMANCE CONTRACT: the layout never restructures mid-drag, so every
 * rect a resolver needs is snapshotted once at drag start (zones AND tab
 * strips) and each pointermove is pure math against those caches — no
 * elementsFromPoint, no getBoundingClientRect, no style writes unless a
 * value actually changed. Moves are coalesced to one hit-test per animation
 * frame, with the pending move flushed synchronously on release so the drop
 * commits at the exact final position.
 *
 * flexlayout 适配差异（与 hermes 自绘树的分叉点，全部在此文件）：
 *  - zone = flexlayout TabSetNode（网格），strip = .flexlayout__tabset_tabbar_outer；
 *    border（折叠轨道）不进 zone 集合——轨道交互仍走原生 DnD（onAction/allowDrop 管）。
 *  - 提交走 model.doAction（程序化路径：绕过 onAction 否决，但 change listener
 *    仍触发壳的 onModelChange 记账）。v2.1 无分区不变量——窗格可落任何
 *    大栏，宽度/高度约束由壳的 syncTabsetConstraints 在动作后按 region 继承修正。
 *  - 多页签块提交 = hermes movePanes：lead 吃几何、其余按条带序跟队、按下的
 *    页签在落点组置前；Shift 跨区 merge = hermes mergeZonesWithPane（非矩形
 *    回退单区投放）。
 *  - 原生 HTML5 DnD（flexlayout 页签拖拽）被 pointerdown preventDefault 压掉
 *    （Chromium：pointerdown 取消默认 → 不派发 mousedown → 不起原生拖拽），
 *    页签拖拽全部由本引擎接管；strip 空白处拖整个 tabset 仍走原生路径。
 */

import type { PointerEvent as ReactPointerEvent } from 'react'

import { Actions, DockLocation, Model, Orientation, RowNode, TabNode, TabSetNode, type Node } from 'flexlayout-react'

import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import { reorderCommitHaptic, reorderStepHaptic } from '@/lib/reorder'

import type { DropHint, DropPosition } from '@/store/layout-store'
import { useLayoutStore } from '@/store/layout-store'
import { PANE_TYPES, paneTypeOf, zoneConfigOf, type Region } from './pane-registry'
import { clearTabSelection } from './tab-selection'
import { type EngineZone, HighlightedZones, primaryZone, type ZoneRect } from './zones-engine'

const DRAG_THRESHOLD_PX = 4

/** Normalized radius of the elliptical CENTER region (stack/link). Outside it
 *  the drop targets the dominant-axis edge — the boundary curves with the
 *  zone's aspect ratio instead of snapping at a rigid pixel band, and corners
 *  ease into their nearest edge along the quadrant diagonals. */
const CENTER_RADIUS = 0.62

/** How far (px) the pointer may stray from the strip before a tab drag stops
 *  being a reorder and becomes a zone move (browser-tab tear-off feel). */
const TEAR_OFF_SLACK_PX = 18

// ---------------------------------------------------------------------------
// 快照（flexlayout 版 snapshotZones/snapshotStrips）：布局拖拽中不重组，
// 一次抓取，全程纯数学。
// ---------------------------------------------------------------------------

export function snapshotZones(model: Model): EngineZone[] {
  const zones: EngineZone[] = []

  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    // 竖轨（20px 导航空轨）不是投放目标：吞签（签进轨不显示）+ 边缘落点
    // 会把轨分栏（用户实测 bug）。flexlayout 原生路径由 setOnAllowDrop 拒，
    // 本引擎的 zone 集合在这里拒。
    if (zoneConfigOf(node)?.track) return
    const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${node.getPath()}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    zones.push({ id: node.getId(), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
  })

  return zones
}

/** One tab's insertion geometry: its pane id + horizontal midpoint（+两缘，
 *  overlay 的插入符从快照取位，拖拽中不再查 DOM）. */
interface StripSlot {
  id: string
  mid: number
  left: number
  right: number
  top: number
  height: number
}

const stripSlots = (tabsetEl: Element): StripSlot[] =>
  [...tabsetEl.querySelectorAll<HTMLElement>('.flexlayout__tab_button')]
    .map((tab) => {
      const r = tab.getBoundingClientRect()
      const id = tab.id.startsWith('flexlayout-tabbutton-') ? tab.id.slice('flexlayout-tabbutton-'.length) : ''

      return { id, mid: r.left + r.width / 2, left: r.left, right: r.right, top: r.top, height: r.height }
    })
    .filter((slot) => slot.id)

/** Insertion slot from the pointer x against the OTHER tabs' midpoints:
 *  stack BEFORE the returned pane id (`null` = append). `exclude` is the
 *  dragged tab — or the whole selection on a multi-tab drag, so the block
 *  can't target a slot inside itself. */
export function slotBefore(
  slots: StripSlot[],
  x: number,
  exclude: readonly string[] | string = ''
): { before: null | string } {
  const excluded = typeof exclude === 'string' ? [exclude] : exclude

  for (const slot of slots) {
    if (excluded.includes(slot.id)) {
      continue
    }

    if (x < slot.mid) {
      return { before: slot.id }
    }
  }

  return { before: null }
}

/** Drag-start snapshot of one zone's tab strip. Strips never overlap and the
 *  layout never restructures mid-drag, so rect containment replaces a
 *  per-move elementsFromPoint hit test. A drop on a strip STACKS at the
 *  divider's slot — the strip is where tabs live, so it wins over the radial
 *  top-edge band that would otherwise read as "split top". 单页签拉伸 zone
 *  （SingleTabStretch）没有 tabbar → 无 strip 快照 → 只能 center/edge。 */
export interface StripSnapshot {
  groupId: string
  rect: ZoneRect
  slots: StripSlot[]
}

export function snapshotStrips(model: Model): StripSnapshot[] {
  const strips: StripSnapshot[] = []

  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${node.getPath()}"]`)
    if (!el) return
    const bar = el.querySelector('.flexlayout__tabset_tabbar_outer')
    if (!bar) return
    const r = bar.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    strips.push({
      groupId: node.getId(),
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      slots: stripSlots(el),
    })
  })

  return strips
}

export const rectContains = (rect: ZoneRect, x: number, y: number, pad = 0) =>
  x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad

/** Radial drop position within `rect`: inside the center ellipse = the center
 *  action (stack/link); outside, the dominant axis picks the edge (VS Code
 *  dock-preview geometry). `centerRadius` sizes the ellipse — larger = more
 *  center, slimmer curved edge bands. */
export function radialPosition(rect: ZoneRect, x: number, y: number, centerRadius = CENTER_RADIUS): DropPosition {
  // Zone-centered coordinates, ±1 at the edge midpoints.
  const dx = ((x - rect.left) / Math.max(1, rect.right - rect.left)) * 2 - 1
  const dy = ((y - rect.top) / Math.max(1, rect.bottom - rect.top)) * 2 - 1

  if (Math.hypot(dx, dy) < centerRadius) {
    return 'center'
  }

  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
}

/** Sub-zone drop position within the zone `groupId` (radial hit-testing). */
export function subZonePosition(zones: EngineZone[], groupId: string, x: number, y: number): DropPosition {
  const rect = zones.find((zone) => zone.id === groupId)?.rect

  return rect ? radialPosition(rect, x, y) : 'center'
}

const sameHint = (a: DropHint | null, b: DropHint | null) =>
  a?.groupId === b?.groupId &&
  a?.pos === b?.pos &&
  a?.stack?.before === b?.stack?.before &&
  (a?.stack === undefined) === (b?.stack === undefined) &&
  (a?.groupIds?.length ?? 0) === (b?.groupIds?.length ?? 0) &&
  (a?.groupIds ?? []).every((id, i) => b?.groupIds?.[i] === id)

// 临时调试钩子（CDP 冒烟用，模块级——startDragSession/startPaneDrag 都写）。
// 有界：cap 200，超限丢最旧（长会话探针不再无限增长，2026-10-01 审查 P2-13）。
const DRAG_LOG_CAP = 200
const dragLog = (what: string, data?: unknown) => {
  const w = window as any
  w.__flDragLog = w.__flDragLog ?? []
  w.__flDragLog.push({ what, data })
  if (w.__flDragLog.length > DRAG_LOG_CAP) w.__flDragLog.splice(0, w.__flDragLog.length - DRAG_LOG_CAP)
}

// ---------------------------------------------------------------------------
// The generic drag session (machinery) — resolvers plug in below / elsewhere.
// ---------------------------------------------------------------------------

export interface DragSessionSpec {
  /** Movement crossed the drag threshold: snapshot geometry, set the drag
   *  store(s), dim/mark the source. Runs once. */
  onEngage(x: number, y: number): void
  /** Per-frame target resolution — pure math against drag-start snapshots.
   *  Returns the hint to publish; `null` = deny area (no-drop cursor, a
   *  release commits nothing). */
  resolveMove(x: number, y: number, shift: boolean): DropHint | null
  /** Release over the final published hint (already flushed to the exact
   *  release position). Only called for engaged drags. */
  onCommit(hint: DropHint | null): void
  /** Teardown for both commit and abort — undo whatever onEngage marked. */
  onEnd?(): void
  /** Sub-threshold release = a click on the handle. */
  onTap?(): void
}

/** After an ENGAGED drag, the release still synthesizes a `click` on the
 *  capture element — swallow exactly that one so a drag can never double as
 *  an activation (row resume, tab close). Committed drags see the click in
 *  the same task burst as pointerup; an Esc abort's click arrives with the
 *  eventual release, so the trap disarms right after it. */
function suppressDragClick(committed: boolean) {
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })

  const disarm = () => window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)

  if (committed) {
    disarm()
  } else {
    window.addEventListener('pointerup', disarm, { capture: true, once: true })
    window.addEventListener('pointercancel', disarm, { capture: true, once: true })
  }
}

/**
 * Begin a drag session from a handle's pointerdown. A sub-threshold release
 * is a click (`onTap`); past the threshold the spec's resolver owns targeting
 * and the machinery owns everything else. Esc aborts instantly: the session
 * registers as the TOP escape layer, tears down synchronously, and nothing
 * commits.
 */
export function startDragSession(e: ReactPointerEvent<Element>, spec: DragSessionSpec) {
  if (e.button !== 0) {
    return
  }

  // RailNav 的拖出把手在 pointermove 里转交**已结束的** pointerdown 事件，
  // 此时 React 的 currentTarget 已置空——捕获退化到 documentElement（同一
  // pointerId 仍有效），否则指针拖出窗口后 pointerup 收不到，会话卡死。
  const handle: Element = e.currentTarget ?? document.documentElement
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  let cursor: string | null = null
  // rAF-coalesced move processing: the raw handler only records the latest
  // point; all hit testing happens at most once per frame.
  let pending: { x: number; y: number; shift: boolean } | null = null
  let raf = 0

  // Cursor writes are per-frame; only touch the style when the value changes.
  const setCursor = (value: string) => {
    if (cursor !== value) {
      cursor = value
      document.body.style.cursor = value
    }
  }

  const publishHint = (next: DropHint | null) => {
    const { dropHint: current, setDropHint } = useLayoutStore.getState()
    if (!sameHint(current, next)) {
      if (next?.stack !== undefined && current?.stack?.before !== next.stack.before) {
        reorderStepHaptic()
      }

      setDropHint(next)
    }
  }

  const engage = (x: number, y: number) => {
    engaged = true

    // Capture only once ENGAGED: pre-threshold pointer events must stay
    // untouched so a plain click on the handle (and its children) keeps
    // working. Window-level listeners track the gesture either way.
    try {
      handle.setPointerCapture?.(pointerId)
    } catch {
      // Synthetic events (automation) have no active pointer.
    }

    setCursor('grabbing')
    document.body.style.userSelect = 'none'
    // While dragging, Esc belongs to the drag ALONE — lower layers (edit
    // mode, overlays) must not also fire on the same press.
    releaseEscapeLayer = pushEscapeLayer(ESCAPE_PRIORITY.drag)

    // Floating ghost chip removed (user 2026-10-05: no dark label chip on
    // tab drags) — the dragged zone/insertion overlays + cursor are the
    // "what am I holding" feedback.

    spec.onEngage(x, y)
  }

  const processMove = (x: number, y: number, shift: boolean) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) {
        return
      }

      engage(x, y)
    }

    const hint = spec.resolveMove(x, y, shift)

    // Over a deny area (no target — titlebar / statusbar / gutters /
    // off-window) the release cancels; the cursor says so up front.
    setCursor(hint ? 'grabbing' : 'no-drop')
    publishHint(hint)
  }

  const flushMove = () => {
    raf = 0

    if (pending) {
      const { shift, x, y } = pending
      pending = null
      processMove(x, y, shift)
    }
  }

  const onMove = (ev: PointerEvent) => {
    pending = { shift: ev.shiftKey, x: ev.clientX, y: ev.clientY }
    raf ||= requestAnimationFrame(flushMove)
  }

  const finish = (commit: boolean) => {
    dragLog('finish', { commit, engaged })
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }

    // The drop must land at the FINAL pointer position, not the last painted
    // frame's — flush the pending move before reading the hint. An abort
    // (Esc / pointercancel) skips it: everything is discarded anyway.
    if (commit) {
      flushMove()
    }

    document.body.style.cursor = restoreCursor
    document.body.style.userSelect = restoreSelect
    releaseEscapeLayer?.()
    releaseEscapeLayer = null

    try {
      handle.releasePointerCapture?.(pointerId)
    } catch {
      // Mirror of the capture guard.
    }

    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)

    if (engaged) {
      suppressDragClick(commit)

      if (commit) {
        spec.onCommit(useLayoutStore.getState().dropHint)
      }
    } else if (commit) {
      spec.onTap?.()
    }

    spec.onEnd?.()
    useLayoutStore.getState().setDropHint(null)
    useLayoutStore.getState().setTreeDragging(null)
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc aborts the drag — the target selection vanishes and nothing moves,
  // the universal "never mind" for an in-flight drag. Capture-phase + stop so
  // it doesn't also close a pane/overlay behind the drag (the escape layer
  // covers contract-following handlers; the stop covers the rest).
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
}

// ---------------------------------------------------------------------------
// 提交层（flexlayout 适配）：hermes 的 movePanes / mergeZonesWithPane /
// reorderPanesInGroup 在 flexlayout action 上的等价物。
// ---------------------------------------------------------------------------

const dropDockLocation = (pos: DropPosition): DockLocation => {
  switch (pos) {
    case 'left':
      return DockLocation.LEFT
    case 'right':
      return DockLocation.RIGHT
    case 'top':
      return DockLocation.TOP
    case 'bottom':
      return DockLocation.BOTTOM
    default:
      return DockLocation.CENTER
  }
}

const tabsetChildCount = (model: Model, tabsetId: string) => {
  const set = model.getNodeById(tabsetId)
  return set instanceof TabSetNode ? set.getChildren().length : 0
}

/** guillotine 树上被 `ids` 恰好覆盖的子树（hermes findCover）：叶集合相等。
 *  矩形区域检查——不成立时 merge 回退单区投放。 */
function findCoverTabset(model: Model, ids: string[]): boolean {
  const want = new Set(ids)
  const root = model.getRootRow()
  if (!root) return false
  const leaves = (n: Node): string[] => (n instanceof TabSetNode ? [n.getId()] : n.getChildren().flatMap(leaves))

  const walk = (n: Node): boolean => {
    const ls = leaves(n)
    if (ls.length === want.size && ls.every((id) => want.has(id))) return true
    return n.getChildren().some(walk)
  }

  return walk(root)
}

export interface PaneDragSpec {
  onTap?: () => void
  /** 有 reorder 上下文 = 从 tabset 页签条发起：条内是插入槽重排，撕出条外
   *  变 zone 移动。无（如从折叠轨道发起）直接进 zone 模式。 */
  reorder?: { groupId: string }
  /** Multi-tab selection riding this drag (strip order, includes `paneId`).
   *  The whole block moves/reorders together; `paneId` stays the pressed tab
   *  (it fronts at the destination). */
  selection?: readonly string[]
}

/**
 * Begin a pane drag from any handle（hermes startPaneDrag 的 flexlayout 版）.
 * A sub-threshold release is a click (`onTap`, tab activation rides the
 * native click). With a `reorder` context (tab drags), movement inside the
 * strip targets an insertion slot — the strip renders a divider at it,
 * NOTHING moves until release (placement-on-release, like every other drop);
 * tearing away from the strip converts the drag into a zone move. Zone mode:
 * zones light up, the target's tab strip stacks at its divider slot, Shift
 * extends the highlight range, release drops into the ClosestCenter primary
 * zone. Esc aborts either mode.
 */
export function startPaneDrag(model: Model, paneId: string, e: ReactPointerEvent<Element>, spec: PaneDragSpec = {}) {
  if (e.button !== 0) {
    return
  }

  // Claim the press: pointerdown preventDefault 压掉原生 HTML5 拖拽
  // （flexlayout 页签拖拽）与文本选择；click 事件照常派发，普通点击的激活
  // 不受影响。stopPropagation 免得 strip 的 pointerdown 再处理一遍。
  e.preventDefault()
  e.stopPropagation()

  // The moving block: the selection when the pressed tab rides one, else just
  // the pressed tab. Order is strip order (selectionFor guarantees it).
  const moving: readonly string[] = spec.selection && spec.selection.length > 1 ? spec.selection : [paneId]

  const highlighted = new HighlightedZones()
  let zones: EngineZone[] = []
  let strips: StripSnapshot[] = []
  let mode: 'reorder' | 'zone' | null = null
  let dimmed: HTMLElement[] = []

  const markSource = () => {
    // Every dragged tab dims for the drag's life — the divider says where
    // they GO, the dim says what MOVES. No live shuffle
    // (placement-on-release).
    if (dimmed.length === 0 && spec.reorder) {
      for (const id of moving) {
        const el = document.getElementById(`flexlayout-tabbutton-${id}`)
        if (el) dimmed.push(el)
      }
    }

    for (const el of dimmed) {
      el.style.setProperty('opacity', '0.45')
    }
  }

  const enterZoneMode = () => {
    mode = 'zone'
    // The layout never restructures mid-drag, so zone/strip rects are stable.
    zones = snapshotZones(model)
    strips = snapshotStrips(model)
    useLayoutStore.getState().setTreeDragging(paneId)
    if (dragGeometry) dragGeometry.mode = 'zone'
    markSource()
  }

  // The reorder strip's geometry, snapshotted on first use (same fixed-layout
  // guarantee as the zone snapshots).
  let reorderSnap: { rect: ZoneRect; slots: StripSlot[] } | null = null

  const reorderStrip = () => {
    if (!reorderSnap) {
      const set = model.getNodeById(spec.reorder!.groupId)
      const el =
        set instanceof TabSetNode
          ? document.querySelector(`.flexlayout__tabset[data-layout-path="${set.getPath()}"]`)
          : null
      const bar = el?.querySelector('.flexlayout__tabset_tabbar_outer')
      const r = (bar ?? el)?.getBoundingClientRect()
      reorderSnap = r
        ? {
            rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            slots: el ? stripSlots(el) : [],
          }
        : { rect: { left: 0, top: 0, right: 0, bottom: 0 }, slots: [] }
    }

    return reorderSnap
  }

  const withinStrip = (x: number, y: number) =>
    Boolean(spec.reorder) && rectContains(reorderStrip().rect, x, y, TEAR_OFF_SLACK_PX)

  startDragSession(e, {
    onTap: spec.onTap,

    onEngage(x, y) {
      dragLog('engage', { x, y, hasReorder: Boolean(spec.reorder) })
      // 快照给 DropOverlay 用（viewport 坐标 + 宿主偏移）
      const host = document.querySelector('.flexlayout-host')
      const hr = host?.getBoundingClientRect()
      dragGeometry = {
        hostOffset: { x: hr?.left ?? 0, y: hr?.top ?? 0 },
        zones: snapshotZones(model),
        strips: snapshotStrips(model),
        moving,
        mode: 'reorder',
      }
      if (spec.reorder && withinStrip(x, y)) {
        mode = 'reorder'
        markSource()
      } else {
        enterZoneMode()
      }
      // overlay 挂载信号两种模式都要（reorder 模式只画插入符不画 sheet）
      useLayoutStore.getState().setTreeDragging(paneId)
      dragLog('mode', mode)
    },

    resolveMove(x, y, shift) {
      if (mode === 'reorder') {
        if (withinStrip(x, y)) {
          return {
            kind: 'group',
            groupId: spec.reorder!.groupId,
            groupIds: [spec.reorder!.groupId],
            pos: 'center',
            stack: slotBefore(reorderStrip().slots, x, moving),
          }
        }

        // Tear-off: the tab leaves the strip and becomes a zone move.
        enterZoneMode()
      }

      // A strip is an exact target. Resolve it before the fuzzy zone engine:
      // near a panel seam, proximity can otherwise pick the neighboring sidebar.
      const hitStrip = !shift && strips.find((strip) => rectContains(strip.rect, x, y))

      if (hitStrip) {
        return {
          kind: 'group',
          groupId: hitStrip.groupId,
          groupIds: [hitStrip.groupId],
          pos: 'center',
          stack: slotBefore(hitStrip.slots, x, moving),
        }
      }

      // The hint updates on highlight-set changes AND on sub-zone position
      // changes (center/edge regions within the same primary zone).
      const point = { x, y }
      highlighted.update(zones, point, shift)
      let groupIds = [...highlighted.zones()]

      // Spanning multiple zones is EXPLICIT (Shift). Without it, the seam-
      // proximity capture (sensitivity radius grabs both neighbors near a
      // shared edge) collapses to the primary zone — otherwise a drop near a
      // seam silently merges zones the user never asked to merge.
      if (!shift && groupIds.length > 1) {
        const collapsed = primaryZone(zones, groupIds, point)
        groupIds = collapsed ? [collapsed] : []
      }

      const gid = groupIds.length > 0 ? primaryZone(zones, groupIds, point) : null

      // Over the target's TAB STRIP the drop stacks at the divider's slot;
      // sub-positions only make sense for a single-zone drop (a Shift-span
      // always merges, pos ignored).
      const strip = gid && groupIds.length === 1 ? strips.find((s) => s.groupId === gid && rectContains(s.rect, x, y)) : null

      const stack = strip ? slotBefore(strip.slots, x, moving) : undefined

      const pos: DropPosition = stack
        ? 'center'
        : gid && groupIds.length === 1
          ? subZonePosition(zones, gid, x, y)
          : 'center'

      // 贴轨拒绝：edge 落点的新分栏会插在目标与 20px 轨之间。dropBlock 走
      // model.doAction 直提、**不经过 setOnAllowDrop**——必须在这里拒，否则
      // "拖签把竖轨分栏"从这个口子漏进来（2026-09-26 复审补）。
      if (gid && groupIds.length === 1 && !stack && (pos === 'left' || pos === 'right')) {
        const set = model.getNodeById(gid)
        if (set instanceof TabSetNode) {
          const parent = set.getParent()
          if (parent instanceof RowNode && parent.getOrientation() === Orientation.HORZ) {
            const sibs = parent.getChildren()
            const i = sibs.indexOf(set)
            const side = pos === 'left' ? sibs[i - 1] : sibs[i + 1]
            if (side instanceof TabSetNode && zoneConfigOf(side)?.track) {
              return null
            }
          }
        }
      }

      return gid ? { kind: 'group', groupId: gid, groupIds, pos, stack } : null
    },

    onCommit(hint) {
      dragLog('commit', { mode, hint })
      // A multi-tab selection is spent by a LANDED drop (reorder or zone) —
      // a deny-area release keeps it, so a missed drop can just be retried.
      const spendSelection = () => {
        if (moving.length > 1) {
          clearTabSelection()
        }
      }

      if (mode === 'reorder' && spec.reorder && hint?.stack !== undefined) {
        // Slot -> index among the OTHER tabs (the block re-inserts there).
        const set = model.getNodeById(spec.reorder.groupId)
        const others =
          set instanceof TabSetNode
            ? set.getChildren().filter((c): c is TabNode => c instanceof TabNode && !moving.includes(c.getId()))
            : []
        const toIndex = hint.stack.before ? others.findIndex((c) => c.getId() === hint.stack!.before) : others.length

        dragLog('reorderCommit', {
          groupId: spec.reorder.groupId,
          before: hint.stack.before,
          toIndex,
          others: others.map((o) => o.getId()),
        })
        if (toIndex >= 0) {
          for (let i = 0; i < moving.length; i++) {
            model.doAction(Actions.moveNode(moving[i], spec.reorder.groupId, DockLocation.CENTER, toIndex + i))
          }
          reorderCommitHaptic()
          spendSelection()
        }
      }

      if (mode === 'zone') {
        // Drop what the hint SHOWS — the overlay and the commit share one
        // truth (the raw highlight set can hold both seam neighbors; the hint
        // already collapsed that to the primary unless Shift made the span
        // explicit).
        const targets = hint?.groupIds ?? []

        if (targets.length > 1) {
          // Shift-span: merge the highlighted zones, dropping the block
          // across them（hermes mergeZonesWithPane：非矩形回退单区投放）。
          if (findCoverTabset(model, targets)) {
            const primary = hint?.groupId ?? targets[0]
            // block 顶到主 zone 前端，再吸收其余 zone 的页签（hermes 语义：
            // [moving..., panesInSet...]）
            for (let i = 0; i < moving.length; i++) {
              model.doAction(Actions.moveNode(moving[i], primary, DockLocation.CENTER, i))
            }
            for (const zoneId of targets) {
              if (zoneId === primary) continue
              const set = model.getNodeById(zoneId)
              if (!(set instanceof TabSetNode)) continue
              for (const t of [...set.getChildren()]) {
                if (t instanceof TabNode && !moving.includes(t.getId())) {
                  model.doAction(
                    Actions.moveNode(t.getId(), primary, DockLocation.CENTER, tabsetChildCount(model, primary)),
                  )
                }
              }
            }
            model.doAction(Actions.selectTab(paneId))
          } else if (hint?.groupId) {
            dropBlock(model, moving, paneId, hint.groupId, 'center', null)
          }
          spendSelection()
        } else if (hint?.groupId) {
          // strip = stack at the divider slot; center = join the stack;
          // an edge = split the zone and land there. The whole selection
          // rides — the pressed tab fronts at the destination.
          dropBlock(model, moving, paneId, hint.groupId, hint.pos ?? 'center', hint.stack?.before ?? null)
          spendSelection()
        }
      }
    },

    onEnd() {
      for (const el of dimmed) {
        el.style.removeProperty('opacity')
      }

      highlighted.reset()
      dragGeometry = null
    },
  })
}

/** 投放块内第一个一级窗格的家乡 region（无 → undefined）——dropBlock 预戳
 *  门控用（§2.1 ②：含一级窗格的投放不预戳，交给 sync 的 primary 锚定） */
const movingPrimaryRegion = (moving: readonly string[]): Region | undefined => {
  for (const id of moving) {
    const t = paneTypeOf(id)
    const def = t ? PANE_TYPES[t] : undefined
    if (def?.primary) return def.region
  }
  return undefined
}

/** hermes movePanes 的 flexlayout 版：lead 吃几何（edge=分裂、center=进栈），
 *  其余按条带序跟队，`activeId`（按下的页签）在落点组置前。 */
function dropBlock(
  model: Model,
  moving: readonly string[],
  activeId: string,
  targetId: string,
  pos: DropPosition,
  before: null | string,
) {
  const lead = moving[0]
  if (!lead) return

  if (pos === 'center') {
    // index = before 页签在"除 block 外页签"中的序（hermes slot→index 语义）；
    // 无 before = 追加
    const set = model.getNodeById(targetId)
    if (!(set instanceof TabSetNode)) return
    const others = set.getChildren().filter((c): c is TabNode => c instanceof TabNode && !moving.includes(c.getId()))
    const raw = before ? others.findIndex((c) => c.getId() === before) : others.length
    const toIndex = raw >= 0 ? raw : others.length
    for (let i = 0; i < moving.length; i++) {
      model.doAction(Actions.moveNode(moving[i], targetId, DockLocation.CENTER, toIndex + i))
    }
  } else {
    // lead 分裂出新 tabset（edge 几何），其余跟进 lead 的新家
    model.doAction(Actions.moveNode(lead, targetId, dropDockLocation(pos), 0))
    const leadParent = model.getNodeById(lead)?.getParent()
    if (leadParent instanceof TabSetNode && leadParent.getId() !== targetId) {
      // 新分栏预戳**被投入分栏（目标）**的列 identity——"放到检查的左边"=
      // 检查所在的列（跟随状态），不能用几何左邻猜（2026-09-26 用户场景）。
      // **门控（§2.1 ②，2026-10-01 审查 P1-2）**：仅当投放内容不含一级窗格
      // （或其家乡 region 与目标列一致）才预戳——含一级窗格（如主会话拖到
      // 左栏旁分裂）时留空，交给 sync 的"列子树内第一个一级窗格锚定"：
      // config 戳防夺锚，预戳的错误 region 会抢在 primary 锚定之前生效，
      // 把主会话钉进左栏限制。
      const targetNode = model.getNodeById(targetId)
      const targetCfg = targetNode instanceof TabSetNode ? zoneConfigOf(targetNode) : undefined
      const movingPrimary = movingPrimaryRegion(moving)
      if (targetCfg && (movingPrimary === undefined || movingPrimary === targetCfg.region)) {
        model.doAction(
          Actions.updateNodeAttributes(leadParent.getId(), { config: { region: targetCfg.region, rail: targetCfg.rail } }),
        )
      }
      for (let i = 1; i < moving.length; i++) {
        model.doAction(Actions.moveNode(moving[i], leadParent.getId(), DockLocation.CENTER, i))
      }
    } else if (leadParent instanceof TabSetNode) {
      // 分裂没发生（单页签 tabset 上落 edge 原地合并之类）——逐个追加
      for (let i = 1; i < moving.length; i++) {
        model.doAction(
          Actions.moveNode(
            moving[i],
            leadParent.getId(),
            DockLocation.CENTER,
            tabsetChildCount(model, leadParent.getId()),
          ),
        )
      }
    }
  }

  model.doAction(Actions.selectTab(activeId))
}

// ---------------------------------------------------------------------------
// 拖拽几何快照（DropOverlay 用）：engage 时抓一次，overlay 从这里读。
// ---------------------------------------------------------------------------

export interface DragGeometry {
  hostOffset: { x: number; y: number }
  zones: EngineZone[]
  strips: StripSnapshot[]
  moving: readonly string[]
  /** 拖拽当前模式：reorder=条带内重排（overlay 只画插入符），
   *  zone=撕出/区移动（overlay 画 zone sheet）。撕裂时 in-place 更新。 */
  mode: 'reorder' | 'zone'
}

let dragGeometry: DragGeometry | null = null

export const getDragGeometry = (): DragGeometry | null => dragGeometry
