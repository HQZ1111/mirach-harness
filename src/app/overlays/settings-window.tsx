/**
 * 设置独立窗口的根组件（`?win=settings`，2026-10-23）。
 *
 * ## 与浮层版的差别
 *
 * 浮层版（`SettingsOverlay` 默认 `variant="overlay"`）是 portal 到 body 的
 * 模态：遮罩 + 点遮罩关闭 + Esc 关闭 + 退场动画。独立窗口里这些**全部不
 * 需要**——窗口本身就是"模态"，没有遮罩可点。
 *
 * 所以本组件传 `variant="window"`：内容树完全共用（左栏 + 右栏 + inset 头 +
 * 4 个真实节 + 16 个占位节 + 写盘队列），外壳换成"铺满窗口"。
 * **不另写一份面板**——两份必然漂移。
 *
 * ## 拖窗（无边框窗必须有）
 *
 * 主窗靠 `dockview-shell.tsx` 的 `pointerdown` 捕获段（`e.clientY <=
 * TOP_BAND_PX` 时 `startDragging`）。设置窗没有 dockview，故在此自己挂一段：
 * 落点在 `.set-nav-head` / `.set-inset-head`（两个 48px 空白带）→ 拖窗；
 * 落在按钮上 → 交给按钮（不拖）。双击同主窗语义 = 最大化/还原。
 */

import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { SettingsOverlay } from '@/app/overlays/settings-overlay'
import { ResizeHandles } from '@/components/layout/resize-handles'
import { appWindow } from '@/lib/tauri-window'
import { useMaximized } from '@/lib/use-maximized'

export function SettingsWindowRoot() {
  // 最大化态 → `html[data-maximized]`：CSS 靠它把圆角/投影/透明边距清零。
  // 设置窗没有控件圆点，此前没人写这个属性 → 最大化后仍留 40px 边距和
  // 35px 圆角，贴屏边看着像"窗口缩了一圈"（2026-10-24 修）。
  useMaximized()

  useEffect(() => {
    const win = appWindow
    if (!win) return

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target
      if (!(t instanceof Element)) return
      // 按钮/输入归原主（✕、下拉、textarea 都不是拖窗区）
      if (t.closest('button, input, textarea, select, a')) return
      // 只有两个 48px 头是拖窗区（与主窗"顶带才拖窗"同一语义）
      if (t.closest('.set-nav-head, .set-inset-head') === null) return
      e.preventDefault()
      if (e.detail === 2) {
        void win.toggleMaximize().catch((err) => {
          console.error('[settings-window] 最大化切换失败', err)
        })
        return
      }
      void win.startDragging().catch((err) => {
        console.error('[settings-window] 拖窗失败', err)
      })
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  return (
    <div className="settings-window-root">
      {/* 边缘 resize 手柄（2026-10-24 用户："设置页也加个左右上下能拖动
          调整宽度和高度的，现在只有顶部有手柄"）。
          与主窗同一个组件：四边 + 四角，落点已内缩 --shell-shadow-margin
          （贴壳的可见边缘，不是窗口矩形的透明带）。最大化态该令牌被覆盖
          成 0，手柄自动回到贴屏边。
          没有它的时候：无边框窗（decorations:false）在设置窗上失去了系统
          边缘拖拽，而这里又只有 `.set-nav-head` / `.set-inset-head` 的拖窗
          带——用户只能拖位置，改不了尺寸。 */}
      <ResizeHandles />
      <SettingsOverlay
        onClose={() => {
          // Rust 侧真关窗（CloseAction::Destroy）。失败必须可见（铁律 12）：
          // 不吞错——窗还在，用户会以为按钮坏了，至少 console 能看到原因。
          void invoke('pi_close_settings_window').catch((e) => {
            console.error('[settings-window] 关窗失败', e)
          })
        }}
        variant="window"
      />
    </div>
  )
}
