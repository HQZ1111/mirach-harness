/** 主对话栏（workspace）：assistant-ui registry Thread（消息流 + composer）。 */
import { Thread } from '@/components/thread.aui'

export function AssistantThreadPane() {
  return (
    <div className="assistant-thread-pane">
      <Thread />
    </div>
  )
}
