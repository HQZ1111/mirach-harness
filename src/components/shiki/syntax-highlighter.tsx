'use client'

// ── 聊天代码块 SyntaxHighlighter ─────────────────────────────────────────
// 高亮内核 = **assistant-ui 上游 Elements 的 `shiki-highlighter`**
// （`components/assistant-ui/elements/shiki-highlighter.tsx`，从 assistant-ui
// registry 直接拉取；用户 2026-11-28："elements 这个不是 ass 的组件库吗，
// 不能直接拉吗？" + "对话的 code diff，Shiki highlighter 显示的不对"）。
// 上游实现：react-shiki/core + shiki/core（JS RegExp 引擎）、双主题
// `light-dark()`（跟随 app 的 color-scheme）、流式跳过 tokenize。
//
// 本文件只保留宿主侧的外壳（上游元素没有对应物）：
// ① mermaid 围栏 → MermaidDiagram（图渲染，不是代码高亮）；
// ② prose 判定 —— 像散文的围栏块直接当文本；
// ③ 预算 —— 超限放弃高亮，纯文本 200 行/块 + content-visibility:auto；
// ④ 卡片外壳（底色板 + 复制钮 + 折叠展开）。
//
// 旧的 shiki-block.tsx 缓存/分块管线不再参与聊天代码块（文件保留：预览
// 面板等调用方仍可复用）；宿主不再维护第二套高亮实现。
import { type FC, lazy, Suspense, useMemo } from 'react'
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'

// **懒加载**（2026-11-28 实锤：elements 的 shiki-highlighter 模块级
//  会把全部语言语法 + 主题
// 打进主包，首屏多解析数 MB、基线内存抬高——"启动卡"的观感来源之一）。
// lazy 后这个 chunk 只有第一个围栏代码块出现才加载；加载期间用与高亮输出
// 几何同高的纯文本上画（不闪空白）。
const AuiSyntaxHighlighter = lazy(() =>
  import('@/components/assistant-ui/elements/shiki-highlighter').then((m) => ({
    default: m.SyntaxHighlighter,
  })),
)
import { MermaidDiagram } from '@/components/assistant-ui/elements/mermaid-diagram'
import { CodeCard, CodeCardBody, CodeCopyButton } from './code-card'
import { ExpandableBlock } from './expandable-block'
import { chunkByLines, exceedsHighlightBudget, isLikelyProseCodeBlock } from './markdown-code'
import { CHUNK_LINES, EST_LINE_PX } from './shiki-config'

/** 超预算纯文本：~200 行/块，块间 content-visibility:auto 跳过视口外渲染。 */
const PlainCode: FC<{ code: string }> = ({ code }) => {
  const chunks = useMemo(() => chunkByLines(code, CHUNK_LINES), [code])

  if (chunks.length === 1) {
    return <code className="block whitespace-pre px-3 py-2.5">{code}</code>
  }

  return (
    <>
      {chunks.map((chunk, index) => (
        <code
          className="block whitespace-pre px-3 py-2.5 [content-visibility:auto]"
          key={index}
          style={{ containIntrinsicSize: `auto ${chunk.lines * EST_LINE_PX}px` }}
        >
          {chunk.text}
        </code>
      ))}
    </>
  )
}

export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({ language, code }) => {
  // 展示与复制都保留解析器载荷的逐字内容（含空白）。
  const content = code ?? ''

  // 流式会递来空/未完成的围栏——渲染空操作，不出瞬态空卡。
  if (!content.trim()) {
    return null
  }

  // mermaid 围栏（2026-11-28 接线）：`\`\`\`mermaid` 渲染成图（beautiful-mermaid
  // 同步出 SVG，失败原样回退源码 + 注明原因——不静默）。点击可全屏缩放。
  if (language === 'mermaid') {
    return <MermaidDiagram className="aui-mermaid-block" code={content} />
  }

  // prose 判定：像散文的围栏块直接当文本（不上底色卡、不给复制钮）。
  if (isLikelyProseCodeBlock(language, content)) {
    return <div className="aui-prose-fence text-foreground wrap-anywhere whitespace-pre-wrap">{content}</div>
  }

  const plain = exceedsHighlightBudget(content)

  return (
    <CodeCard>
      <CodeCopyButton code={content} label="复制代码" />
      <CodeCardBody>
        <ExpandableBlock>
          {plain ? (
            <PlainCode code={content} />
          ) : (
            // 上游元素自带容器描边/底色/内距——宿主卡片已经给了同一套
            // （CodeCard/CodeCardBody 的令牌面），这里用 twMerge 把它压回
            // 透明（同名变体后者胜出）：代码块在消息里读作一块底色板，
            // 不是"卡里再套一张卡"。
            <Suspense fallback={<PlainCode code={content} />}>
              <AuiSyntaxHighlighter
                className="[&_pre]:m-0! [&_pre]:rounded-none! [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:text-[length:var(--code-font-size)]!"
                code={content}
                language={language || 'text'}
              />
            </Suspense>
          )}
        </ExpandableBlock>
      </CodeCardBody>
    </CodeCard>
  )
}
