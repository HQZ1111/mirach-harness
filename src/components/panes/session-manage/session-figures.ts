/**
 * 行尾数字标注（hermes session-row 的 figures 段逐语义照抄）：
 * `compactNumber` = hermes apps/shared/src/format.ts 逐字（999→"999"、
 * 1000→"1k"、1_500_000→"1.5M"，M 顶格不出 B）；figures = rowMeta 开关
 * （tokens/cost）的合成——多项以 ` · ` 连读（hermes：several switched on
 * read as one number），成本低于 1 美分不显示（$0.00 读作 bug）。
 */

/** THE compact-number formatter（hermes format.ts 逐字照抄）。 */
export function compactNumber(value: null | number | undefined): string {
  const num = Number(value ?? 0)

  if (!Number.isFinite(num) || num <= 0) {
    return '0'
  }

  const scaled = (v: number, suffix: string) => `${v.toFixed(1).replace(/\.0$/, '')}${suffix}`

  // 阈值贴着单位边界下方，舍入产不出 "1000k"/"1000"——直接进位。
  if (num >= 999_950) {
    return scaled(num / 1_000_000, 'M')
  }

  if (num >= 999.5) {
    return scaled(num / 1_000, 'k')
  }

  return `${Math.round(num)}`
}

/** 单会话用量（pi stats 聚合产物，session-usage.ts 缓存值）。 */
export interface SessionUsageRow {
  readonly totalTokens: number
  readonly costUsd: number
}

/**
 * figures 文本（hermes figures 数组逐语义）：
 * - rowMeta 含 'tokens' 且总量 > 0 → compactNumber；
 * - rowMeta 含 'cost' 且 cost ≥ $0.01 → `$X.XX`（低于一分不出声）；
 * - 多项 ` · ` 连读；全关/全无数据 = 空（调用方不渲染 trailing figures）。
 */
export function buildSessionFigures(
  rowMeta: readonly ('cost' | 'tokens')[],
  usage: SessionUsageRow | undefined,
): string {
  if (!usage) {
    return ''
  }

  const parts: string[] = []

  if (rowMeta.includes('tokens') && usage.totalTokens > 0) {
    parts.push(compactNumber(usage.totalTokens))
  }

  if (rowMeta.includes('cost') && usage.costUsd >= 0.01) {
    parts.push(`$${usage.costUsd.toFixed(2)}`)
  }

  return parts.join(' · ')
}
