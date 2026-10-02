/**
 * 左栏会话列表（assistant-ui registry ThreadList）+ 上方入口条（hermes
 * SIDEBAR_NAV 照抄——entry-bar.tsx）。AssistantRuntimeProvider 包住整个
 * app-shell（flex-layout.tsx:1830），本组件树内 useAui 合法。
 */
import { ThreadList } from '@/components/thread-list.aui'
import { useAui } from '@assistant-ui/react'

import { EntryBar } from './hub/entry-bar'

export function AssistantSessionsPane() {
  const aui = useAui()
  return (
    <div className="assistant-sessions-pane h-full min-h-0">
      <EntryBar callbacks={{ newThread: () => void aui.threads.switchToNewThread() }} />
      <div className="hub-entry-body">
        <ThreadList />
      </div>
    </div>
  )
}
