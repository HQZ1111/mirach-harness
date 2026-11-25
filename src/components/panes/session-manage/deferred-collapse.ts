/**
 * 分组开关（会话侧栏的段头/日期桶/工作区桶/状态桶共用入口）。
 *
 * **2026-11-25 用户两轮定稿**：
 * 1. "折叠和打开选项的动画组件，就是慢慢展开的那个，删除改回默认的"——
 *    2026-10-18 的逐行 40ms/8ms 步进（deferred-collapse 的 stagger 计时 +
 *    `.disclose-row` 的 `--disclose-index`）整体删除；
 * 2. "默认也加个过渡，默认太生硬了"——保留**一个**轻量过渡：展开时行淡入
 *    上移 160ms、收起时行淡出 120ms 再提交（无逐行步进、无逐桶计数）。
 *
 * 收起仍需延迟提交：行的可见性由 `buildSessionDisplay` 的数据管线决定
 * （收起 = 行被整行滤掉，React 同步卸载，CSS 没有机会播完）——先把桶 key
 * 放进 `closing` 集合、120ms 后真正写 store。
 *
 * 模块级单例：四个分组头是独立组件，共享不到 ThreadListSections 的 hooks
 * ——头部调 `requestGroupToggle`，列表订阅 `useCollapsingGroups` /
 * `useJustExpandedGroups` 给行挂类。
 */
import { useSyncExternalStore } from 'react'

import { sessionCatalog } from './session-catalog'

/** 收起过渡时长（与 ui-primitives.css 的 --disclose-out-dur 同值）。 */
const COLLAPSE_MS = 120
/** 展开标记存活时长（动画 160ms，留 60ms 余量避免重渲染时闪烁）。 */
const EXPAND_FLASH_MS = 220

let closing: ReadonlySet<string> = new Set()
let expanded: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const timers = new Map<string, number>()
let expandTimer: number | null = null

const emit = (): void => {
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 正在播收起过渡的桶（列表用它给行挂 `.disclose-row--closing`）。 */
export const useCollapsingGroups = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => closing, () => closing)

/** 刚刚展开的桶（行重新挂载时挂 `.disclose-row` 播一次淡入）。 */
export const useJustExpandedGroups = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => expanded, () => expanded)

/** 分组头的统一开关（`collapsed` = 目标状态）。 */
export const requestGroupToggle = (key: string, collapsed: boolean): void => {
  if (!collapsed) {
    // 展开：立即提交；打一个短标记让挂载的行播一次入场过渡。
    const pending = timers.get(key)
    if (pending !== undefined) {
      window.clearTimeout(pending)
      timers.delete(key)
      closing = new Set([...closing].filter((k) => k !== key))
    }
    sessionCatalog.getState().setGroupCollapsed(key, false)
    expanded = new Set(expanded).add(key)
    if (expandTimer === null) {
      expandTimer = window.setTimeout(() => {
        expandTimer = null
        expanded = new Set()
        emit()
      }, EXPAND_FLASH_MS)
    }
    emit()
    return
  }
  // 收起：已经在收集中 → 幂等；否则挂退场类，120ms 后提交。
  if (timers.has(key)) return
  closing = new Set(closing).add(key)
  emit()
  const timer = window.setTimeout(() => {
    timers.delete(key)
    closing = new Set([...closing].filter((k) => k !== key))
    emit()
    sessionCatalog.getState().setGroupCollapsed(key, true)
  }, COLLAPSE_MS)
  timers.set(key, timer)
}
