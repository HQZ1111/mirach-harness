/**
 * 上游 SDK 的能力面板导出（`CapabilitiesView` / `ConnectorsTab` /
 * `ToolsetConfigPanel`）——hermes-bots 的编辑机器人对话框把这些当
 * "宿主原生能力面"直接嵌入（`profile-config.tsx` 的 feature-detect）。
 *
 * 宿主对偶 = `src/hermes-mirror/app/capabilities/**` 的上游原件（与「技能与
 * 工具」页同一棵树，95 文件逐字复制 + `hermes-shim` 数据桥）。它们需要三样
 * 上下文，插件对话框里没有 App 根：
 *   1. 宿主桥（`window.hermesDesktop.api` → pi IPC）——`ensureCapabilitiesWiring`；
 *   2. TanStack Query（上游页面所有的数据钩子）——shim 的单例 queryClient；
 *   3. I18nProvider（语言 = 宿主偏好）。
 *
 * `supportsFixedConnection` 静态标记让插件把 `fixedConnection` 传给组件
 * （`profile-config.tsx::capabilitiesViewRoutesConnections`）——宿主单连接，
 * 标记照上游打上；host.getGateway() 为 null 时各 Tab 走 bridge 的默认路由。
 */

import type { ComponentProps, ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

import { I18nProvider } from '@/hermes-mirror/i18n'
import { CapabilitiesView as UpstreamCapabilitiesView } from '@/hermes-mirror/app/capabilities'
import { ConnectorsTab as UpstreamConnectorsTab } from '@/hermes-mirror/app/capabilities/connectors/connectors-tab'
import { ToolsetConfigPanel as UpstreamToolsetConfigPanel } from '@/hermes-mirror/app/settings/toolset-config-panel'
import { queryClient } from '@/hermes-shim/lib/query-client'
import { ensureCapabilitiesWiring } from '@/components/panes/capabilities-pane'

function hostLocale(): 'en' | 'zh' {
  try {
    return new URLSearchParams(window.location.search).get('lang') === 'en' ||
      localStorage.getItem('mirach:locale') === 'en'
      ? 'en'
      : 'zh'
  } catch {
    return 'zh'
  }
}

function HostSurface({ children }: { children: ReactNode }) {
  ensureCapabilitiesWiring()
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale={hostLocale()}>
        {children}
      </I18nProvider>
    </QueryClientProvider>
  )
}

type UpstreamCapabilitiesProps = ComponentProps<typeof UpstreamCapabilitiesView>
type UpstreamConnectorsProps = ComponentProps<typeof UpstreamConnectorsTab>
type UpstreamToolsetProps = ComponentProps<typeof UpstreamToolsetConfigPanel>

/** 上游 `CapabilitiesView`（`app/capabilities/index.tsx`）。 */
export function CapabilitiesView(props: UpstreamCapabilitiesProps) {
  return (
    <HostSurface>
      <UpstreamCapabilitiesView {...props} />
    </HostSurface>
  )
}
CapabilitiesView.supportsFixedConnection = true as const

/** 上游 `ConnectorsTab`（managed apps / MCP 服务器管理）。 */
export function ConnectorsTab(props: UpstreamConnectorsProps) {
  return (
    <HostSurface>
      <UpstreamConnectorsTab {...props} />
    </HostSurface>
  )
}

/** 上游 `ToolsetConfigPanel`（工具集配置面板）。 */
export function ToolsetConfigPanel(props: UpstreamToolsetProps) {
  return (
    <HostSurface>
      <UpstreamToolsetConfigPanel {...props} />
    </HostSurface>
  )
}
