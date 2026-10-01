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
import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
} from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useActorRef, useSelector } from '@xstate/react'
import { useStore } from 'zustand'

import { turnMachine, type TurnContext, type TurnMessage, type TurnPart } from './turn-actor'
import { approvalBridge } from './approval-bridge'
import {
  branchBridge,
  parseForkPoints,
  type ForkRequest,
  type OpenParentRequest,
  type SwitchRequest,
} from './branch-store'
import { connectionBridge } from './connection-store'
import { errorBridge } from './error-bridge'
import { usageBridge, type UsageState } from './usage-bridge'

const THREAD = 'main'

/** POST /ag-ui 图片契约白名单（png/jpeg/webp/gif） */
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** POST body images[] 条目（纯 base64，不带 data: 前缀） */
interface PiImagePayload {
  data: string
  mimeType: string
}

/** data URL → {data: 纯 base64, mimeType}；白名单外/形状不符返回 null，
 * 调用方 console.error 后跳过（渲染选择非吞错） */
const parseImageDataUrl = (url: string): PiImagePayload | null => {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url)
  return m ? { mimeType: m[1]!, data: m[2]! } : null
}

/** 图片附件适配器：accept 收窄到 POST 契约白名单——白名单外的文件在
 * 选择器/拖放层就被拒，不会进入 composer（禁止兜底的前置闸门） */
class PiImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  override accept = 'image/png,image/jpeg,image/webp,image/gif'
}

/** 模块级单例：adapter 实例稳定，避免 runtime 每次渲染重建 */
const imageAttachmentAdapter: AttachmentAdapter = new PiImageAttachmentAdapter()

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
      compaction: null,
      interrupted: false,
    } as TurnContext,
  })
  const messages = useSelector(actorRef, (s) => s.context.messages)
  const isRunning = useSelector(actorRef, (s) => s.matches('streaming'))
  const usage = useSelector(actorRef, (s) => s.context.usage)
  useEffect(() => {
    usageBridge.getState().setUsage(usage as UsageState | null)
  }, [usage])
  // RUN_ERROR 用户可见面（§0.3 错误即错误）：轮次机 context.error 经桥
  // 传给 thread.aui 的错误条——机器在下一个 run 的 RUN_STARTED 归约里
  // 清 error，错误条随之消失。桥不持真相（真相在轮次机 context）。
  const runError = useSelector(actorRef, (s) => s.context.error)
  useEffect(() => {
    errorBridge.getState().setError(runError)
  }, [runError])
  // thread.state 透传（s.thread.state）：压缩横幅 / 中断态的机器投影——
  // 与 usageBridge/errorBridge 不同，这两个只在 thread.aui 消费，直接走
  // adapter 的 state 通道，不再加桥（真相仍在轮次机 context）
  const compaction = useSelector(actorRef, (s) => s.context.compaction)
  const interrupted = useSelector(actorRef, (s) => s.context.interrupted)

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
   * - assistant：content blocks → parts（text/toolCall/image）；
   * - toolResult：结果归并到前一条 assistant 匹配 toolCallId 的部件
   *   （孤儿结果跳过——无宿主消息可挂）；
   * - user：string/blocks（text/image）→ 投影。
   * pi Message 带 timestamp（i64，epoch ms）→ createdAt（day-separator 用）；
   * id 用 hydrate 序号（pi 消息无稳定 id 字段，须自造稳定键）。 */
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
          timestamp?: unknown
        }
        const createdAt =
          typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
            ? new Date(m.timestamp)
            : undefined
        if (m.role === 'user') {
          // user 内容块严格映射：text 拼接、image（白名单内）→ data URL
          // image part；其余形状 console.error 可见并跳过该块（渲染选择
          // 非吞错——单块异常不拖垮整个会话水合）
          const blocks =
            typeof m.content === 'string'
              ? [m.content]
              : Array.isArray(m.content)
                ? m.content
                : []
          const parts: TurnPart[] = []
          let textBuf = ''
          const flushText = () => {
            if (textBuf) parts.push({ type: 'text', text: textBuf })
            textBuf = ''
          }
          for (const b of blocks) {
            if (typeof b === 'string') {
              textBuf += b
              continue
            }
            const blk = b as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
            if (typeof blk?.text === 'string') {
              textBuf += blk.text
              continue
            }
            if (
              blk?.type === 'image' &&
              typeof blk.data === 'string' &&
              typeof blk.mimeType === 'string' &&
              IMAGE_MIME_WHITELIST.has(blk.mimeType)
            ) {
              flushText()
              parts.push({ type: 'image', image: `data:${blk.mimeType};base64,${blk.data}` })
              continue
            }
            console.error('[pi] 历史 user 消息存在未识别/白名单外内容块——跳过', blk)
          }
          flushText()
          const content: string | TurnPart[] =
            parts.length === 0 ? '' : parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts
          out.push({ id: `hydrate-${i}-user`, role: 'user', content, ...(createdAt ? { createdAt } : {}) })
        } else if (m.role === 'assistant') {
          const blocks = Array.isArray(m.content) ? m.content : []
          const parts: TurnPart[] = []
          for (const b of blocks) {
            const blk = b as { type?: string; text?: string; id?: string; name?: string; arguments?: unknown; data?: unknown; mimeType?: unknown }
            if (blk.type === 'text' && typeof blk.text === 'string') {
              parts.push({ type: 'text', text: blk.text })
            } else if (blk.type === 'image' && typeof blk.data === 'string' && typeof blk.mimeType === 'string') {
              if (IMAGE_MIME_WHITELIST.has(blk.mimeType)) {
                parts.push({ type: 'image', image: `data:${blk.mimeType};base64,${blk.data}` })
              } else {
                console.error(`[pi] 历史 assistant 图片块 mime ${blk.mimeType} 不在白名单——跳过`)
              }
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
          out.push({ id: `hydrate-${i}-assistant`, role: 'assistant', content: parts, ...(createdAt ? { createdAt } : {}) })
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
  // dropped 相（浏览器放弃自动重连）的手动 Reconnect：connectionBridge
  // requestReconnect 递增 reconnectSeq → 本 effect 重跑（cleanup close 旧
  // 连接 → 端点重发现 + 历史水合 + 会话列表重拉，幂等）。
  const reconnectSeq = useStore(connectionBridge, (s) => s.reconnectSeq)
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
          if (cancelled) return
          url += `&lastEventId=${cursor}`
        } catch (e) {
          console.error('[pi] 流游标获取失败（保留全量重放连接）', e)
        }
        if (cancelled) return
        es = new EventSource(url)
        es.onmessage = onMessage
        // 连接态投影（L1 可见性，四相见 connection-store）：onopen 置
        // online；onerror 按 readyState 区分重试中（CONNECTING，自动重连
        // 进行中）与 dropped（CLOSED，浏览器放弃）——真相在 EventSource。
        es.onopen = () => {
          connectionBridge.getState().setConnected(true)
        }
        es.onerror = (e) => {
          console.error('[agui] SSE 连接错误', e)
          // readyState：CONNECTING = 自动重试中；CLOSED = 浏览器放弃（dropped）
          const source = e.target as EventSource
          connectionBridge.getState().setDisconnected(source.readyState === EventSource.CLOSED)
        }
        // 会话列表 + 当前线程 id（threadId 与 pi sessionId 同源）
        await refreshThreads()
        if (cancelled) return
        try {
          const st = await invoke<{ sessionId: string | null }>('pi_get_state')
          if (cancelled) return
          setCurrentThreadId(st.sessionId)
          if (st.sessionId) {
            const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
            if (cancelled) return
            actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
          }
        } catch (e) {
          // 区分"正常无会话"（pi_get_state 报 no active session——首启预期
          // 域状态：threadId 置空 = ThreadList 高亮 New Chat）与真错误
          // （mutex 中毒/pi 内部错误）：真错误保持当前状态并 console 可见，
          // 不伪装"无会话"（禁止兜底）。泄漏路径的 es 由 cleanup close。
          if (String(e).includes('no active session')) {
            setCurrentThreadId(null)
          } else {
            console.error('[runtime] hydrate 失败', e)
          }
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
  }, [actorRef, refreshThreads, hydratePiMessages, reconnectSeq])

  const postRun = useCallback((message: string, images?: PiImagePayload[]) => {
    const ep = endpointRef.current
    if (!ep) return
    void fetch(`http://127.0.0.1:${ep.port}/ag-ui?token=${encodeURIComponent(ep.token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 契约：{threadId, message, images?: [{data: 纯base64, mimeType}]}；
      // 无图片不带 images 键
      body: JSON.stringify({
        threadId: THREAD,
        message,
        ...(images && images.length > 0 ? { images } : {}),
      }),
    })
      .then((res) => {
        // 错误即错误：非 2xx 不装作已发送——状态码可见并抛出
        if (!res.ok) throw new Error(`POST /ag-ui 失败: ${res.status}`)
      })
      .catch((e) => console.error('[agui] POST 失败', e))
  }, [])

  /** 最后一条 user 消息（TurnMessage 形）——onReload 重发文本的来源 */
  const lastUserMessage = useCallback((): TurnMessage | null => {
    const msgs = actorRef.getSnapshot().context.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'user') return msgs[i]!
    }
    return null
  }, [actorRef])

  /** run 进行中先中断（照抄 switchToThread 守卫）：prompt 持锁跨整个 run，
   * 不先 pi_interrupt 重发会撞锁失败；中断失败返回 false，调用方不动状态 */
  const interruptIfRunning = useCallback(async (): Promise<boolean> => {
    if (!actorRef.getSnapshot().matches('streaming')) return true
    try {
      await invoke('pi_interrupt')
      console.info('[pi] run 进行中：已中断当前 run 后继续（prompt 持锁跨整个 run）')
      return true
    } catch (e) {
      console.error('[pi] 中断当前 run 失败——取消本次操作', e)
      return false
    }
  }, [actorRef])

  // ── 分支桥请求执行器（fork / 兄弟分支切换）──────────────────────────
  // UI（thread.aui）经 branch-store 投递请求，这里订阅串行执行——fork/switch
  // 都要动活动会话（重水合走 actorRef + hydratePiMessages，currentThreadId/
  // 线程列表只在 runtime 手里）。branchBusy 串行锁：进行中收到新请求
  // drop + console.error（可见，不排队装作已受理）；handledBranchSeq 防
  // StrictMode 双 effect 对同一请求重复执行。

  /** fork 执行（「从此分支探索」）：守卫 → fork 点 index 映射 →
   * pi_fork_session → 采纳新会话（HYDRATE 重水合——switchToThread 同款
   * 通道，messages/currentRunId/error/usage/compaction/interrupted 随
   * HYDRATE 整体重置；lastEventId 是流游标不属会话态，照旧不动）→
   * currentThreadId 切新会话 + 线程列表刷新 → composer 预填 selectedText
   * → 分支条刷新。任一步失败 console.error 并中止（不动本地状态）。 */
  const runFork = useCallback(
    async (req: ForkRequest) => {
      // 守卫：run 进行中先中断（照抄 switchToThread/onEdit——fork 与
      // prompt 同抢会话锁）
      if (!(await interruptIfRunning())) return
      // fork 点清单 + index 映射：thread 第 N 条 user 消息 = 清单第 N 项
      // （同源水合+流式追加按序对应）。清单解析失败/越界 = 该消息尚未
      // 落盘（fork 点只在已水合历史上有）；text 不匹配 = 投影与 pi 路径
      // 漂移。二者都 fail loud 中止。
      let points: ReturnType<typeof parseForkPoints>
      try {
        points = parseForkPoints(await invoke<unknown>('pi_get_fork_points'))
      } catch (e) {
        console.error('[pi] fork 点清单获取失败——fork 取消', e)
        return
      }
      const point = points[req.userOrdinal]
      if (!point) {
        console.error(
          `[pi] fork：第 ${req.userOrdinal} 条 user 消息没有对应 fork 点（越界——该消息尚未落盘或清单形状非法）——fork 取消`,
        )
        return
      }
      if (point.text !== req.expectText) {
        console.error(
          `[pi] fork：fork 点文本与 thread 投影不匹配（index=${req.userOrdinal}）——fork 取消`,
        )
        return
      }
      let forked: { path: string; sessionId: string; selectedText: string }
      try {
        forked = await invoke<{ path: string; sessionId: string; selectedText: string }>(
          'pi_fork_session',
          { entryId: point.entryId },
        )
      } catch (e) {
        console.error('[pi] fork 失败（保持当前会话）', e)
        return
      }
      if (
        typeof forked?.sessionId !== 'string' ||
        typeof forked?.selectedText !== 'string'
      ) {
        console.error('[pi] fork 返回形状非法——不采纳新会话', forked)
        return
      }
      // 采纳新会话：重水合 + currentThreadId 切换 + 线程列表刷新
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
        setCurrentThreadId(forked.sessionId)
        await refreshThreads()
      } catch (e) {
        console.error('[pi] fork 后重水合失败（新会话未采纳，可从侧栏手动打开）', e)
        void refreshThreads()
        return
      }
      // composer 预填 selectedText：上游语义——选中的 user 消息不进新文件，
      // 用户重新提交即开新分支。重水合成功才预填。
      branchBridge.getState().setComposerPrefill(forked.selectedText)
      // 分支条刷新（新会话的分支态）
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydratePiMessages, interruptIfRunning, refreshThreads],
  )

  /** 分支切换执行：守卫 → pi_switch_branch（服务端切叶）→ 重拉
   * pi_get_messages 重水合（契约：切叶后必须重水合）→ 分支条刷新。
   * threadId 不变（同一会话文件内换叶）。失败 console.error 不动本地态。 */
  const runSwitch = useCallback(
    async (req: SwitchRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_switch_branch', { leafId: req.leafId })
      } catch (e) {
        console.error('[pi] 分支切换失败（保持当前分支）', e)
        return
      }
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
      } catch (e) {
        console.error('[pi] 分支切换后重水合失败（服务端已切叶，可重试切换恢复）', e)
        return
      }
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydratePiMessages, interruptIfRunning],
  )

  /** 会话线「回到父会话」执行：守卫 → pi_open_session(路径)（返回新活动
   * 会话 id）→ 重水合 + currentThreadId + 线程列表刷新 → 分支条刷新。
   * 失败 console.error 不动本地态。 */
  const runOpenParent = useCallback(
    async (req: OpenParentRequest) => {
      if (!(await interruptIfRunning())) return
      let sessionId: string
      try {
        sessionId = await invoke<string>('pi_open_session', { path: req.path })
      } catch (e) {
        console.error('[pi] 回到父会话失败（保持当前会话）', e)
        return
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        console.error('[pi] open_session 返回形状非法——不采纳', sessionId)
        return
      }
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
        setCurrentThreadId(sessionId)
        await refreshThreads()
      } catch (e) {
        console.error('[pi] 回到父会话后重水合失败（服务端已切换，可从侧栏手动打开）', e)
        void refreshThreads()
        return
      }
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydratePiMessages, interruptIfRunning, refreshThreads],
  )

  const forkRequest = useStore(branchBridge, (s) => s.forkRequest)
  const switchRequest = useStore(branchBridge, (s) => s.switchRequest)
  const openParentRequest = useStore(branchBridge, (s) => s.openParentRequest)
  const branchBusyRef = useRef(false)
  const handledBranchSeqRef = useRef(0)

  useEffect(() => {
    if (!forkRequest || forkRequest.seq <= handledBranchSeqRef.current) return
    if (branchBusyRef.current) {
      console.error('[pi] fork/分支操作进行中——忽略新 fork 请求', forkRequest)
      branchBridge.getState().clearForkRequest(forkRequest.seq)
      return
    }
    handledBranchSeqRef.current = forkRequest.seq
    branchBusyRef.current = true
    void runFork(forkRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearForkRequest(forkRequest.seq)
    })
  }, [forkRequest, runFork])

  useEffect(() => {
    if (!switchRequest || switchRequest.seq <= handledBranchSeqRef.current) return
    if (branchBusyRef.current) {
      console.error('[pi] fork/分支操作进行中——忽略新分支切换请求', switchRequest)
      branchBridge.getState().clearSwitchRequest(switchRequest.seq)
      return
    }
    handledBranchSeqRef.current = switchRequest.seq
    branchBusyRef.current = true
    void runSwitch(switchRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearSwitchRequest(switchRequest.seq)
    })
  }, [switchRequest, runSwitch])

  useEffect(() => {
    if (
      !openParentRequest ||
      openParentRequest.seq <= handledBranchSeqRef.current
    )
      return
    if (branchBusyRef.current) {
      console.error(
        '[pi] fork/分支操作进行中——忽略新「回到父会话」请求',
        openParentRequest,
      )
      branchBridge.getState().clearOpenParentRequest(openParentRequest.seq)
      return
    }
    handledBranchSeqRef.current = openParentRequest.seq
    branchBusyRef.current = true
    void runOpenParent(openParentRequest).finally(() => {
      branchBusyRef.current = false
      branchBridge.getState().clearOpenParentRequest(openParentRequest.seq)
    })
  }, [openParentRequest, runOpenParent])

  // run 收尾（streaming → idle 迁移）刷新分支数据：user 消息落盘后才成为
  // fork 点（「从此分支探索」钮可用性依赖 forkPoints 新鲜）。挂载跳过
  // （SessionLineBar 挂载已拉一次）。
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true
      return
    }
    if (!wasRunningRef.current) return
    wasRunningRef.current = false
    branchBridge.getState().requestRefresh()
  }, [isRunning])

  // onEdit（§数据面契约 pi_retry_edit）：准备最后一个可重试 user turn 的
  // 兄弟分支，重发 = 之后一次普通 POST。成功后把编辑文本经 USER_SUBMIT
  // 进投影（乐观用户消息——否则编辑后的文本在扁平投影里不可见），再 POST。
  const onEdit = useCallback(
    async (m: AppendMessage) => {
      const raw = m.content
      const text = (
        typeof raw === 'string' ? raw : raw.map((c) => (c.type === 'text' ? c.text : '')).join('')
      ).trim()
      if (!text) throw new Error('[pi] 编辑后消息为空，未发送')
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪，消息未发送')
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_retry_edit')
      } catch (e) {
        // 失败 console.error 不动状态（重试分支未建立，POST 不发）
        console.error('[pi] retry_edit 失败——编辑未生效', e)
        return
      }
      actorRef.send({ type: 'USER_SUBMIT', text, messageId: `user-edit-${Date.now()}` })
      postRun(text)
      void refreshThreads()
      // retry_edit 已建兄弟分支——分支条/fork 点刷新
      branchBridge.getState().requestRefresh()
    },
    [actorRef, interruptIfRunning, postRun, refreshThreads],
  )

  // onReload（重新生成最后一条 assistant 回复）：同样守卫 → pi_retry_edit
  // → 取最后一条 user 消息文本重发。只支持最后 turn：parentId 非 null 且
  // 不是最后一条 user 消息（= 用户点了旧 assistant 的 Reload）时 fail loud
  // 拒绝——兄弟分支历史重建不做（诚实暴露，不硬做）。modelOverride：本版
  // core 的 StartRunConfig 无该字段（0.12 改名 runConfig.custom），两处都
  // 探测，存在则先 pi_set_model 成功再重发。
  const onReload = useCallback(
    async (
      parentId: string | null,
      // StartRunConfig 的结构超集（本版 core 无 modelOverride 字段——
      // 0.12 起挪进 runConfig.custom；两处都探测，兼容任务契约的旧位）
      config: {
        parentId?: string | null
        runConfig?: { custom?: Record<string, unknown> }
        modelOverride?: string
      },
    ) => {
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪')
      const lastUser = lastUserMessage()
      if (!lastUser || typeof lastUser.content !== 'string') {
        console.error('[pi] reload：没有可重发的 user 文本消息——忽略')
        return
      }
      if (parentId !== null && parentId !== lastUser.id) {
        console.error(
          `[pi] reload：只支持重新生成最后一条回复（parentId=${parentId}，最后 user 消息=${lastUser.id}）——历史 turn 重刷未支持`,
        )
        return
      }
      const modelOverride =
        config.modelOverride ??
        (typeof config.runConfig?.custom?.modelOverride === 'string'
          ? config.runConfig.custom.modelOverride
          : undefined)
      if (modelOverride) {
        const idx = modelOverride.indexOf('/')
        if (idx <= 0) {
          console.error(`[pi] reload：modelOverride 形状非法（${modelOverride}）——忽略`)
          return
        }
        try {
          await invoke('pi_set_model', {
            provider: modelOverride.slice(0, idx),
            modelId: modelOverride.slice(idx + 1),
          })
        } catch (e) {
          console.error(`[pi] reload：pi_set_model ${modelOverride} 失败——未重发`, e)
          return
        }
      }
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_retry_edit')
      } catch (e) {
        console.error('[pi] retry_edit 失败——重发取消', e)
        return
      }
      postRun(lastUser.content)
      void refreshThreads()
      // retry_edit 已建重试分支——分支条/fork 点刷新
      branchBridge.getState().requestRefresh()
    },
    [interruptIfRunning, lastUserMessage, postRun, refreshThreads],
  )

  const switchToThread = useCallback(
    async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法打开`)
        return
      }
      // 流式中切换（§4.5）：prompt 持锁跨整个 run（RUN_FINISHED/ERROR 才
      // 释放），不先中断 open_session 会撞锁失败——先 pi_interrupt 再切；
      // 中断失败保持当前会话（不更新本地态，禁止假装切换成功）。
      if (actorRef.getSnapshot().matches('streaming')) {
        try {
          await invoke('pi_interrupt')
          console.info('[pi] run 进行中：已中断当前 run 后切换会话（prompt 持锁跨整个 run）')
        } catch (e) {
          console.error('[pi] 中断当前 run 失败，取消切换会话', e)
          return
        }
      }
      try {
        await invoke('pi_open_session', { path })
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
        setCurrentThreadId(id)
        await refreshThreads()
        // 活动会话已换——分支条/fork 点随新会话刷新（防上一会话的投影残留）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error(`[pi] 会话 ${id} 打开失败（保持当前会话）`, e)
      }
    },
    [actorRef, hydratePiMessages, refreshThreads],
  )

  const threadListAdapter = {
    threadId: currentThreadId ?? undefined,
    threads,
    onSwitchToNewThread: async () => {
      // New Chat：flush 旧会话落盘 + 清 handle（不立即建空会话文件），
      // 下一次发送按需创建全新会话；失败保持当前会话（不更新本地态）
      try {
        await invoke('pi_discard_session')
        actorRef.send({ type: 'RESET' })
        setCurrentThreadId(null)
        await refreshThreads()
        // 无活动会话——分支条/fork 点投影清空（refresh 命中 no active
        // session 域状态，静默清投影）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error('[pi] New Chat 失败（保持当前会话）', e)
      }
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
      try {
        await invoke('pi_rename_session', { name: newTitle })
        await refreshThreads()
      } catch (e) {
        console.error('[pi] 会话重命名失败', e)
      }
    },
    onDelete: async (id: string) => {
      const row = threadsRef.current.find((t) => t.id === id)
      const path = row?.custom?.path
      if (typeof path !== 'string') {
        console.error(`[pi] 会话 ${id} 缺少 path，无法删除`)
        return
      }
      try {
        if (id === currentThreadId) {
          // 当前活跃会话：pi 持有该会话 handle（jsonl 打开中），直接
          // delete 会撞打开中的文件——先 discard（flush 落盘 + 清 handle
          // + 清挂起审批）+ 清轮次态（消息清空、threadId 置 null = 高亮
          // New Chat），再删文件。非当前会话行为不变。
          await invoke('pi_discard_session')
          actorRef.send({ type: 'RESET' })
          setCurrentThreadId(null)
          // 无活动会话——分支条/fork 点投影清空（同 New Chat 语义）
          branchBridge.getState().requestRefresh()
        }
        await invoke('pi_delete_session', { path })
        await refreshThreads()
      } catch (e) {
        console.error(`[pi] 会话 ${id} 删除失败（保持当前状态）`, e)
      }
    },
    onArchive: async () => {
      console.error('[pi] 会话归档未实现（pi 无 archive 概念）')
    },
  }

  const runtime = useExternalStoreRuntime({
    // threadListAdapter 必须放 adapters.threadList（core 的
    // getThreadListAdapter 只读 store.adapters?.threadList；顶层平铺无效）
    adapters: {
      threadList: threadListAdapter,
      // 图片附件（POST 契约白名单见 PiImageAttachmentAdapter.accept）——
      // send 产出 content [{type:'image', image: dataURL}]，onNew 据此
      // 组 POST images 与乐观消息 image part
      attachments: imageAttachmentAdapter,
    },
    // 压缩横幅 / 中断态投影（机器 context 的 JSON 快照）
    state: { compaction, interrupted },
    // TurnPart 与 ThreadMessageLike 的 tool-call 形状对齐；args 的
    // Record<string, unknown> 运行时即 JSON 对象（pi arguments Value），断言
    convertMessage: (m) => ({
      id: m.id,
      role: m.role,
      // createdAt 透传（TurnMessage.createdAt：run 段/乐观消息为本地时刻，
      // hydrate 为 pi timestamp）——day-separator 消费
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => {
              if (p.type === 'tool-call')
                return { ...p, args: p.args as never, result: p.result as never }
              // thinking part 出口转 reasoning——ThreadMessageLike 的
              // ReasoningMessagePart 要求 type:"reasoning"（Reasoning 组件
              // 消费，§2.2 thinking 流式）；TurnPart 内部保持 thinking
              if (p.type === 'thinking') return { type: 'reasoning' as const, text: p.text }
              // text / image part 形状与 ThreadMessageLike 一致，原样透传
              return p
            }),
    }),
    messages,
    isRunning,
    onNew: async (m) => {
      const raw = m.content
      const text = (typeof raw === 'string' ? raw : raw.map((c) => (c.type === 'text' ? c.text : '')).join('')).trim()
      // canSend 保证：走到这里要么有文本、要么带附件。纯附件无文本不满足
      // POST 契约（message 必填）——抛 MessageNotSentError 让草稿回到
      // composer（静默丢附件 = 兜底，禁止）
      if (!text) throw new MessageNotSentError('[pi] 消息为空：附件必须伴随文本 prompt 发送')
      // 图片附件 → POST images（data URL 严格解析成 {data: 纯base64,
      // mimeType}）；白名单外/形状不符 console.error 可见并跳过该图——
      // 文本照发（渲染选择非吞错）
      const images: PiImagePayload[] = []
      const imageDataUrls: string[] = []
      for (const att of m.attachments ?? []) {
        for (const part of att.content) {
          if (part.type !== 'image') continue
          const parsed = parseImageDataUrl(part.image)
          if (!parsed) {
            console.error(`[pi] 附件 ${att.name} 的图片不在白名单（png/jpeg/webp/gif）——未随消息发送`)
            continue
          }
          images.push(parsed)
          imageDataUrls.push(part.image)
        }
      }
      // 错误即错误：endpoint 未就绪直接抛错——消息不装作已发送
      if (!endpointRef.current) throw new Error('[agui] endpoint 未就绪，消息未发送')
      actorRef.send({
        type: 'USER_SUBMIT',
        text,
        messageId: `user-${Date.now()}`,
        ...(imageDataUrls.length > 0 ? { images: imageDataUrls } : {}),
      })
      postRun(text, images)
      // 首条消息触发会话创建 → 线程列表出现当前会话
      void refreshThreads()
    },
    onEdit,
    onReload,
    onCancel: async () => {
      // §4.5：abort 是控制操作走 IPC；阻塞中的 prompt 观察 abort 信号收尾
      try {
        await invoke('pi_interrupt')
        // 中断成功置标记：run 收尾后 StoppedRun 展示中断态（新 run 开始清）
        actorRef.send({ type: 'CANCEL_MARK' })
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
