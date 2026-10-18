/**
 * 遮罩式弹层的进场/退场（2026-10-18，用户报"弹窗只有输入框的模型有效果，
 * 其他弹窗都没生效"）。
 *
 * 覆盖 `.set-overlay` 家族：设置浮层 / 技能与工具 / 机器人编辑 / pi 资源。
 * 这些浮层此前**没有任何动画规则**——挂载即硬出现、卸载即硬消失。
 *
 * ## 为什么退场不能用 CSS transition
 *
 * 退出 = 从树上卸载。React 卸载是同步的，CSS 动画没有机会播完（节点没了）。
 * 必须让"要关闭"与"真的卸载"分开：调用方把 `closing` 置位 → 播退场动画 →
 * 到点再卸载。`useOverlayExit` 就是这段编排（与 presence-gate 同一思路，
 * 但这里不需要 AnimatePresence——浮层只有一个根节点、无兄弟参与布局）。
 *
 * 用法（三个消费方同形）：
 *   const { closing, requestClose } = useOverlayExit(onClose)
 *   <div className={`set-overlay${closing ? ' set-overlay--closing' : ''}`}
 *        onClick={requestClose}> ... </div>
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 退场时长（与 ui-primitives.css 的 --overlay-exit-dur 同值；改一处改两处）。 */
const EXIT_MS = 160

export function useOverlayExit(onClose: () => void): {
  closing: boolean
  requestClose: () => void
} {
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const closedRef = useRef(false)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const requestClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    // 减少动效偏好：不播退场，直接关（系统级要求必须真的停）。
    const reduce =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      onClose()
      return
    }
    setClosing(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      onClose()
    }, EXIT_MS)
  }, [onClose])

  return { closing, requestClose }
}

export const OVERLAY_EXIT_MS = EXIT_MS
