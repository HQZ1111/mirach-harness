/**
 * 会话行跨面拖拽（投放主会话页签切换）——列表内让位排序已交 dnd-kit
 * （reorderable-list.tsx 照抄 hermes），本机器只负责「出侧栏」那一半。
 *
 * 双机器并行照抄 hermes（session-row.tsx:374-395 实锤）：同一 pointerdown
 * 起 dnd-kit 排序 + 本 pointer 会话，各管各的区域、互不仲裁——侧栏上只有
 * 排序有目标（本机器拒绝），主区页签上只有本机器有目标（列表已松手）。
 * 释放落点是谁的合法区，就谁提交。
 *
 * 机器照抄 layout/drag-session.ts 的 startDragSession（4px 阈值 / rAF 合帧 /
 * pointer capture / Esc 顶层逃生层 / engaged 后吞合成 click），独立实现——
 * startDragSession 的提示通道耦合窗格 DropHint，不复用以免污染窗格 overlay。
 *
 * 拖起视觉（hermes session-drag.ts:120 实锤）：engage 起源行内联
 * opacity 0.45（「picked up」反馈）+ label chip ghost 跟手
 * （lib/drag-ghost.ts，opacity 0.6）；行自身 z-10/不透明底/cursor-grabbing
 * 由 dnd-kit isDragging 类负责（thread-list 行上）。
 *
 * 命中面（engage 时快照，拖拽中纯数学——无 elementsFromPoint）：
 * - 主会话页签：#flexlayout-tabbutton-<PRIMARY_PANE.main>（id 方案见
 *   flex-layout.tsx；拉伸头栏与普通页签按钮同 id 方案，都算命中面）→
 *   内嵌 accent 描边高亮 + 松手切换主线程（onCommitMainTab）；
 * - 其余（侧栏列表——那里 dnd-kit 在排、标题栏/分隔条/窗格内容）= 拒绝区
 *   （no-drop，松手不提交）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

import { PRIMARY_PANE } from '@/components/layout/pane-registry'
import { createDragGhost, type DragGhost } from '@/lib/drag-ghost'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'

const DRAG_THRESHOLD_PX = 4
const TAB_BUTTON_ID = 'flexlayout-tabbutton-'

/** 拖起源行的压暗值（hermes session-drag.ts:120 `source?.style.setProperty
 *  ('opacity', '0.45')` 逐字实锤——用户点名「拖出来的透明度不对」即此值）。 */
const SOURCE_DIM_OPACITY = '0.45'

export interface SessionRowDragSpec {
  sessionId: string
  /** chip ghost 标签（hermes sessionLabel(payload) = 会话标题） */
  title: string
  /** 松手在主会话页签上（切换主线程到该会话） */
  onCommitMainTab(): void
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

/**
 * 起一次会话行跨面拖拽。阈值内松开 = 普通点击（切会话照常，机器不干预）；
 * 越阈值后落点与提交全由本会话接管，Esc 随时中止（dnd-kit 一侧的排序拖
 * 由 PointerSensor 原生 Esc 取消——core AbstractPointerSensor.handleKeydown，
 * 两边同一次按键各自回到静止态）。列表内排序不在这里——dnd-kit。
 */
export function startSessionRowDrag(e: ReactPointerEvent<Element>, spec: SessionRowDragSpec) {
  if (e.button !== 0) return

  // 把手（[data-reorder-handle]，自带 dnd-kit 完整监听）与行操作簇
  // （⋯ 菜单钮 [data-row-actions]）/输入框/已打开的菜单：原生交互优先，
  // 行壳不重复起拖（hermes session-row.tsx:385 同款豁免选择器）。
  const pressTarget = e.target as HTMLElement | null
  if (
    pressTarget?.closest(
      '[data-reorder-handle], [data-row-actions], input, textarea, [role="menu"], [role="dialog"]',
    )
  )
    return

  const handle = e.currentTarget as HTMLElement
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  let ghost: DragGhost | null = null
  // 源行内联 opacity 的恢复快照（hermes restoreOpacity 语义：还原到原行
  // 自身样式，不是硬写 ''）
  let restoreRowOpacity = ''
  let cursor: string | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null

  // engage 快照：主页签矩形（拖拽中布局不重组，全程纯数学）
  let mainTab: HTMLElement | null = null
  let mainRect: Rect | null = null
  let lastMainTab = false

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

  const publish = (overMainTab: boolean) => {
    // 拒绝区（hermes resolveMove 返回 null 的等价面）：no-drop 光标，松手
    // 什么都不提交——侧栏列表区正被 dnd-kit 排序占用，这里同样归拒绝区。
    // 光标每帧对齐（setCursor 自带值变守卫；hermes startDragSession
    // processMove 同款——hint 恒定时也要保证 engage→grabbing 起手值不丢）。
    setCursor(overMainTab ? 'grabbing' : 'no-drop')
    if (lastMainTab === overMainTab) return
    lastMainTab = overMainTab
    applyMainHighlight(overMainTab)
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
    // label chip 跟手（hermes ghost: { label: sessionLabel(payload) }）
    ghost = createDragGhost(spec.title)
    // 源行压暗 0.45 = 「picked up」反馈（hermes session-drag.ts:120 逐字；
    // dnd-kit 一侧的行自身类负责 z-10/不透明底/cursor-grabbing）
    restoreRowOpacity = handle.style.opacity
    handle.style.setProperty('opacity', SOURCE_DIM_OPACITY)

    mainTab = mainTabButton()
    const mr = mainTab?.getBoundingClientRect()
    mainRect =
      mr && mr.width > 0 && mr.height > 0
        ? { left: mr.left, top: mr.top, right: mr.right, bottom: mr.bottom }
        : null
  }

  const resolve = (x: number, y: number) => {
    publish(mainRect !== null && rectContains(mainRect, x, y))
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

      if (commit && lastMainTab) spec.onCommitMainTab()
    }
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc = 拖拽独占的"不要了"：高亮消失、什么都不提交（顶层逃生层，
  // 低于它且守契约的编辑模式/浮层不再同时响应同一次 Esc）。
  // 不 stopPropagation：dnd-kit PointerSensor 的 Esc 取消挂在 document 冒泡段
  // （core AbstractPointerSensor.attach → documentListeners.add(Keydown)），
  // 捕获段阻断会连排序侧的取消一起杀死——实测（CDP）捕获段 stop 时松手仍
  // 提交换位，即此。排序侧的中止交给 dnd-kit 自己（onDragCancel 复原位）。
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      finish(false)
    }
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
}
