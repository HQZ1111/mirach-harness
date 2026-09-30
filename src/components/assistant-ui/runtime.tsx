/**
 * assistant-ui 运行时接入（L1，docs/pi-integration.md §7-3）：
 * ExternalStore 纯渲染 + XState 轮次机唯一真相（§0.2-5 定稿）。
 *
 * 数据流：常驻 EventSource（GET /ag-ui/stream，断线自动带 Last-Event-ID
 * 重连）→ AGUI_EVENT → 轮次机归约 → messages/isRunning 喂 ExternalStore；
 * 发送：POST /ag-ui 起 run（RUN_STARTED 经 SSE 到达后进 streaming 态）。
 */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useActorRef, useSelector } from '@xstate/react'

import { turnMachine, type TurnContext } from './turn-actor'
import { approvalBridge } from './approval-bridge'

const THREAD = 'main'

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
    } as TurnContext,
  })
  const messages = useSelector(actorRef, (s) => s.context.messages)
  const isRunning = useSelector(actorRef, (s) => s.matches('streaming'))

  const [endpoint, setEndpoint] = useState<{ port: number; token: string } | null>(null)
  const endpointRef = useRef(endpoint)
  endpointRef.current = endpoint

  // 端点发现（IPC 主动拉取，避免启动竞态）+ 常驻 SSE 连接。
  // EventSource 断线时浏览器自动带 Last-Event-ID 重连 = 免费续放。
  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false
    void (async () => {
      try {
        const ep = await invoke<{ port: number; token: string }>('get_agui_endpoint')
        if (cancelled) return
        setEndpoint(ep)
        const url = `http://127.0.0.1:${ep.port}/ag-ui/stream?thread=${THREAD}&token=${encodeURIComponent(ep.token)}`
        es = new EventSource(url)
        es.onmessage = (e) => {
          try {
            const parsed = JSON.parse(e.data)
            // 宿主桥门铃（§4.4）：卡片详情以 registry 为真相，经 IPC 拉取
            // 全量挂起列表（重放流不会造成卡片重复）。事件本体照常喂机器。
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
        es.onerror = () => {
          // 浏览器自动重连（带 Last-Event-ID），静默
        }
        // 挂载恢复：页面刷新后拉一次挂起列表（§4.4 pending_approvals）
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
  }, [actorRef])

  const postRun = useCallback((message: string) => {
    const ep = endpointRef.current
    if (!ep) return
    void fetch(`http://127.0.0.1:${ep.port}/ag-ui?token=${encodeURIComponent(ep.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: THREAD, message }),
    }).catch((e) => console.error('[agui] POST 失败', e))
  }, [])

  const runtime = useExternalStoreRuntime({
    convertMessage: (m) => ({ id: m.id, role: m.role, content: m.content }),
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
