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
import { useEffect, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'

import { Thread } from '@/components/thread.aui'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { ErrorState } from '@/components/assistant-ui/elements/error-state'
import { useThreadChatRuntime } from '@/components/assistant-ui/session-runtime'
import { useSessionManage } from '@/components/panes/session-manage/session-catalog'

export function SessionThreadPane({ threadId, tabName }: { threadId: string; tabName: string }) {
  const activeId = useSessionManage((s) => s.activeId)
  const catalogPath = useSessionManage((s) => s.entries[threadId]?.path)
  const [fallbackPath, setFallbackPath] = useState<string | null>(null)
  const [resolveFailed, setResolveFailed] = useState(false)
  const live = threadId === activeId

  // 非目录会话（插件 `host.openSession(intent:'tab')` 开出的隐藏 bot 会话/
  // 群成员会话不在侧栏目录）：按 id 从 pi 会话面补路径——pi_get_session_messages
  // 与 POST sessionPath 都要真路径，缺路径 = 水合空、发送 400（agui 对非
  // main 线程强制要求 sessionPath；不静默落主会话）。
  useEffect(() => {
    if (live || catalogPath || resolveFailed) return
    let dead = false
    void (async () => {
      try {
        const list = await invoke<{ id: string; path: string }[]>('pi_list_sessions')
        let hit = list.find((r) => r.id === threadId)?.path ?? null
        if (!hit) {
          const index = await invoke<{ sessions?: { id: string; path: string }[] }>(
            'pi_sessions_index',
          )
          hit = index?.sessions?.find((r) => r.id === threadId)?.path ?? null
        }
        if (dead) return
        if (hit) {
          setFallbackPath(hit)
        } else {
          // 死会话（文件已删/工作区已清）：**不挂 runtime**——空 runtime +
          // SSE 到不存在的线程会引发 React hooks 崩溃链（01a1ebc6 实测），
          // 改为可见错误（规矩 12）。
          setResolveFailed(true)
          console.error(`[session-pane] 会话 ${threadId} 既不在目录也不在 pi 索引——无法定位`)
        }
      } catch (e) {
        if (!dead) console.error('[session-pane] 会话路径解析失败', e)
      }
    })()
    return () => {
      dead = true
    }
  }, [live, catalogPath, threadId, resolveFailed])

  if (live) return <AssistantThreadPane />

  // 解析确认的死会话：可见错误，不挂 runtime
  if (resolveFailed && !catalogPath && !fallbackPath) {
    return (
      <div className="assistant-thread-pane h-full" data-slot="session-thread-pane">
        <ErrorState
          className="m-3"
          data-slot="session-pane-dead-bar"
          detail={`会话 ${threadId} 的文件不存在（已删除或工作区已清空）——此窗格无法打开`}
          retrying={false}
          title="会话不存在"
        />
      </div>
    )
  }

  return (
    <SessionChatPane
      threadId={threadId}
      sessionPath={catalogPath ?? fallbackPath ?? undefined}
      tabName={tabName}
    />
  )
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
  const { runtime, error } = useThreadChatRuntime({ threadId, sessionPath })
  void tabName
  return (
    <div
      className="assistant-thread-pane relative h-full"
      data-slot="session-thread-pane"
    >
      <AssistantRuntimeProvider runtime={runtime}>
        {/* 分栏/机器人聊天失败可见（主 runtime 的 RUN_ERROR 走全局 error 桥；
            本窗格的轮次机错误只在这里，没有这段 = 失败静默，规矩 12）。
            **浮层而不是文档流**（2026-11-25 用户："机器人页的错误提示卡会把
            内容挤到下面"）：absolute 在对话区顶部，错误出现/消失不再改变
            Thread 的可用高度，也不推动消息与输入框。 */}
        {error ? (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center">
            <ErrorState
              className="pointer-events-auto shadow-lg"
              data-slot="session-run-error-bar"
              detail={String(error)}
              retrying={false}
              title="运行出错"
            />
          </div>
        ) : null}
        <Thread scoped sessionId={threadId} />
      </AssistantRuntimeProvider>
    </div>
  )
}
