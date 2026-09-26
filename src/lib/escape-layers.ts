/**
 * Ordered Escape ownership for the app's transient window-level layers.
 * 逐字移植 hermes src/lib/escape-layers.ts：多个 transient 层各自绑 window
 * keydown Escape 时，没有共同秩序一次 Esc 会全触发。层只在打开期间注册
 * 优先级（pushEscapeLayer），处理方契约：bail defaultPrevented →
 * bail !isTopEscapeLayer(myPriority) → 处理并 preventDefault。
 */

// Higher number = closer to the user. Gaps leave room to slot new layers.
export const ESCAPE_PRIORITY = {
  layoutEdit: 20,
  zoneEditor: 30,
  overlay: 40,
  // An in-flight pane drag: Esc means "abort the drag", never ALSO exit edit
  // mode / close the overlay the drag started over. Registered only for the
  // drag's few-hundred-ms lifetime (drag-session.ts).
  drag: 50
} as const

const active = new Map<symbol, number>()

/** Register a layer as open; call the returned disposer when it closes. */
export function pushEscapeLayer(priority: number): () => void {
  const key = Symbol('escape-layer')
  active.set(key, priority)

  return () => {
    active.delete(key)
  }
}

/** True when no open layer outranks `priority`, so its handler should act. */
export function isTopEscapeLayer(priority: number): boolean {
  for (const p of active.values()) {
    if (p > priority) {
      return false
    }
  }

  return true
}
