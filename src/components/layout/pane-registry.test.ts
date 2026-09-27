/** pane-registry 数据不变量（§6/§7）：类型表自洽性 */
import { describe, expect, it } from 'vitest'

import { PANE_TYPES, PRIMARY_PANE, REGION_DEFAULT_W, REGION_LIMITS, type PaneType, type Region } from './pane-registry'

describe('PANE_TYPES 不变量', () => {
  it('每个类型都有合法 region', () => {
    for (const [type, def] of Object.entries(PANE_TYPES)) {
      expect(['left', 'main', 'right']).toContain(def.region)
      expect(typeof type).toBe('string')
    }
  })

  it('每个大栏的一级窗格存在且primary指向自身类型', () => {
    for (const region of ['left', 'main', 'right'] as Region[]) {
      const primary = PRIMARY_PANE[region]
      expect(PANE_TYPES[primary]).toBeDefined()
      expect(PANE_TYPES[primary].region).toBe(region)
      expect(PANE_TYPES[primary].primary).toBe(true)
    }
  })

  it('primary 类型集合与表一致', () => {
    const primaries = Object.entries(PANE_TYPES).filter(([, d]) => d.primary).map(([t]) => t)
    expect(primaries.sort()).toEqual(['files', 'sessions', 'workspace'])
  })

  it('REGION_LIMITS：min ≤ max（有 max 的区）；默认宽在区间内', () => {
    for (const region of ['left', 'main', 'right'] as Region[]) {
      const lim = REGION_LIMITS[region]
      if (lim.maxW != null) expect(lim.minW).toBeLessThanOrEqual(lim.maxW)
      const def = REGION_DEFAULT_W[region]
      expect(def).toBeGreaterThanOrEqual(lim.minW)
      // 列默认宽的天花板是**聚合** max（§2.3，随列内结构变化），
      // 不与单分栏 maxW 直接比较——只做量级卫生检查（≤ 2×420 并排聚合）
      expect(def).toBeLessThanOrEqual(900)
    }
    expect((Object.keys(REGION_LIMITS) as PaneType[]).length).toBeGreaterThan(0)
  })
})
