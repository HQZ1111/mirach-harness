/**
 * 会话行左键点击的手势解析（hermes app/chat/sidebar/session-row-gesture.ts
 * 逐字照抄）——纯 resolver，与行组件分离，让"优先级"这个最容易 subtly
 * wrong 的部分可以脱离整栏渲染单测。
 *
 * 优先级 matters：多修饰键手势（⌥+⇧ 归档、⌘/⌃+⇧ 新窗口）都会置 shiftKey，
 * 必须先于单修饰的 ⇧ 置顶（pin）与 ⌘/⌃ 新标签（newTab）判定——先测
 * shiftKey 会把两者都吞进 "pin"。
 *
 * 归档独立于窗口支持（web 嵌入也能用）；只有新窗口手势需要独立窗口，
 * 没有它时 ⌘/⌃+⇧ 落到普通 ⌘/⌃ 新标签行为。
 *
 * harness 消费面：`pin` / `resume` 真实生效；`newTab` / `newWindow` /
 * `archive` 数据面不适用（主会话区单线程投影、pi 无归档），行上按
 * 不适用处置（吞掉默认行为、不乱切换）——见 thread-list.aui.tsx。
 */

export type SessionRowClickAction = 'archive' | 'newTab' | 'newWindow' | 'pin' | 'resume'

export interface SessionRowClickModifiers {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function resolveSessionRowClick(
  { altKey, ctrlKey, metaKey, shiftKey }: SessionRowClickModifiers,
  opts: { canOpenWindow: boolean },
): SessionRowClickAction {
  const primaryModifier = metaKey || ctrlKey

  if (altKey && shiftKey) {
    return 'archive'
  }

  if (primaryModifier && shiftKey && opts.canOpenWindow) {
    return 'newWindow'
  }

  if (primaryModifier) {
    return 'newTab'
  }

  if (shiftKey) {
    return 'pin'
  }

  return 'resume'
}
