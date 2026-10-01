/**
 * 会话自动命名（规则段）：hermes agent/title_generator.py 的 derive_title
 * 与 hermes_state_titles.py:177-189 get_next_title_in_lineage 的 TS 对标。
 * LLM 总结升级段不做（无凭据面）——接口说明见本轮交接报告。
 *
 * 纯函数、零依赖（TurnMessage 仅类型），可单测。
 */
import type { TurnMessage } from './turn-actor'

/** hermes MAX_DERIVED_TITLE_CHARS */
export const MAX_DERIVED_TITLE_CHARS = 48

/** hermes rstrip(" ,.;:—-") 的字符集（字符类，- 置尾为字面量） */
const TRAILING_TRIM_RE = /[ ,.;:—-]+$/u

/** hermes _NUMBERED_TITLE_RE（^(.*?) #(\d+)$ 非贪婪与贪婪在此模式上解析
 * 唯一——" #" 分隔符钉死了唯一的尾部数字段） */
const NUMBERED_TITLE_RE = /^(.*) #(\d+)$/

/**
 * 即时标题（无模型、永不失败）：首个非空行折叠空白后，超长按词边界截断
 * 48 字符 + 「…」。
 * - 词边界 = 截断段内最后一个空格；空格位置 ≤ 一半（24）时保留整段硬截
 *   （hermes：`space > MAX//2 ? cut[:space] : cut`）；
 * - 截断后去除尾部标点（" ,.;:—-"）再补省略号；
 * - 全空白输入返回 null（调用方跳过命名）。
 */
export function deriveTitle(userMessage: string): string | null {
  // 首个非空行（hermes _first_line）
  let line = ''
  for (const raw of userMessage.split(/\r\n|\r|\n/)) {
    const trimmed = raw.trim()
    if (trimmed) {
      line = trimmed
      break
    }
  }
  if (!line) return null
  // 空白折叠（hermes " ".join(line.split())）
  line = line.split(/\s+/).join(' ')
  if (line.length > MAX_DERIVED_TITLE_CHARS) {
    const cut = line.slice(0, MAX_DERIVED_TITLE_CHARS)
    const space = cut.lastIndexOf(' ')
    line = (space > MAX_DERIVED_TITLE_CHARS / 2 ? cut.slice(0, space) : cut)
      .replace(TRAILING_TRIM_RE, '')
    line += '…'
  }
  return line || null
}

/**
 * 撞名谱系编号（hermes get_next_title_in_lineage）："my session" →
 * "my session #2"。剥掉 baseTitle 自带的 " #N" 后缀取真基名，与既有标题
 * （精确等于基名，或以「基名 #」开头）比对，取既有最大号 +1；只有
 * 无编号原版时按 #1 计 → 追加 #2。无冲突原样返回基名。
 * 与 SQL LIKE 的差异：SQLite LIKE 对 ASCII 不分大小写，此处为精确比较
 * （标题是用户可见文本，大小写变体按不同名处理）。
 */
export function nextTitleInLineage(baseTitle: string, existingTitles: readonly string[]): string {
  const baseMatch = NUMBERED_TITLE_RE.exec(baseTitle)
  const base = baseMatch ? baseMatch[1]! : baseTitle
  const numberedPrefix = `${base} #`
  let hasConflict = false
  let maxNumber = 0
  for (const title of existingTitles) {
    if (title === base || title.startsWith(numberedPrefix)) {
      hasConflict = true
      const m = NUMBERED_TITLE_RE.exec(title)
      if (m) maxNumber = Math.max(maxNumber, Number.parseInt(m[2]!, 10))
    }
  }
  if (!hasConflict) return base
  // 无编号原版按 #1 计（hermes：max([1, *numbers]) + 1）
  return `${base} #${Math.max(1, maxNumber) + 1}`
}

/**
 * 首条 user 消息的可派生文本（标题原料）：string content 原样；parts
 * 形态拼接 text 部件（image/thinking/tool-call 不进标题）。无 user 消息
 * 或文本为空返回 null。
 */
export function firstUserMessageText(messages: readonly TurnMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content || null
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
    return text || null
  }
  return null
}
