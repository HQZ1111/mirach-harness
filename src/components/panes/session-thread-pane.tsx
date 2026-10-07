/**
 * 会话窗格（session-N 页签 / 分栏出的对话分栏，docs/layout-design.md §5）：
 * **自持完整聊天运行时**（v7.4，抄 hermes 会话瓦片）——按 config.threadId
 * 绑定自己的轮次机 + per-thread SSE 流 + 自己的 composer/发送/中断，
 * 不再镜像全局活动会话（并排两个对话分栏各显各的会话、各自收发）。
 *
 * 两态：
 * - threadId === 目录 activeId（该会话就是主会话）→ **live**：复用全局
 *   runtime 的 AssistantThreadPane（与工作区一致——运行时只有一份流，
 *   两个消费者会互抢 per-thread buffer 的单消费配额）；
 * - 否则 → **独立完整聊天**：useThreadChatRuntime（自己的轮次机 +
 *   EventSource ?thread=<sessionId> + 水合 pi_get_session_messages）+
 *   全套 thread.aui Thread（scoped：跳过主会话管理 chrome——检查点/
 *   谱系/队列/成本/中断横幅的桥是主会话单例；消息/composer/思考指示/
 *   建议全部照常）。发送 POST 带 sessionPath（引擎 flush 当前会话切到
 *   本会话再跑，事件落本线程 buffer）。
 */
import { invoke } from '@tauri-apps/api/core'
import { AssistantRuntimeProvider } from '@assistant-ui/react'

import { Thread } from '@/components/thread.aui'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { useThreadChatRuntime } from '@/components/assistant-ui/session-runtime'
import { useSessionManage } from '@/components/panes/session-manage/session-catalog'

export function SessionThreadPane({ threadId, tabName }: { threadId: string; tabName: string }) {
  const activeId = useSessionManage((s) => s.activeId)
  const path = useSessionManage((s) => s.entries[threadId]?.path)
  const live = threadId === activeId

  if (live) return <AssistantThreadPane />

  return <SessionChatPane threadId={threadId} sessionPath={path} tabName={tabName} />
}

function SessionChatPane({
  threadId,
  sessionPath,
  tabName,
}: {
  threadId: string
  sessionPath: string | undefined
  tabName: string
}) {
  const runtime = useThreadChatRuntime({ threadId, sessionPath })
  void tabName
  return (
    <div className="assistant-thread-pane h-full" data-slot="session-thread-pane">
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread scoped />
      </AssistantRuntimeProvider>
    </div>
  )
}
