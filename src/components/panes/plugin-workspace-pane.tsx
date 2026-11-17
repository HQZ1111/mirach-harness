/**
 * 插件工作区窗格 —— `host.openWorkspace` 开出的主区标签页内容宿主。
 *
 * 渲染面从 `plugin-workspaces.ts` 的记录表取（`render` 是插件闭包，进不了
 * 布局存档）；Providers 与 PluginPane 同源（插件的 i18n / TanStack Query）。
 *
 * **重启恢复的孤儿面板**由 shell 在 fromJSON 之后统一剪除
 * （`pruneOrphanWorkspacePanels`）——**不要**在本组件里调 `api.close()`：
 * mount effect 撞上布局恢复会抛 dockview "invalid operation"（实测把聊天区
 * 带崩）。本组件在记录缺席时只渲染 null，等 boot 剪枝。
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'

import { I18nProvider } from '@/hermes-mirror/i18n'
import { ContribBoundary } from '@/hermes-shim/contrib/react/contrib-boundary'
import { queryClient } from '@/hermes-shim/lib/query-client'
import {
  pluginWorkspaceRecord,
  pluginWorkspacesVersion,
  subscribePluginWorkspaces,
} from '@/components/layout/plugin-workspaces'

import { hostLocale } from './plugin-pane'

export function PluginWorkspacePane(props: IDockviewPanelProps<{ workspaceId?: string }>) {
  const workspaceId = props.params?.workspaceId ?? ''
  useSyncExternalStore(subscribePluginWorkspaces, pluginWorkspacesVersion, pluginWorkspacesVersion)
  const record = pluginWorkspaceRecord(workspaceId)

  if (!record) return null
  return (
    <div data-panel-id={workspaceId} style={{ display: 'contents' }}>
      {/* 上游 workspace 的可见性探针按 `plugin-workspace:<id>` 查（插件
          GroupChatMainView：`host.paneVisibility(\`plugin-workspace:${ID}:group:…\`)`）。
          宿主 dockview 面板 id 是 `<id>`，这里补一个同层标记，否则插件面永远
          认为自己在屏外、不读数据（实测：群聊房间卡在"正在加载群组…"）。 */}
      <span data-panel-id={`plugin-workspace:${workspaceId}`} style={{ display: 'contents' }} />
      <QueryClientProvider client={queryClient}>
        <I18nProvider configClient={null} initialLocale={hostLocale()}>
          {record.render ? (
            <ContribBoundary id={workspaceId}>{record.render()}</ContribBoundary>
          ) : null}
        </I18nProvider>
      </QueryClientProvider>
    </div>
  )
}
