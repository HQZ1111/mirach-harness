/**
 * 会话行跨面拖拽（v8.1 dockview 版，2026-10-14 恢复）——M1 换壳时随
 * flexlayout 版拆除（v7.4 语义：拖出侧栏 → 对话栏开该会话的分栏），本版
 * 按 dockview 目标面重写：
 *
 * - 目标 = **region=chat 各组的内容区**（.dv-content-container 矩形）——
 *   拖入高亮、松手经 openSessionTabBridge(threadId) 提交（shell 注册的实现
 *   = addPanel direction right 完整聊天分栏）；
 * - 其余区面（侧栏列表/标题栏/面板栏）= 拒绝区（no-drop，松手不提交）；
 * - 列表内排序仍归 dnd-kit（ReorderableList 不动）——双机器并行照抄 hermes
 *   （session-row.tsx:374-395）：同一 pointerdown 各起各的，各管各的区域、
 *   互不仲裁，释放落在谁的合法区就谁提交。
 *
 * 机器形态沿用旧版（4px 阈值 / rAF 合帧 / pointer capture / Esc 顶层逃生
 * 层 / engaged 后吞合成 click），拖起视觉：源行压暗 0.45（hermes 实锤值）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

import { regionOfGroup } from '@/components/layout/dockview-column-ops'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import type { DockviewApi } from 'dockview-react'

const DRAG_THRESHOLD_PX = 4

/** 拖起源行的压暗值（hermes session-drag.ts:120 逐字）。 */
const SOURCE_DIM_OPACITY = '0.45'

export interface SessionRowDragSpec {
  /** 松手在对话栏（region=chat）任一内容区上 → 开该会话的分栏。 */
  onCommitOpenTab(): void
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/** 活动布局 api（shell onReady 挂的 __dvApi 通道——column-ops 同款生产用法）。
 *  不在场 = 目标不可用，错误可见。 */
const dvApi = (): DockviewApi | undefined => {
  const a = (globalThis as { __dvApi?: DockviewApi }).__dvApi
  if (!a) console.error('[session-drag] 布局 api 不在场（__dvApi 未挂载）——跨面目标不可用')
  return a
}

interface DragTarget {
  el: HTMLElement
  rect: Rect
}

/** engage 快照：对话栏各组的**内容区**矩形（拖拽中布局不重组，全程纯数学）。 */
const chatTargets = (): DragTarget[] => {
  const a = dvApi()
  if (!a) return []
  const out: DragTarget[] = []
  for (const g of a.groups) {
    if (regionOfGroup(g) !== 'chat') continue
    const el = document.getElementById(g.model.contentContainerId)
    if (!(el instanceof HTMLElement)) continue
    const r = el.getBoundingClientRect()
    out.push({ el, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
  }
  return out
}

/** engaged 松手后吞掉恰一个合成 click（照抄旧版：commit 与 abort 的 click
 *  到达时机不同，disarm 分别对齐）。 */
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
 * 由 PointerSensor 原生 Esc 取消，两边同一次按键各自回到静止态）。
 */
export function startSessionRowDrag(e: ReactPointerEvent<Element>, spec: SessionRowDragSpec) {
  if (e.button !== 0) return

  // 把手（[data-reorder-handle]，自带 dnd-kit 完整监听）与行操作簇
  // （[data-row-actions]）/输入框/已打开的菜单：原生交互优先，行壳不重复起拖
  // （hermes session-row.tsx:385 同款豁免选择器）。
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
  // 源行内联 opacity 的恢复快照（还原到原行自身样式，不是硬写 ''）
  let restoreRowOpacity = ''
  let cursor: string | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null

  // engage 快照：对话栏内容区（拖拽中布局不重组，全程纯数学）
  let targets: DragTarget[] = []
  // 当前悬停的高亮目标：null=拒绝区
  let hover: DragTarget | null = null

  const setCursor = (value: string) => {
    if (cursor !== value) {
      cursor = value
      document.body.style.cursor = value
    }
  }

  const setHighlight = (el: HTMLElement | null, on: boolean) => {
    if (!el) return
    if (on) el.style.boxShadow = 'inset 0 0 0 2px var(--fl-accent)'
    else el.style.removeProperty('box-shadow')
  }

  const clearHover = () => {
    if (!hover) return
    setHighlight(hover.el, false)
    hover = null
  }

  const publish = (next: DragTarget | 'deny' | null) => {
    // 拒绝区：no-drop 光标，松手什么都不提交。光标每帧对齐（值变守卫）。
    setCursor(next && next !== 'deny' ? 'grabbing' : 'no-drop')
    if (next === 'deny') {
      clearHover()
      return
    }
    if (next && hover && next.el === hover.el) return
    clearHover()
    if (!next) return
    hover = next
    setHighlight(hover.el, true)
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
    // 源行压暗 0.45 = 「picked up」反馈（hermes session-drag.ts:120 逐字）
    restoreRowOpacity = handle.style.opacity
    handle.style.setProperty('opacity', SOURCE_DIM_OPACITY)

    targets = chatTargets()
  }

  const resolve = (x: number, y: number) => {
    // 对话栏内容区 = 提交面；其余拒绝。
    const hit = targets.find((t) => rectContains(t.rect, x, y))
    if (!hit) {
      publish(null)
      return
    }
    publish(hit)
  }

  const processMove = (x: number, y: number) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) return
      engage()
    }

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

      if (commit && hover) spec.onCommitOpenTab()
      clearHover()
    }
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc = 拖拽独占的"不要了"：高亮消失、什么都不提交（顶层逃生层）。
  // 不 stopPropagation：dnd-kit PointerSensor 的 Esc 取消挂在 document 冒泡段，
  // 捕获段阻断会连排序侧的取消一起杀死（实测踩过）。
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
