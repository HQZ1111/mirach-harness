/**
 * 触控板手势（hermes `lib/trackpad-gestures.ts`）。
 *
 * 上游识别 pinch / 双指横扫 / smart zoom。宿主保留同形 API，事件源用
 * wheel + ctrlKey（浏览器把 pinch 报成 ctrl+wheel）。
 *
 * 2026-11-16：补齐上游的 `isSmartZoomWheel` / `isPinchZoomWheel` /
 * `createDoubleTapDetector`。hermes-mirror 的 `use-zoom-pan` 直接 import 它们；
 * 缺失会让 vite pre-transform 500，整页白屏。
 */
export type TrackpadGesture = 'pinch-in' | 'pinch-out' | 'swipe-left' | 'swipe-right'

export interface WheelLike {
  ctrlKey: boolean
  deltaX: number
  deltaY: number
}

/** macOS "smart zoom"（双指双击）：ctrl+wheel 且 delta 全 0。 */
export function isSmartZoomWheel(event: WheelLike): boolean {
  return event.ctrlKey && event.deltaX === 0 && event.deltaY === 0
}

/** Pinch-to-zoom（或 ctrl+鼠标滚轮）：ctrl+wheel 且带 delta。 */
export function isPinchZoomWheel(event: WheelLike): boolean {
  return event.ctrlKey && (event.deltaX !== 0 || event.deltaY !== 0)
}

export const DOUBLE_TAP_MS = 300

/**
 * 有状态双击检测（tap-to-click 关闭的触控板可能没有原生 dblclick）。
 * 每次离散点击调用一次；两次点击间隔小于阈值返回 true 并重置。
 */
export function createDoubleTapDetector(
  thresholdMs: number = DOUBLE_TAP_MS,
): (now?: number) => boolean {
  let last = 0
  return (now: number = Date.now()): boolean => {
    if (now - last < thresholdMs) {
      last = 0
      return true
    }
    last = now
    return false
  }
}

export function detectGesture(event: WheelEvent): null | TrackpadGesture {
  if (event.ctrlKey) {
    if (event.deltaX === 0 && event.deltaY === 0) return null
    return event.deltaY < 0 ? 'pinch-out' : 'pinch-in'
  }
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && Math.abs(event.deltaX) > 20) {
    return event.deltaX > 0 ? 'swipe-right' : 'swipe-left'
  }
  return null
}
