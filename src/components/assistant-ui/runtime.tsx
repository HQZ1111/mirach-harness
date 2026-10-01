/**
 * assistant-ui 运行时接入（L1，docs/pi-integration.md §7-3）：
 * ExternalStore 纯渲染 + XState 轮次机唯一真相（§0.2-5 定稿）。
 *
 * 数据流：常驻 EventSource（GET /ag-ui/stream，断线自动带 Last-Event-ID
 * 重连）→ AGUI_EVENT → 轮次机归约 → messages/isRunning 喂 ExternalStore；
 * 发送：POST /ag-ui 起 run（RUN_STARTED 经 SSE 到达后进 streaming 态）。
 * 会话列表（§7-4）：threadListAdapter 接 pi SessionIndex——threadId =
 * pi 会话 id，切换 = pi_open_session + HYDRATE 注入历史（真相在 pi）。
 */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useActorRef, useSelector } from '@xstate/react'

import { turnMachine, type TurnContext, type TurnMessage, type TurnPart } from './turn-actor'
import { approvalBridge } from './approval-bridge'
import { usageBridge, type UsageState } from './usage-bridge'

const THREAD = 'main'

/** pi SessionIndex 行（pi_list_sessions 返回，字段对齐上游 SessionMeta） */
interface PiSessionMeta {
  path: string
  id: string
  cwd: string
  timestamp: string
  messageCount: number
  lastModifiedMs: number
  sizeBytes: number
  name: string | null
}

interface ThreadListRow {
  status: 'regular'
  id: string
  title?: string
  custom?: Record<string, unknown>
}

/** 渲染错误兜底：归约链路的任何意外不得白屏整个应用（只隔离聊天树）。 */
class RuntimeBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-sm text-(--text-3)">
          聊天渲染出错：{String(this.state.error.message ?? this.state.error)}
        </div>
      )
    }
    return this.props.children
  }
}

export function AssistantRuntime({ children }: { children: ReactNode }) {
  const actorRef = useActorRef(turnMachine, {
    input: {
      messages: [],
      currentRunId: null,
      lastEventId: 0,
      error: null,
      usage: null,
    } as TurnContext,
  })
  const messages = useSelector(actorRef, (s) => s.context.messages)
  const isRunning = useSelector(actorRef, (s) => s.matches('streaming'))
  const usage = useSelector(actorRef, (s) => s.context.usage)
  useEffect(() => {
    usageBridge.getState().setUsage(usage as UsageState | null)
  }, [usage])

  const [endpoint, setEndpoint] = useState<{ port: number; token: string } | null>(null)
  const endpointRef = useRef(endpoint)
  endpointRef.current = endpoint

  // ── 会话列表（§7-4 侧栏 sessions）——threadId = pi 会话 id（与
  // pi_get_state.sessionId 同源），path 存 custom 供打开/删除使用。
  // 必须声明在挂载 effect 之前（effect 依赖数组 render 期求值，TDZ）。──
  const [threads, setThreads] = useState<ThreadListRow[]>([])
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const threadsRef = useRef<ThreadListRow[]>([])
  threadsRef.current = threads

  const refreshThreads = useCallback(async () => {
    try {
      const metas = await invoke<PiSessionMeta[]>('pi_list_sessions')
      setThreads(
        (metas ?? []).map((m) => ({
          status: 'regular' as const,
          id: m.id,
          title: m.name ?? undefined,
          custom: { path: m.path, messageCount: m.messageCount, lastModifiedMs: m.lastModifiedMs },
        })),
      )
    } catch (e) {
      console.error('[pi] 会话列表读取失败', e)
    }
  }, [])

  /** pi Message JSON → 聊天投影（真相在 pi）：
   * - assistant：content blocks → parts（text/toolCall）；
   * - toolResult：结果归并到前一条 assistant 匹配 toolCallId 的部件
   *   （孤儿结果跳过——无宿主消息可挂）；
   * - user：string/blocks → 纯文本。
   * id 用 hydrate 序号（pi AssistantMessage 无 id/timestamp，须稳定）。 */
  const hydratePiMessages = useCallback(
    (history: Record<string, unknown>[]): TurnMessage[] => {
      const out: TurnMessage[] = []
      for (let i = 0; i < history.length; i++) {
        const m = history[i] as {
          role?: string
          content?: unknown
          toolCallId?: string
          toolName?: string
          isError?: boolean
        }
        if (m.role === 'user') {
          const c = m.content
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c
                    .map((b) =>
                      typeof b === 'string'
                        ? b
                        : typeof (b as { text?: unknown })?.text === 'string'
                          ? (b as { text: string }).text
                          : '',
                    )
                    .join('')
                : ''
          out.push({ id: `hydrate-${i}-user`, role: 'user', content: text })
        } else if (m.role === 'assistant') {
          const blocks = Array.isArray(m.content) ? m.content : []
          const parts: TurnPart[] = []
          for (const b of blocks) {
            const blk = b as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }
            if (blk.type === 'text' && typeof blk.text === 'string') {
              parts.push({ type: 'text', text: blk.text })
            } else if (blk.type === 'toolCall' && typeof blk.id === 'string') {
              parts.push({
                type: 'tool-call',
                toolCallId: blk.id,
                toolName: blk.name ?? '',
                args:
                  blk.arguments && typeof blk.arguments === 'object' && !Array.isArray(blk.arguments)
                    ? (blk.arguments as Record<string, unknown>)
                    : undefined,
              })
            }
            // thinking/redacted_thinking/media：MVP 不渲染（等 reasoning 面）
          }
          out.push({ id: `hydrate-${i}-assistant`, role: 'assistant', content: parts })
        } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
          // 工具结果归并：挂到前一条 assistant 匹配 toolCallId 的部件
          const resultBlocks = Array.isArray(m.content) ? m.content : []
          const resultText = resultBlocks
            .map((b) =>
              typeof b === 'string'
                ? b
                : typeof (b as { text?: unknown })?.text === 'string'
                  ? (b as { text: string }).text
                  : '',
            )
            .join('')
          for (let j = out.length - 1; j >= 0; j--) {
            const msg = out[j]
            if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
            const parts = msg.content as TurnPart[]
            const idx = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === m.toolCallId)
            if (idx >= 0) {
              const p = parts[idx]
              if (p.type !== 'tool-call') continue
              parts[idx] = { ...p, result: resultText, isError: m.isError === true }
              break
            }
          }
          // 孤儿 toolResult（无匹配部件）：跳过
        }
      }
      return out
    },
    [],
  )

  // 端点发现（IPC 主动拉取，避免启动竞态）+ 常驻 SSE 连接。
  // EventSource 断线时浏览器自动带 Last-Event-ID 重连 = 免费续放。
  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false
    const onMessage = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data)
        // 审批请求进流（§4.4 prescribed：ExtensionUiRequest → CUSTOM
        // 常驻流——不是被删的 Tauri Event 门铃，零新增通道）：卡片详情
        // 以 Rust 端 ApprovalRegistry 为真相，经 IPC 拉取全量挂起列表
        // （重放流不会造成卡片重复）。事件本体照常喂机器。
        if (parsed?.type === 'CUSTOM' && parsed?.name === 'extension_ui_request') {
          approvalBridge
            .getState()
            .refresh()
            .catch((err) => console.error('[pi] 审批列表拉取失败', err))
        }
        actorRef.send({
          type: 'AGUI_EVENT',
          event: parsed as { type: string } & Record<string, unknown>,
          id: Number(e.lastEventId || 0),
        })
      } catch (err) {
        console.error('[agui] 事件解析失败', err)
      }
    }
    void (async () => {
      try {
        const ep = await invoke<{ port: number; token: string }>('get_agui_endpoint')
        if (cancelled) return
        setEndpoint(ep)
        // 挂载水合（§7-4 多会话）：历史真相在 pi（pi_get_messages 水合），
        // 流游标从缓冲最新 seq 起——跳过重放，避免混入其它会话的旧事件。
        // 之后断线重连由浏览器带最后收到的 Last-Event-ID 正常续放。
        let url = `http://127.0.0.1:${ep.port}/ag-ui/stream?thread=${THREAD}&token=${encodeURIComponent(ep.token)}`
        try {
          const cursor = await invoke<number>('pi_stream_cursor')
          url += `&lastEventId=${cursor}`
        } catch (e) {
          console.error('[pi] 流游标获取失败（保留全量重放连接）', e)
        }
        es = new EventSource(url)
        es.onmessage = onMessage
        es.onerror = () => {
          // 浏览器自动重连（带 Last-Event-ID），静默
        }
        // 会话列表 + 当前线程 id（threadId 与 pi sessionId 同源）
        await refreshThreads()
        try {
          const st = await invoke<{ sessionId: string | null }>('pi_get_state')
          setCurrentThreadId(st.sessionId)
          if (st.sessionId) {
            const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
            actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
          }
        } catch {
          // 无活跃会话：threadId 置空 = ThreadList 高亮 New Chat
          setCurrentThreadId(null)
        }
        // 审批挂起列表（§4.4 挂载拉取）
        approvalBridge
          .getState()
          .refresh()
          .catch((err) => console.error('[pi] 审批列表拉取失败', err))
      } catch (e) {
        console.error('[agui] endpoint 获取失败（应用重启中？）', e)
      }
    })()
    return () => {
      cancelled = true
      es?.close()
    }
  }, [actorRef, refreshThreads, hydratePiMessages])

  const postRun = useCallback((message: string) => {
    const ep = endpointRef.current
    if (!ep) return
    void fetch(`http://127.0.0.1:${ep.port}/ag-ui?token=${encodeURIComponent(ep.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: THREAD, message }),
    }).catch((e) => console.error('[agui] POST 失败', e))
  }, [])

  const switchToThread = useCallback(
    async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法打开`)
        return
      }
      await invoke('pi_open_session', { path })
      const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
      actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
      setCurrentThreadId(id)
      await refreshThreads()
    },
    [hydratePiMessages, refreshThreads],
  )

  const threadListAdapter = {
    threadId: currentThreadId ?? undefined,
    threads,
    onSwitchToNewThread: async () => {
      // New Chat：flush 旧会话落盘 + 清 handle（不立即建空会话文件），
      // 下一次发送按需创建全新会话
      await invoke('pi_discard_session')
      actorRef.send({ type: 'RESET' })
      setCurrentThreadId(null)
      await refreshThreads()
    },
    onSwitchToThread: async (id: string) => {
      await switchToThread(id)
    },
    onRename: async (id: string, newTitle: string) => {
      if (id !== currentThreadId) {
        // SDK 语义：set_session_name 只作用于当前会话
        console.error('[pi] 仅当前活跃会话支持重命名')
        return
      }
      await invoke('pi_rename_session', { name: newTitle })
      await refreshThreads()
    },
    onDelete: async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法删除`)
        return
      }
      await invoke('pi_delete_session', { path })
      await refreshThreads()
    },
    onArchive: async () => {
      console.error('[pi] 会话归档未实现（pi 无 archive 概念）')
    },
  }

  const runtime = useExternalStoreRuntime({
    // threadListAdapter 必须放 adapters.threadList（core 的
    // getThreadListAdapter 只读 store.adapters?.threadList；顶层平铺无效）
    adapters: { threadList: threadListAdapter },
    // TurnPart 与 ThreadMessageLikePart 的 tool-call 形状对齐；args 的
    // Record<string, unknown> 运行时即 JSON 对象（pi arguments Value），断言
    convertMessage: (m) => ({
      id: m.id,
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) =>
              p.type === 'tool-call'
                ? { ...p, args: p.args as never, result: p.result as never }
                : p,
            ),
    }),
    messages,
    isRunning,
    onNew: async (m) => {
      const raw = m.content
      const text = (typeof raw === 'string' ? raw : raw.map((c) => (c.type === 'text' ? c.text : '')).join('')).trim()
      if (!text) return
      // 错误即错误：endpoint 未就绪直接抛错——消息不装作已发送
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪，消息未发送')
      actorRef.send({ type: 'USER_SUBMIT', text, messageId: `user-${Date.now()}` })
      postRun(text)
      // 首条消息触发会话创建 → 线程列表出现当前会话
      void refreshThreads()
    },
    onCancel: async () => {
      // §4.5：abort 是控制操作走 IPC；阻塞中的 prompt 观察 abort 信号收尾
      try {
        await invoke('pi_interrupt')
      } catch (e) {
        console.error('[agui] interrupt 失败', e)
      }
    },
  })

  return (
    <RuntimeBoundary>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeBoundary>
  )
}
