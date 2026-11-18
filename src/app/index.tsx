/**
 * 主窗根。窗口分派（main.tsx 的 ?win= 参数）落点：
 *   - 默认 → 本文件 App（主窗壳：app/shell/）
 *   - ?win=quick → app/quick-entry/（骨架已建，待接）
 *   - ?win=hud   → app/hud/（骨架已建，待接）
 */

import { useEffect } from 'react'

import { AppPrefsBoot } from '@/app/app-prefs-boot'
import { EngineBridges } from '@/components/engine-bridges'
import { DockviewShell } from '@/components/layout/dockview-shell'
import { ToastHost } from '@/components/motion/toast-host'
import { reapStaleTerminals } from '@/components/panes/terminal/terminal-pty'
import { inTauri } from '@/lib/tauri-window'

export function App() {
  // 页面加载即回收本窗口上一代页面遗留的终端 PTY（reload / HMR 后旧页面
  // 已发不出 kill；不回收会一路占住会话登记——2026-11-18 用户报的
  // "上限 8 打不开"根因）。失败可见，不让 boot 静默带僵尸会话。
  useEffect(() => {
    if (!inTauri) return
    reapStaleTerminals().catch((err) => console.error('[terminal] 回收遗留会话失败:', err))
  }, [])

  return (
    <>
      {/* 应用级偏好守卫（F12 拦截 / 外链外部打开）：不渲染 UI，只装监听。 */}
      <AppPrefsBoot />
      {/* 引擎侧宿主桥（message_agent 投递 / 审批卡） */}
      <EngineBridges />
      {/* 全局 toast（host.notify / notifyError 的可见面，2026-11-18） */}
      <ToastHost />
      <DockviewShell />
    </>
  )
}
