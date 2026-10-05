/**
 * THE in-app drag primitive —— hermes drag-session 的 flexlayout 适配版
 * （docs/layout-design.md v6.0 §4：单目标解析）。
 *
 * One pointer-capture session (`startDragSession`) owns the machinery every
 * in-app drag shares — threshold, rAF-coalesced moves, cursor/user-select
 * chrome, 跟手克隆件, Esc-as-top-escape-layer, hint publishing, teardown —
 * and a per-kind RESOLVER supplies the semantics: what the pointer is over
 * (`resolveMove` → DropHint) and what a release does (`onCommit`).
 *
 * Pane drags resolve ONE target per frame: a tab strip first (stack at the
 * insertion caret), else the zone under the pointer (center = join the
 * stack, edge = split). The LAYOUT STAYS FIXED and nothing moves until
 * release (placement-on-release). Admission is by 页签归属 (§4): 对话栏页签
 * 只进对话栏，面板栏页签进面板栏+对话栏，打开页钉在面板栏，左栏拒收一切。
 *
 * PERFORMANCE CONTRACT: the layout never restructures mid-drag, so every
 * rect a resolver needs is snapshotted once at drag start (zones AND tab
 * strips) and each pointermove is pure math against those caches. Moves are
 * coalesced to one hit-test per animation frame, flushed synchronously on
 * release so the drop commits at the exact final position.
 *
 * flexlayout 适配差异（与 hermes 自绘树的分叉点，全部在此文件）：
 *  - zone = flexlayout TabSetNode，strip = .flexlayout__tabset_tabbar_outer。
 *  - 提交走 model.doAction（程序化路径：绕过 onAction 否决，但 change
 *    listener 仍触发壳的 onModelChange 记账）；准入/上下限在这里判。
 *  - 原生 HTML5 DnD（flexlayout 页签拖拽）被 pointerdown preventDefault
 *    压掉，页签拖拽全部由本引擎接管。
 */

import type { PointerEvent as ReactPointerEvent } from 'react'

import { Actions, DockLocation, Model, RowNode, TabNode, TabSetNode, type Node } from 'flexlayout-react'

import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import { reorderCommitHaptic, reorderStepHaptic } from '@/lib/reorder'

import type { DropHint, DropPosition } from '@/store/layout-store'
import { useLayoutStore } from '@/store/layout-store'
import { PANE_TYPES, paneTypeOf, zoneConfigOf, type Region } from './pane-registry'

const DRAG_THRESHOLD_PX = 4

/** Normalized radius of the elliptical CENTER region (stack). Outside it
 *  the drop targets the dominant-axis edge — the boundary curves with the
 *  zone's aspect ratio instead of snapping at a rigid pixel band. */
const CENTER_RADIUS = 0.62

/** How far (px) the pointer may stray from the strip before a tab drag stops
 *  being a reorder and becomes a zone move (browser-tab tear-off feel). */
const TEAR_OFF_SLACK_PX = 18

// ---------------------------------------------------------------------------
// 快照（拖拽中不重组，一次抓取，全程纯数学）
// ---------------------------------------------------------------------------

/** Viewport-space rect（zones-engine 已删，类型收留于此）。 */
export interface ZoneRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface EngineZone {
  id: string
  region: Region
  rect: ZoneRect
}

export function snapshotZones(model: Model): EngineZone[] {
  const zones: EngineZone[] = []

  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    const region = zoneConfigOf(node)?.region
    if (!region) return
    const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${node.getPath()}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    zones.push({ id: node.getId(), region, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
  })

  return zones
}

/** One tab's insertion geometry: its pane id + horizontal midpoint（+两缘，
 *  overlay 的插入符从快照取位，拖拽中不再查 DOM）. */
export interface StripSlot {
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
 *  dragged tab. */
export function slotBefore(slots: StripSlot[], x: number, exclude: string): { before: null | string } {
  for (const slot of slots) {
    if (slot.id === exclude) {
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
 *  per-move elementsFromPoint hit test. */
export interface StripSnapshot {
  groupId: string
  region: Region
  rect: ZoneRect
  slots: StripSlot[]
}

export function snapshotStrips(model: Model): StripSnapshot[] {
  const strips: StripSnapshot[] = []

  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    const region = zoneConfigOf(node)?.region
    if (!region) return
    const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${node.getPath()}"]`)
    if (!el) return
    const bar = el.querySelector('.flexlayout__tabset_tabbar_outer')
    if (!bar) return
    const r = bar.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    strips.push({
      groupId: node.getId(),
      region,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      slots: stripSlots(el),
    })
  })

  return strips
}

export const rectContains = (rect: ZoneRect, x: number, y: number, pad = 0) =>
  x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad

/** Radial drop position within `rect`: inside the center ellipse = the center
 *  action (stack); outside, the dominant axis picks the edge (VS Code
 *  dock-preview geometry). */
export function radialPosition(rect: ZoneRect, x: number, y: number, centerRadius = CENTER_RADIUS): DropPosition {
  // Zone-centered coordinates, ±1 at the edge midpoints.
  const dx = ((x - rect.left) / Math.max(1, rect.right - rect.left)) * 2 - 1
  const dy = ((y - rect.top) / Math.max(1, rect.bottom - rect.top)) * 2 - 1

  if (Math.hypot(dx, dy) < centerRadius) {
    return 'center'
  }

  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
}

const sameHint = (a: DropHint | null, b: DropHint | null) =>
  a?.groupId === b?.groupId &&
  a?.pos === b?.pos &&
  a?.stack?.before === b?.stack?.before &&
  (a?.stack === undefined) === (b?.stack === undefined)

// 临时调试钩子（CDP 冒烟用，模块级）。有界：cap 200，超限丢最旧。
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
  resolveMove(x: number, y: number): DropHint | null
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

  // 从宿主捕获段进入时 React 的 currentTarget 已是宿主——捕获退化到
  // documentElement（同一 pointerId 仍有效），否则指针拖出窗口后
  // pointerup 收不到，会话卡死。
  const handle: Element = e.currentTarget ?? document.documentElement
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  let cursor: string | null = null
  // 被拖页签的跟手克隆件（「拖出来」视觉；engage 时创建、finish 时拆除）
  let follower: HTMLElement | null = null
  let grabOffset = { x: 0, y: 0 }
  // rAF-coalesced move processing: the raw handler only records the latest
  // point; all hit testing happens at most once per frame.
  let pending: { x: number; y: number } | null = null
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
    // While dragging, Esc belongs to the drag ALONE — lower layers must not
    // also fire on the same press.
    releaseEscapeLayer = pushEscapeLayer(ESCAPE_PRIORITY.drag)

    // 「拖出来」的视觉（用户 2026-10-05：页签要跟着指针走）：克隆被拖的
    // 页签元素做跟手替身。**克隆源 = e.target 上溯的页签按钮**——本会话从
    // 宿主捕获段进入（onPointerDownCapture 挂 .flexlayout-host），
    // currentTarget 是宿主不是页签按钮，按 handle 判定永远不中。
    const pressedTab =
      e.target instanceof Element
        ? (e.target.closest(
            '.flexlayout__tab_button, .flexlayout__tab_button_stretch, .flexlayout__border_button',
          ) as HTMLElement | null)
        : null
    if (pressedTab) {
      const rect = pressedTab.getBoundingClientRect()
      follower = pressedTab.cloneNode(true) as HTMLElement
      follower.removeAttribute('id') // 页签按钮 id 全局唯一——克隆件不得重号
      follower.classList.add('fl-drag-clone')
      follower.style.width = `${rect.width}px`
      follower.style.height = `${rect.height}px`
      // 记住抓取偏移：指针相对页签原位的落点，跟随即从原姿态被提起
      grabOffset = { x: x - rect.left, y: y - rect.top }
      document.body.appendChild(follower)
      moveFollower(x, y)
    }

    spec.onEngage(x, y)
  }

  const moveFollower = (x: number, y: number) => {
    follower?.style.setProperty(
      'transform',
      `translate3d(${x - grabOffset.x}px, ${y - grabOffset.y}px, 0)`,
    )
  }

  const processMove = (x: number, y: number) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) {
        return
      }

      engage(x, y)
    }

    const hint = spec.resolveMove(x, y)

    moveFollower(x, y)

    // Over a deny area (no target — 左栏/面板栏拒收面 / titlebar / off-window)
    // the release cancels; the cursor says so up front.
    setCursor(hint ? 'grabbing' : 'no-drop')
    publishHint(hint)
  }

  const flushMove = () => {
    raf = 0

    if (pending) {
      const { x, y } = pending
      pending = null
      processMove(x, y)
    }
  }

  const onMove = (ev: PointerEvent) => {
    pending = { x: ev.clientX, y: ev.clientY }
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
    follower?.remove()
    follower = null
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

  // Esc aborts the drag — the target selection vanishes and nothing moves.
  // Capture-phase + stop so it doesn't also close a pane/overlay behind the
  // drag (the escape layer covers contract-following handlers; the stop
  // covers the rest).
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
// 准入与分栏上下限（docs/layout-design.md v6.0 §4）
// ---------------------------------------------------------------------------

/** 页签可去的大栏（§4 归属表）：对话栏页签只进对话栏；打开页钉在面板栏；
 *  其余面板栏页签面板栏+对话栏均可；左栏拒收一切（leftrail 无条不参与）。 */
export const allowedRegionsOf = (paneId: string): Region[] => {
  const t = paneTypeOf(paneId)
  if (!t) return ['left', 'chat', 'panels'] // 未知 id（外部拖入占位等）不设限
  const def = PANE_TYPES[t]
  if (t === 'open') return [] // 打开页锚：不参与拖拽（语义钉死在面板栏顶组）
  if (def.region === 'chat') return ['chat']
  if (def.region === 'left') return []
  return ['panels', 'chat']
}

/** 列的竖向行数：tabset=1；VERT 行=Σ子项；HORZ 行=MAX 子项（横向分栏
 *  不新增竖向行）。上下限 = 列行数 < 2 才允许 top/bottom 投放。 */
export const verticalRowCount = (n: RowNode | TabSetNode): number => {
  if (n instanceof TabSetNode) return 1
  let sum = 0
  for (const c of n.getChildren()) {
    if (c instanceof TabSetNode) sum += 1
    else if (c instanceof RowNode) sum += verticalRowCount(c)
  }
  return sum
}

// ---------------------------------------------------------------------------
// 提交层：center=入栈、edge=分裂（lead 吃几何，其余跟队）。
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

/** center 投放：index = before 页签在"除拖动签外"中的序（hermes slot→index
 *  语义）；无 before = 追加。 */
function dropStack(model: Model, paneId: string, targetId: string, before: null | string) {
  const set = model.getNodeById(targetId)
  if (!(set instanceof TabSetNode)) return
  const others = set.getChildren().filter((c): c is TabNode => c instanceof TabNode && c.getId() !== paneId)
  const raw = before ? others.findIndex((c) => c.getId() === before) : others.length
  const toIndex = raw >= 0 ? raw : others.length
  model.doAction(Actions.moveNode(paneId, targetId, DockLocation.CENTER, toIndex))
}

/** edge 投放：lead 分裂出新 tabset（新栏预戳目标列 region——"放到检查的
 *  左边"=检查所在的列），selectTab 激活。 */
function dropSplit(model: Model, paneId: string, targetId: string, pos: DropPosition) {
  model.doAction(Actions.moveNode(paneId, targetId, dropDockLocation(pos), 0))
  const leadParent = model.getNodeById(paneId)?.getParent()
  if (leadParent instanceof TabSetNode && leadParent.getId() !== targetId) {
    // v7.0：新分栏预戳 = **被拖页签的语义 region**（docs §4——分栏身份跟
    // 内容走；面板页签拖到对话栏旁分栏，新分栏仍是面板栏子栏）
    const t = paneTypeOf(paneId)
    const region = t ? PANE_TYPES[t].region : undefined
    if (region) {
      model.doAction(
        Actions.updateNodeAttributes(leadParent.getId(), { config: { region } }),
      )
    }
  }
}

export interface PaneDragSpec {
  onTap?: () => void
  /** 有 reorder 上下文 = 从 tabset 页签条发起：条内是插入槽重排，撕出条外
   *  变 zone 移动。 */
  reorder?: { groupId: string }
}

/**
 * Begin a pane drag from a tab（hermes startPaneDrag 的 flexlayout 版）.
 * A sub-threshold release is a click (`onTap`, tab activation rides the
 * native click). With a `reorder` context, movement inside the strip targets
 * an insertion slot — the strip renders a divider at it, NOTHING moves until
 * release; tearing away from the strip converts the drag into a zone move.
 * Zone move: the zone under the pointer lights up, its strip stacks at the
 * divider slot, an edge splits. Esc aborts either mode.
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

  const allowed = allowedRegionsOf(paneId)
  let zones: EngineZone[] = []
  let strips: StripSnapshot[] = []
  let mode: 'reorder' | 'zone' | null = null
  const dimmed: HTMLElement[] = []

  const markSource = () => {
    // The dragged tab dims for the drag's life — the divider says where it
    // GOES, the dim says what MOVES. No live shuffle (placement-on-release).
    if (dimmed.length === 0) {
      const el = document.getElementById(`flexlayout-tabbutton-${paneId}`)
      if (el) dimmed.push(el)
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
      dragLog('engage', { x, y, paneId, hasReorder: Boolean(spec.reorder) })
      // 快照给 DropOverlay 用（viewport 坐标 + 宿主偏移）
      const host = document.querySelector('.flexlayout-host')
      const hr = host?.getBoundingClientRect()
      dragGeometry = {
        hostOffset: { x: hr?.left ?? 0, y: hr?.top ?? 0 },
        zones: snapshotZones(model),
        strips: snapshotStrips(model),
        moving: [paneId],
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

    resolveMove(x, y) {
      if (mode === 'reorder') {
        if (withinStrip(x, y)) {
          return {
            kind: 'group',
            groupId: spec.reorder!.groupId,
            pos: 'center',
            stack: slotBefore(reorderStrip().slots, x, paneId),
          }
        }

        // Tear-off: the tab leaves the strip and becomes a zone move.
        enterZoneMode()
      }

      // A strip is an exact target. Resolve it before the zone rect:
      // near a panel seam, containment can otherwise pick the neighbor zone.
      const hitStrip = strips.find((strip) => rectContains(strip.rect, x, y) && allowed.includes(strip.region))

      if (hitStrip) {
        return {
          kind: 'group',
          groupId: hitStrip.groupId,
          pos: 'center',
          stack: slotBefore(hitStrip.slots, x, paneId),
        }
      }

      // Zone under the pointer (region-admitted only).
      const zone = zones.find((z) => rectContains(z.rect, x, y) && allowed.includes(z.region))
      if (!zone) return null

      const pos = radialPosition(zone.rect, x, y)
      const strip = strips.find((s) => s.groupId === zone.id && rectContains(s.rect, x, y))
      if (strip) {
        return { kind: 'group', groupId: zone.id, pos: 'center', stack: slotBefore(strip.slots, x, paneId) }
      }

      // 上下两行上限（§2）：edge=top/bottom 会新增竖向行——目标列已满 2 行
      // 则拒（center/edge 左右仍可）。
      if (pos === 'top' || pos === 'bottom') {
        const targetColumn = columnOfZone(model, zone.id)
        if (targetColumn && verticalRowCount(targetColumn) >= 2) return null
      }

      return { kind: 'group', groupId: zone.id, pos, stack: undefined }
    },

    onCommit(hint) {
      dragLog('commit', { mode, hint })
      if (mode === 'reorder' && spec.reorder && hint?.stack !== undefined) {
        dropStack(model, paneId, spec.reorder.groupId, hint.stack.before)
        reorderCommitHaptic()
        return
      }

      if (mode === 'zone' && hint?.groupId) {
        if (hint.stack !== undefined) {
          dropStack(model, paneId, hint.groupId, hint.stack.before)
        } else if (hint.pos === 'center') {
          dropStack(model, paneId, hint.groupId, null)
        } else {
          dropSplit(model, paneId, hint.groupId, hint.pos)
        }
        model.doAction(Actions.selectTab(paneId))
        reorderCommitHaptic()
      }
    },

    onEnd() {
      for (const el of dimmed) {
        el.style.removeProperty('opacity')
      }

      dragGeometry = null
    },
  })
}

/** zone id（tabset id）所在列的根行直接子项。 */
const columnOfZone = (model: Model, zoneId: string): RowNode | TabSetNode | undefined => {
  const rootRow = model.getRootRow()
  let cur: Node | undefined = model.getNodeById(zoneId)
  while (cur) {
    const p: Node | undefined = cur.getParent()
    if (!p || p === rootRow) break
    cur = p
  }
  return cur instanceof TabSetNode || cur instanceof RowNode ? cur : undefined
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
