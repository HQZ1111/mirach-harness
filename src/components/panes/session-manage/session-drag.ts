/**
 * 会话行跨面拖拽（docs/layout-design.md §6，hermes app/chat/session-drag.ts
 * 的投放语言逐条对齐）——列表内让位排序已交 dnd-kit（reorderable-list.tsx
 * 照抄 hermes），本机器只负责「出侧栏」那一半。
 *
 * 双机器并行照抄 hermes（session-row.tsx:374-395 实锤）：同一 pointerdown
 * 起 dnd-kit 排序 + 本 pointer 会话，各管各的区域、互不仲裁——侧栏上只有
 * 排序有目标（本机器拒绝），对话栏页签条上只有本机器有目标（列表已松手）。
 * 释放落点是谁的合法区，就谁提交。
 *
 * **投放语言（hermes session-drag resolveMove 逐条）**：
 * - 对话栏任一分栏的**页签条**（条带矩形覆盖页签按钮——拖到主对话页签上 =
 *   拖到条上）→ 在悬停页签的槽位前**堆叠**该会话的页签（slotBefore 槽位
 *   精度，onCommitOpenTab(tabsetId, beforeTabId)）；
 * - **页签条隐藏 = 无法拖入**（hermes snapshotStrips 来自 DOM：条不渲染即
 *   无堆叠目标）——单签自动隐藏的对话栏拒收会话行；
 * - 其余（窗格 body/侧栏列表/标题栏）= 拒绝区（no-drop，松手不提交）。
 *
 * 机器与 layout/drag-session.ts 同款（4px 阈值 / rAF 合帧 / pointer
 * capture / Esc 顶层逃生层 / engaged 后吞合成 click），独立实现——不复用
 * startDragSession：它的提示通道耦合窗格 DropHint（overlay sheet），会话行
 * 拖拽的反馈是命中面内描边，不能污染窗格 overlay。
 *
 * 拖起视觉（hermes session-drag.ts:120 实锤）：engage 起源行内联
 * opacity 0.45（「picked up」反馈）；行自身 z-10/不透明底/cursor-grabbing
 * 由 dnd-kit isDragging 类负责。**chip ghost 已删**（用户 2026-10-05）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

import { TabSetNode, type Model } from 'flexlayout-react'

import { zoneConfigOf } from '@/components/layout/pane-registry'
import { slotBefore, snapshotStrips, type StripSnapshot } from '@/components/layout/drag-session'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'

const DRAG_THRESHOLD_PX = 4

/** 拖起源行的压暗值（hermes session-drag.ts:120 逐字）。 */
const SOURCE_DIM_OPACITY = '0.45'

export interface SessionRowDragSpec {
  sessionId: string
  /** 会话显示名（压暗行跟随） */
  title: string
  /** 松手在对话栏某分栏的页签条上（开出该会话的页签；beforeTabId = 悬停
   *  页签的槽位，插到它前面；null = 追加到条尾） */
  onCommitOpenTab(tabsetId: string, beforeTabId: string | null): void
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/** 活动布局模型（flex-layout 的 __flModel 通道——pane-context-menu 同款
 *  生产用法）。不在场 = 条带目标不可用，错误可见。 */
const flModel = (): Model | undefined => {
  const m = (window as { __flModel?: Model }).__flModel
  if (!m) console.error('[session-drag] 活动布局模型不在场（__flModel 未挂载）——条带目标不可用')
  return m
}

/** engage 快照：对话栏（region=chat）各分栏**已渲染**的页签条（条隐藏 =
 *  bar 不在 DOM = 天然拒收——hermes snapshotStrips 同款语义）。 */
const chatStripSnapshots = (): { el: HTMLElement; snap: StripSnapshot }[] => {
  const model = flModel()
  if (!model) return []
  const out: { el: HTMLElement; snap: StripSnapshot }[] = []
  model.visitNodes((n) => {
    if (!(n instanceof TabSetNode)) return
    if (n.getChildren().length === 0) return
    if (zoneConfigOf(n)?.region !== 'chat') return
    const setEl = document.querySelector(`.flexlayout__tabset[data-layout-path="${n.getPath()}"]`)
    const bar = setEl?.querySelector('.flexlayout__tabset_tabbar_outer')
    if (!(bar instanceof HTMLElement)) return
    const strips = snapshotStrips(model).filter((s) => s.groupId === n.getId())
    if (strips.length === 0) return
    out.push({ el: bar, snap: strips[0] })
  })
  return out
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
 * 由 PointerSensor 原生 Esc 取消，两边同一次按键各自回到静止态）。
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
  // 源行内联 opacity 的恢复快照（hermes restoreOpacity 语义：还原到原行
  // 自身样式，不是硬写 ''）
  let restoreRowOpacity = ''
  let cursor: string | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null

  // engage 快照：对话栏条带（拖拽中布局不重组，全程纯数学）
  let strips: { el: HTMLElement; rect: Rect; snap: StripSnapshot }[] = []
  // 当前悬停的高亮目标：null=拒绝区；否则条带元素 + 槽位
  type Hover = { el: HTMLElement; tabsetId: string; before: string | null } | null
  let hover: Hover = null

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

  const publish = (next: Exclude<Hover, null> | 'deny' | null) => {
    // 拒绝区（hermes resolveMove 返回 null 的等价面）：no-drop 光标，松手
    // 什么都不提交。光标每帧对齐（setCursor 自带值变守卫）。
    setCursor(next && next !== 'deny' ? 'grabbing' : 'no-drop')
    if (next === 'deny') {
      clearHover()
      return
    }
    if (next && hover && next.el === hover.el && next.before === hover.before) return
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
    // 源行压暗 0.45 = 「picked up」反馈（hermes session-drag.ts:120 逐字；
    // dnd-kit 一侧的行自身类负责 z-10/不透明底/cursor-grabbing）
    restoreRowOpacity = handle.style.opacity
    handle.style.setProperty('opacity', SOURCE_DIM_OPACITY)

    strips = chatStripSnapshots().map(({ el, snap }) => {
      const r = el.getBoundingClientRect()
      return {
        el,
        snap,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      }
    })
  }

  const resolve = (x: number, y: number) => {
    // 对话栏条带（含页签按钮——拖到主对话页签上就是拖到条上）= 堆叠；
    // 槽位 = 悬停页签前（hermes slotBefore）；其余拒绝。
    const hit = strips.find((s) => rectContains(s.rect, x, y))
    if (!hit) {
      publish(null)
      return
    }
    const before = slotBefore(hit.snap.slots, x, '').before
    publish({ el: hit.el, tabsetId: hit.snap.groupId, before })
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

      if (commit && hover) spec.onCommitOpenTab(hover.tabsetId, hover.before)
      clearHover()
    }
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc = 拖拽独占的"不要了"：高亮消失、什么都不提交（顶层逃生层）。
  // 不 stopPropagation：dnd-kit PointerSensor 的 Esc 取消挂在 document 冒泡段，
  // 捕获段阻断会连排序侧的取消一起杀死（实测踩过）。排序侧的中止交给
  // dnd-kit 自己（onDragCancel 复原位）。
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
