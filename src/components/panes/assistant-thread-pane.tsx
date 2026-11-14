/** 主对话栏（workspace）：列头（工作区名/会话名双行块）+ assistant-ui
 *  registry Thread（消息流 + composer）。
 *
 *  列头 = ChatTabLabel（v8 布局定稿"工作区名=容器子元素"回迁）——嵌在
 *  75px 顶带区域内（与左栏 logo 同高带，水平对齐语义不变）；flex 纵排：
 *  列头在上、Thread 吃剩余高度。
 *  2026-10-19 三栏卡片化：卡片（.dv-groupview）给白底。
 *  2026-10-21：调色层（MainTint）整体删除（用户："颜色层不要了，直接删除"）
 *  ——组件文件、`.main-tint` 规则、`--main-tint-*` 令牌一并撤除。
 */
import { Thread } from '@/components/thread.aui'
import { ChatTabLabel } from '@/components/layout/chat-tab-label'
import { ConversationStatusPanel } from '@/components/assistant-ui/conversation-status-panel'

export function AssistantThreadPane() {
  return (
    <div className="assistant-thread-pane">
      <ChatTabLabel />
      <Thread />
      <ConversationStatusPanel />
    </div>
  )
}
