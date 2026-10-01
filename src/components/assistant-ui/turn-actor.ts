/**
 * 轮次状态机（XState v5）——AG-UI SSE 事件流的唯一归约者
 * （docs/pi-integration.md §0.2-5 定稿：XState 唯一轮次真相，assistant-ui
 * 经 ExternalStore 纯渲染）。
 *
 * 铁律：纯投影（不持会话真相，真相在 pi）；lastEventId 是续放句柄；
 * run 内交错 RUN_STARTED = 协议违例 fail loud、按新 run 段接受（§0.3-1，
 * 物理上不可能——Mutex 互斥）；run 外消息类事件 drop（§0.3-5）；
 * idle 态 run 外事件透传。
 */
import { assign, setup } from 'xstate'

export interface TurnMessage {
  id: string
  role: 'user' | 'assistant'
  /** string = 纯文本（用户消息/简单助手）；parts = 结构化（文本 + 工具调用 + 图片） */
  content: string | TurnPart[]
  /** 消息时刻：run 段 = RUN_STARTED 到达时刻、乐观用户消息 = 提交时刻、
   * 历史会话 = pi Message.timestamp（i64，epoch ms）。day-separator 用。 */
  createdAt?: Date
}

/** 结构化内容部件（ThreadMessageLike 兼容形状；args 限 JSON 对象——
 * ThreadMessageLike 的 tool-call args 要求 ReadonlyJSONObject）。
 * thinking part 经 runtime convertMessage 映射为 assistant-ui 的
 * reasoning part（Reasoning 组件消费，§2.2 thinking 流式）。
 * image part 的 image 是 data URL（FileReader.readAsDataURL 产物 /
 * hydrate 时由 pi ContentBlock::Image 的 base64 拼装）。 */
export type TurnPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; image: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      args?: Record<string, unknown>
      result?: unknown
      isError?: boolean
    }

/** 上下文压缩快照（AG-UI CUSTOM name=compaction，§数据面契约：
 * Start={phase:"start", reason}；End={phase:"end", tokensBefore?,
 * tokensAfter?, aborted, willRetry, errorMessage?}）。thread.aui 顶部
 * 压缩横幅（guardrail-notice 元素）消费；新 run 开始清。
 * type 而非 interface：可隐式获得 string 索引签名（adapter state 通道
 * 要求 ReadonlyJSONValue）。 */
export type CompactionSnapshot = {
  phase: 'start' | 'end'
  reason?: string
  tokensBefore?: number
  tokensAfter?: number
  aborted?: boolean
  errorMessage?: string
}

/** 会话用量快照（ContextDisplay 数据面；RUN_FINISHED.usage 原样投影；
 * cacheWriteTokens / costUsd 为可选增补字段） */
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  costUsd?: number
}

export interface TurnContext {
  messages: TurnMessage[]
  currentRunId: string | null
  lastEventId: number
  error: string | null
  /** 最新 run 结束时的用量（= 当前上下文规模近似，替换不累计） */
  usage: TurnUsage | null
  /** 上下文压缩横幅数据（CUSTOM name=compaction；新 run 开始清） */
  compaction: CompactionSnapshot | null
  /** 用户中断标记：pi_interrupt 成功后置位，run 结束后 thread.aui 据此
   * 展示 StoppedRun（继续/丢弃）；新 run 开始、RESET、HYDRATE 清。 */
  interrupted: boolean
}

export type AguiEvent = { type: string } & Record<string, unknown>

export type TurnEvent =
  | { type: 'AGUI_EVENT'; event: AguiEvent; id: number }
  | { type: 'USER_SUBMIT'; text: string; messageId: string; images?: string[] }
  /** 新会话（New Chat）：清空全部轮次态（§7-4 会话切换） */
  | { type: 'RESET' }
  /** 打开历史会话：注入 pi 会话历史（真相在 pi，机器只收投影快照） */
  | { type: 'HYDRATE'; messages: TurnMessage[] }
  /** 用户中断已成功（pi_interrupt IPC 返回后）——置 interrupted 标记，
   * run 结束后 StoppedRun 据此展示中断态 */
  | { type: 'CANCEL_MARK' }
  /** StoppedRun 的继续/丢弃被处理——清中断标记 */
  | { type: 'INTERRUPT_CLEAR' }

/** 会往消息里写内容的事件类（run 归属事件）。currentRunId === null 时送达
 * = run 外残留/重放（RUN_ERROR 后的服务器尾流、断线重放窗口）——drop 并
 * 告警，防止写入旧会话消息（§0.3-5）。run 外 CUSTOM（compaction /
 * data_changed / extension_ui_request）不在此列，照常透传。 */
const MESSAGE_WRITE_TYPES = new Set([
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
])

const isMessageWriteEvent = (ev: AguiEvent): boolean =>
  MESSAGE_WRITE_TYPES.has(ev.type) ||
  // 工具执行维度（start/update/end 全家族）：同为 run 归属事件
  (ev.type === 'CUSTOM' && ev.name === 'tool_execution')

/** 归约单条 AG-UI 事件 → 上下文（纯函数，可单测）。 */
export function reduceAguiEvent(ctx: TurnContext, ev: AguiEvent, id: number): TurnContext {
  const next = { ...ctx, lastEventId: id }
  if (ctx.currentRunId === null && isMessageWriteEvent(ev)) {
    console.warn(`[turn] run 外收到消息类事件 ${ev.type}——丢弃（无 run 段可写）`)
    return next // lastEventId 照常推进（游标必须走，§0.3-5）
  }
  switch (ev.type) {
    case 'RUN_STARTED': {
      const runId = String(ev.runId ?? '')
      return {
        ...next,
        currentRunId: runId,
        // 新 run 开始清上一 run 的错误——错误条生命周期到下一个 run 为止
        error: null,
        // 新 run 开始清压缩横幅与中断标记（二者都只描述上一个 run）
        compaction: null,
        interrupted: false,
        messages: [
          ...ctx.messages,
          {
            id: String(ev.runId ?? `run-${id}`),
            role: 'assistant',
            content: '',
            createdAt: new Date(),
          },
        ],
      }
    }
    case 'TEXT_MESSAGE_CONTENT': {
      // 追加到最后一条 assistant 消息（当前 run 段）。content 已是 parts
      // （工具调用后又有文本）时追加/合并最后的 text part。
      const messages = [...ctx.messages]
      const delta = String(ev.delta ?? '')
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const c = messages[i].content
        if (typeof c === 'string') {
          messages[i] = { ...messages[i], content: c + delta }
        } else {
          const parts = [...c]
          const last = parts[parts.length - 1]
          if (last?.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + delta }
          else parts.push({ type: 'text', text: delta })
          messages[i] = { ...messages[i], content: parts }
        }
        break
      }
      return { ...next, messages }
    }
    case 'THINKING_TEXT_MESSAGE_START': {
      // 思考块开始（§2.2）：保证存在思考段——后续 CONTENT 追加到最后的
      // thinking part。文本在先时把 string content 摊成 parts；空 thinking
      // part 在渲染层被丢弃（assistant-ui 空 text 滤除），无害。
      const messages = [...ctx.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const c = messages[i].content
        if (typeof c === 'string') {
          messages[i] = {
            ...messages[i],
            content: c
              ? [{ type: 'text', text: c }, { type: 'thinking', text: '' }]
              : [{ type: 'thinking', text: '' }],
          }
        } else {
          const last = c[c.length - 1]
          // 最后已是空 thinking part（重复 START）：幂等不新开
          if (!(last?.type === 'thinking' && last.text === '')) {
            messages[i] = { ...messages[i], content: [...c, { type: 'thinking', text: '' }] }
          }
        }
        break
      }
      return { ...next, messages }
    }
    case 'THINKING_TEXT_MESSAGE_CONTENT': {
      // 追加到最后的 thinking part；无思考段则新开（START 缺失时 CONTENT
      // 自立——Rust 侧 ThinkingStart 映射补齐前仍可用）。
      const messages = [...ctx.messages]
      const delta = String(ev.delta ?? '')
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const c = messages[i].content
        if (typeof c === 'string') {
          messages[i] = {
            ...messages[i],
            content: c
              ? [{ type: 'text', text: c }, { type: 'thinking', text: delta }]
              : [{ type: 'thinking', text: delta }],
          }
        } else {
          const parts = [...c]
          const last = parts[parts.length - 1]
          if (last?.type === 'thinking') parts[parts.length - 1] = { ...last, text: last.text + delta }
          else parts.push({ type: 'thinking', text: delta })
          messages[i] = { ...messages[i], content: parts }
        }
        break
      }
      return { ...next, messages }
    }
    case 'THINKING_TEXT_MESSAGE_END':
      // 块结束：TurnPart 无状态位，流式态由渲染层 auto-status 收尾（消息
      // 仍 running 时最后 part 即 running）——内容无关，透传游标。
      return next
    case 'CUSTOM': {
      // 工具执行维度（§2.2）：start = push 工具调用部件（args 来自
      // 模型参数流）；end = 填结果。行内标记呈现退役，真工具 UI
      // （thread.aui 的 ToolFallback）按 parts 渲染。
      const value = ev.value as
        | { phase?: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean }
        | undefined
      if (ev.name === 'tool_execution' && value?.phase === 'start' && value.toolCallId) {
        const args =
          value.args && typeof value.args === 'object' && !Array.isArray(value.args)
            ? (value.args as Record<string, unknown>)
            : undefined
        const messages = [...ctx.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant') continue
          const c = messages[i].content
          const parts: TurnPart[] =
            typeof c === 'string'
              ? c
                ? [{ type: 'text', text: c }, { type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args }]
                : [{ type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args }]
              : [...c, { type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args }]
          messages[i] = { ...messages[i], content: parts }
          break
        }
        return { ...next, messages }
      }
      if (ev.name === 'tool_execution' && value?.phase === 'end' && value.toolCallId) {
        const messages = [...ctx.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant' || typeof messages[i].content === 'string') continue
          const parts = (messages[i].content as TurnPart[]).map((p) =>
            p.type === 'tool-call' && p.toolCallId === value.toolCallId
              ? { ...p, result: value.result, isError: value.isError === true }
              : p,
          )
          messages[i] = { ...messages[i], content: parts }
          break
        }
        return { ...next, messages }
      }
      // 上下文压缩（§数据面契约）：phase 严格二值，其余字段按类型收窄——
      // 形状不符 console.error 可见并丢弃（渲染选择非吞错）
      if (ev.name === 'compaction' && value && typeof value === 'object') {
        const v = value as {
          phase?: unknown
          reason?: unknown
          tokensBefore?: unknown
          tokensAfter?: unknown
          aborted?: unknown
          errorMessage?: unknown
        }
        if (v.phase !== 'start' && v.phase !== 'end') {
          console.error(`[turn] compaction 事件 phase 非法（${String(v.phase)}）——丢弃`)
          return next
        }
        const snap: CompactionSnapshot = { phase: v.phase }
        if (typeof v.reason === 'string') snap.reason = v.reason
        if (typeof v.tokensBefore === 'number') snap.tokensBefore = v.tokensBefore
        if (typeof v.tokensAfter === 'number') snap.tokensAfter = v.tokensAfter
        if (v.phase === 'end' && typeof v.aborted === 'boolean') snap.aborted = v.aborted
        if (typeof v.errorMessage === 'string') snap.errorMessage = v.errorMessage
        return { ...next, compaction: snap }
      }
      return next
    }
    case 'RUN_FINISHED': {
      // 用量快照（替换语义：最新 run 结束时的上下文规模）；cacheWriteTokens
      // / costUsd 为可选增补字段，缺省不写
      const usage = ev.usage as Partial<TurnUsage> | null | undefined
      const num = (x: unknown): number | undefined =>
        typeof x === 'number' ? x : undefined
      return {
        ...next,
        currentRunId: null,
        usage: usage
          ? {
              inputTokens: num(usage.inputTokens),
              outputTokens: num(usage.outputTokens),
              cachedInputTokens: num(usage.cachedInputTokens),
              cacheWriteTokens: num(usage.cacheWriteTokens),
              totalTokens: num(usage.totalTokens),
              costUsd: num(usage.costUsd),
            }
          : next.usage,
      }
    }
    case 'RUN_ERROR':
      return { ...next, currentRunId: null, error: String(ev.message ?? 'run error') }
    default:
      return next // run 外/未映射事件透传（§0.3-5）
  }
}

export const turnMachine = setup({
  types: {
    context: {} as TurnContext,
    events: {} as TurnEvent,
    input: {} as TurnContext,
  },
  actions: {
    appendUser: assign({
      messages: ({ context, event }) => {
        if (event.type !== 'USER_SUBMIT') return context.messages
        // 带图片附件时 content 摊成 parts（text + image data URL，
        // 经 convertMessage 原样透传给 ThreadMessageLike 渲染）；纯文本
        // 保持 string 形状不变
        const content: string | TurnPart[] =
          event.images && event.images.length > 0
            ? [
                { type: 'text', text: event.text },
                ...event.images.map((image) => ({ type: 'image' as const, image })),
              ]
            : event.text
        return [
          ...context.messages,
          {
            id: event.messageId,
            role: 'user' as const,
            content,
            createdAt: new Date(),
          },
        ]
      },
    }),
    reduce: assign(({ context, event }) => {
      if (event.type !== 'AGUI_EVENT') return context
      // RUN_ERROR 的 error 写入在 reduceAguiEvent 内（case 'RUN_ERROR'）——
      // 早期版本在此重复 set，已并入归约器单一来源。
      return reduceAguiEvent(context, event.event, event.id)
    }),
    markCancelled: assign({ interrupted: () => true }),
    clearInterrupt: assign({ interrupted: () => false }),
    reset: assign(() => ({
      messages: [],
      currentRunId: null,
      lastEventId: 0,
      error: null,
      usage: null,
      compaction: null,
      interrupted: false,
    })),
    hydrate: assign(({ event }) => {
      if (event.type !== 'HYDRATE') return {}
      // 历史会话的用量未知——pi_get_messages 的消息 usage 后续可聚合
      return {
        messages: event.messages,
        currentRunId: null,
        error: null,
        usage: null,
        compaction: null,
        interrupted: false,
      }
    }),
  },
  guards: {
    isRunStart: ({ event }) =>
      event.type === 'AGUI_EVENT' && event.event.type === 'RUN_STARTED',
    isRunEnd: ({ event }) =>
      event.type === 'AGUI_EVENT' &&
      (event.event.type === 'RUN_FINISHED' || event.event.type === 'RUN_ERROR'),
    isRunStartViolation: ({ context, event }) =>
      event.type === 'AGUI_EVENT' &&
      event.event.type === 'RUN_STARTED' &&
      context.currentRunId !== null &&
      context.currentRunId !== String(event.event.runId ?? ''),
  },
}).createMachine({
  id: 'turn',
  context: ({ input }) => input,
  initial: 'idle',
  states: {
    idle: {
      on: {
        USER_SUBMIT: { actions: 'appendUser' },
        RESET: { actions: 'reset' },
        HYDRATE: { actions: 'hydrate' },
        CANCEL_MARK: { actions: 'markCancelled' },
        INTERRUPT_CLEAR: { actions: 'clearInterrupt' },
        AGUI_EVENT: [
          { guard: 'isRunStart', target: 'streaming', actions: 'reduce' },
          { actions: 'reduce' }, // idle 态 run 外事件透传（§0.3-5）
        ],
      },
    },
    streaming: {
      on: {
        USER_SUBMIT: { actions: 'appendUser' },
        RESET: { actions: 'reset' },
        HYDRATE: { actions: 'hydrate' },
        CANCEL_MARK: { actions: 'markCancelled' },
        INTERRUPT_CLEAR: { actions: 'clearInterrupt' },
        AGUI_EVENT: [
          // streaming 中另一 runId 的 RUN_STARTED：协议违例（§0.3-1——
          // run 内交错在物理上不可能，AgentSessionHandle Mutex 互斥），
          // fail loud 上报；语义按注释意图接受为新 run 段（reduce 追加
          // 新 assistant 消息、currentRunId 换轨、phase 保持 streaming）。
          {
            guard: 'isRunStartViolation',
            actions: [
              ({ context, event }) => {
                if (event.type !== 'AGUI_EVENT') return
                console.error(
                  `[turn] 协议违例：streaming 中收到另一 runId 的 RUN_STARTED（run=${String(event.event.runId ?? '')}，当前=${context.currentRunId}）——按新 run 段接受`,
                )
              },
              'reduce',
            ],
          },
          { guard: 'isRunEnd', target: 'idle', actions: 'reduce' },
          { actions: 'reduce' },
        ],
      },
    },
  },
})
