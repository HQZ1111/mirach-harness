/**
 * pi 会话历史 → 聊天投影的纯映射（runtime 与会话静态投影面板共用的
 * 数据面——无 React、无状态）。
 *
 * ## 2026-11-15：按 turn 合并（ZCode 一个 turn 一个工作段的前提）
 *
 * ZCode 的 turn = 一条 user 行 + 其后**全部** assistant 行，工作段头「已工作
 * N 分 M 秒」按 turn 计。pi 的历史里，一次工具循环会落成**多条** assistant
 * 消息（文本→工具→文本→工具→最终回答），若逐条投影，聊天流里一个 turn 就会
 * 冒出好几个「已处理」头（旧版实测症状）。
 *
 * 故本模块把**连续 assistant 消息（直到下一条 user）合并成一条** TurnMessage：
 * - parts 顺序原样保留（text / thinking / toolCall / image）；
 * - toolResult 仍按 toolCallId 归并到对应部件（可跨被合并的消息）；
 * - 部件计时：tool-call 的 startedAt = 所在 assistant 消息的 timestamp、
 *   completedAt = 对应 toolResult 的 timestamp；text/thinking 至少写所在消息的
 *   startedAt，并在下一条消息到达时补 completedAt（= 下一条消息 timestamp，
 *   即「这段输出在被下一条消息取代时结束」）；
 * - 合并消息的 createdAt = 前一条 user 的 timestamp（无则首条 assistant），
 *   completedAt = 本轮最后一条消息的 timestamp —— 外层工作段时长 =
 *   completedAt − createdAt，与 ZCode 的 turn.activeMs 同口径。
 *
 * 实时路径（turn-actor）本来就是「run 一条消息」，不走这里；`convertTurnMessage`
 * 是两条路径的共用出口。
 */
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { TurnMessage, TurnPart, TurnUsage } from './turn-actor'

const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 旧版语音委托把内部 note + spoken context 直接写进了 user 消息内容，
 *  聊天区会显示英文 note 和 "[object Object]"（2026-11-15 用户："乱"）。
 *  新的委托只把用户那句话放进消息、其余走 runConfig；这里对**历史**做显示
 *  清洗：note 开头的消息只保留最后一个空行块（真正的 spoken prompt）。 */
const LEGACY_VOICE_NOTE_PREFIX =
  '[Note: this message is a delegation from a live spoken conversation.'

function cleanLegacyVoiceUserText(text: string): string {
  if (!text.startsWith(LEGACY_VOICE_NOTE_PREFIX)) return text
  const blocks = text.split(/\n{2,}/)
  const prompt = blocks.at(-1)?.trim()
  return prompt || text
}

/** pi Message 的最小形状（hydrate 输入；字段缺失时按类型收窄）。 */
interface PiMessageLike {
  role?: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** pi ToolOutput.details（edit 的 diff、submit_plan 的审批态等） */
  details?: unknown
  timestamp?: unknown
}

function readTimestamp(message: PiMessageLike): number | undefined {
  return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined
}

/** user 内容块 → 投影部件（text 拼接、白名单图片 → data URL、其余可见报错跳过）。 */
function userBlocksToParts(content: unknown): TurnPart[] {
  const blocks =
    typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
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
  return parts
}

/**
 * assistant 内容块 → 投影部件。`startedAt` 是该消息的 timestamp：
 * 每个部件都带上（文本/思考的 completedAt 由后续消息补齐，见 mergeAssistant）。
 */
function assistantBlocksToParts(content: unknown, startedAt: number | undefined): TurnPart[] {
  const blocks = Array.isArray(content) ? content : []
  const parts: TurnPart[] = []
  for (const b of blocks) {
    const blk = b as {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      arguments?: unknown
      data?: unknown
      mimeType?: unknown
    }
    if (blk.type === 'text' && typeof blk.text === 'string') {
      parts.push({ type: 'text', text: blk.text, ...(startedAt !== undefined ? { startedAt } : {}) })
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
        // 工具调用起始 = 产出该调用的 assistant 消息时刻（ZCode row.createdAt 同口径）
        ...(startedAt !== undefined ? { startedAt } : {}),
      })
    } else if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
      // pi 的 thinking 块（session jsonl：`{"type":"thinking","thinking":"…"}`）
      // → TurnPart thinking → convertTurnMessage 的 reasoning 部件。
      // 空串不产部件（空思考不占一行）。
      if (blk.thinking.trim().length > 0) {
        parts.push({
          type: 'thinking',
          text: blk.thinking,
          ...(startedAt !== undefined ? { startedAt } : {}),
        })
      }
    } else if (blk.type === 'thinking' || blk.type === 'redacted_thinking') {
      // redacted_thinking 无正文（pi 只给签名占位），不造假文本。
      console.error(`[pi] 历史 assistant 思考块无可渲染正文（type=${blk.type}）——跳过`)
    }
  }
  return parts
}

/** 被合并消息的文本/思考段：下一条消息到达即视为结束（补 completedAt）。 */
function closeOpenTextParts(parts: TurnPart[], endedAt: number): void {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type !== 'text' && part.type !== 'thinking') continue
    if (part.completedAt !== undefined) continue
    parts[i] = { ...part, completedAt: endedAt }
  }
}

/** 历史消息 → ContextDisplay 的用量快照：取**最后一条带非零 usage 的
 *  assistant**（pi 每条 assistant 都带 usage；input 已含历史，最后一条即
 *  当前上下文规模）。全零 = provider 没回传用量（DS 代理实测），返回 null，
 *  不把 0 当真实用量展示。
 *
 *  RUN_FINISHED.usage 的字段口径见 agui.rs：input/output/cacheRead/cacheWrite/
 *  totalTokens 原样映射；costUsd 取 cost.total。 */
export function usageFromPiMessages(
  messages: readonly unknown[],
): TurnUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = messages[i]
    if (typeof record !== 'object' || record === null) continue
    const msg = record as Record<string, unknown>
    if (msg.role !== 'assistant') continue
    const raw = msg.usage
    if (typeof raw !== 'object' || raw === null) continue
    const u = raw as Record<string, unknown>
    const num = (key: string): number | undefined =>
      typeof u[key] === 'number' ? (u[key] as number) : undefined
    const cost =
      typeof u.cost === 'object' && u.cost !== null
        ? (u.cost as Record<string, unknown>).total
        : undefined
    const usage: TurnUsage = {
      inputTokens: num('input'),
      outputTokens: num('output'),
      cachedInputTokens: num('cacheRead'),
      cacheWriteTokens: num('cacheWrite'),
      totalTokens: num('totalTokens'),
      ...(typeof cost === 'number' ? { costUsd: cost } : {}),
    }
    const nonZero = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.cacheWriteTokens,
      usage.totalTokens,
    ].some((n) => (n ?? 0) > 0)
    return nonZero ? usage : null
  }
  return null
}

/** pi Message JSON → 聊天投影（真相在 pi）——**模块级纯函数**（会话静态
 *  投影面板复用，见 session-thread-pane）。
 *
 *  合并规则见模块头；toolResult 的孤儿结果（无宿主部件）跳过并可见报错。 */
export function hydratePiMessages(
  history: Record<string, unknown>[],
  /** 稳定行身份（尾页水合的原始条目 id）：跨页 prepend 时 React key / 树节点身份不漂移。 */
  entryIds?: readonly (string | undefined)[],
): TurnMessage[] {
  const out: TurnMessage[] = []
  /** 当前 turn 的合并目标（assistant 消息）；遇到 user 清空。 */
  let pendingAssistant: {
    message: TurnMessage
    parts: TurnPart[]
    lastTimestamp: number | undefined
  } | null = null

  const closePendingTurn = () => {
    if (!pendingAssistant) return
    if (pendingAssistant.lastTimestamp !== undefined) {
      pendingAssistant.message.completedAt = pendingAssistant.lastTimestamp
    }
    pendingAssistant = null
  }

  for (let i = 0; i < history.length; i++) {
    const m = history[i] as PiMessageLike
    const timestamp = readTimestamp(m)

    if (m.role === 'user') {
      closePendingTurn()
      const parts = userBlocksToParts(m.content)
      const content: string | TurnPart[] =
        parts.length === 0
          ? ''
          : parts.length === 1 && parts[0]!.type === 'text'
            ? cleanLegacyVoiceUserText(parts[0]!.text)
            : parts
      out.push({
        id: entryIds?.[i]
          ? `msg-${entryIds[i]}-user`
          : `hydrate-${i}-user`,
        role: 'user',
        content,
        ...(timestamp !== undefined ? { createdAt: new Date(timestamp) } : {}),
      })
      continue
    }

    if (m.role === 'assistant') {
      const parts = assistantBlocksToParts(m.content, timestamp)
      if (pendingAssistant) {
        // 合并：上一段的开放文本以本消息时刻收尾，parts 顺序追加
        if (timestamp !== undefined) {
          closeOpenTextParts(pendingAssistant.parts, timestamp)
        }
        pendingAssistant.parts.push(...parts)
        pendingAssistant.message.content = pendingAssistant.parts
        if (timestamp !== undefined) pendingAssistant.lastTimestamp = timestamp
        continue
      }
      // 新 turn 的 assistant：createdAt 取前一条 user 的时间戳（ZCode 的
      // turn.startedAt = 用户提交时刻），没有则退回首条 assistant 自身时间。
      let createdAt = timestamp
      for (let j = out.length - 1; j >= 0; j--) {
        const prev = out[j]!
        if (prev.role === 'user') {
          if (prev.createdAt) createdAt = prev.createdAt.getTime()
          break
        }
      }
      const message: TurnMessage = {
        id: entryIds?.[i]
          ? `msg-${entryIds[i]}-assistant`
          : `hydrate-${i}-assistant`,
        role: 'assistant',
        content: parts,
        ...(createdAt !== undefined ? { createdAt: new Date(createdAt) } : {}),
      }
      out.push(message)
      pendingAssistant = { message, parts, lastTimestamp: timestamp }
      continue
    }

    if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
      const resultBlocks = Array.isArray(m.content) ? m.content : []
      // **result 与流式路径同形**（2026-11-03 修）：pi 的 ToolExecutionEnd
      // 携带完整 ToolOutput `{content, details?, isError}`，历史里也是对象
      // 形状——details（edit 的 diff、submit_plan 的审批态）不能丢。
      const result: Record<string, unknown> = {
        content: resultBlocks,
        isError: m.isError === true,
      }
      if (m.details !== undefined && m.details !== null) {
        result.details = m.details
      }
      let matched = false
      if (pendingAssistant) {
        if (timestamp !== undefined) {
          // 工具结果到达 = 此前的文本输出已结束（比「等下一条 assistant」更准）
          closeOpenTextParts(pendingAssistant.parts, timestamp)
        }
        // 合并后的当前 turn 就是自然边界；回溯兜底只在上一条 assistant
        // 已闭合的历史快照出现（不会被本次合并产生）。
        const parts = pendingAssistant.parts
        for (let j = parts.length - 1; j >= 0; j--) {
          const p = parts[j]!
          if (p.type !== 'tool-call' || p.toolCallId !== m.toolCallId) continue
          parts[j] = {
            ...p,
            result,
            isError: m.isError === true,
            ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
          }
          matched = true
          break
        }
      }
      if (!matched) {
        console.error(
          `[pi] 历史 toolResult 找不到宿主部件（toolCallId=${m.toolCallId}）——跳过`,
        )
      }
      if (pendingAssistant && timestamp !== undefined) {
        pendingAssistant.lastTimestamp = timestamp
      }
      continue
    }
  }
  closePendingTurn()
  return out
}

/** TurnMessage → ThreadMessageLike（ExternalStore convertMessage 的纯映射，
 *  主 runtime 与会话分栏运行时共用——单源防漂移）：
 *  - tool-call：args/result 断言为运行时 JSON 形状（pi arguments Value）；
 *    `startedAt`/`completedAt` → assistant-ui 的 `timing`
 *    (`ToolCallTiming{startedAt, completedAt?}`)——官方 useToolCallElapsed
 *    读它做工具卡耗时（官方注释明说 host 自己提供权威时间）；
 *  - thinking → reasoning（ThreadMessageLike 的 ReasoningMessagePart，
 *    §2.2 thinking 流式；TurnPart 内部保持 thinking）；
 *  - text / image 原样透传；createdAt 透传（day-separator 消费）；
 *  - **工作段时长**：message.metadata.custom 带 `workStartedAt` /
 *    `workEndedAt`（= createdAt / completedAt，history 有、实时缺）
 *    ——`work-segment.ts` 的 resolveWorkSegmentStatus 在外层「已工作
 *    N 分 M 秒」上用它兜底无工具计时的轮次。 */
export function convertTurnMessage(m: TurnMessage): ThreadMessageLike {
  const workStartedAt = m.createdAt?.getTime()
  const custom: Record<string, number> = {}
  if (workStartedAt !== undefined && Number.isFinite(workStartedAt)) {
    custom.workStartedAt = workStartedAt
  }
  if (m.completedAt !== undefined) custom.workEndedAt = m.completedAt
  return {
    id: m.id,
    role: m.role,
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
    // 文件引用附件（视频/音频/文档）：assistant-ui 的 message attachments
    // 通道（UserMessageAttachments 渲染 chip）。content 必须给空数组——
    // fromThreadMessageLike 会对它做 map。size/kind/sourcePath 是宿主扩展
    // 字段（`...att` 原样存活），chip 用来显示类型/大小，消息 sent 后也会
    // 保留在乐观投影里。
    ...(m.attachments && m.attachments.length > 0
      ? {
          attachments: m.attachments.map((a) => ({
            id: a.id,
            type: a.kind === 'image' ? 'image' : a.kind === 'document' ? 'document' : 'file',
            name: a.name,
            contentType: a.mime,
            content: [],
            status: { type: 'complete' as const },
            kind: a.kind,
            size: a.size,
            sourcePath: a.path,
          })) as unknown as ThreadMessageLike['attachments'],
        }
      : {}),
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => {
            if (p.type === 'tool-call') {
              // startedAt 由 tool_execution start / 所在消息时刻记录；缺它就不给
              // timing（hook 会返回 undefined，不编造时长）。
              const { startedAt, completedAt, ...rest } = p
              return {
                ...rest,
                args: rest.args as never,
                result: rest.result as never,
                ...(startedAt === undefined
                  ? {}
                  : {
                      timing: {
                        startedAt,
                        ...(completedAt === undefined ? {} : { completedAt }),
                      },
                    }),
              }
            }
            if (p.type === 'thinking') {
              const { startedAt, completedAt, ...rest } = p
              return {
                type: 'reasoning' as const,
                text: rest.text,
                ...(startedAt === undefined
                  ? {}
                  : { providerMetadata: { mirach: { startedAt, ...(completedAt === undefined ? {} : { completedAt }) } } }),
              }
            }
            if (p.type === 'text') {
              // text 部件不参与工具计时；时间只留在 TurnPart 投影里（assistant-ui
              // 的 TextMessagePart 没有 timing 字段），故此处不额外携带。
              return { type: 'text' as const, text: p.text }
            }
            return p
          }),
  }
}
