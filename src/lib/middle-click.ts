/**
 * 中键点击辅助（hermes `lib/middle-click.ts` 的宿主对偶）。
 *
 * 上游除了 `isMiddleClick`，还导出：
 *
 * - `isMetaClose(event)` —— Cmd/Ctrl + 中键 = 「关闭」语义（标签页）
 * - `middleClickHandlers(onClose)` —— 生成一组可直接展开到元素的 handler
 *   （`pane-tab.tsx` 依赖它做「中键关闭标签」）
 */

/** 是否是中键点击。 */
export function isMiddleClick(event: MouseEvent): boolean {
  return event.button === 1
}

/**
 * 是否「带修饰键的中键」= 关闭语义。
 *
 * 上游：macOS 上 Cmd+中键、其它平台 Ctrl+中键，都表示「关闭而不只是激活」。
 */
export function isMetaClose(event: MouseEvent): boolean {
  return isMiddleClick(event) && (event.metaKey || event.ctrlKey)
}

/** 给元素挂中键处理（返回退订）。 */
export function onMiddleClick(el: HTMLElement, handler: (event: MouseEvent) => void): () => void {
  const listener = (event: MouseEvent) => {
    if (!isMiddleClick(event)) return
    event.preventDefault()
    handler(event)
  }
  el.addEventListener('auxclick', listener)
  return () => el.removeEventListener('auxclick', listener)
}

/**
 * 生成可展开的 handler 集合（上游 `middleClickHandlers`）。
 *
 * 用法：`<button {...middleClickHandlers(close)} />`
 */
export function middleClickHandlers(onClose: () => void): {
  onAuxClick: (event: React.MouseEvent) => void
} {
  return {
    onAuxClick: (event) => {
      // React 的 SyntheticEvent 上 button=1 即中键
      if (event.button !== 1) return
      event.preventDefault()
      onClose()
    },
  }
}