/**
 * 主窗根。窗口分派（main.tsx 的 ?win= 参数）落点：
 *   - 默认 → 本文件 App（主窗壳：app/shell/）
 *   - ?win=quick → app/quick-entry/（骨架已建，待接）
 *   - ?win=hud   → app/hud/（骨架已建，待接）
 */

import { AppPrefsBoot } from '@/app/app-prefs-boot'
import { DockviewShell } from '@/components/layout/dockview-shell'

export function App() {
  return (
    <>
      {/* 应用级偏好守卫（F12 拦截 / 外链外部打开）：不渲染 UI，只装监听。 */}
      <AppPrefsBoot />
      <DockviewShell />
    </>
  )
}
