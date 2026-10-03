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
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type SpeechSynthesisAdapter,
} from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useActorRef, useSelector } from '@xstate/react'
import { useStore } from 'zustand'

import { turnMachine, type TurnContext, type TurnMessage, type TurnPart, type TurnUsage } from './turn-actor'
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
import { clearThreadScroll, threadScrollBridge } from './thread-scroll-store'
import { deriveTitle, firstUserMessageText, nextTitleInLineage } from './session-title'
import { usageBridge, type UsageState } from './usage-bridge'
import { checkpointBridge, type RewindRequest } from './checkpoint-store'
import { costBridge } from './cost-bridge'
import { sessionQueue } from './session-queue-store'

import { sessionWorkspaceStore } from '@/components/panes/session-manage/session-workspace'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'

import {
  BoundarySpeechSynthesisAdapter,
  ensureSpeechSupportLogged,
} from './speech-adapter'

const THREAD = 'main'

/** 自动命名已尝试过的会话（每会话只做一次——含失败，失败 console 可见、
 * 不静默重试；跨重启由 pi 持久的 name 字段 + 默认态判定兜住重名） */
const autoNamedSessions = new Set<string>()

/** 朗读适配器（read-aloud）：speechSynthesis 不存在的环境不注册（核心
 * capabilities.speech=false → UI 钮隐藏），console.info 一次 */
const speechAdapter: SpeechSynthesisAdapter | undefined =
  ensureSpeechSupportLogged() ? new BoundarySpeechSynthesisAdapter() : undefined

/** 排队消息 id 序列（同毫秒双提交不得撞 id） */
let queuedSeq = 0

/** titling.auto_title 配置门（pi Config TitlingSettings，config.rs:434-440；
 * settings.json 落盘 snake_case `auto_title`，读取侧 pi 另收 autoTitle/auto
 * 别名——门保持同款别名集）。显式 false = 用户关掉自动命名；缺省（无
 * settings 文件 / titling 键缺 / auto_title 缺 / true）= 开（上游默认 true）。 */
const isAutoTitleEnabled = async (): Promise<boolean> => {
  const settings = await invoke<unknown>('pi_get_settings')
  if (settings === null || settings === undefined) return true // 无配置文件 = 上游默认
  if (typeof settings !== 'object') {
    console.error('[pi] 自动命名：pi_get_settings 返回形状非法——跳过', settings)
    return false
  }
  const titling = (settings as Record<string, unknown>).titling
  if (!titling || typeof titling !== 'object') return true
  const t = titling as Record<string, unknown>
  return (t.auto_title ?? t.autoTitle ?? t.auto) !== false
}

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
}/** 渲染错误兜底：归约链路的任何意外不得白屏整个应用（只隔离聊天树）。 */
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
  // **真相源 = sessionCatalog**（用户定稿：会话名/项目名单一存储，所有
  // 消费方——侧栏/双行块/workspace 页签名——只读 catalog）；本组件是
  // 唯一写入者（pi_list_sessions 灌入 + 消息流派生标题）。assistant-ui
  // 的 threads 数组从 catalog 派生（title = 统一显示名）。
  // 必须声明在挂载 effect 之前（effect 依赖数组 render 期求值，TDZ）。──
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  // 【bisect】threads 暂回本地 state（title=统一显示名）；catalog 并行灌入。
  const [threads, setThreads] = useState<ThreadListRow[]>([])
  const threadsRef = useRef<ThreadListRow[]>([])
  threadsRef.current = threads
  // 会话列表刷新是异步回调——ingestRows 需要"当前选中的会话"（选中恒
  // 确认已读），ref 保证回调里拿到最新值（closure 陈旧是已踩过的坑）。
  const currentThreadIdRef = useRef<string | null>(null)
  currentThreadIdRef.current = currentThreadId

  // 活动会话切换 → catalog（消费方经 activeId 取显示名/项目名）。
  useEffect(() => {
    sessionCatalog.getState().setActive(currentThreadId)
  }, [currentThreadId])

  // 派生标题（首条用户消息——侧栏/双行块/页签名同源的"自动命名"）：pi
  // 无名时前端即时显示，消息流变化即重算写入 catalog。
  const firstUserText = firstUserMessageText(messages)
  const derivedTitle = currentThreadId && firstUserText ? deriveTitle(firstUserText) : undefined
  useEffect(() => {
    if (!currentThreadId || !derivedTitle) return
    sessionCatalog.getState().setDerivedTitle(currentThreadId, derivedTitle)
  }, [currentThreadId, derivedTitle])

  const refreshThreads = useCallback(async () => {
    try {
      const metas = await invoke<PiSessionMeta[]>('pi_list_sessions')
      const rows = (metas ?? []).map((m) => ({
        status: 'regular' as const,
        id: m.id,
        title: m.name ?? undefined,
        // custom = SessionMeta 的前端投影面：path（打开/删除/导出）、
        // messageCount（未读水位）、lastModifiedMs（行龄）、cwd（工作区
        // 分组）、timestamp（created 排序）。
        custom: {
          path: m.path,
          messageCount: m.messageCount,
          lastModifiedMs: m.lastModifiedMs,
          cwd: m.cwd,
          timestamp: m.timestamp,
        },
      }))
      // 单一真相源灌入：未读播种已并入 ingest（hermes ingestRows 语义）；
      // 侧栏 threads（assistant-ui）title 用统一显示名。
      sessionCatalog.getState().ingest(rows, currentThreadIdRef.current)
      setThreads(
        rows.map((r) => ({
          ...r,
          title: sessionDisplayName(sessionCatalog.getState().entries[r.id]),
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
            // 滚动位置恢复请求（挂载水合成功路径）：视口（thread.aui 侧）
            // 消费后按持久化位置恢复阅读位
            threadScrollBridge.getState().requestRestore(st.sessionId)
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

  /** 自动会话命名（规则段，hermes title_generator 两段式的即时段）：
   * POST 成功后对「默认态名」（pi SessionIndex 的 name 为 null/空 = 用户
   * 未命名）的会话，从首条 user 消息派生标题（deriveTitle——首个非空行、
   * 词边界截 48 字符+…），撞名走谱系编号追加 #N（nextTitleInLineage——
   * 既有最大号+1），pi_rename_session 落名后刷新线程列表。受
   * titling.auto_title 配置门约束（isAutoTitleEnabled）；每会话只尝试
   * 一次（autoNamedSessions 内存 Set，含失败——失败可见不重试）；LLM
   * 总结升级段不做（无凭据面）。全程独立 try/catch：命名失败不影响
   * 消息发送/run 流。 */
  const maybeAutoNameSession = useCallback(async () => {
    let sessionId: string | null
    try {
      sessionId = (await invoke<{ sessionId: string | null }>('pi_get_state')).sessionId
    } catch (e) {
      console.error('[pi] 自动命名：pi_get_state 失败——跳过', e)
      return
    }
    if (!sessionId) {
      console.error('[pi] 自动命名：POST 成功但无活动会话（域异常）——跳过')
      return
    }
    if (autoNamedSessions.has(sessionId)) return
    // 配置门（titling.auto_title）：显式 false = 用户关掉自动命名——
    // 不占命名名额（同一 run 内改回 true，下次 POST 即恢复触发）；
    // settings 读取失败 = 错误可见并跳过本次（同样不占名额）。
    try {
      if (!(await isAutoTitleEnabled())) return
    } catch (e) {
      console.error('[pi] 自动命名：pi_get_settings 读取失败——跳过', e)
      return
    }
    // 先占位再执行：并发 POST 不得重复触发同一会话的命名
    autoNamedSessions.add(sessionId)
    try {
      const metas = await invoke<PiSessionMeta[]>('pi_list_sessions')
      const self = (metas ?? []).find((m) => m.id === sessionId)
      if (!self) {
        console.error('[pi] 自动命名：会话不在索引中——跳过', sessionId)
        return
      }
      // 默认态判定：已有自定义名（用户命名/历史命名）→ 不动
      if (self.name) return
      const firstUser = firstUserMessageText(actorRef.getSnapshot().context.messages)
      if (!firstUser) {
        console.error('[pi] 自动命名：没有可派生文本的首条 user 消息——跳过', sessionId)
        return
      }
      const derived = deriveTitle(firstUser)
      if (!derived) {
        console.error('[pi] 自动命名：首行派生标题为空——跳过', sessionId)
        return
      }
      // 谱系编号：与其它会话撞名时追加 #N（N = 既有最大号+1）
      const others = (metas ?? [])
        .filter((m) => m.id !== sessionId && m.name)
        .map((m) => m.name!)
      const title = nextTitleInLineage(derived, others)
      await invoke('pi_rename_session', { name: title })
      await refreshThreads()
    } catch (e) {
      console.error('[pi] 自动命名失败（会话保持默认名，可手动重命名）', e)
    }
  }, [actorRef, refreshThreads])

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
      // POST 成功即触发自动命名（maybeAutoNameSession 内部全 try/catch，
      // 不向外抛——外层 catch 仍只服务 POST 本身的失败）
      .then(() => maybeAutoNameSession())
      .catch((e) => console.error('[agui] POST 失败', e))
  }, [maybeAutoNameSession])

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

  /** 会话更换（切换 / New Chat / fork / 回父会话 / 删除当前 / 回退）成功后
   * 清会话域桥投影：排队消息属于原会话轨迹（clear）、检查点投影与
   * currentId 同属会话（resetProjection）、成本显示切到新会话（lastRun
   * 清；累计按 sessionId 键隔离保留）。 */
  const resetSessionScopedBridges = useCallback((sessionId: string | null) => {
    sessionQueue.getState().clear()
    checkpointBridge.getState().resetProjection()
    costBridge.getState().resetSession(sessionId)
  }, [])

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
        resetSessionScopedBridges(forked.sessionId)
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
      [actorRef, hydratePiMessages, interruptIfRunning, refreshThreads, resetSessionScopedBridges],
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

  /** 会话线「回到父会话」执行：守卫 → pi_open_session(路径)（**返回的是
   * 模型条目串不是会话 id**——实测 "amazon-bedrock/…"；sessionId 从
   * pi_get_state 取）→ 重水合 + currentThreadId + 线程列表刷新 → 分支条
   * 刷新。失败 console.error 不动本地态。 */
  const runOpenParent = useCallback(
    async (req: OpenParentRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_open_session', { path: req.path })
      } catch (e) {
        console.error('[pi] 回到父会话失败（保持当前会话）', e)
        return
      }
      let sessionId: string
      try {
        const st = await invoke<{ sessionId?: unknown }>('pi_get_state')
        if (typeof st?.sessionId !== 'string' || st.sessionId.length === 0) {
          console.error('[pi] 回到父会话后 pi_get_state 无 sessionId——不采纳', st)
          return
        }
        sessionId = st.sessionId
      } catch (e) {
        console.error('[pi] 回到父会话后读取会话 id 失败', e)
        return
      }
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
        setCurrentThreadId(sessionId)
        await refreshThreads()
        resetSessionScopedBridges(sessionId)
        // 滚动位置恢复请求（回到父会话 = 打开既有历史会话，与
        // switchToThread 同语义）
        threadScrollBridge.getState().requestRestore(sessionId)
      } catch (e) {
        console.error('[pi] 回到父会话后重水合失败（服务端已切换，可从侧栏手动打开）', e)
        void refreshThreads()
        return
      }
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydratePiMessages, interruptIfRunning, refreshThreads, resetSessionScopedBridges],
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

  // ── checkpoint 回退执行器（checkpoint-store 请求通道，branch 同款）──
  /** 回退执行：守卫（照抄 switchToThread——prompt 持锁跨整个 run）→
   * pi_rewind（checkpointId = 检查点**名称**，pi find_checkpoint 的匹配
   * 键——不是 entryId）→ 重拉 pi_get_messages HYDRATE 重水合（活动上下文
   * 已截断到检查点，其后 span 折叠为一条摘要——重水合后的投影即回退后的
   * 真相）→ currentId 标记 + 检查点清单/分支点刷新。任一步失败
   * console.error 不动本地态。 */
  const runRewind = useCallback(
    async (req: RewindRequest) => {
      if (!(await interruptIfRunning())) return
      try {
        await invoke('pi_rewind', { checkpointId: req.name })
      } catch (e) {
        console.error(`[pi] 回退到检查点「${req.name}」失败（保持当前上下文）`, e)
        return
      }
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_messages')
        actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
      } catch (e) {
        console.error('[pi] 回退后重水合失败（服务端已截断，可重开检查点面板查看）', e)
        return
      }
      checkpointBridge.setState({ currentId: req.name })
      void checkpointBridge.getState().refresh()
      branchBridge.getState().requestRefresh()
    },
    [actorRef, hydratePiMessages, interruptIfRunning],
  )

  const rewindRequest = useStore(checkpointBridge, (s) => s.rewindRequest)
  const handledRewindSeqRef = useRef(0)
  const rewindBusyRef = useRef(false)

  useEffect(() => {
    if (!rewindRequest || rewindRequest.seq <= handledRewindSeqRef.current) return
    if (rewindBusyRef.current) {
      console.error('[pi] 回退进行中——忽略新回退请求', rewindRequest)
      checkpointBridge.getState().clearRewindRequest(rewindRequest.seq)
      return
    }
    handledRewindSeqRef.current = rewindRequest.seq
    rewindBusyRef.current = true
    void runRewind(rewindRequest).finally(() => {
      rewindBusyRef.current = false
      checkpointBridge.getState().clearRewindRequest(rewindRequest.seq)
    })
  }, [rewindRequest, runRewind])

  // ── 「选择工作区新建会话」执行器（session-workspace 请求桥，branch/
  //    checkpoint 同款请求-执行形态）──
  // pi_new_session（working_directory 透传 SessionOptions）→ pi_get_state
  // 取 sessionId → RESET（新会话无历史）+ currentThreadId 采纳 + 列表刷新。
  // 守卫照抄 switchToThread：prompt 持锁跨整个 run，先 pi_interrupt。
  // 任一步失败 console.error 并丢弃请求（不排队重试——用户重选即可）。
  const workspaceRequest = useStore(sessionWorkspaceStore, (s) => s.request)
  const handledWorkspaceSeqRef = useRef(0)
  const workspaceBusyRef = useRef(false)

  useEffect(() => {
    if (!workspaceRequest || workspaceRequest.seq <= handledWorkspaceSeqRef.current) return
    if (workspaceBusyRef.current) {
      console.error('[pi] 会话操作进行中——忽略新工作区请求', workspaceRequest)
      sessionWorkspaceStore.getState().clearRequest(workspaceRequest.seq)
      return
    }
    handledWorkspaceSeqRef.current = workspaceRequest.seq
    workspaceBusyRef.current = true
    const { seq, cwd } = workspaceRequest
    sessionCatalog.getState().setPendingCwd(cwd)
    void (async () => {
      try {
        if (!(await interruptIfRunning())) return
        await invoke('pi_new_session', { cwd })
        const st = await invoke<{ sessionId: string | null }>('pi_get_state')
        if (typeof st?.sessionId !== 'string' || st.sessionId.length === 0) {
          console.error('[pi] 工作区新建会话后 pi_get_state 无 sessionId——不采纳', st)
          return
        }
        actorRef.send({ type: 'RESET' })
        setCurrentThreadId(st.sessionId)
        await refreshThreads()
        resetSessionScopedBridges(st.sessionId)
        // 新会话——分支条/fork 点投影清空（同 New Chat 语义）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error(`[pi] 在工作区新建会话失败（${cwd}）——保持当前会话`, e)
      } finally {
        sessionWorkspaceStore.getState().clearRequest(seq)
      }
    })().finally(() => {
      workspaceBusyRef.current = false
    })
  }, [workspaceRequest, interruptIfRunning, refreshThreads, resetSessionScopedBridges, actorRef])

  // ── run 收尾（streaming → idle 迁移，RUN_FINISHED 与 RUN_ERROR 都走
  // 此迁移）三件事 ─────────────────────────────────────────────────────
  // ① 分支数据刷新：user 消息落盘后才成为 fork 点（「从此分支探索」钮
  //    可用性依赖 forkPoints 新鲜）。挂载跳过（SessionLineBar 挂载已拉）。
  // ② 队列 drain（message-queue）：按序发出下一条排队消息——出队即
  //    USER_SUBMIT 乐观进投影 + postRun；本 run 收尾后只发一条，发完等
  //    下一次收尾（one-at-a-time）。用户取消（pi_interrupt）同样算收尾
  //    ——排队意图仍然兑现（队列面板全程可见可删）。
  // ③ 成本入账（cost-meter）：pi_get_state 是 sessionId 的权威源（首条
  //    消息创建的会话 currentThreadId 可能仍为 null），把本 run 的
  //    costUsd 累进该会话的进程内账本（历史会话不回算）。
  const wasRunningRef = useRef(false)
  const usageRef = useRef<TurnUsage | null>(null)
  usageRef.current = usage

  /** 队列 drain：endpoint 未就绪时保留队列（出队即丢 = 兜底，禁止） */
  const drainQueue = useCallback(() => {
    if (!endpointRef.current) {
      console.error('[queue] endpoint 未就绪——排队消息保留，待下次 run 收尾再发')
      return
    }
    const next = sessionQueue.getState().takeFirst()
    if (!next) return
    actorRef.send({
      type: 'USER_SUBMIT',
      text: next.text,
      messageId: `user-q-${Date.now()}`,
      ...(next.imageDataUrls && next.imageDataUrls.length > 0
        ? { images: next.imageDataUrls }
        : {}),
    })
    postRun(next.text, next.images)
    void refreshThreads()
  }, [actorRef, postRun, refreshThreads])

  /** 成本入账：失败 console.error 可见，本 run 不入账（不估算） */
  const recordRunCost = useCallback(() => {
    const u = usageRef.current
    void (async () => {
      try {
        const st = await invoke<{
          sessionId: string | null
          provider: string
          modelId: string
        }>('pi_get_state')
        costBridge.getState().recordRun({
          sessionId: st.sessionId,
          model: `${st.provider}/${st.modelId}`,
          costUsd: u?.costUsd,
          inputTokens: u?.inputTokens,
          outputTokens: u?.outputTokens,
        })
      } catch (e) {
        console.error('[cost] run 收尾成本入账失败（本 run 不入账）', e)
      }
    })()
  }, [])

  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true
      return
    }
    if (!wasRunningRef.current) return
    wasRunningRef.current = false
    branchBridge.getState().requestRefresh()
    drainQueue()
    recordRunCost()
  }, [isRunning, drainQueue, recordRunCost])

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
        resetSessionScopedBridges(id)
        // 滚动位置恢复请求（打开会话成功路径）：视口按该会话的持久化
        // 位置恢复阅读位
        threadScrollBridge.getState().requestRestore(id)
        // 活动会话已换——分支条/fork 点随新会话刷新（防上一会话的投影残留）
        branchBridge.getState().requestRefresh()
      } catch (e) {
        console.error(`[pi] 会话 ${id} 打开失败（保持当前会话）`, e)
      }
    },
    [actorRef, hydratePiMessages, refreshThreads, resetSessionScopedBridges],
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
        resetSessionScopedBridges(null)
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
          resetSessionScopedBridges(null)
          // 无活动会话——分支条/fork 点投影清空（同 New Chat 语义）
          branchBridge.getState().requestRefresh()
        }
        await invoke('pi_delete_session', { path })
        // 删除成功清该会话的滚动位置记忆（内存 + 持久化）
        clearThreadScroll(id)
        await refreshThreads()
      } catch (e) {
        console.error(`[pi] 会话 ${id} 删除失败（保持当前状态）`, e)
      }
    },
    onArchive: async () => {
      // 归档的实现在行菜单/手势（session-archive 客户端归档，重审计 #6）；
      // assistant-ui 的 archive API 本工程未接线——到达这里即未预期路径。
      console.error('[pi] threadListAdapter.onArchive 未接线（归档走行菜单）')
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
      // 朗读（read-aloud 元素）：带 boundary 进度的 Web Speech 适配器——
      // 无语音引擎环境为 undefined（capabilities.speech=false，UI 钮隐藏）
      ...(speechAdapter ? { speech: speechAdapter } : {}),
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
      // run 进行中 → 入队（message-queue 语义，对应 pi steering/follow_up
      // 的 one-at-a-time 排队模式）：pi prompt 持锁跨整个 run，立即 POST
      // 只会撞锁。排队消息不进轮次投影（乐观 user 消息在出队发送时才
      // 出现）——队列项本身在 MessageQueue 面板可见、可删；run 收尾后由
      // drainQueue 按序发出。
      if (actorRef.getSnapshot().matches('streaming')) {
        sessionQueue.getState().enqueue({
          id: `queued-${++queuedSeq}`,
          text,
          ...(images.length > 0 ? { images, imageDataUrls } : {}),
        })
        return
      }
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
