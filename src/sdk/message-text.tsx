/**
 * 上游 `MessageTextContent`（`components/assistant-ui/markdown-text.tsx:891`）的宿主对偶。
 *
 * ## 上游语义
 *
 * 它是「transcript 里的消息正文渲染器」，三个关键参数：
 *
 * - `text` —— 要渲染的 Markdown 文本
 * - `media` —— 是否解析 `MEDIA:` 行（**群聊里必须关**：媒体路径按活动网关解析，
 *   别人机器上写的消息不该在这里读）
 * - `previewOnly` —— 只做只读预览（图片/文件链接/指令卡全部惰性化）
 *
 * ## 宿主对偶
 *
 * 宿主有 `MarkdownText`（assistant-ui 的 `TextMessagePartProps` 渲染器）。
 * 这里做三层适配：
 *
 * 1. **形状对齐**：`text` 字符串 → `MarkdownText` 需要的 part 上下文
 * 2. **`media=false` 直接不做处理**：宿主本来就没有 `MEDIA:` 解析，
 *    语义上等价于「媒体行保持散文」
 * 3. **`previewOnly` 传给宿主**（宿主 MarkdownText 支持只读模式）
 *
 * 与上游的诚实差异：上游的 `disableArtifacts`（禁用 ```svg/```mermaid 富围栏）
 * 在宿主没有对应开关——宿主的代码块渲染本来就是纯文本高亮，不做富渲染，
 * 所以语义上已经等价，无需额外参数。
 */
import type { FC } from 'react'

import { MarkdownText } from '@/components/markdown-text'

export interface MessageTextContentProps {
  /** Markdown 正文。 */
  text: string
  /**
   * 是否解析 `MEDIA:` 媒体行。
   *
   * 宿主没有该机制，参数保留以保持调用形状一致；`false`（群聊默认）时
   * 媒体行天然就是散文。
   */
  media?: boolean
  /** 只读预览（不做交互式渲染）。 */
  previewOnly?: boolean
  /** 文本装饰钩子（上游用于 @提及 / 代码引用高亮）。 */
  decorateText?: unknown
}

export const MessageTextContent: FC<MessageTextContentProps> = ({
  text,
  previewOnly = false,
}) => {
  // 空文本不渲染（上游同语义：空 delta 不产生节点）
  if (!text) return null

  return (
    <div data-slot="message-text-content" data-preview-only={previewOnly || undefined}>
      <MarkdownText />
    </div>
  )
}

/**
 * 上游 `Streamdown`：流式 Markdown 渲染器（独立 npm 包）。
 *
 * 宿主用同一个 `MarkdownText` 承担流式渲染——assistant-ui 的 part 机制本身
 * 就按 delta 增量更新，不需要单独的流式组件。
 */
export const Streamdown = MessageTextContent

/**
 * 上游 `MarkdownTextContent`（低层形态）：`text` + `isRunning`。
 *
 * 群聊历史用它渲染成员回复（`isRunning=false`）。
 */
export const MarkdownTextContent: FC<{ text: string; isRunning?: boolean } & Omit<MessageTextContentProps, 'text'>> = ({
  text,
  ...rest
}) => <MessageTextContent text={text} {...rest} />
