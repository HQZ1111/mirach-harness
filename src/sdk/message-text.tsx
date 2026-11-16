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
 * - `decorateText` —— 段落级子节点的装饰钩子（hermes-bots 的 @提及高亮）
 *
 * ## 宿主对偶（2026-11-17 修正：不能借用 `MarkdownText`）
 *
 * 宿主主聊天区的 `MarkdownText` 是 **assistant-ui 的 message-part 原语**
 * （`MarkdownTextPrimitive` 从 part 上下文读文本，不看 props）。群聊房间不在
 * part scope 里——借它渲染会抛 `The current scope does not have a "part"
 * property`，被 ContribBoundary 整块隐藏（实测：发第一条消息后房间白屏）。
 *
 * 所以这份实现用**独立渲染管线**（react-markdown + GFM + 数学），与官方
 * `generative-ui.tsx` 的先例同款；`decorateText` 应用在 p/li/td 的直接子节点
 * 上（与上游 streamdown 覆盖路径的 `groupMentionComponents` 同一约定）。
 *
 * 与上游的诚实差异：上游的 `disableArtifacts`（禁用 ```svg/```mermaid 富围栏）
 * 在宿主没有对应开关——宿主的代码块渲染本来就是纯文本高亮，不做富渲染，
 * 所以语义上已经等价，无需额外参数。
 */
import type { FC, ReactNode } from 'react'
import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
// 公式样式（Vite 去重；不 import 的消费面会看到无排版裸公式——同
// markdown-text.tsx 的注释）。
import 'katex/dist/katex.min.css'


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
  /** 只读预览（链接不可点、不做交互式渲染）。 */
  previewOnly?: boolean
  /** 文本装饰钩子（上游用于 @提及 / 代码引用高亮）。 */
  decorateText?: unknown
}

type DecorateText = (children: ReactNode) => ReactNode

/** 段落级容器（p/li/td）的直接子节点过装饰钩子（上游同约定）。 */
const withDecoration =
  (tag: 'p' | 'li' | 'td', decorate: DecorateText | null) =>
  ({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode } & Record<string, unknown>) => {
    const Tag = tag
    return <Tag {...props}>{decorate ? decorate(children) : children}</Tag>
  }

export const MessageTextContent: FC<MessageTextContentProps> = ({
  text,
  previewOnly = false,
  decorateText,
}) => {
  const decorate = typeof decorateText === 'function' ? (decorateText as DecorateText) : null

  const components = useMemo(
    () => ({
      p: withDecoration('p', decorate),
      li: withDecoration('li', decorate),
      td: withDecoration('td', decorate),
      a: ({ node: _node, children, href, ...props }: { node?: unknown; children?: ReactNode; href?: string } & Record<string, unknown>) =>
        previewOnly ? (
          <span {...props}>{children}</span>
        ) : (
          <a
            {...props}
            href={href}
            rel="noreferrer noopener"
            target="_blank"
            className="underline decoration-(--ui-stroke-secondary) underline-offset-2"
          >
            {children}
          </a>
        ),
      pre: ({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode } & Record<string, unknown>) => (
        <pre
          {...props}
          className="bg-(--ui-bg-tertiary) my-2 overflow-x-auto rounded-md px-2.5 py-2 text-[0.8125rem] leading-5"
        >
          {children}
        </pre>
      ),
      code: ({ node: _node, children, ...props }: { node?: unknown; children?: ReactNode } & Record<string, unknown>) => (
        <code {...props} className="font-mono text-[0.8125rem]">
          {children}
        </code>
      ),
    }),
    [decorate, previewOnly],
  )

  // 空文本不渲染（上游同语义：空 delta 不产生节点）
  if (!text) return null

  return (
    <div data-slot="message-text-content" data-preview-only={previewOnly || undefined}>
      <ReactMarkdown
        components={components as never}
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 上游 `Streamdown`：流式 Markdown 渲染器（独立 npm 包）。
 *
 * 宿主用同一个独立渲染管线承担——群聊历史与流式成员回复都经这里。
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
