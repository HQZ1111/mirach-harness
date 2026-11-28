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
import type { TurnAttachment } from './attachments'

export interface TurnMessage {
  id: string
  role: 'user' | 'assistant'
  /** string = 纯文本（用户消息/简单助手）；parts = 结构化（文本 + 工具调用 + 图片） */
  content: string | TurnPart[]
  /** 消息时刻：run 段 = RUN_STARTED 到达时刻、乐观用户消息 = 提交时刻、
   * 历史会话 = pi Message.timestamp（i64，epoch ms）。day-separator 用。 */
  createdAt?: Date
  /** 本轮结束时刻（epoch ms）：历史水合取本轮最后一条 pi 消息的 timestamp；
   * 实时路径不写（外层工作段时长回落到部件计时）。外层「已工作 N 分 M 秒」
   * 的结束边界（ZCode turn.activeMs 同口径）。 */
  completedAt?: number
  /** 文件引用附件（视频/音频/文档）：图片走 content 的 image part（原生
   * 多模态），这些没有原生块，只在本轮投影里留 chip + 路径元数据
   * （convertTurnMessage 映射成 ThreadMessageLike.attachments）。 */
  attachments?: TurnAttachment[]
}

/** 结构化内容部件（ThreadMessageLike 兼容形状；args 限 JSON 对象——
 * ThreadMessageLike 的 tool-call args 要求 ReadonlyJSONObject）。
 * thinking part 经 runtime convertMessage 映射为 assistant-ui 的
 * reasoning part（Reasoning 组件消费，§2.2 thinking 流式）。
 * image part 的 image 是 data URL（FileReader.readAsDataURL 产物 /
 * hydrate 时由 pi ContentBlock::Image 的 base64 拼装）。 */
export type TurnPart =
  | {
      type: 'text'
      text: string
      /** 部件起始时刻（epoch ms）——历史水合写所在 pi 消息的 timestamp；
       * 实时流式不写（文本计时对外层工作段无意义，见 work-segment）。 */
      startedAt?: number
      /** 部件结束时刻——历史水合里 = 下一条消息的 timestamp（该段输出
       * 被下一条消息取代即结束）。 */
      completedAt?: number
    }
  | {
      type: 'thinking'
      text: string
      /** 见 text 部件的同名字段。 */
      startedAt?: number
      completedAt?: number
    }
  | { type: 'image'; image: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      args?: Record<string, unknown>
      result?: unknown
      isError?: boolean
      /** 工具执行起始时刻（epoch ms）——CUSTOM tool_execution start 到达时记。
       * assistant-ui 的 `useToolCallElapsed` 读 `part.timing`（官方注释：
       * "hosts that need authoritative timings supply the field themselves"），
       * convertTurnMessage 把它转成 ToolCallTiming{startedAt,completedAt}。 */
      startedAt?: number
      /** 结果落地时刻（epoch ms）——end 到达时记；缺席 = 仍在跑。 */
      completedAt?: number
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

/**
 * 提供方重试快照（AG-UI CUSTOM name=provider_retry）。
 *
 * 引擎在上游 provider 瞬时失败（429/配额/过载/5xx）后、退避等待前发一次
 * （`agui.rs` 的 RetryScheduled → CUSTOM provider_retry）。
 *
 * 为什么必须有：此前这个事件被**完全忽略**，用户只看到会话“卡住很久 → 突然
 * 报错停下”，中间 10 次重试全无感知（2026-11-27 用户：“模型出问题了，不显示
 * 自动重连”）。hermes 在 assistant-message 里显示「Retrying at … — in Ns」+ 取消，
 * 这里用同一语义。
 *
 * run 结束（FINISHED/ERROR）、新 run 开始、RESET 清空。
 */
export type ProviderRetrySnapshot = {
  /** 第几次重试（1 起，首发不计）。 */
  attempt: number
  /** 本次请求允许的最大重试次数。 */
  maxRetries: number
  /** 本次退避时长 ms。 */
  delayMs: number
  /** 失败原因（引擎原文，展示层已由 agui 清洗过 HTML）。 */
  error: string
  /** 收到该事件的本机时刻（ms）——UI 据此倒计时。 */
  scheduledAt: number
}

/** 当前答案段边界：最后一个 tool-call 之后是否已有 text。 */
function segmentBounds(parts: TurnPart[]): { lastTool: number; lastText: number } {
  let lastTool = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.type === 'tool-call') {
      lastTool = i
      break
    }
  }
  let lastText = -1
  for (let i = parts.length - 1; i > lastTool; i--) {
    if (parts[i]!.type === 'text') {
      lastText = i
      break
    }
  }
  return { lastTool, lastText }
}

/**
 * 文本增量：**追加到当前答案段已有的 text part**，而不是"最后一个 part 是
 * text 才合并"。
 *
 * 2026-11-15 用户截图："我是一个 / 思考 / 正文" 在同一轮里穿插。真实流式
 * 顺序是 text → thinking → text，旧实现把第二段文本 push 成新 part，于是
 * live 投影是 [text1, thinking, text2]；而 pi 最终落盘是 [thinking, text]，
 * 导致回复过程中和完成后长得不一样。
 * 新规则：同一 tool 边界内只保留一个 text part，thinking 一律插到该 text
 * part 之前（对齐落盘形状）；工具之后的文本才是新答案段。
 */
function appendTextDelta(parts: TurnPart[], delta: string): void {
  const { lastTool, lastText } = segmentBounds(parts)
  if (lastText > lastTool) {
    const part = parts[lastText] as Extract<TurnPart, { type: 'text' }>
    parts[lastText] = { ...part, text: part.text + delta }
    return
  }
  parts.push({ type: 'text', text: delta })
}

/** thinking 增量/开块：插到当前答案段 text part 之前（无 text 则尾部）。 */
function appendThinkingDelta(parts: TurnPart[], delta: string, openBlock: boolean): boolean {
  const { lastTool, lastText } = segmentBounds(parts)
  const insertAt = lastText > lastTool ? lastText : parts.length
  let thinkingAt = -1
  for (let i = insertAt - 1; i > lastTool; i--) {
    if (parts[i]!.type === 'thinking') {
      thinkingAt = i
      break
    }
  }
  if (openBlock) {
    // 重复 START：紧贴 text 之前已有空 thinking = 幂等（返回 false 让调用方
    // 保持 messages/parts 引用不变，增量同步门依赖这个身份）
    if (thinkingAt >= 0 && (parts[thinkingAt] as Extract<TurnPart, { type: 'thinking' }>).text === '') {
      return false
    }
    parts.splice(insertAt, 0, { type: 'thinking', text: '' })
    return true
  }
  if (thinkingAt >= 0) {
    const part = parts[thinkingAt] as Extract<TurnPart, { type: 'thinking' }>
    parts[thinkingAt] = { ...part, text: part.text + delta }
    return true
  }
  parts.splice(insertAt, 0, { type: 'thinking', text: delta })
  return true
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
  /** 提供方自动重试中（CUSTOM name=provider_retry；run 收尾/新 run 清） */
  providerRetry: ProviderRetrySnapshot | null
  /** 用户中断标记：pi_interrupt 成功后置位，run 结束后 thread.aui 据此
   * 展示 StoppedRun（继续/丢弃）；新 run 开始、RESET、HYDRATE 清。 */
  interrupted: boolean
}

export type AguiEvent = { type: string } & Record<string, unknown>

export type TurnEvent =
  | { type: 'AGUI_EVENT'; event: AguiEvent; id: number }
  | { type: 'USER_SUBMIT'; text: string; messageId: string; images?: string[]; files?: TurnAttachment[] }
  /** 新会话（New Chat）：清空全部轮次态（§7-4 会话切换） */
  | { type: 'RESET' }
  /** 打开历史会话：注入 pi 会话历史（真相在 pi，机器只收投影快照） */
  | { type: 'HYDRATE'; messages: TurnMessage[]; usage?: TurnUsage | null }
  /** 上滚补页（hermes tail-hydration）：把更老的一页消息插到现有 store 头部。
   *  与 HYDRATE 不同——保留已加载行与在途 run 段，仅前插。 */
  | { type: 'PREPEND_HISTORY'; messages: TurnMessage[] }
  /** 视图窗 retention：滚离顶部后释放最老的行（hermes boundRetainedTranscript
   *  的宿主对偶；actor 只保最新 keep 条）。 */
  | { type: 'TRIM_HISTORY'; keep: number }
  /** 用户中断已成功（pi_interrupt IPC 返回后）——置 interrupted 标记，
   * run 结束后 StoppedRun 据此展示中断态 */
  | { type: 'CANCEL_MARK' }
  /** StoppedRun 的继续/丢弃被处理——清中断标记 */
  | { type: 'INTERRUPT_CLEAR' }
  /** 多会话并存（2026-11-28）：把游标拨到事件缓冲的指定 seq——新 actor
   *  从文件水合后跳过缓冲里已落盘的历史（文件 ≥ 缓冲），只收之后的
   *  增量。不改投影，只动 lastEventId。 */
  | { type: 'SEEK'; id: number }

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
  // ── 游标去重（根因修复，2026-11-15）────────────────────────────────────
  // SSE 事件带单调递增序号（服务端 Event::id(seq)）。重连重放/重复投递
  // 会把**已应用过**的事件再送一次——旧代码只把 id 记为游标、从不比较，
  // 于是同一事件（如 tool_execution start）被应用两次 → 同一 toolCallId
  // 出现两个部件 → assistant-ui useResources 抛 Duplicate key 崩渲染。
  // 这里按序号丢弃 id <= 已应用游标的整事件（游标不倒退），并 console.warn
  // 让重放可见（不静默）。id=0（无序号事件）不受影响。
  if (id > 0 && id <= ctx.lastEventId) {
    console.warn(
      `[turn] 丢弃重放事件 seq=${id}（已应用游标 ${ctx.lastEventId}，type=${ev.type}）`,
    )
    return ctx
  }
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
        // 新 run 开始清上一 run 的重试提示（只描述上一个 run）
        providerRetry: null,
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
          break
        }
        const parts: TurnPart[] = [...c]
        appendTextDelta(parts, delta)
        messages[i] = { ...messages[i], content: parts }
        break
      }
      return { ...next, messages }
    }
    case 'THINKING_TEXT_MESSAGE_START': {
      // 思考块开始：插到当前答案段 text 之前（live 投影对齐 pi 落盘形状
      // [thinking, text]，避免 text/thinking/text 穿插）。
      const messages = [...ctx.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const c = messages[i].content
        const parts: TurnPart[] = typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : [...c]
        const changed = appendThinkingDelta(parts, '', true)
        if (changed) messages[i] = { ...messages[i], content: parts }
        break
      }
      return { ...next, messages }
    }
    case 'THINKING_TEXT_MESSAGE_CONTENT': {
      // 追加到当前答案段之前的 thinking；无则插到 text 前（START 缺失时
      // CONTENT 自立——Rust 侧 ThinkingStart 映射补齐前仍可用）。
      const messages = [...ctx.messages]
      const delta = String(ev.delta ?? '')
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const c = messages[i].content
        const parts: TurnPart[] = typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : [...c]
        appendThinkingDelta(parts, delta, false)
        messages[i] = { ...messages[i], content: parts }
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
        const startedAt = Date.now()
        // **投影幂等（协议契约，不是兜底）**：tool 事件流是 at-least-once——
        // ①SSE 断线重放（同 seq 已由入口游标挡掉）；②**水合与流的竞态**：
        // 切会话/挂载时先 pi_get_messages 水合（历史里已有该 toolCall 部件），
        // 而 SSE 是 150ms 轮询，水合前已产生、水合后才投递的
        // `tool_execution start` 会再挂一份 → 同一 toolCallId 两个部件 →
        // assistant-ui useResources 抛 "Duplicate key" 整窗崩（2026-11-15
        // 实锤 call_8c148f…）。toolCallId 是自然键：已存在即**跳过**该事件
        // （不合并、不改写既有部件——result 由后续 end 事件填），console.warn
        // 让竞态可见。这与"合并掩盖"不同：重复事件在语义上就是 no-op。
        for (const m of messages) {
          const c = m.content
          if (typeof c === 'string') continue
          if (
            c.some((p) => p.type === 'tool-call' && p.toolCallId === value.toolCallId)
          ) {
            console.warn(
              `[turn] tool_execution start 重复（${value.toolCallId}，水合/流竞态或重放）——已存在部件，跳过`,
            )
            return next
          }
        }
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant') continue
          const c = messages[i].content
          const parts: TurnPart[] =
            typeof c === 'string'
              ? c
                ? [{ type: 'text', text: c }, { type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args, startedAt }]
                : [{ type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args, startedAt }]
              : [...c, { type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName ?? '', args, startedAt }]
          messages[i] = { ...messages[i], content: parts }
          break
        }
        return { ...next, messages }
      }
      if (ev.name === 'tool_execution' && value?.phase === 'end' && value.toolCallId) {
        const messages = [...ctx.messages]
        const completedAt = Date.now()
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role !== 'assistant' || typeof messages[i].content === 'string') continue
          const parts = (messages[i].content as TurnPart[]).map((p) =>
            p.type === 'tool-call' && p.toolCallId === value.toolCallId
              ? { ...p, result: value.result, isError: value.isError === true, completedAt }
              : p,
          )
          messages[i] = { ...messages[i], content: parts }
          break
        }
        return { ...next, messages }
      }
      // 提供方自动重试（CUSTOM name=provider_retry）：引擎在退避等待前发一次。
      // 形状不符 console.error 可见并丢弃（渲染选择非吞错）。
      if (ev.name === 'provider_retry' && value && typeof value === 'object') {
        const v = value as {
          attempt?: unknown
          maxRetries?: unknown
          delayMs?: unknown
          error?: unknown
        }
        const attempt = typeof v.attempt === 'number' ? v.attempt : null
        const maxRetries = typeof v.maxRetries === 'number' ? v.maxRetries : null
        const delayMs = typeof v.delayMs === 'number' ? v.delayMs : null
        if (attempt === null || maxRetries === null || delayMs === null) {
          console.error('[turn] provider_retry 事件字段缺失——丢弃', v)
          return next
        }
        const snap: ProviderRetrySnapshot = {
          attempt,
          maxRetries,
          delayMs,
          error: typeof v.error === 'string' ? v.error : '',
          scheduledAt: Date.now(),
        }
        return { ...next, providerRetry: snap }
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
        // run 结束（无论成败）都不再有“重试中”——清掉，避免下一 run 残留。
        providerRetry: null,
      }
    }
    case 'RUN_ERROR':
      return {
        ...next,
        currentRunId: null,
        error: String(ev.message ?? 'run error'),
        providerRetry: null,
      }
    default:
      return next // run 外/未映射事件透传（§0.3-5）
  }
}

/**
 * 消息数组稳定化（流式增量同步，hermes
 * lib/incremental-external-store-runtime.ts 的「引用相等 = 未变」语义）：
 * 归约器保证未变消息段复用旧对象引用、只替换当前 run 段（尾段）；
 * 本函数是喂给 ExternalStore 前的最后一道门——
 * - prev/next 逐项引用相等（零变化重建，如重复 THINKING_START 的幂等
 *   路径）→ 返回 prev 数组本身：ExternalStore 的
 *   `oldStore.messages === store.messages` 快速通道命中，跳过全量转换
 *   与 repository 重写；
 * - 有变化/新增 → 返回 next（未变项已是旧引用，变化项是新对象）。
 * 纯函数，可单测；不改渲染结果（内容逐项相同，只动引用策略）。
 */
export function stabilizeMessages(prev: TurnMessage[], next: TurnMessage[]): TurnMessage[] {
  if (prev === next) return next
  if (prev.length !== next.length) return next
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) return next
  }
  return prev
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
        // **按 submission id 幂等**（2026-11-28）：队列 drain 重试、切换竞态、
        // 重放都可能重发同一条 USER_SUBMIT——同 id 已在本投影就不重复追加
        // （hermes admitted-submissions 的宿主最小对偶）。
        if (context.messages.some((m) => m.id === event.messageId)) {
          return context.messages
        }
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
            ...(event.files && event.files.length > 0
              ? { attachments: event.files }
              : {}),
          },
        ]
      },
    }),
    reduce: assign(({ context, event }) => {
      if (event.type !== 'AGUI_EVENT') return context
      // RUN_ERROR 的 error 写入在 reduceAguiEvent 内（case 'RUN_ERROR'）——
      // 早期版本在此重复 set，已并入归约器单一来源。
      const reduced = reduceAguiEvent(context, event.event, event.id)
      // 增量同步门：归约只新建当前 run 段（RUN_STARTED 前的旧段对象引用
      // 原样保留）；零变化重建复用旧数组本身，喂 ExternalStore 的引用
      // 不变 → core 走 messages 全等快速通道（stabilizeMessages 详注）。
      return { ...reduced, messages: stabilizeMessages(context.messages, reduced.messages) }
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
      providerRetry: null,
      interrupted: false,
    })),
    hydrate: assign(({ context, event }) => {
      if (event.type !== 'HYDRATE') return {}
      // **水合×live 对账**（2026-11-28；hermes reconciliation.ts 的对偶子集）：
      // 文件页是权威，但"文件还没落盘的实时行"不能被全量替换抹掉。actor 按
      // 会话分键，context 里未出现在 incoming（按 durable id = pi entryId）
      // 的行按三类保留：
      //  - 'user-' 开头 = 乐观提交（长会话冷开慢时最常撞，必留）；
      //  - currentRunId 非空（run 在途）= 本 run 段（流式回复/工具行，
      //    RUN_STARTED 只来一次，抹掉后增量无处落）；
      //  - 其余：createdAt 晚于文件页最后一行 = 实时追加但尚未 flush 到文件
      //    （时钟同机，pi timestamp 与本地 Date.now() 同基准）。
      // 分支切换/旧分支残留行的 createdAt 早于新页尾 → 不保留（文件是真相）。
      const lastIncomingAt = event.messages.reduce((acc, m) => {
        const t = m.createdAt instanceof Date ? m.createdAt.getTime() : 0
        return t > acc ? t : acc
      }, 0)
      const incomingIds = new Set(event.messages.map((m) => m.id))
      const pending = context.messages.filter((m) => {
        if (incomingIds.has(m.id)) return false
        if (m.id.startsWith('user-')) return true
        if (context.currentRunId !== null) return true
        const t = m.createdAt instanceof Date ? m.createdAt.getTime() : 0
        return lastIncomingAt > 0 && t > lastIncomingAt
      })
      // 在途 run 的游标保住：run 还没收尾时 currentRunId 归零会让后续增量
      // （message-write 事件）被「run 外丢弃」规则吞掉——视图停在半句。
      // run 真正结束时 RUN_FINISHED 照常收尾（isRunEnd 与 currentRunId 无关）。
      const keptRun =
        context.currentRunId !== null &&
        (pending.some((m) => m.id === context.currentRunId) ||
          event.messages.some((m) => m.id === context.currentRunId))
      // 历史会话的用量 = pi 最后一条 assistant 的 usage（runtime 用
      // usageFromPiMessages 提取；provider 未回传时为 null）。
      return {
        messages: pending.length > 0 ? [...event.messages, ...pending] : event.messages,
        currentRunId: keptRun ? context.currentRunId : null,
        error: null,
        usage: event.usage ?? null,
        compaction: null,
        providerRetry: null,
        interrupted: false,
      }
    }),
    prependOlder: assign(({ context, event }) => {
      if (event.type !== 'PREPEND_HISTORY' || event.messages.length === 0) return {}
      // 补页只在已有 store 上操作（空 store 说明会话已切走，丢弃由调用方守卫）
      return { messages: [...event.messages, ...context.messages] }
    }),
    trimHistory: assign(({ context, event }) => {
      if (event.type !== 'TRIM_HISTORY') return {}
      const keep = Math.max(0, Math.trunc(event.keep))
      if (keep === 0 || context.messages.length <= keep) return {}
      return { messages: context.messages.slice(context.messages.length - keep) }
    }),
    seek: assign(({ context, event }) => {
      if (event.type !== 'SEEK') return {}
      const id = Math.max(0, Math.trunc(event.id))
      // 只前移不后退：游标是"本会话已消费到的缓冲位置"，倒退会造成重放
      // （dedupe 门会挡掉，但游标语义就该单调）。
      return id > context.lastEventId ? { lastEventId: id } : {}
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
        PREPEND_HISTORY: { actions: 'prependOlder' },
        TRIM_HISTORY: { actions: 'trimHistory' },
        CANCEL_MARK: { actions: 'markCancelled' },
        INTERRUPT_CLEAR: { actions: 'clearInterrupt' },
        SEEK: { actions: 'seek' },
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
        PREPEND_HISTORY: { actions: 'prependOlder' },
        TRIM_HISTORY: { actions: 'trimHistory' },
        CANCEL_MARK: { actions: 'markCancelled' },
        INTERRUPT_CLEAR: { actions: 'clearInterrupt' },
        SEEK: { actions: 'seek' },
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
