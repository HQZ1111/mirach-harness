/**
 * pi 工具 diff → 官方 code-diff 元素的形状（纯函数，可单测）。
 *
 * 数据源：pi `edit` / `hashline_edit` 的 `ToolOutput.details.diff`
 * （`tools.rs::generate_diff_string` 的输出，**不是** unified diff）。格式：
 * ```
 *  +{新行号} 行文本      ← 新增
 *  -{旧行号} 行文本      ← 删除
 *   {旧行号} 行文本      ← 上下文
 *      ...              ← 跳过标记（行号列宽对齐的空格 + ...）
 * ```
 * 行号列宽由 pi 按最大行号算（`diff_line_num_width`），所以解析**不能**按
 * 固定宽度切——按「首字符 + 跳过空白 + 行号 + 空格」的宽松规则取文本部分。
 *
 * `write` 工具**没有** diff（整体覆盖，见 tools.rs WriteTool 无 generate_diff）——
 * 本解析器返回 null，调用方回退通用卡（不编造 diff）。
 */
import type { DiffLine } from './elements/code-diff'

export interface ParsedDiff {
  lines: DiffLine[]
  additions: number
  deletions: number
}

/** 从 tool 结果对象里取 details.diff（形状严格校验，非字符串即 null）。 */
export function extractDiffText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const details = (result as Record<string, unknown>).details
  if (typeof details !== 'object' || details === null) return null
  const diff = (details as Record<string, unknown>).diff
  return typeof diff === 'string' && diff.length > 0 ? diff : null
}

/**
 * 解析 pi 的 diff 文本。每行按首字符分类：
 * - `+` → added（去掉 `+`、行号、空格）
 * - `-` → removed
 * - ` ` → context（去掉行号）
 * - 其余（skip marker：空白 + `...`）→ 跳过标记，不入 lines
 *
 * 文本部分 = 行号后的第一个空格之后的所有内容（保留行内前导空格）。
 */
export function parsePiDiff(diff: string): ParsedDiff | null {
  const lines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  for (const raw of diff.split('\n')) {
    if (raw.length === 0) continue
    const marker = raw[0]
    if (marker !== '+' && marker !== '-' && marker !== ' ') {
      continue // 非法行：跳过（不 panic、不造行）
    }
    // 去掉 marker 后是 `{padding}{lineNum} {text}`；找到「行号后的第一个空格」
    const rest = raw.slice(1)
    // 跳过前导空格（行号右对齐填充）
    let i = 0
    while (i < rest.length && rest[i] === ' ') i++
    // 跳过数字
    while (i < rest.length && rest[i] >= '0' && rest[i] <= '9') i++
    // 期望一个空格分隔；没有则说明是 skip marker 或畸形行
    if (rest[i] !== ' ') {
      const trimmed = rest.trim()
      if (trimmed === '...' || trimmed === '') continue // skip marker
      continue
    }
    const text = rest.slice(i + 1)
    if (marker === '+') {
      lines.push({ kind: 'added', text })
      additions++
    } else if (marker === '-') {
      lines.push({ kind: 'removed', text })
      deletions++
    } else {
      lines.push({ kind: 'context', text })
    }
  }
  if (lines.length === 0) return null
  return { lines, additions, deletions }
}

/** 从工具名 + 结果一次性拿到可渲染的 diff（无则 null）。 */
export function diffFromToolResult(
  toolName: string,
  result: unknown,
): ParsedDiff | null {
  // 只有这些工具产 diff（tools.rs 实锤：WriteTool 无 generate_diff）
  if (toolName !== 'edit' && toolName !== 'hashline_edit') return null
  const text = extractDiffText(result)
  if (text === null) return null
  return parsePiDiff(text)
}

/** 从工具参数取文件路径（edit/hashline_edit 的 `path`；缺省 = "?"）。 */
export function diffFilename(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '?'
  const p = (args as Record<string, unknown>).path
  return typeof p === 'string' && p ? p : '?'
}
