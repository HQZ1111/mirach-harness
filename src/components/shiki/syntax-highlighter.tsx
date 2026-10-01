'use client'

// ── 聊天代码块 SyntaxHighlighter（hermes shiki-highlighter.tsx 对应物）──────
// 接在 @assistant-ui/react-markdown 管线的 components.SyntaxHighlighter 位
// （围栏代码块由 CodeOverride → DefaultCodeBlock 渲染到这里）。CodeHeader
// 不提供（默认 null）——代码卡只有底色无头栏（任务定稿）。
//
// 四件套：
// ① lazy 单缝 —— 下面这个 lazy() 是全应用唯一的 shiki chunk 入口；
// ② 内容键缓存 —— 在 lazy 块内（shiki-block.tsx，模块级 LRU）；
// ③ 预算 —— exceedsHighlightBudget：超限放弃高亮，纯文本 200 行/块 +
//    content-visibility:auto；
// ④ prose 判定 —— isLikelyProseCodeBlock：像散文的围栏块直接当文本。
import { type FC, lazy, Suspense, useMemo } from 'react'
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'

import { CodeCard, CodeCardBody, CodeCopyButton } from './code-card'
import { ExpandableBlock } from './expandable-block'
import { chunkByLines, exceedsHighlightBudget, isLikelyProseCodeBlock } from './markdown-code'
import { CHUNK_LINES, EST_LINE_PX } from './shiki-config'
import { PlainShiki } from './shiki-plain'
import type { CachedShikiBlockProps } from './shiki-block'

// shiki（及其背后的多 MB 语言/主题/wasm bundle）是渲染器最重的依赖。
// shiki-block.tsx 是它唯一的静态 import 者，这个 lazy() 就是把它挡在
// 首屏之外的单缝——第一个高亮代码块出现才加载。
const ShikiBlock = lazy(() => import('./shiki-block'))

/** 首次使用时挂起，shiki chunk 到达前以纯文本 pre 上画（几何同高亮输出）。 */
const LazyShiki: FC<CachedShikiBlockProps> = ({ language, code }) => (
  <Suspense fallback={<PlainShiki code={code} />}>
    <ShikiBlock code={code} language={language} />
  </Suspense>
)

/** 超预算纯文本：~200 行/块，块间 content-visibility:auto 跳过视口外渲染。
 *  这些 code 不经 pre 包裹（React 元素树路径没有外层 pre），内边距直接挂在
 *  块上，与 CodeCardBody 给 pre 的 px-3/py-2.5 对齐。 */
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
          {plain ? <PlainCode code={content} /> : <LazyShiki code={content} language={language || 'text'} />}
        </ExpandableBlock>
      </CodeCardBody>
    </CodeCard>
  )
}
