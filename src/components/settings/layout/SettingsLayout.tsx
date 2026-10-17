import type { ReactNode } from 'react'

import { SettingsLayoutProvider } from './SettingsLayoutContext'
import SettingsSidebar from './SettingsSidebar'

/**
 * Settings 外壳（去 react-router 版，2026-10-17）。
 *
 * 与 openhuman 原版的差异：
 * - `SidebarContent`（把导航投影进 App 根侧栏）→ **本地两栏**：左导航 + 右内容；
 * - `<Outlet />`（路由出口）→ `children`（宿主传入当前面板）。
 *
 * 其余（两栏导航语义、面板自己拥有唯一纵向滚动）保持不变。
 */
const SettingsLayout = ({ children }: { children: ReactNode }) => {
  return (
    <SettingsLayoutProvider value={{ inTwoPaneShell: true }}>
      <div className="flex h-full min-h-0 w-full">
        <aside className="border-border/60 h-full w-56 shrink-0 overflow-hidden border-e">
          <SettingsSidebar />
        </aside>
        {/* 面板区域：唯一纵向滚动（与原版一致——面板自己管滚动） */}
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </div>
    </SettingsLayoutProvider>
  )
}

export default SettingsLayout
