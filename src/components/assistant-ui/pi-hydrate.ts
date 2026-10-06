/**
 * pi 会话历史 → 聊天投影的纯映射（runtime 与会话静态投影面板共用的
 * 数据面——无 React、无状态）。
 */
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
}
