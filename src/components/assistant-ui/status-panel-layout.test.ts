/**
 * 状态面板让位形态单测（与 ZCode conversationLayout.ts 对账）。
 *
 * 锁住的契约：
 * - 面板不在场（draft / 无内容）→ 不让位、不加顶部余隙（即使 override 钉死了形态）；
 * - mini 钉死 → 任何宽度都是胶囊：不横向让位 + 顶部余隙；
 * - auto → 横向让位（CSS 容器查询 ≥1280 才真正平移）+ 窄态顶部余隙；
 * - panel 钉死 → 横向让位，无顶部余隙。
 */
import { describe, expect, it } from 'vitest'

import { resolveStatusPanelShift } from './status-panel-store'

describe('resolveStatusPanelShift', () => {
  it('draft / 无内容时即使钉死形态也不让位', () => {
    for (const variant of ['auto', 'panel', 'mini'] as const) {
      expect(resolveStatusPanelShift({ scoped: false, present: false, variant })).toEqual({
        offset: false,
        topClearance: 'none',
      })
    }
  })

  it('scoped（会话分栏）永不让位', () => {
    for (const variant of ['auto', 'panel', 'mini'] as const) {
      expect(resolveStatusPanelShift({ scoped: true, present: true, variant })).toEqual({
        offset: false,
        topClearance: 'none',
      })
    }
  })

  it('mini：不让位 + 顶部余隙', () => {
    expect(resolveStatusPanelShift({ scoped: false, present: true, variant: 'mini' })).toEqual({
      offset: false,
      topClearance: 'always',
    })
  })

  it('auto：让位 + 窄态顶部余隙（平移本身由 CSS 容器查询 ≥1280 把关）', () => {
    expect(resolveStatusPanelShift({ scoped: false, present: true, variant: 'auto' })).toEqual({
      offset: true,
      topClearance: 'below-wide',
    })
  })

  it('panel：让位且无顶部余隙', () => {
    expect(resolveStatusPanelShift({ scoped: false, present: true, variant: 'panel' })).toEqual({
      offset: true,
      topClearance: 'none',
    })
  })
})