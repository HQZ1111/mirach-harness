/** 主对话栏（workspace）：assistant-ui registry Thread（消息流 + composer）。
 *  + MainTint 调色层（v6.0 语义 v8.0 回迁：面板内子元素绝对定位铺满——
 *  原宿主叠片方案在 dockview 下退役）。 */
import { Thread } from '@/components/thread.aui'
import { MainTint } from '@/components/layout/main-tint'

export function AssistantThreadPane() {
  return (
    <div className="assistant-thread-pane">
      <MainTint />
      <Thread />
    </div>
  )
}
