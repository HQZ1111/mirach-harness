/**
 * 配置档案短标签（hermes `lib/profile-short-label.ts` 逐字移植，2026-11-26）。
 * 取名字里第一个"有意义的字素"（跳过空白/标点；组合字符与 emoji 序列不拆散，
 * 保持方块尺寸稳定）。旧版自造的"多词取 2 个首字母/大写"与上游不符。
 */
const profileGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function profileShortLabel(label: string): string {
  for (const { segment } of profileGraphemes.segment(label.trim())) {
    if (/[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment)) {
      return segment
    }
  }

  return '?'
}
