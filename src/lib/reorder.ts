/**
 * THE reorder feel —— 移植 hermes src/lib/reorder.ts 的两个手感调用（拖拽
 * 越槽 tick、落位 confirm pulse；web-haptics 已在 harness 依赖里，hermes
 * 经 registerHapticTrigger 注入，harness 直接持一个共享实例）。
 * glide/rail 的 CSS 过渡参数由 flexlayout 自身的拖影承担，这里只取 haptic。
 */

import { WebHaptics } from 'web-haptics'

const haptics = new WebHaptics()

/** Tick each time the drag crosses into a new slot. */
export const reorderStepHaptic = () => {
  void haptics.trigger([{ duration: 16, intensity: 0.52 }])?.catch(() => undefined)
}

/** Satisfying confirm on a committed reorder. */
export const reorderCommitHaptic = () => {
  void haptics
    .trigger([
      { duration: 28, intensity: 0.5 },
      { delay: 42, duration: 30, intensity: 0.68 },
      { delay: 48, duration: 38, intensity: 0.86 }
    ])
    ?.catch(() => undefined)
}
