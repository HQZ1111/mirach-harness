'use client'

// ── shiki 唯一静态缝（hermes shiki-block.tsx 对应物）────────────────────────
// 本文件是全应用唯一静态 import react-shiki 的模块（经它拖入 shiki 的多 MB
// 语言/主题/wasm bundle）。所有消费方都必须经 syntax-highlighter.tsx 里的
// React.lazy(() => import('./shiki-block')) 到达这里——chunk 完全不进首屏，
// 第一个高亮代码块出现时才加载。
//
// 任何入口图可达的模块都不得静态 import 本文件，否则 chunk 回到 boot。
//
// 与 react-shiki 直通组件的差异（hermes #95595 同款）：本模块内容键缓存——
// 高亮结果存模块级 LRU（键 = scope+language+code），未变更块重挂载（切热
// 会话路径）同步上画缓存，永不重新 tokenize；只有 miss 跑高亮，miss 经
// react-shiki 的 delay 节流，流式块落定后才开工。
//
// 铁律「永不 innerHTML」：用 useShikiHighlighter 默认 outputFormat:'react'
// （hast → React 元素树），不用 hermes 的 codeToHtml+dangerouslySetInnerHTML
// 路径。缓存值因此是 React 元素，体量按源码长度计（见 highlight-cache.ts）。
import { type ReactElement, useEffect, useState } from 'react'
import { useShikiHighlighter } from 'react-shiki'

import { HighlightCache, HIGHLIGHT_CACHE_MAX_ENTRIES, highlightCacheKey } from './highlight-cache'
import { PlainShiki } from './shiki-plain'
import {
  HIGHLIGHT_CACHE_MAX_SOURCE_CHARS,
  HIGHLIGHT_DELAY_MS,
  SHIKI_COLOR_REPLACEMENTS,
  SHIKI_HIGHLIGHT_SCOPE,
  SHIKI_THEMES,
} from './shiki-config'

export interface CachedShikiBlockProps {
  language: string
  code: string
}

// 渲染期全生命周期的缓存实例。容量按「源码字符 5-10 倍 ≈ 元素树」折算，
// 上限见 shiki-config 的 HIGHLIGHT_CACHE_MAX_SOURCE_CHARS。
const highlightCache = new HighlightCache<ReactElement>(
  HIGHLIGHT_CACHE_MAX_ENTRIES,
  HIGHLIGHT_CACHE_MAX_SOURCE_CHARS,
)

/** 缓存命中：同步上画，零高亮工作（热会话切换路径）。 */
function CachedPaint({ elements }: { elements: ReactElement }) {
  return <div className="aui-shiki-root">{elements}</div>
}

/** 缓存 miss：react-shiki hook 异步高亮（delay 节流），落定后写缓存。
 *  结果为 null（加载中，或 react-shiki 高亮失败——它自身 console.error
 *  可见）期间渲染纯文本 pre：颜色缺席、几何不跳，失败可见不吞错。 */
function ShikiCacheMiss({
  cacheKey,
  code,
  language,
}: {
  cacheKey: string
  code: string
  language: string
}) {
  const elements = useShikiHighlighter(code, language || 'text', SHIKI_THEMES, {
    colorReplacements: SHIKI_COLOR_REPLACEMENTS,
    defaultColor: 'light-dark()',
    delay: HIGHLIGHT_DELAY_MS,
  })

  useEffect(() => {
    if (elements) {
      highlightCache.set(cacheKey, elements, code.length)
    }
  }, [cacheKey, code.length, elements])

  if (!elements) {
    return <PlainShiki code={code} />
  }

  return <CachedPaint elements={elements} />
}

export default function CachedShikiBlock({ language, code }: CachedShikiBlockProps) {
  const cacheKey = highlightCacheKey(SHIKI_HIGHLIGHT_SCOPE, language, code)
  const cached = highlightCache.get(cacheKey)

  if (cached !== undefined) {
    return <CachedPaint elements={cached} />
  }

  return <ShikiCacheMiss cacheKey={cacheKey} code={code} language={language} />
}
