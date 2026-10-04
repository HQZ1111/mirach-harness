import { describe, expect, it } from 'vitest'
import { PANE_TYPES, PRIMARY_PANE, REGION_DEFAULT_W, REGION_LIMITS, type PaneType, type Region } from './pane-registry'

describe('PANE_TYPES 不变量', () => {
  it('每个类型都有合法 region', () => {
    for (const [type, def] of Object.entries(PANE_TYPES)) {
      expect(['left', 'chat', 'panels']).toContain(def.region)
      expect(typeof type).toBe('string')
    }
  })

  it('每个大栏的常驻窗格存在且 primary 指向自身类型', () => {
    for (const region of ['left', 'chat', 'panels'] as Region[]) {
      const primary = PRIMARY_PANE[region]
      expect(PANE_TYPES[primary]).toBeDefined()
      expect(PANE_TYPES[primary].region).toBe(region)
      expect(PANE_TYPES[primary].primary).toBe(true)
    }
  })

  it('primary 类型集合 = leftrail/workspace/open（三栏各一）', () => {
    const primaries = Object.entries(PANE_TYPES).filter(([, d]) => d.primary).map(([t]) => t)
    expect(primaries.sort()).toEqual(['leftrail', 'open', 'workspace'])
  })

  it('REGION_LIMITS：默认宽不低于 min（v5.0：左栏唯一有 max 420）', () => {
    for (const region of ['left', 'chat', 'panels'] as Region[]) {
      const lim = REGION_LIMITS[region]
      expect(typeof lim.minW).toBe('number')
      expect(lim.minW).toBeGreaterThan(0)
      const def = REGION_DEFAULT_W[region]
      expect(def).toBeGreaterThanOrEqual(lim.minW)
    }
    expect(REGION_LIMITS.left.maxW).toBe(420)
    expect(REGION_LIMITS.chat.maxW).toBeUndefined()
    expect(REGION_LIMITS.panels.maxW).toBeUndefined()
    expect((Object.keys(REGION_LIMITS) as PaneType[]).length).toBeGreaterThan(0)
  })
})
