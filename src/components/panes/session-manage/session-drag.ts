/**
 * 会话行拖拽会话（侧栏手动排序 + 投放主会话页签切换）。
 *
 * 机器照抄 layout/drag-session.ts 的 startDragSession（4px 阈值 / rAF 合帧 /
 * pointer capture / Esc 顶层逃生层 / engaged 后吞合成 click），独立实现——
 * startDragSession 的提示通道耦合 layout-store 的 DropHint（窗格投放形状，
 * DropOverlay 消费），侧栏插入符形状不同，不复用以免污染窗格 overlay。
 *
 * 视觉（DragOverlay 观感，不引 dnd-kit）：engage 起整行克隆浮层跟手
 * （session-drag-ghost.ts：尺寸/内容=原行快照、抓取点跟光标），原行隐藏
 * 占位防跳动——hermes dnd-kit 语义「原行消失、整行随光标、落点让位」
 * （落点指示=本机制的插入符，落下提交即让位）。
 *
 * 命中面（engage 时快照，拖拽中纯数学——无 elementsFromPoint）：
 * - 主会话页签：#flexlayout-tabbutton-<PRIMARY_PANE.main>（id 方案见
 *   flex-layout.tsx；拉伸头栏与普通页签按钮同 id 方案，都算命中面）→
 *   内嵌 accent 描边高亮 + 松手切换主线程（onCommitMainTab）；
 * - 侧栏列表插入符：候选 = 非置顶行（置顶组固定活跃降序，不参与排序；
 *   置顶行起拖只允许投主页签），被拖行自身除外 → beforeId（null = 尾部）；
 * - 其余（标题栏/分隔条/窗格内容）= 拒绝区（no-drop，松手不提交）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

import { PRIMARY_PANE } from '@/components/layout/pane-registry'
import type { DragGhost } from '@/lib/drag-ghost'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'

import { sessionManageStore, type SessionDragState, type SessionRowGroup } from './session-manage-store'
import { createRowDragGhost } from './session-drag-ghost'

const DRAG_THRESHOLD_PX = 4
const TAB_BUTTON_ID = 'flexlayout-tabbutton-'

/** 行元素标记（ThreadListItem 的 Root 上挂，快照/候选识别用） */
export const SESSION_ROW_ATTR = 'data-session-row-id'
/** 行所在列表组（'pinned' | 'recent' | 'search'）——拖拽落点按组匹配：
 *  置顶区与会话区各自独立可排、互不越组（hermes 每区一个 ReorderableList）；
 *  搜索区不可排（hermes 搜索结果段不接 sortable）。 */
export const SESSION_ROW_GROUP_ATTR = 'data-session-row-group'

export interface SessionRowDragSpec {
  sessionId: string
  /** 被拖行所在组（落点候选只收同组行） */
  group: SessionRowGroup | 'search'
  /** 松手在列表插入符上（beforeId = 目标行 id，null = 该组尾部） */
  onCommitListMove(beforeId: string | null): void
  /** 松手在主会话页签上（切换主线程到该会话） */
  onCommitMainTab(): void
}

interface RowRect {
  id: string
  /** 行垂直中点（插入判定：y < mid = 插到它前面） */
  mid: number
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/**
 * 主会话页签元素。flexlayout 页签按钮 id = flexlayout-tabbutton-<tabId>
 * （tabset 与 border 按钮同前缀；单页签拉伸头栏也带此 id）——直接按 id 取
 * workspace 页签；id 在但不是页签按钮（不该发生）不算命中面。
 */
export const mainTabButton = (): HTMLElement | null => {
  const el = document.getElementById(TAB_BUTTON_ID + PRIMARY_PANE.main)
  if (!el) return null
  return el.classList.contains('flexlayout__tab_button') ||
    el.classList.contains('flexlayout__tab_button_stretch')
    ? el
    : null
}

/** engaged 松手后吞掉恰一个合成 click（照抄 drag-session.ts：commit 与
 *  abort 的 click 到达时机不同，disarm 分别对齐）。 */
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

const sameTarget = (a: SessionDragState['target'] | null, b: SessionDragState['target'] | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    (a.kind !== 'list' ||
      b.kind !== 'list' ||
      (a.beforeId === b.beforeId && a.group === b.group)))

/**
 * 起一次会话行拖拽。阈值内松开 = 普通点击（切会话照常，机器不干预）；
 * 越阈值后落点与提交全由本会话接管，Esc 随时中止。
 */
export function startSessionRowDrag(e: ReactPointerEvent<Element>, spec: SessionRowDragSpec) {
  if (e.button !== 0) return

  // 行操作簇（⋯ 菜单钮，[data-row-actions]——hermes 同款豁免选择器）/
  // 输入框 / 已打开的菜单：原生交互优先，不起拖。
  const pressTarget = e.target as HTMLElement | null
  if (pressTarget?.closest('[data-row-actions], input, textarea, [role="menu"], [role="dialog"]')) return

  const handle = e.currentTarget as HTMLElement
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  let ghost: DragGhost | null = null
  let restoreRowOpacity = ''
  let cursor: string | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null

  // engage 快照：主页签矩形 + 同组行候选（拖拽中布局不重组，全程纯数学）
  let mainTab: HTMLElement | null = null
  let mainRect: Rect | null = null
  let candidates: RowRect[] = []
  let listGroup: SessionRowGroup | null = null
  let lastTarget: SessionDragState['target'] | null = null

  const setCursor = (value: string) => {
    if (cursor !== value) {
      cursor = value
      document.body.style.cursor = value
    }
  }

  const applyMainHighlight = (on: boolean) => {
    if (!mainTab) return
    if (on) mainTab.style.boxShadow = 'inset 0 0 0 2px var(--fl-accent)'
    else mainTab.style.removeProperty('box-shadow')
  }

  const publish = (target: SessionDragState['target'] | null) => {
    if (sameTarget(lastTarget, target)) return
    if (lastTarget?.kind === 'main-tab') applyMainHighlight(false)
    lastTarget = target
    if (target?.kind === 'main-tab') applyMainHighlight(true)
    sessionManageStore
      .getState()
      .setDrag(target === null ? null : { sessionId: spec.sessionId, target })
  }

  const engage = () => {
    engaged = true

    try {
      handle.setPointerCapture?.(pointerId)
    } catch {
      // 合成事件（自动化）没有活动指针
    }

    setCursor('grabbing')
    document.body.style.userSelect = 'none'
    releaseEscapeLayer = pushEscapeLayer(ESCAPE_PRIORITY.drag)
    // 整行克隆浮层跟手（DragOverlay 观感），原行隐藏占位防跳动——内联
    // opacity 压过行类，恢复在 finish（commit/abort 同一条清场路径）。
    restoreRowOpacity = handle.style.opacity
    handle.style.opacity = '0'
    ghost = createRowDragGhost(handle, sx, sy)

    mainTab = mainTabButton()
    const mr = mainTab?.getBoundingClientRect()
    mainRect =
      mr && mr.width > 0 && mr.height > 0
        ? { left: mr.left, top: mr.top, right: mr.right, bottom: mr.bottom }
        : null

    // 插入候选 = 与拖拽行同组、同列表容器的其它行（被拖行自身除外——不能
    // 插到自己旁边装作移动）。组间互不越界（hermes：每区一个 ReorderableList）；
    // 搜索区不可排（listGroup 保持 null → 落点只剩主页签/no-drop）。
    listGroup = spec.group === 'search' ? null : spec.group
    const listEl = handle.closest('[data-slot="aui_thread-list-items"]')
    const rowEls = listEl ? [...listEl.querySelectorAll<HTMLElement>(`[${SESSION_ROW_ATTR}]`)] : []
    candidates =
      listGroup === null
        ? []
        : rowEls
            .map((el): RowRect | null => {
              const id = el.dataset.sessionRowId
              if (!id || id === spec.sessionId) return null
              if (el.dataset.sessionRowGroup !== listGroup) return null
              const r = el.getBoundingClientRect()
              if (r.height === 0) return null
              return { id, mid: r.top + r.height / 2 }
            })
            .filter((r): r is RowRect => r !== null)
  }

  const resolve = (x: number, y: number) => {
    // 主会话页签优先（页签在布局里，与侧栏列表不相交，顺序无歧义）
    if (mainRect && rectContains(mainRect, x, y)) {
      publish({ kind: 'main-tab' })
      setCursor('grabbing')
      return
    }

    // 无可排组（搜索态 / 该区只有被拖行一行）：非页签区拒绝投放
    if (listGroup === null || candidates.length === 0) {
      publish(null)
      setCursor('no-drop')
      return
    }

    const beforeId = candidates.find((c) => y < c.mid)?.id ?? null
    publish({ kind: 'list', group: listGroup, beforeId })
    setCursor('grabbing')
  }

  const processMove = (x: number, y: number) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) return
      engage()
    }

    ghost?.moveTo(x, y)
    resolve(x, y)
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
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }

    // 落点按最终指针位置算，不是最后一帧的——提交前冲刷 pending move。
    // 中止（Esc / pointercancel）直接丢弃。
    if (commit && engaged) {
      flushMove()
    }

    document.body.style.cursor = restoreCursor
    document.body.style.userSelect = restoreSelect
    ghost?.destroy()
    ghost = null
    handle.style.opacity = restoreRowOpacity
    releaseEscapeLayer?.()
    releaseEscapeLayer = null

    try {
      handle.releasePointerCapture?.(pointerId)
    } catch {
      // 镜像 capture 守卫
    }

    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)

    if (engaged) {
      suppressDragClick(commit)
      applyMainHighlight(false)
      sessionManageStore.getState().setDrag(null)

      if (commit) {
        if (lastTarget?.kind === 'list') spec.onCommitListMove(lastTarget.beforeId)
        else if (lastTarget?.kind === 'main-tab') spec.onCommitMainTab()
      }
    }
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc = 拖拽独占的"不要了"：目标指示消失、什么都不提交（顶层逃生层，
  // 低于它的编辑模式/浮层不再同时响应同一次 Esc）。
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
