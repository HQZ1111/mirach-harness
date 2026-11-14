import type { CSSProperties } from 'react'
import { appWindow, inTauri } from '@/lib/tauri-window'

/** 无边框窗的边缘 resize 手柄（Tauri startResizeDragging；四边离角避圆角） */
// ── 无边框窗的边缘 resize 手柄（用户定稿：四周+四角可拖调宽高）──
// Tauri 原生 startResizeDragging（capabilities 需 allow-start-resize-dragging）。
//
// **落点必须让出透明边距**（2026-10-23）：窗口投影改由 CSS 画之后，窗口矩形
// 四周多了一圈 `--shell-shadow-margin`(40px) 的**透明带**——那里没有可见
// 内容，也没有指针事件目标。手柄若还贴在窗口矩形边上，用户会对着透明空气
// 拖（手感"差 40px"）。所以所有手柄内缩这条边距，贴到壳（可见部分）的边缘。
// 最大化态该令牌被覆盖成 0（base.css），手柄自动回到贴屏边。
//
// 四边手柄离角 56（2026-10-16 阶段 7：壳圆角 40 → 56，离角值同步——手柄
// 压进弧线会盖住圆角本身；值须 ≥ 圆角半径）。
export type ResizeDir = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

/** 手柄到窗口矩形的距离 = 透明边距 + 1（压住壳的第一像素，别留缝）。 */
const EDGE = 'calc(var(--shell-shadow-margin) + 1px)'
/** 离角避让（弧线半径 + 余量），同样叠加边距。 */
const CORNER_INSET = 'calc(var(--shell-shadow-margin) + 56px)'

export const RESIZE_HANDLES: { dir: ResizeDir; style: CSSProperties }[] = [
  { dir: 'North', style: { top: EDGE, left: CORNER_INSET, right: CORNER_INSET, height: 6, cursor: 'ns-resize' } },
  { dir: 'South', style: { bottom: EDGE, left: CORNER_INSET, right: CORNER_INSET, height: 6, cursor: 'ns-resize' } },
  { dir: 'West', style: { left: EDGE, top: CORNER_INSET, bottom: CORNER_INSET, width: 6, cursor: 'ew-resize' } },
  { dir: 'East', style: { right: EDGE, top: CORNER_INSET, bottom: CORNER_INSET, width: 6, cursor: 'ew-resize' } },
  { dir: 'NorthWest', style: { top: EDGE, left: EDGE, width: 16, height: 16, cursor: 'nwse-resize' } },
  { dir: 'NorthEast', style: { top: EDGE, right: EDGE, width: 16, height: 16, cursor: 'nesw-resize' } },
  { dir: 'SouthWest', style: { bottom: EDGE, left: EDGE, width: 16, height: 16, cursor: 'nwse-resize' } },
  { dir: 'SouthEast', style: { bottom: EDGE, right: EDGE, width: 16, height: 16, cursor: 'nwse-resize' } },
]

export function ResizeHandles() {
  if (!inTauri || !appWindow) return null
  return (
    <>
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.dir}
          onPointerDown={(e) => {
            if (e.button !== 0 || !appWindow) return
            e.stopPropagation()
            void appWindow.startResizeDragging(h.dir).catch(() => {})
          }}
          style={{ position: 'fixed', zIndex: 300, ...h.style }}
          className="win-resize-handle"
        />
      ))}
    </>
  )
}

// ── 主组件 ───────────────────────────────────────────────────────────────────
