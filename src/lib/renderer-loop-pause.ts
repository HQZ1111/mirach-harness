/**
 * 渲染循环暂停控制器（hermes `lib/renderer-loop-pause.ts` 的宿主对偶）。
 *
 * 上游导出 `createRendererLoopPauseController()`：返回一个可被多个 rAF 循环
 * 共享的暂停开关，窗口隐藏时统一暂停、恢复时统一唤醒。
 */

export interface RendererLoopPauseController {
  /** 当前是否暂停。 */
  isPaused: () => boolean
  /** 订阅暂停变化（返回退订）。 */
  subscribe: (handler: (paused: boolean) => void) => () => void
  /** 手动置位（测试/特殊场景用）。 */
  setPaused: (paused: boolean) => void
  /** 释放监听。 */
  dispose: () => void
}

export function isRendererPaused(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

/**
 * 创建共享的暂停控制器。
 *
 * 判据与上游一致：`document.hidden`（窗口最小化/切到后台）。
 * 宿主（WebView2）同样会触发 `visibilitychange`。
 */
export function createRendererLoopPauseController(): RendererLoopPauseController {
  const handlers = new Set<(paused: boolean) => void>()
  let manual: boolean | null = null
  let installed = false

  const current = () => manual ?? isRendererPaused()

  const notify = () => {
    const paused = current()
    for (const handler of handlers) handler(paused)
  }

  const listener = () => {
    // 窗口可见性变化时，手动置位让位给真实状态
    manual = null
    notify()
  }

  const install = () => {
    if (installed || typeof document === 'undefined') return
    installed = true
    document.addEventListener('visibilitychange', listener)
  }

  install()

  return {
    isPaused: current,
    subscribe: (handler) => {
      install()
      handlers.add(handler)
      handler(current())
      return () => handlers.delete(handler)
    },
    setPaused: (paused) => {
      manual = paused
      notify()
    },
    dispose: () => {
      handlers.clear()
      if (installed && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', listener)
      }
      installed = false
    },
  }
}

/** 订阅暂停变化（便捷形式）。 */
export function onRendererPauseChange(handler: (paused: boolean) => void): () => void {
  const controller = createRendererLoopPauseController()
  const off = controller.subscribe(handler)
  return () => {
    off()
    controller.dispose()
  }
}