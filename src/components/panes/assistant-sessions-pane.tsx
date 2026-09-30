/** 左栏会话列表：assistant-ui registry ThreadList（会话侧栏）。 */
import { ThreadList } from '@/components/thread-list.aui'

export function AssistantSessionsPane() {
  return (
    <div className="assistant-sessions-pane h-full min-h-0">
      <ThreadList />
    </div>
  )
}
