/**
 * A flat, pointer-following drag chip — the shared "what am I holding"
 * affordance for in-app pointer drags. 逐字移植 hermes src/lib/drag-ghost.ts：
 * 纯 DOM（无 React）——pointer-capture 拖拽期间不重渲染，Esc 中止同步拆除。
 */

/** How far (px) the chip trails the pointer so it never sits under the cursor. */
const OFFSET_X = 14
const OFFSET_Y = 12

export interface DragGhost {
  /** Reposition the chip near the current pointer point. */
  moveTo(x: number, y: number): void
  /** Remove the chip from the DOM. Idempotent. */
  destroy(): void
}

export function createDragGhost(label: string): DragGhost {
  const el = document.createElement('div')

  el.textContent = label
  el.style.cssText =
    'position:fixed;left:0;top:0;z-index:9999;pointer-events:none;max-width:16rem;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap;padding:0.25rem 0.625rem;opacity:0.6;' +
    'background:#1a1a22;color:#e6e6ea;' +
    'font-size:0.75rem;font-weight:500;font-family:inherit;will-change:transform'
  document.body.appendChild(el)

  return {
    moveTo(x, y) {
      el.style.transform = `translate3d(${x + OFFSET_X}px, ${y + OFFSET_Y}px, 0)`
    },
    destroy() {
      el.remove()
    }
  }
}
