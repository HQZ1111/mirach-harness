/**
 * 会话行跨面拖拽（docs/layout-design.md v6.0 §6）——列表内让位排序已交
 * dnd-kit（reorderable-list.tsx 照抄 hermes），本机器只负责「出侧栏」那一半。
 *
 * 双机器并行照抄 hermes（session-row.tsx:374-395 实锤）：同一 pointerdown
 * 起 dnd-kit 排序 + 本 pointer 会话，各管各的区域、互不仲裁——侧栏上只有
 * 排序有目标（本机器拒绝），对话栏页签条/主页签上只有本机器有目标（列表
 * 已松手）。释放落点是谁的合法区，就谁提交。
 *
 * 机器与 layout/drag-session.ts 同款（4px 阈值 / rAF 合帧 / pointer
 * capture / Esc 顶层逃生层 / engaged 后吞合成 click），独立实现——不复用
 * startDragSession：它的提示通道耦合窗格 DropHint（overlay sheet），会话行
 * 拖拽的反馈是命中面内描边，不能污染窗格 overlay。
 *
 * 拖起视觉（hermes session-drag.ts:120 实锤）：engage 起源行内联
 * opacity 0.45（「picked up」反馈）；行自身 z-10/不透明底/cursor-grabbing
 * 由 dnd-kit isDragging 类负责。**chip ghost 已删**（用户 2026-10-05）。
 *
 * 命中面（engage 时快照，拖拽中纯数学——无 elementsFromPoint）：
 * - 主会话页签按钮（#flexlayout-tabbutton-workspace，单签拉伸形态同 id）→
 *   内嵌 accent 描边 + 松手**切换主会话**（onCommitMainTab）；
 * - **对话栏任一分栏的页签条**（region=chat 的 tabset 条带）→ 条带内嵌
 *   accent 描边 + 松手**开出该会话的页签**（onCommitOpenTab；已开 → 置前，
 *   由 flex-layout 的 openSessionTab 保证同会话不重复开签）；
 * - 其余（面板栏条带/窗格 body/侧栏列表/标题栏）= 拒绝区（no-drop，
 *   松手不提交）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

import { TabSetNode, type Model } from 'flexlayout-react'

import { PRIMARY_PANE, zoneConfigOf } from '@/components/layout/pane-registry'
import { snapshotStrips, type StripSnapshot } from '@/components/layout/drag-session'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'

const DRAG_THRESHOLD_PX = 4
const TAB_BUTTON_ID = 'flexlayout-tabbutton-'

/** 拖起源行的压暗值（hermes session-drag.ts:120 逐字）。 */
const SOURCE_DIM_OPACITY = '0.45'

export interface SessionRowDragSpec {
  sessionId: string
  /** 会话显示名（压暗行跟随） */
  title: string
  /** 松手在主会话页签上（切换主线程到该会话） */
  onCommitMainTab(): void
  /** 松手在对话栏某分栏的页签条上（开出该会话的页签，多标签模式） */
  onCommitOpenTab(tabsetId: string): void
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
 *  生产用法）。不在场 = 条带目标不可用（只见主页签），错误可见。 */
const flModel = (): Model | undefined => {
  const m = (window as { __flModel?: Model }).__flModel
  if (!m) console.error('[session-drag] 活动布局模型不在场（__flModel 未挂载）——条带目标不可用')
  return m
}

/**
 * 主会话页签元素。flexlayout 页签按钮 id = flexlayout-tabbutton-<tabId>
 * ——直接按 id 取 workspace 页签；id 在但不是页签按钮（不该发生）不算
 * 命中面。
 */
export const mainTabButton = (): HTMLElement | null => {
  const el = document.getElementById(TAB_BUTTON_ID + PRIMARY_PANE.chat)
  if (!el) return null
  return el.classList.contains('flexlayout__tab_button') ||
    el.classList.contains('flexlayout__tab_button_stretch')
    ? el
    : null
}

/** engage 快照：对话栏（region=chat）各分栏的页签条。 */
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

  // engage 快照：主页签矩形 + 对话栏条带（拖拽中布局不重组，全程纯数学）
  let mainTab: HTMLElement | null = null
  let mainRect: Rect | null = null
  let strips: { el: HTMLElement; rect: Rect; snap: StripSnapshot }[] = []
  // 当前悬停的高亮目标：null=拒绝区；'main'=主页签；否则条带元素
  type Hover = { kind: 'main' } | { kind: 'strip'; el: HTMLElement; tabsetId: string } | null
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
    if (hover.kind === 'main') setHighlight(mainTab, false)
    else setHighlight(hover.el, false)
    hover = null
  }

  const publish = (next: Hover) => {
    // 拒绝区（hermes resolveMove 返回 null 的等价面）：no-drop 光标，松手
    // 什么都不提交。光标每帧对齐（setCursor 自带值变守卫）。
    setCursor(next ? 'grabbing' : 'no-drop')
    if (next?.kind === 'strip' && hover?.kind === 'strip' && next.el === hover.el) return
    if ((next?.kind ?? null) === (hover?.kind ?? null) && next?.kind !== 'strip') return
    clearHover()
    hover = next
    if (hover?.kind === 'main') setHighlight(mainTab, true)
    else if (hover?.kind === 'strip') setHighlight(hover.el, true)
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

    mainTab = mainTabButton()
    const mr = mainTab?.getBoundingClientRect()
    mainRect =
      mr && mr.width > 0 && mr.height > 0
        ? { left: mr.left, top: mr.top, right: mr.right, bottom: mr.bottom }
        : null
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
    // 主页签优先：指针压在主页签按钮上 = 切换主会话（§6 命中面 1）
    if (mainRect && rectContains(mainRect, x, y)) {
      publish({ kind: 'main' })
      return
    }
    // 对话栏条带 = 开签（§6 命中面 2）；其余拒绝
    const hit = strips.find((s) => rectContains(s.rect, x, y))
    publish(hit ? { kind: 'strip', el: hit.el, tabsetId: hit.snap.groupId } : null)
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

      if (commit && hover?.kind === 'main') spec.onCommitMainTab()
      else if (commit && hover?.kind === 'strip') spec.onCommitOpenTab(hover.tabsetId)
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
