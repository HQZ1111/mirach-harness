/**
 * hermes 桌面端 `components/chat/diff-lines.tsx` 的移植（692 行 → 本文件）。
 *
 * 统一 diff 渲染，两条路径共用一份解析：
 *  - 有语言且未超预算 → Shiki 按文件语言高亮变更**内容**，逐行 transformer 把
 *    加/删底色叠上去；
 *  - 否则（无语言 / 超预算 / shiki 加载中）→ 纯色兜底（DiffBody）。
 * 两者都丢掉 git 文件头 + `@@` 噪声与 `+/-` 槽，靠颜色 + 2px 左描边读变更。
 *
 * 与上游的差异（宿主事实）：
 * - `@/components/error-boundary` → 本地 `DiffBoundary`（只隔离 diff 区，
 *   与上游"chunk 加载失败不拖垮整面板"同语义）。
 * - `@/components/chat/shiki-highlighter` 的 SHIKI_THEME → 宿主
 *   `shiki-config.ts` 的 SHIKI_THEMES（同值：github-light-default /
 *   github-dark-dimmed）。
 * - `@/lib/markdown-code` 的 shikiLanguageForFilename → 宿主同名函数
 *   （已移植到 components/shiki/markdown-code.ts）。
 * - 上游 `SyntaxDiff` 走 lazy `syntax-diff.tsx` 把 shiki 移出冷启动路径；
 *   宿主这里用 `await import('shiki')` 的动态导入达成同一目的（与上游
 *   TokenizedDiffBody 同款写法，且已有先例）。
 * 其余解析/窗口化/overview ruler 逻辑逐字保留。
 */

import { type CSSProperties, Component, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'

import { chunkLines, type LineChunk, useFixedRowWindow } from '@/components/preview/fixed-row-window'
import {
  exceedsHighlightBudget,
  shikiLanguageForFilename,
} from '@/components/shiki/markdown-code'
import { SHIKI_THEMES } from '@/components/shiki/shiki-config'
import { cn } from '@/lib/utils'

/**
 * 只兜住 diff 区（上游 ErrorBoundary 的等价物）：shiki chunk 加载失败时退回
 * 纯色 diff，而不是让异常冒到面板级边界把整个审查面板变成白屏。
 */
class DiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

type DiffKind = 'add' | 'context' | 'remove'

export interface DiffLine {
  kind: DiffKind
  text: string
  /** 1-based line number in the old/new file. */
  newNo?: number
  oldNo?: number
}

interface ParsedHunk {
  lines: Array<{ kind: DiffKind; text: string }>
  newStart: number
  oldStart: number
}

// Tint + 2px gutter accent per change kind.
const DIFF_KIND_TINT: Record<DiffKind, string> = {
  add: 'border-(--ui-diff-add-border) bg-(--ui-diff-add-background)',
  context: 'border-transparent',
  remove: 'border-(--ui-diff-remove-border) bg-(--ui-diff-remove-background)',
}

const DIFF_KIND_TEXT: Record<DiffKind, string> = {
  add: 'text-(--ui-diff-add-foreground)',
  context: '',
  remove: 'text-(--ui-diff-remove-foreground)',
}

const DIFF_LINE_BASE = 'block min-w-max whitespace-pre border-l-2 px-2.5 py-px'
const PREVIEW_DIFF_LINE_BASE = 'block h-5 min-w-max whitespace-pre px-2.5 leading-5'
const PREVIEW_CHUNK_LINES = 200
const PREVIEW_LINE_PX = 20
const PREVIEW_OVERSCAN_LINES = 400

const DIFF_BOX_CLASS =
  '-mx-1.5 -mb-1.5 max-h-[12rem] max-w-none min-w-0 overflow-auto overscroll-x-contain overscroll-y-auto font-mono text-[0.7rem] leading-relaxed text-(--ui-text-secondary)'

function diffKind(line: string): DiffKind {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'add'
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'remove'
  }

  return 'context'
}

function stripDiffMarker(line: string): string {
  if (diffKind(line) !== 'context' || line.startsWith(' ')) {
    return line.slice(1)
  }

  return line
}

const DIFF_HEADER_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'similarity ',
  'rename ',
  'new file',
  'deleted file',
]

function isArrowHeaderLine(line: string): boolean {
  const trimmed = line.trim()

  return trimmed.includes('→') && /^\S.*→\s*\S+$/.test(trimmed) && !/^[+\-@]/.test(trimmed)
}

/** Exported for tests. */
export function stripDiffFileHeaders(diff: string): string {
  const lines = diff.split('\n')
  let start = 0

  for (; start < lines.length; start += 1) {
    const line = lines[start]

    if (line.startsWith('@@')) {
      break
    }

    if (
      line.trim() === '' ||
      isArrowHeaderLine(line) ||
      DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))
    ) {
      continue
    }

    break
  }

  return lines.slice(start).join('\n')
}

function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let active: null | ParsedHunk = null

  for (const line of stripDiffFileHeaders(diff).split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)

      if (!match) {
        active = null

        continue
      }

      active = { oldStart: Number(match[1]), newStart: Number(match[2]), lines: [] }
      hunks.push(active)

      continue
    }

    if (!active || line.startsWith('\\')) {
      continue
    }

    active.lines.push({ kind: diffKind(line), text: stripDiffMarker(line) })
  }

  return hunks
}

function parseDiff(diff: string): DiffLine[] {
  const hunks = parseHunks(diff)

  if (hunks.length === 0) {
    // Fallback for unexpected non-hunk payloads.
    return stripDiffFileHeaders(diff)
      .split('\n')
      .map((line) => ({ kind: diffKind(line), text: stripDiffMarker(line) }))
  }

  const out: DiffLine[] = []
  let emitted = false
  let oldNo = 1
  let newNo = 1

  for (const hunk of hunks) {
    oldNo = hunk.oldStart
    newNo = hunk.newStart

    if (emitted) {
      out.push({ kind: 'context', text: '' })
    }

    for (const line of hunk.lines) {
      const entry: DiffLine = { kind: line.kind, text: line.text }

      if (line.kind === 'add') {
        entry.newNo = newNo++
      } else if (line.kind === 'remove') {
        entry.oldNo = oldNo++
      } else {
        entry.oldNo = oldNo++
        entry.newNo = newNo++
      }

      out.push(entry)
      emitted = true
    }
  }

  return out
}

// Build a full-file diff view anchored to the CURRENT file text.
function parseFullFileDiff(diff: string, fullText: string): DiffLine[] {
  const hunks = parseHunks(diff)
  const fullLines = fullText.split('\n')

  if (hunks.length === 0) {
    return fullLines.map((text, index) => ({ kind: 'context', newNo: index + 1, oldNo: index + 1, text }))
  }

  const added = new Set<number>()
  const oldNoByNewNo = new Map<number, number>()
  const removalsByNewNo = new Map<number, DiffLine[]>()
  const out: DiffLine[] = []

  for (const hunk of hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        added.add(newNo)
        newNo += 1
      } else if (line.kind === 'remove') {
        const anchor = Math.max(1, Math.min(newNo, fullLines.length + 1))
        const bucket = removalsByNewNo.get(anchor) ?? []

        bucket.push({ kind: 'remove', oldNo, text: line.text })
        removalsByNewNo.set(anchor, bucket)
        oldNo += 1
      } else {
        oldNoByNewNo.set(newNo, oldNo)
        oldNo += 1
        newNo += 1
      }
    }
  }

  for (let index = 0; index < fullLines.length; index += 1) {
    const newNo = index + 1
    const removals = removalsByNewNo.get(newNo)

    if (removals) {
      out.push(...removals)
    }

    out.push({
      kind: added.has(newNo) ? 'add' : 'context',
      newNo,
      oldNo: oldNoByNewNo.get(newNo),
      text: fullLines[index] ?? '',
    })
  }

  const trailingRemovals = removalsByNewNo.get(fullLines.length + 1)

  if (trailingRemovals) {
    out.push(...trailingRemovals)
  }

  return out
}

export function DiffBody({ lines, syntax }: { lines: DiffLine[]; syntax?: boolean }) {
  return (
    <>
      {lines.map((line, index) => (
        <span
          className={cn(DIFF_LINE_BASE, DIFF_KIND_TINT[line.kind], !syntax && DIFF_KIND_TEXT[line.kind])}
          key={`${index}-${line.text}`}
        >
          {line.text || ' '}
        </span>
      ))}
    </>
  )
}

// shiki FontStyle is a bitmask: Italic=1, Bold=2, Underline=4.
interface DiffToken {
  content: string
  color?: string
  bgColor?: string
  fontStyle?: number
  offset: number
}

function tokenStyle({ bgColor, color, fontStyle = 0 }: DiffToken): CSSProperties | undefined {
  if (!color && !bgColor && !fontStyle) {
    return undefined
  }

  return {
    backgroundColor: bgColor,
    color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecorationLine: fontStyle & 4 ? 'underline' : undefined,
  }
}

/** 文档 color-scheme 跟随（宿主 :root 恒 light，但跟随 class 变化以兼容暗色）。 */
function useThemeName() {
  const current = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? SHIKI_THEMES.dark
      : SHIKI_THEMES.light
  const [theme, setTheme] = useState(current)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()))

    observer.observe(document.documentElement, { attributeFilter: ['class'], attributes: true })

    return () => observer.disconnect()
  }, [])

  return theme
}

function PreviewDiffRows({
  afterLines = 0,
  beforeLines = 0,
  chunks,
  tokens,
}: {
  afterLines?: number
  beforeLines?: number
  chunks: Array<LineChunk<DiffLine>>
  tokens?: DiffToken[][] | null
}) {
  return (
    <>
      {beforeLines > 0 && <div aria-hidden style={{ height: beforeLines * PREVIEW_LINE_PX }} />}
      {chunks.map((chunk) => (
        <div className='block' key={chunk.start}>
          {chunk.lines.map((line, offset) => {
            const index = chunk.start + offset
            const rowTokens = tokens?.[index] ?? []

            return (
              <span className={cn(PREVIEW_DIFF_LINE_BASE, DIFF_KIND_TINT[line.kind])} key={`${index}-${line.text}`}>
                {rowTokens.length > 0
                  ? rowTokens.map((token, tokenIndex) => (
                      <span key={`${tokenIndex}-${token.offset}`} style={tokenStyle(token)}>
                        {token.content}
                      </span>
                    ))
                  : line.text || ' '}
              </span>
            )
          })}
        </div>
      ))}
      {afterLines > 0 && <div aria-hidden style={{ height: afterLines * PREVIEW_LINE_PX }} />}
    </>
  )
}

function TokenizedDiffBody({
  afterLines,
  beforeLines,
  chunked = false,
  chunks,
  language,
  lines,
}: {
  afterLines?: number
  beforeLines?: number
  chunked?: boolean
  chunks?: Array<LineChunk<DiffLine>>
  language: string
  lines: DiffLine[]
}) {
  const code = useMemo(() => lines.map((line) => line.text).join('\n'), [lines])
  const theme = useThemeName()
  const [tokens, setTokens] = useState<DiffToken[][] | null>(null)

  useEffect(() => {
    let cancelled = false

    setTokens(null)
    // 动态 import：shiki 的多 MB chunk 不進冷启动路径。
    void import('shiki')
      .then(({ codeToTokens }) => codeToTokens(code, { lang: language as never, theme }))
      .then((result) => {
        if (!cancelled) {
          setTokens(result.tokens as unknown as DiffToken[][])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokens([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  if (!tokens) {
    return chunked ? (
      <PreviewDiffRows
        afterLines={afterLines}
        beforeLines={beforeLines}
        chunks={chunks ?? chunkLines(lines, PREVIEW_CHUNK_LINES)}
      />
    ) : (
      <DiffBody lines={lines} />
    )
  }

  if (chunked) {
    return (
      <PreviewDiffRows
        afterLines={afterLines}
        beforeLines={beforeLines}
        chunks={chunks ?? chunkLines(lines, PREVIEW_CHUNK_LINES)}
        tokens={tokens}
      />
    )
  }

  return (
    <>
      {lines.map((line, index) => {
        const rowTokens = tokens[index] ?? []

        return (
          <span className={cn(PREVIEW_DIFF_LINE_BASE, DIFF_KIND_TINT[line.kind])} key={`${index}-${line.text}`}>
            {rowTokens.length > 0
              ? rowTokens.map((token, tokenIndex) => (
                  <span key={`${tokenIndex}-${token.offset}`} style={tokenStyle(token)}>
                    {token.content}
                  </span>
                ))
              : line.text || ' '}
          </span>
        )
      })}
    </>
  )
}

interface DiffLinesProps {
  className?: string
  text: string
}

export function DiffLines({ className, text }: DiffLinesProps) {
  const lines = useMemo(() => parseDiff(text), [text])

  return (
    <pre className={cn(DIFF_BOX_CLASS, className)} data-slot='diff-lines'>
      <DiffBody lines={lines} />
    </pre>
  )
}

// Coalesce consecutive same-kind changed rows into runs, each placed by line
// fraction (no DOM measurement). Context rows produce no tick.
function overviewRuns(lines: DiffLine[]): { kind: 'add' | 'remove'; sizePct: number; startPct: number }[] {
  const total = lines.length || 1
  const runs: { kind: 'add' | 'remove'; sizePct: number; startPct: number }[] = []

  for (let i = 0; i < lines.length; ) {
    const kind = lines[i].kind

    if (kind === 'context') {
      i += 1

      continue
    }

    let j = i + 1

    while (j < lines.length && lines[j].kind === kind) {
      j += 1
    }

    runs.push({ kind, sizePct: ((j - i) / total) * 100, startPct: (i / total) * 100 })
    i = j
  }

  return runs
}

// VS Code-style overview ruler: a thin strip pinned to the diff's right edge.
function DiffOverviewRuler({ lines }: { lines: DiffLine[] }) {
  const runs = useMemo(() => overviewRuns(lines), [lines])

  if (runs.length === 0) {
    return null
  }

  return (
    <div aria-hidden className='pointer-events-none absolute top-0 right-0 bottom-0 w-1.5 opacity-80'>
      <div className='relative w-full' style={{ height: `min(100%, ${lines.length * PREVIEW_LINE_PX}px)` }}>
        {runs.map((run, index) => (
          <div
            className={cn(
              'absolute inset-x-0',
              run.kind === 'add' ? 'bg-(--ui-diff-add-border)' : 'bg-(--ui-diff-remove-border)',
            )}
            key={index}
            style={{ height: `max(0.125rem, ${run.sizePct}%)`, top: `${run.startPct}%` }}
          />
        ))}
      </div>
    </div>
  )
}

interface FileDiffPanelProps {
  className?: string
  diff: string
  /** Current file text. When provided, the panel expands hunked diffs into a
   *  full-file view so unchanged lines are preserved between hunks. */
  fullText?: string
  path?: string
  /** Render an old/new line-number gutter (the full preview diff). */
  showLineNumbers?: boolean
  /** Window the rows (fixed-row virtualization) WITHOUT a gutter. */
  virtualized?: boolean
}

export function FileDiffPanel({
  className,
  diff,
  fullText,
  path,
  showLineNumbers = false,
  virtualized = false,
}: FileDiffPanelProps) {
  const lines = useMemo(
    () => (fullText != null ? parseFullFileDiff(diff, fullText) : parseDiff(diff)),
    [diff, fullText],
  )

  const lineChunks = useMemo(() => chunkLines(lines, PREVIEW_CHUNK_LINES), [lines])

  const { afterRows, beforeRows, endChunk, onScroll, scrollerRef, startChunk } = useFixedRowWindow({
    overscanRows: PREVIEW_OVERSCAN_LINES,
    rowPx: PREVIEW_LINE_PX,
    rowsPerChunk: PREVIEW_CHUNK_LINES,
    totalRows: lines.length,
  })

  const visibleLineChunks = lineChunks.slice(startChunk, endChunk + 1)

  const language = shikiLanguageForFilename(path)
  const canHighlight = Boolean(language) && !exceedsHighlightBudget(fullText ?? diff)
  const windowed = showLineNumbers || virtualized

  const windowedBody = canHighlight ? (
    <TokenizedDiffBody
      afterLines={afterRows}
      beforeLines={beforeRows}
      chunked
      chunks={visibleLineChunks}
      language={language}
      lines={lines}
    />
  ) : (
    <PreviewDiffRows afterLines={afterRows} beforeLines={beforeRows} chunks={visibleLineChunks} />
  )

  const compactBody = !canHighlight ? (
    <DiffBody lines={lines} />
  ) : (
    // 上游 SyntaxDiff 用 lazy 模块；宿主用同一份动态 import 路径（
    // TokenizedDiffBody 已内建），外面套边界保住面板。
    <DiffBoundary fallback={<DiffBody lines={lines} />}>
      <Suspense fallback={<DiffBody lines={lines} />}>
        <TokenizedDiffBody language={language} lines={lines} />
      </Suspense>
    </DiffBoundary>
  )

  if (!windowed) {
    return (
      <div className={cn(DIFF_BOX_CLASS, className)} data-slot='file-diff-panel'>
        {compactBody}
      </div>
    )
  }

  return (
    <div className={cn(DIFF_BOX_CLASS, 'relative overflow-hidden', className)} data-slot='file-diff-panel'>
      <div className={cn('absolute inset-0 overflow-auto', showLineNumbers && 'pr-2.5')} onScroll={onScroll} ref={scrollerRef}>
        {showLineNumbers ? (
          <div className='grid min-w-max grid-cols-[auto_minmax(0,1fr)]'>
            <div
              className='sticky left-0 z-1 select-none bg-(--ui-editor-surface-background) py-3 text-muted-foreground/55'
              data-glass-opaque=''
            >
              {beforeRows > 0 && <div aria-hidden style={{ height: beforeRows * PREVIEW_LINE_PX }} />}
              {visibleLineChunks.map((chunk) => (
                <div className='block' key={chunk.start}>
                  {chunk.lines.map((line, offset) => {
                    const index = chunk.start + offset

                    return (
                      <div className='h-5 w-9 pr-2 text-right leading-5 tabular-nums' key={`${index}-${line.oldNo}-${line.newNo}`}>
                        {line.newNo ?? ''}
                      </div>
                    )
                  })}
                </div>
              ))}
              {afterRows > 0 && <div aria-hidden style={{ height: afterRows * PREVIEW_LINE_PX }} />}
            </div>
            <div className='min-w-0'>{windowedBody}</div>
          </div>
        ) : (
          <div className='min-w-0'>{windowedBody}</div>
        )}
      </div>
      <DiffOverviewRuler lines={lines} />
    </div>
  )
}
