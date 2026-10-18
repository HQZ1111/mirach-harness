/**
 * 左栏会话列表（assistant-ui registry ThreadList）+ 上方入口条（hermes
 * SIDEBAR_NAV 照抄——entry-bar.tsx）。AssistantRuntimeProvider 包住整个
 * app-shell（flex-layout.tsx:1830），本组件树内 useAui 合法。
 */
import { ThreadList } from '@/components/thread-list.aui'
import { useAui } from '@assistant-ui/react'

import { EntryBar } from './hub/entry-bar'
import ResourcesDialogHost from './hub/pi-resources-dialog'

export function AssistantSessionsPane() {
  const aui = useAui()
  return (
    <div className="assistant-sessions-pane h-full min-h-0">
      <EntryBar callbacks={{ newThread: () => void aui.threads.switchToNewThread() }} />
      <div className="hub-entry-body">
        <ThreadList />
      </div>
      {/* 「技能与工具」浮层宿主（2026-10-18 修：EntryBar 一直调
          openResourcesDialog()，但这个 Host 从未在任何树里渲染过——store
          改了 open=true 没有消费者，点入口完全没反应）。挂在入口条同一棵
          树内，portal 到 body，与 z 层/层级无关。 */}
      <ResourcesDialogHost />
    </div>
  )
}
