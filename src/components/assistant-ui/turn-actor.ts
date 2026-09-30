/**
 * 轮次状态机（XState v5）——AG-UI SSE 事件流的唯一归约者
 * （docs/pi-integration.md §0.2-5 定稿：XState 唯一轮次真相，assistant-ui
 * 经 ExternalStore 纯渲染）。
 *
 * 铁律：纯投影（不持会话真相，真相在 pi）；lastEventId 是续放句柄；
 * run 内交错 = 按新 run 段接受（HTTP 流无连接亲和性，重放/多 run 共存
 * 是常态，§0.3）；idle 态 run 外事件透传。
 */
import { assign, setup } from 'xstate'

export interface TurnMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/** 会话用量快照（ContextDisplay 数据面；RUN_FINISHED.usage 原样投影） */
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
}

export interface TurnContext {
  messages: TurnMessage[]
  currentRunId: string | null
  lastEventId: number
  error: string | null
  /** 最新 run 结束时的用量（= 当前上下文规模近似，替换不累计） */
  usage: TurnUsage | null
}

export type AguiEvent = { type: string } & Record<string, unknown>

export type TurnEvent =
  | { type: 'AGUI_EVENT'; event: AguiEvent; id: number }
  | { type: 'USER_SUBMIT'; text: string; messageId: string }
  /** 新会话（New Chat）：清空全部轮次态（§7-4 会话切换） */
  | { type: 'RESET' }
  /** 打开历史会话：注入 pi 会话历史（真相在 pi，机器只收投影快照） */
  | { type: 'HYDRATE'; messages: TurnMessage[] }

/** 归约单条 AG-UI 事件 → 上下文（纯函数，可单测）。 */
export function reduceAguiEvent(ctx: TurnContext, ev: AguiEvent, id: number): TurnContext {
  const next = { ...ctx, lastEventId: id }
  switch (ev.type) {
    case 'RUN_STARTED':
      return {
        ...next,
        currentRunId: String(ev.runId ?? ''),
        messages: [
          ...ctx.messages,
          { id: String(ev.runId ?? `run-${id}`), role: 'assistant', content: '' },
        ],
      }
    case 'TEXT_MESSAGE_CONTENT': {
      // 追加到最后一条 assistant 消息（当前 run 段）
      const messages = [...ctx.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          messages[i] = { ...messages[i], content: messages[i].content + String(ev.delta ?? '') }
          break
        }
      }
      return { ...next, messages }
    }
    case 'CUSTOM': {
      // 工具执行维度（§2.2 裁定）：行内标记呈现，真工具 UI 等数据面
      const value = ev.value as { phase?: string; toolName?: string } | undefined
      if (ev.name === 'tool_execution' && value?.phase === 'start') {
        const messages = [...ctx.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages[i] = {
              ...messages[i],
              content: messages[i].content + `[使用工具 ${value.toolName ?? ''}]\n`,
            }
            break
          }
        }
        return { ...next, messages }
      }
      return next
    }
    case 'RUN_FINISHED': {
      // 用量快照（替换语义：最新 run 结束时的上下文规模）
      const usage = ev.usage as Partial<TurnUsage> | null | undefined
      return {
        ...next,
        currentRunId: null,
        usage: usage
          ? {
              inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
              outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
              cachedInputTokens:
                typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined,
              totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
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
        return [
          ...context.messages,
          { id: event.messageId, role: 'user' as const, content: event.text },
        ]
      },
    }),
    reduce: assign(({ context, event }) => {
      if (event.type !== 'AGUI_EVENT') return context
      const next = reduceAguiEvent(context, event.event, event.id)
      if (event.event.type === 'RUN_ERROR')
        return { ...next, error: String(event.event.message ?? 'run error') }
      return next
    }),
    reset: assign(() => ({
      messages: [],
      currentRunId: null,
      lastEventId: 0,
      error: null,
      usage: null,
    })),
    hydrate: assign(({ event }) => {
      if (event.type !== 'HYDRATE') return {}
      // 历史会话的用量未知——pi_get_messages 的消息 usage 后续可聚合
      return { messages: event.messages, currentRunId: null, error: null, usage: null }
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
        AGUI_EVENT: [
          // streaming 中另一 runId 的 RUN_STARTED：HTTP 流无连接亲和性，
          // 断线重连重放/多 run 同缓冲都是常态（§0.3 交错语义）——接受为
          // 新 run 段（reduce 追加新 assistant 消息），只告警不炸树。
          {
            guard: 'isRunStartViolation',
            actions: ({ context, event }) => {
              if (event.type !== 'AGUI_EVENT') return
              console.warn(
                `[turn] streaming 中收到新 RUN_STARTED（run=${String(event.event.runId ?? '')}，当前=${context.currentRunId}）——按交错接受`,
              )
            },
          },
          { guard: 'isRunEnd', target: 'idle', actions: 'reduce' },
          { actions: 'reduce' },
        ],
      },
    },
  },
})
