/**
 * 带预算的 rAF 循环（上游 `createBudgetedLoop`）。
 *
 * ## 语义（与上游一致）
 *
 * - **fps 预算**：按目标帧率节流，不是每个 rAF 都跑（省 CPU）
 * - **idle 判据**：`idleWhen()` 返回 true 时跳过本次 tick（不消耗预算）
 * - **pauseWhenFocused 开关**：失焦可暂停（上游用于波形等非关键动画）
 * - **dispose / wake**：显式生命周期 + 手动唤醒
 *
 * 上游用它驱动头像动画与波形。宿主没有完全相同的实现（`bot-face.tsx` 里
 * 是 `undefined` 降级），这里给一个**真实可用**的实现，让上游代码走完整路径
 * 而不是降级分支。
 */

export interface BudgetedLoopOptions {
  /** 目标帧率（每秒最多跑几次 tick）。 */
  fps?: number
  /** 返回 true 时本次不 tick（省预算）。 */
  idleWhen?: () => boolean
  /** 窗口失焦时是否暂停。 */
  pauseWhenFocused?: boolean
}

export interface BudgetedLoop {
  dispose: () => void
  wake: () => void
}

export function createBudgetedLoop(tick: () => void, options: BudgetedLoopOptions = {}): BudgetedLoop {
  const fps = Math.max(1, options.fps ?? 30)
  const period = 1000 / fps
  let raf = 0
  let last = 0
  let disposed = false

  const step = (now: number) => {
    if (disposed) return
    raf = requestAnimationFrame(step)
    // 失焦暂停
    if (options.pauseWhenFocused === false && typeof document !== 'undefined' && document.hidden) return
    // 预算：未到周期就跳过
    if (now - last < period) return
    // idle 判据
    if (options.idleWhen?.()) return
    last = now
    tick()
  }

  const start = () => {
    if (raf || disposed) return
    raf = requestAnimationFrame(step)
  }

  start()

  return {
    dispose: () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    },
    wake: () => {
      // 手动唤醒：把 last 归零，下一帧必定 tick
      last = 0
      start()
    },
  }
}
