/**
 * 指针跟随拖拽 chip（hermes drag-ghost.ts 逐字移植，2026-10-16）——共享的
 * 「手里拿着什么」可供性：会话条拖出分栏时鼠标上不能是空的（用户点名
 * "鼠标上是空的，没有显示会话条被拖出"）。
 *
 * **扁平设计**（hermes 原文：solid app surface with the dragged item's
 * label, no border / radius / shadow, dimmed——它**复制被拖的行/页签本身**
 * 而不是读作一个独立 pill）。指针右下 14/12px 跟随，纯 DOM（无 React）：
 * pointer-capture 拖拽期间不重渲染、Esc 同步销毁。
 *
 * 历史（为什么此前没有）：2026-10-05 用户嫌黑底白字 chip 丑（dce9abf
 * 删链）——那次的样式是深底浅字（#1a1a22/#e6e6ea）。hermes 的**正确**
 * 形状是侧栏表面色 + 正文色（不是黑底白字）：本移植用 harness 令牌
 * --surface/--text（同一语义链），观感 = 行被"拎起来"。
 */

/** 与指针的偏移（px），chip 不压在光标下（hermes 逐字值）。 */
const OFFSET_X = 14
const OFFSET_Y = 12

export interface DragGhost {
  /** 把 chip 钉到当前指针点附近。 */
  moveTo(x: number, y: number): void
  /** 从 DOM 移除。幂等。 */
  destroy(): void
}

export function createDragGhost(label: string): DragGhost {
  const el = document.createElement('div')

  el.textContent = label
  // hermes 逐字 cssText；色值走 harness 令牌（--surface=侧栏表面，
  // --text=正文色——hermes 的 --ui-sidebar-surface-background/--ui-text-
  // primary 同链对位）。无描边/无圆角/无阴影 = hermes 扁平纪律。
  el.style.cssText =
    'position:fixed;left:0;top:0;z-index:9999;pointer-events:none;max-width:16rem;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;padding:0.25rem 0.625rem;opacity:0.6;' +
    'background:var(--surface,var(--dt-card));color:var(--text);' +
    'font-size:0.75rem;font-weight:500;will-change:transform;box-shadow:var(--shadow-pop)'
  document.body.appendChild(el)

  return {
    moveTo(x, y) {
      el.style.transform = `translate3d(${x + OFFSET_X}px, ${y + OFFSET_Y}px, 0)`
    },
    destroy() {
      el.remove()
    },
  }
}
