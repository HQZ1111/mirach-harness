/**
 * 主窗根。窗口分派（main.tsx 的 ?win= 参数）落点：
 *   - 默认 → 本文件 App（主窗壳：app/shell/）
 *   - ?win=quick → app/quick-entry/（骨架已建，待接）
 *   - ?win=hud   → app/hud/（骨架已建，待接）
 */

import { useEffect } from 'react'

import { AppPrefsBoot } from '@/app/app-prefs-boot'
import { EngineBridges } from '@/components/engine-bridges'
import { LaunchOverlay } from '@/components/launch-overlay'
import { StartupConnectionGate } from '@/components/startup-connection-gate'
import { DockviewShell } from '@/components/layout/dockview-shell'
import { TrayBridge } from '@/components/layout/tray-bridge'
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
      {/* 系统托盘动作桥（托盘菜单「新建任务 / 打开工作区」→ 会话面） */}
      <TrayBridge />
      {/* 全局 toast（host.notify / notifyError 的可见面，2026-11-18） */}
      <ToastHost />
      <DockviewShell />
      {/* 启动页（hermes GatewayConnectingOverlay 的宿主移植 + ReactBits
          ParticleText 字标）：冷启动全屏遮挡，引擎就绪后自退场；失败时
          留在原地给错误与「重试」。放在最后 = z-(--z-connecting) 压过壳。 */}
      <LaunchOverlay />
      {/* 启动连接选择（首次启动 / ?setup=1 / 设置页「启动与连接」）：
          本机启动 + 远程连接管理；远程运行面下一阶段接入。 */}
      <StartupConnectionGate />
    </>
  )
}
