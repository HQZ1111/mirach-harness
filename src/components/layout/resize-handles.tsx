import type { CSSProperties } from 'react'
import { appWindow, inTauri } from '@/lib/tauri-window'

/** 无边框窗的边缘 resize 手柄（Tauri startResizeDragging；四边离角 50 避圆角） */
// ── 无边框窗的边缘 resize 手柄（用户定稿：四周+四角可拖调宽高）──
// Tauri 原生 startResizeDragging（capabilities 需 allow-start-resize-dragging）。
// 四边手柄离角 50（用户：避开 50px 圆角区域；四角归 16px 角手柄管）。
export type ResizeDir = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'
export const RESIZE_HANDLES: { dir: ResizeDir; style: CSSProperties }[] = [
  { dir: 'North', style: { top: 0, left: 50, right: 50, height: 6, cursor: 'ns-resize' } },
  { dir: 'South', style: { bottom: 0, left: 50, right: 50, height: 6, cursor: 'ns-resize' } },
  { dir: 'West', style: { left: 0, top: 50, bottom: 50, width: 6, cursor: 'ew-resize' } },
  { dir: 'East', style: { right: 0, top: 50, bottom: 50, width: 6, cursor: 'ew-resize' } },
  { dir: 'NorthWest', style: { top: 0, left: 0, width: 16, height: 16, cursor: 'nwse-resize' } },
  { dir: 'NorthEast', style: { top: 0, right: 0, width: 16, height: 16, cursor: 'nesw-resize' } },
  { dir: 'SouthWest', style: { bottom: 0, left: 0, width: 16, height: 16, cursor: 'nesw-resize' } },
  { dir: 'SouthEast', style: { bottom: 0, right: 0, width: 16, height: 16, cursor: 'nwse-resize' } },
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
