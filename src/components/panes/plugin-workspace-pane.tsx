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
import { ArrowLeftIcon } from 'lucide-react'
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
  const body = (
    <>
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
    </>
  )

  // 群聊的返回按钮在插件自己的 RoomHeader；屏幕页没有，宿主补一个浮层返回钮
  // （2026-11-26 用户："群聊和屏幕也不要有标签，直接给个返回的按钮"）。
  if (!workspaceId.includes(':screen:')) {
    return (
      <div data-panel-id={workspaceId} style={{ display: 'contents' }}>
        {body}
      </div>
    )
  }
  return (
    <div className="relative h-full min-h-0" data-panel-id={workspaceId}>
      <div className="h-full min-h-0">{body}</div>
      <button
        aria-label="返回主对话"
        className="absolute left-2 top-2 z-20 inline-flex items-center gap-1 rounded-md border border-(--stroke-soft) bg-(--surface) px-2 py-1 text-[0.7rem] text-foreground shadow-sm hover:bg-(--hover-wash)"
        data-slot="plugin-workspace-back"
        onClick={() => props.api.close()}
        type="button"
      >
        <ArrowLeftIcon className="size-3.5" />
        返回
      </button>
    </div>
  )
}
