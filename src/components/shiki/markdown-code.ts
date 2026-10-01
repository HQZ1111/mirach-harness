// ── 代码块纯判定（hermes lib/markdown-code.ts 移植，裁剪到聊天代码块所需）──
// 只保留四件套里两件的纯逻辑：预算判定（exceedsHighlightBudget）、分块
// （chunkByLines）、prose 判定（isLikelyProseCodeBlock 及其信号/否决帮手）。
// hermes 的语言图标映射（codiconFor* / shikiLanguageForFilename）与
// isLikelyProseFence（streamdown 剥围栏用）不在本管线，未移植。
// 本文件零依赖（无 React、无 react-shiki），全部可独立单测。

import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from './shiki-config'

const VALID_LANGUAGE_RE = /^[a-z0-9][a-z0-9+#-]*$/i
const NON_CODE_FENCE_LANGUAGES = new Set(['', 'text', 'plain', 'plaintext', 'md', 'markdown'])

const COMMON_CODE_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'css',
  'diff',
  'go',
  'html',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'markdown',
  'md',
  'php',
  'python',
  'py',
  'ruby',
  'rust',
  'rs',
  'sh',
  'sql',
  'swift',
  'tsx',
  'ts',
  'typescript',
  'xml',
  'yaml',
  'yml',
])

/** 围栏信息串首 token 清洗：合法且 ≤16 字符返回小写，否则空串。 */
export function sanitizeLanguageTag(tag: string): string {
  const trimmed = tag.trim()
  const first = trimmed.split(/\s/, 1)[0] || ''

  return VALID_LANGUAGE_RE.test(first) && first.length <= 16 ? first.toLowerCase() : ''
}

// ── 预算判定（hermes shiki-highlighter.tsx 同款）────────────────────────────
// >150k 字符或 >3k 行即放弃高亮：shiki tokenize 是主线程重活，超大块直接
// 走纯文本分块路径。
export function exceedsHighlightBudget(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return true
  }

  let lines = 1
  let idx = code.indexOf('\n')

  while (idx !== -1) {
    if ((lines += 1) > MAX_HIGHLIGHT_LINES) {
      return true
    }

    idx = code.indexOf('\n', idx + 1)
  }

  return false
}

export interface CodeChunk {
  text: string
  lines: number
}

/** 按行切成 ≤perChunk 的块；不足一块时整体单块返回（内容逐字保留）。 */
export function chunkByLines(code: string, perChunk: number): CodeChunk[] {
  const lines = code.split('\n')

  if (lines.length <= perChunk) {
    return [{ text: code, lines: lines.length }]
  }

  const chunks: CodeChunk[] = []

  for (let i = 0; i < lines.length; i += perChunk) {
    const slice = lines.slice(i, i + perChunk)
    chunks.push({ text: slice.join('\n'), lines: slice.length })
  }

  return chunks
}

// ── prose 判定（hermes 启发式逐条移植）──────────────────────────────────────

interface CodeSignals {
  bulletLines: number
  codeSignals: number
  hasMarkdown: boolean
  proseLines: number
  trimmed: string
  urlLines: number
}

function proseLineCount(body: string): number {
  return body.split('\n').filter(line => {
    const trimmed = line.trim()

    // hermes 原式只认 ASCII 起始行；本应用中文为主，追加 CJK 起始行
    //（有意的适配，非逐抄）——中文围栏散文才判得出来。
    return Boolean(trimmed) && (/^[A-Za-z0-9"'`*-]/.test(trimmed) || /^[\u4e00-\u9fff]/.test(trimmed))
  }).length
}

const CODE_SIGNAL_RE = [
  /(^|\s)(const|let|var|function|class|import|export|return|if|for|while|switch)\b/gim,
  /=>|==|===|!=|!==|\{|\}|;|<\/?[a-z][^>]*>/gi,
  /^\s*(#include|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)\b/gim,
]

function codeSignalCount(body: string): number {
  return CODE_SIGNAL_RE.reduce((total, pattern) => total + (body.match(pattern)?.length ?? 0), 0)
}

function codeSignals(body: string): CodeSignals {
  const trimmed = body.trim()
  const markdownSignals = (trimmed.match(/\*\*[^*]+\*\*/g) || []).length + (trimmed.match(/`[^`\n]+`/g) || []).length

  return {
    bulletLines: (trimmed.match(/^\s*[-*]\s+\S+/gm) || []).length,
    codeSignals: codeSignalCount(trimmed),
    hasMarkdown: markdownSignals > 0,
    proseLines: proseLineCount(trimmed),
    trimmed,
    urlLines: (trimmed.match(/^\s*https?:\/\/\S+\s*$/gim) || []).length,
  }
}

// 句末标点后跟空白或行尾——真散文有，配置/结构化清单几乎 never。
// 中文句号/叹/问同算（本应用中文为主，与 proseLineCount 的 CJK 适配同源）。
const SENTENCE_PUNCTUATION_RE = /[.!?。！？](?:\s|$)/
// `Key: value` / `Key = value`——带显式分隔符的配置/指令行，形状无歧义。
const CONFIG_SEPARATOR_LINE_RE = /^[A-Za-z0-9_][\w.-]*\s*[:=]\s*\S/
// 可能是配置键的裸标识符（Host/Port/API_KEY）。只用于短 `Key value` 指令形。
const CONFIG_KEY_RE = /^[A-Za-z0-9_][\w.-]*$/

// 单行看起来像配置指令而非散文：显式 `Key: value`，或 2-3 个 token、由标识符
// 打头的短空白指令（`Host example`、`Port 22`）。token 上限是它与散文的分界
// ——真句子行比配置指令词多，无标点的散文片段（5 个 token）不会被当成配置。
function isConfigDirectiveLine(line: string): boolean {
  const trimmed = line.trim()

  if (CONFIG_SEPARATOR_LINE_RE.test(trimmed)) {
    return true
  }

  const tokens = trimmed.split(/\s+/)

  return tokens.length >= 2 && tokens.length <= 3 && CONFIG_KEY_RE.test(tokens[0])
}

/**
 * 围栏块像结构化/配置/表格文本而非换行散文时为真。这类块（SSH config、
 * .env、INI、键值清单）会骗过 prose 启发式的「3+ 平行行、无代码 token」
 * 规则，被错误地剥掉围栏摊平成段落；此否决保住它们的围栏。
 * 两个信号，含糊时偏向保围栏：
 * - 任一缩进续行（内容前有前导空白）：散文不逐行缩进，配置段会；
 * - 无句末标点，且多数行是 `Key value` / `Key: value` 指令。
 */
export function isLikelyStructuredText(body: string): boolean {
  const lines = body.split('\n').filter(line => line.trim())

  if (lines.length < 2) {
    return false
  }

  if (lines.some(line => /^\s+\S/.test(line))) {
    return true
  }

  if (lines.some(line => SENTENCE_PUNCTUATION_RE.test(line.trim()))) {
    return false
  }

  const configLines = lines.filter(line => isConfigDirectiveLine(line)).length

  return configLines >= Math.max(2, Math.ceil(lines.length * 0.6))
}

/**
 * 围栏块像散文时为真——直接当文本渲染（四件套之四）。agent 常把 ordinary
 * 段落/要点清单包进无语言围栏，语法高亮它们只会得到一块突兀的底色板。
 */
export function isLikelyProseCodeBlock(language: string | undefined, code: string | undefined): boolean {
  const cleanLanguage = sanitizeLanguageTag(language || '')
  const signals = codeSignals(code || '')

  if (!signals.trimmed || signals.codeSignals >= 3) {
    return false
  }

  // 带 markdown 强调的要点清单是散文，即使碰巧结构化；下面的配置否决只为
  // 保护配置/键值清单，所以要点-散文情形先赢。
  if (signals.bulletLines >= 1 && (signals.hasMarkdown || signals.proseLines >= 2)) {
    return true
  }

  // 配置 / 键值 / 缩进清单是代码不是散文——永不剥（SSH config、.env、INI）。
  if (isLikelyStructuredText(code || '')) {
    return false
  }

  if (NON_CODE_FENCE_LANGUAGES.has(cleanLanguage)) {
    return signals.proseLines >= 3 && signals.codeSignals === 0
  }

  return !COMMON_CODE_LANGUAGES.has(cleanLanguage) && signals.proseLines >= 2 && signals.codeSignals <= 1
}
