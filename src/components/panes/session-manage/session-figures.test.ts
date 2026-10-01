/**
 * 行尾数字标注单测：compactNumber（hermes apps/shared format.ts 逐字照抄
 * 的边界）+ figures 合成（rowMeta 开关 × 用量缓存值 × 成本 1 美分阈值）。
 */
import { describe, expect, it } from 'vitest'

import { buildSessionFigures, compactNumber } from './session-figures'

describe('compactNumber（hermes format.ts 边界逐条）', () => {
  it('999 → "999"，1000 → "1k"，1230 → "1.2k"，10000 → "10k"', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1000)).toBe('1k')
    expect(compactNumber(1230)).toBe('1.2k')
    expect(compactNumber(10000)).toBe('10k')
  })

  it('999_950 进 M 档（产不出 "1000k"），1_500_000 → "1.5M"', () => {
    expect(compactNumber(999_950)).toBe('1M')
    expect(compactNumber(1_500_000)).toBe('1.5M')
  })

  it('非有限/非正数 → "0"', () => {
    expect(compactNumber(0)).toBe('0')
    expect(compactNumber(-5)).toBe('0')
    expect(compactNumber(null)).toBe('0')
    expect(compactNumber(Number.NaN)).toBe('0')
  })
})

describe('buildSessionFigures（hermes figures 数组逐语义）', () => {
  const usage = { totalTokens: 12300, costUsd: 0.125 }

  it('tokens 开 → 紧凑数；cost 开且 ≥ $0.01 → $X.XX；多项 ` · ` 连读', () => {
    expect(buildSessionFigures(['tokens'], usage)).toBe('12.3k')
    expect(buildSessionFigures(['cost'], usage)).toBe('$0.13')
    expect(buildSessionFigures(['tokens', 'cost'], usage)).toBe('12.3k · $0.13')
  })

  it('rowMeta 关 → 空；用量未拉到（undefined）→ 空', () => {
    expect(buildSessionFigures([], usage)).toBe('')
    expect(buildSessionFigures(['tokens', 'cost'], undefined)).toBe('')
  })

  it('成本低于一分不出声（$0.00 读作 bug——hermes 原注释）', () => {
    expect(buildSessionFigures(['cost'], { totalTokens: 0, costUsd: 0.004 })).toBe('')
  })

  it('tokens 为 0 不显示（compactNumber 的 0 不占位）', () => {
    expect(buildSessionFigures(['tokens', 'cost'], { totalTokens: 0, costUsd: 0.5 })).toBe('$0.50')
  })
})
