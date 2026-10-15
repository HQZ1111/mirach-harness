/** 主对话栏（workspace）：列头（工作区名/会话名双行块）+ assistant-ui
 *  registry Thread（消息流 + composer）+ MainTint 调色层。
 *
 *  列头 = ChatTabLabel（v8 布局定稿"工作区名=容器子元素"回迁；原
 *  ChatLabelOverlay 宿主叠片随 M1 换壳丢失）——嵌在 85px 顶带区域内
 *  （与左栏 logo 同高带，水平对齐语义不变）；flex 纵排：列头在上、
 *  Thread 吃剩余高度。MainTint 调色层仍为面板内子元素绝对定位铺满
 *  （贴边语义见 panes.css）。 */
import { Thread } from '@/components/thread.aui'
import { MainTint } from '@/components/layout/main-tint'
import { ChatTabLabel } from '@/components/layout/chat-tab-label'

export function AssistantThreadPane() {
  return (
    <div className="assistant-thread-pane">
      <MainTint />
      <ChatTabLabel />
      <Thread />
    </div>
  )
}
