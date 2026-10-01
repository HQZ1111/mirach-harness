/**
 * 代码/文本文件预览（文件树 → 预览页签的代码渲染分支）：
 * Shiki 语法高亮（react-shiki）+ 行号槽 + 复制钮（copied/error 态）+ 代码卡观感。
 *
 * 结构照抄 hermes：SourceView 的 200 行分块 + 固定行高窗口化
 * （preview-file.tsx）与 lazy 单缝（shiki-highlighter.tsx——多 MB 的 shiki
 * 语法包只进懒加载 chunk，首个代码预览打开时才加载，不进首屏）。
 * 超预算（>512KB 或 >3k 行，exceedsHighlightBudget）诚实降级为纯文本分块，
 * 不做语法高亮——全量 tokenize 大文件会卡；降级本身对用户可见（提示行）。
 */
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'

import { exceedsHighlightBudget } from './code-language'
import { chunkTextLines, useFixedRowWindow } from './fixed-row-window'
import { cn } from '@/lib/utils'

// 单条 lazy 缝：react-shiki（连带 shiki 语法包）的唯一静态引用点在这里的
// 动态 import 里，其余模块一律经本组件间接使用。
const ShikiHighlighter = lazy(() => import('react-shiki'))

// 浅色主题（应用为浅色定稿，tokens.css color-scheme: light）。
// hermes shiki-config：github-light-default 的注释色 #6e7781 在小字号下
// 对比不足，压深到 GitHub 的深一档灰 #57606a。
const SHIKI_THEME = 'github-light-default'
const SHIKI_COLOR_REPLACEMENTS: Record<string, string> = { '#6e7781': '#57606a' }

const CHUNK_LINES = 200 // hermes SOURCE_CHUNK_LINES
const LINE_PX = 20 // 必须与 tokens.css --code-line-h 一致（hermes SOURCE_LINE_PX）
const OVERSCAN_LINES = 400 // hermes SOURCE_OVERSCAN_LINES
const COPIED_RESET_MS = 1_500 // hermes CopyButton COPIED_RESET_MS

type CopyStatus = 'idle' | 'copied' | 'error'

/** 复制整份文件内容；copied/error 态 1.5s 自复位，失败可见不静默。 */
function CopyCodeButton({ text }: { text: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const resetRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current)
    }
  }, [])

  const copy = useCallback(() => {
    const write = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('Clipboard API is unavailable'))
    void write
      .then(() => setStatus('copied'))
      .catch((error: unknown) => {
        // 禁止兜底：复制失败保持可见（error 态 + console.error）。
        console.error('复制代码预览失败', error)
        setStatus('error')
      })
      .finally(() => {
        if (resetRef.current !== null) window.clearTimeout(resetRef.current)
        resetRef.current = window.setTimeout(() => {
          resetRef.current = null
          setStatus('idle')
        }, COPIED_RESET_MS)
      })
  }, [text])

  const Icon = status === 'copied' ? Check : status === 'error' ? X : Copy

  return (
    <button
      aria-label={status === 'error' ? '复制失败' : '复制代码'}
      className={cn(
        'absolute top-1.5 right-2 z-10 inline-flex size-6 items-center justify-center rounded-(--code-btn-radius) opacity-0 transition-opacity group-hover/cp:opacity-100 focus-visible:opacity-100',
        status === 'idle' && 'text-(--text-3) hover:bg-(--hover-wash)',
        status === 'copied' && 'text-(--brand)',
        status === 'error' && 'text-destructive',
      )}
      onClick={copy}
      title={status === 'error' ? '复制失败' : '复制代码'}
      type="button"
    >
      <Icon className="size-3" />
    </button>
  )
}

/** 与高亮产物同几何的纯文本块（Suspense fallback / 超预算回退共用）：
 *  语法包加载完成只换颜色，不换布局。 */
function PlainCodeChunk({ code }: { code: string }) {
  return (
    <pre className="cp-plain">
      <code>{code}</code>
    </pre>
  )
}

export function CodePreview({ language, text }: { language: string; text: string }) {
  const overBudget = useMemo(() => exceedsHighlightBudget(text), [text])
  const chunks = useMemo(() => chunkTextLines(text, CHUNK_LINES), [text])
  const lastChunk = chunks[chunks.length - 1]
  const totalRows = lastChunk ? lastChunk.start + lastChunk.lines.length : 0

  const { afterRows, beforeRows, endChunk, onScroll, scrollerRef, startChunk } = useFixedRowWindow({
    overscanRows: OVERSCAN_LINES,
    rowPx: LINE_PX,
    rowsPerChunk: CHUNK_LINES,
    totalRows,
  })

  const visibleChunks = chunks.slice(startChunk, endChunk + 1)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {overBudget && (
        <div className="cp-budget-note">文件较大（超过 512KB 或 3000 行），已按纯文本分块显示，未做语法高亮。</div>
      )}
      <div className="cp-card group/cp">
        <CopyCodeButton text={text} />
        <div className="cp-scroll" onScroll={onScroll} ref={scrollerRef}>
          <div className="cp-grid grid min-w-max grid-cols-[auto_minmax(0,1fr)] font-mono">
            {beforeRows > 0 && <div aria-hidden className="col-span-2" style={{ height: beforeRows * LINE_PX }} />}
            {visibleChunks.map(chunk => (
              <Fragment key={chunk.start}>
                <div className="cp-gutter">
                  {chunk.lines.map((_lineText, offset) => (
                    <div className="cp-ln" key={chunk.start + offset}>
                      {chunk.start + offset + 1}
                    </div>
                  ))}
                </div>
                <div className="cp-code min-w-0">
                  {overBudget ? (
                    <PlainCodeChunk code={chunk.text} />
                  ) : (
                    <Suspense fallback={<PlainCodeChunk code={chunk.text} />}>
                      <ShikiHighlighter
                        addDefaultStyles={false}
                        className="cp-shiki"
                        colorReplacements={SHIKI_COLOR_REPLACEMENTS}
                        delay={120}
                        language={language}
                        showLanguage={false}
                        theme={SHIKI_THEME}
                      >
                        {chunk.text}
                      </ShikiHighlighter>
                    </Suspense>
                  )}
                </div>
              </Fragment>
            ))}
            {afterRows > 0 && <div aria-hidden className="col-span-2" style={{ height: afterRows * LINE_PX }} />}
          </div>
        </div>
      </div>
    </div>
  )
}
