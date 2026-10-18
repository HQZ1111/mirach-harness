/**
 * 分组收起的延迟提交（2026-10-18，用户报"展开有动画、收起直接消失"）。
 *
 * ## 为什么收起不能只靠 CSS
 *
 * 会话行的可见性由 `buildSessionDisplay` 的数据管线决定：桶收起 = 行被
 * `hideCollapsedGroupRows` **整行滤掉**——React 同步卸载，CSS 动画没有
 * 机会播完。展开方向之所以有动画，是因为"展开 = 行重新挂载"，挂载即播
 * 的 animation 正好卡在唯一时序点上（见 thread-list.aui.tsx 的 justExpanded）。
 *
 * ## 做法
 *
 * 点击收起时**先不动 store**：把桶 key 放进 `closing` 集合，行仍按展开态
 * 渲染、但带上收起动画类（`disclose-row--closing`，见 ui-primitives.css）；
 * 动画播完（与 --disclose-dur 同值）再真正调 setGroupCollapsed。这样行在
 * 动画期间一直在 DOM 里，CSS 有时间把它压回去。
 *
 * ## 为什么是模块级单例
 *
 * 四个分组头（段头 SectionHeader / 日期桶 / 工作区桶 / 状态桶）是**独立
 * 组件**，不在 ThreadListSections 的作用域里，无法共享它的 hooks。用
 * 模块级 store（与 sessionCatalog 同款模式）让"谁触发"和"谁渲染行"解耦：
 * 头部调用 `requestGroupToggle`，列表订阅 `useCollapsingGroups` 拿集合。
 *
 * 竞态：动画期间又点展开 → 取消计时器、清标记、不提交（保持展开）；
 * 动画期间连点收起 → 第二次直接忽略（幂等）。
 */
import { useSyncExternalStore } from 'react'

import { sessionCatalog } from './session-catalog'

/** 与 ui-primitives.css 的 --disclose-out-dur 同值（改一处改两处）。 */
const COLLAPSE_MS = 160
/** 收起逐行步进（ui-primitives.css 的 --disclose-out-index × 8ms 同值）。 */
const COLLAPSE_STAGGER_MS = 8
/** 兜底上限：行数再多也不等太久（超出部分靠 CSS 的 forwards 收尾，
 *  反正提交那一刻整片就卸载了，不需要每行都播完）。 */
const COLLAPSE_MAX_WAIT_MS = 360

let closing: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const timers = new Map<string, number>()

/** 每个桶收起的等待时长。**必须覆盖逐行步进**（2026-10-18 实锤）：
 *  退场动画 = 220ms 时长 + (n-1)×30ms 延迟。若只等 220ms 就提交，最后几行
 *  在延迟期里就被卸载了——用户看到的仍是"部分行直接消失"。 */
const waitMsFor = (rowCount: number): number =>
  Math.min(
    COLLAPSE_MS + Math.max(0, rowCount - 1) * COLLAPSE_STAGGER_MS,
    COLLAPSE_MAX_WAIT_MS,
  )

const emit = (next: ReadonlySet<string>): void => {
  closing = next
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const getSnapshot = (): ReadonlySet<string> => closing

/** 正在播收起动画的桶（列表用它给行挂退场动画类）。 */
export const useCollapsingGroups = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

/** 分组头的统一开关（延迟提交）。`collapsed` = 当前是否已收起。
 *  `rowCount` = 将被收起的行数（决定逐行步进要等多久；缺省按 1 行算）。 */
export const requestGroupToggle = (
  key: string,
  collapsed: boolean,
  rowCount = 1,
): void => {
  const pending = timers.get(key)
  if (pending !== undefined) {
    // 收起动画进行中：
    // - 再点收起 → 幂等忽略（那次提交会落地）
    // - 点展开 → 反悔：取消提交、撤动画，停在展开态
    if (collapsed) return
    window.clearTimeout(pending)
    timers.delete(key)
    if (closing.has(key)) {
      const next = new Set(closing)
      next.delete(key)
      emit(next)
    }
    return
  }
  // 展开（或收起一个本来就展示着的桶）：展开立即提交，无延迟。
  if (!collapsed) {
    sessionCatalog.getState().setGroupCollapsed(key, false)
    return
  }
  const reduce =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    sessionCatalog.getState().setGroupCollapsed(key, true)
    return
  }
  emit(new Set(closing).add(key))
  const timer = window.setTimeout(() => {
    timers.delete(key)
    if (closing.has(key)) {
      const next = new Set(closing)
      next.delete(key)
      emit(next)
    }
    sessionCatalog.getState().setGroupCollapsed(key, true)
  }, waitMsFor(rowCount))
  timers.set(key, timer)
}

export const DEFERRED_COLLAPSE_MS = COLLAPSE_MS
