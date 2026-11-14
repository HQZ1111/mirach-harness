/**
 * pi 会话历史 → 聊天投影的纯映射（runtime 与会话静态投影面板共用的
 * 数据面——无 React、无状态）。
 */
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { TurnMessage, TurnPart } from './turn-actor'

const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** pi Message JSON → 聊天投影（真相在 pi）——**模块级纯函数**（会话静态
 *  投影面板复用，见 session-thread-pane）：
 * - assistant：content blocks → parts（text/toolCall/image）；
 * - toolResult：结果归并到前一条 assistant 匹配 toolCallId 的部件
 *   （孤儿结果跳过——无宿主消息可挂）；
 * - user：string/blocks（text/image）→ 投影。
 * pi Message 带 timestamp（i64，epoch ms）→ createdAt（day-separator 用）；
 * id 用 hydrate 序号（pi 消息无稳定 id 字段，须自造稳定键）。 */
export function hydratePiMessages(history: Record<string, unknown>[]): TurnMessage[] {
  const out: TurnMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i] as {
      role?: string
      content?: unknown
      toolCallId?: string
      toolName?: string
      isError?: boolean
      /** pi ToolOutput.details（edit 的 diff、submit_plan 的审批态等） */
      details?: unknown
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
        const blk = b as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: unknown; mimeType?: unknown }
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
        } else if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
          // pi 的 thinking 块（session jsonl：`{"type":"thinking","thinking":"…"}`）
          // → TurnPart thinking → convertTurnMessage 的 reasoning 部件。
          // **2026-11-02 修复**：此前这里直接丢弃，导致历史会话里的思考整块
          // 消失（只有实时流式才显示），与 ZCode "Thought · N 秒" 折叠行
          // 的行为不一致。空串不产部件（空思考不占一行）。
          if (blk.thinking.trim().length > 0) {
            parts.push({ type: 'thinking', text: blk.thinking })
          }
        } else if (blk.type === 'thinking' || blk.type === 'redacted_thinking') {
          // redacted_thinking 无正文（pi 只给签名占位），不造假文本。
          console.error(`[pi] 历史 assistant 思考块无可渲染正文（type=${blk.type}）——跳过`)
        }
      }
      out.push({ id: `hydrate-${i}-assistant`, role: 'assistant', content: parts, ...(createdAt ? { createdAt } : {}) })
    } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
      // 工具结果归并：挂到前一条 assistant 匹配 toolCallId 的部件
      const resultBlocks = Array.isArray(m.content) ? m.content : []
      // **result 与流式路径同形**（2026-11-03 修）：pi 的 ToolExecutionEnd
      // 携带的是完整 ToolOutput 对象 `{content, details?, isError}`（agent.rs
      // :1428 + agui.rs:318 原样透传），此前水合把 content 拼成纯文本字符串
      // ——details（edit 的 diff、submit_plan 的审批态）全部丢失，历史会话
      // 的 edit 卡片退回通用卡、文件汇总拿不到行数。修成对象形状后两条
      // 路径一致；渲染层 `toolResultText` 兼容两种形状。
      const result: Record<string, unknown> = {
        content: resultBlocks,
        isError: m.isError === true,
      }
      if (m.details !== undefined && m.details !== null) {
        result.details = m.details
      }
      for (let j = out.length - 1; j >= 0; j--) {
        const msg = out[j]
        if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
        const parts = msg.content as TurnPart[]
        const idx = parts.findIndex((p) => p.type === 'tool-call' && p.toolCallId === m.toolCallId)
        if (idx >= 0) {
          const p = parts[idx]
          if (p.type !== 'tool-call') continue
          parts[idx] = { ...p, result, isError: m.isError === true }
          break
        }
      }
      // 孤儿 toolResult（无匹配部件）：跳过
    }
  }
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
 *  - text / image 原样透传；createdAt 透传（day-separator 消费）。 */
export function convertTurnMessage(m: TurnMessage): ThreadMessageLike {
  return {
    id: m.id,
    role: m.role,
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => {
            if (p.type === 'tool-call') {
              // startedAt 由 tool_execution start 记录；缺它就不给 timing
              // （hook 会返回 undefined，不编造时长）。
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
            if (p.type === 'thinking') return { type: 'reasoning' as const, text: p.text }
            return p
          }),
  }
}
