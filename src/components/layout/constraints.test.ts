/**
 * constraints.ts 纯函数单测：聚合界限 / 钳制 / 顶带判定 / region 读取。
 * 假节点 = Object.create(真原型) + 自有字段/方法——instanceof 判定真实，
 * 行为受控（不需要真 flexlayout 布局）。
 */
import { describe, expect, it } from 'vitest'
import { Orientation, RowNode, TabSetNode } from 'flexlayout-react'

import {
  clampRowWeights,
  heightBounds,
  isTopBand,
  regionCfgOfNode,
  rootNeededMin,
  widthBounds,
} from './constraints'

type TabOpts = { minW?: number; maxW?: number; minH?: number; maxH?: number; config?: unknown }

/** 假 tabset：instanceof TabSetNode 为真，约束字段可控 */
function fakeTabset(id: string, o: TabOpts = {}) {
  const n = Object.create(TabSetNode.prototype) as Record<string, unknown>
  n.getId = () => id
  n.getConfig = () => o.config
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getMinHeight = () => o.minH ?? 0
  n.getMaxHeight = () => o.maxH ?? 99999
  return n
}

type RowOpts = {
  orientation: Orientation
  children: Record<string, unknown>[]
  minW?: number
  maxW?: number
  minH?: number
  maxH?: number
}

/** 假行：instanceof RowNode 为真 */
function fakeRow(id: string, o: RowOpts) {
  const n = Object.create(RowNode.prototype) as Record<string, unknown>
  n.getId = () => id
  n.getChildren = () => o.children
  n.getOrientation = () => o.orientation
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getMinHeight = () => o.minH ?? 0
  n.getMaxHeight = () => o.maxH ?? 99999
  return n
}

const HORZ = Orientation.HORZ
const VERT = Orientation.VERT

describe('widthBounds 聚合', () => {
  it('tabset：读自身声明 min/max', () => {
    const t = fakeTabset('a', { minW: 240, maxW: 420 })
    expect(widthBounds(t as never, false)).toEqual({ min: 240, max: 420 })
  })

  it('轨 tabset：固定 20/20', () => {
    const t = fakeTabset('track', { config: { region: 'left', rail: true, track: true } })
    expect(widthBounds(t as never, false)).toEqual({ min: 20, max: 20 })
  })

  it('HORZ 行：宽 = Σ 子项（+1px 缝）', () => {
    const row = fakeRow('col', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240, maxW: 420 }),
        fakeTabset('b', { minW: 240, maxW: 420 }),
      ],
    })
    expect(widthBounds(row as never, false)).toEqual({ min: 481, max: 841 })
  })

  it('VERT 行：宽 = MAX(min)/MIN(max)——聚合上限有效', () => {
    const inner = fakeRow('inner', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240, maxW: 420 }),
        fakeTabset('b', { minW: 240, maxW: 420 }),
      ],
      minW: 481,
      maxW: 841,
    })
    const soft = fakeTabset('soft', { minW: 0, maxW: 99999 })
    const col = fakeRow('col', { orientation: VERT, children: [inner, soft] })
    expect(widthBounds(col as never, true)).toEqual({ min: 481, max: 841 })
  })
})

describe('heightBounds 聚合（转置）', () => {
  it('VERT 行：高 = Σ 子项（+缝）', () => {
    const row = fakeRow('col', {
      orientation: VERT,
      children: [
        fakeTabset('a', { minH: 100, maxH: 500 }),
        fakeTabset('b', { minH: 50, maxH: 300 }),
      ],
    })
    expect(heightBounds(row as never)).toEqual({ min: 151, max: 801 }) // Σ + 1px 缝
  })

  it('HORZ 行：高 = MAX(min)/MIN(max)', () => {
    const row = fakeRow('row', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minH: 100, maxH: 500 }),
        fakeTabset('b', { minH: 150, maxH: 300 }),
      ],
    })
    expect(heightBounds(row as never)).toEqual({ min: 150, max: 300 })
  })
})

describe('clampRowWeights 拖拽钳制（保险网）', () => {
  function fakeDragRow(orientation: Orientation, kids: Record<string, unknown>[], w: number, h: number) {
    const row = Object.create(RowNode.prototype) as Record<string, unknown>
    row.getChildren = () => kids
    row.getOrientation = () => orientation
    row.getRect = () => ({ width: w, height: h } as never)
    return row as never
  }
  const tab = (minW: number, maxW: number, minH = 0, maxH = 99999) =>
    fakeTabset('t' + Math.random(), { minW, maxW, minH, maxH })

  it('无越界：返回 null（不干预）', () => {
    const kids = [tab(240, 420), tab(395, 99999), tab(240, 99999)]
    // 1796px 可用：[350, 746, 700] 全部在界内
    const row = fakeDragRow(HORZ, kids, 1798, 1000)
    expect(clampRowWeights(row as never, [(350 / 1796) * 100, (746 / 1796) * 100, (700 / 1796) * 100])).toBeNull()
  })

  it('子项超聚合上限：钳回 max（宽度轴）', () => {
    const kids = [tab(240, 420), tab(240, 420)]
    const row = fakeDragRow(HORZ, kids, 842, 500)
    // 权重把两栏顶到 500/500 → 各自 max 420
    const fixed = clampRowWeights(row as never, [(500 / 840) * 100, (500 / 840) * 100])
    expect(fixed).not.toBeNull()
    for (const wPct of fixed!) {
      const px = (wPct / 100) * 840
      expect(px).toBeLessThanOrEqual(420 + 0.5)
      expect(px).toBeGreaterThanOrEqual(240 - 0.5)
    }
  })

  it('VERT 行钳高度轴（不是宽度）', () => {
    const kids = [tab(240, 420, 50, 99999), tab(240, 420, 50, 99999)]
    const row = fakeDragRow(VERT, kids, 900, 600)
    // 高度 600：权重把两栏压到 100/100 → 各自 min 高 50 不触发，改用超 min 方向
    const fixed = clampRowWeights(row as never, [(50 / 600) * 100, (50 / 600) * 100])
    expect(fixed).not.toBeNull()
    for (const wPct of fixed!) {
      const px = (wPct / 100) * (600 - 1)
      expect(px).toBeGreaterThanOrEqual(50 - 0.5)
    }
  })
})

describe('isTopBand 顶带判定', () => {
  function nodeWithParent(parent: Record<string, unknown>) {
    const n = Object.create(TabSetNode.prototype) as Record<string, unknown>
    n.getParent = () => parent as never
    return n
  }
  function row(orientation: Orientation, children: unknown[]) {
    const r = Object.create(RowNode.prototype) as Record<string, unknown>
    r.getOrientation = () => orientation
    r.getChildren = () => children as never
    return r
  }

  it('根行直接子项（列）= 顶带', () => {
    const root = row(HORZ, [])
    const col = nodeWithParent(root)
    root.getChildren = () => [col] as never
    expect(isTopBand(root as never, col as never)).toBe(true)
  })

  it('VERT 行的第二个孩子不在顶带；HORZ 行孩子全体在顶带', () => {
    const root = row(HORZ, [])
    const col = row(VERT, [])
    const a = nodeWithParent(col)
    const b = nodeWithParent(col)
    col.getChildren = () => [a, b] as never
    col.getParent = () => root as never
    root.getChildren = () => [col] as never
    expect(isTopBand(root as never, a as never)).toBe(true)
    expect(isTopBand(root as never, b as never)).toBe(false)
  })

  it('HORZ 子行的孩子并排同高：全体顶带', () => {
    const root = row(HORZ, [])
    const col = row(VERT, [])
    const band = row(HORZ, [])
    const a = nodeWithParent(band)
    const b = nodeWithParent(band)
    band.getChildren = () => [a, b] as never
    band.getParent = () => col as never
    col.getChildren = () => [band] as never
    col.getParent = () => root as never
    root.getChildren = () => [col] as never
    expect(isTopBand(root as never, a as never)).toBe(true)
    expect(isTopBand(root as never, b as never)).toBe(true)
  })
})

describe('rootNeededMin / regionCfgOfNode', () => {
  it('根行所需最小宽 = Σ(列聚合 min) + 缝', () => {
    const root = fakeRow('root', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240, maxW: 420 }),
        fakeTabset('mid', { minW: 395, maxW: 99999 }),        fakeTabset('c', { minW: 240, maxW: 420 }),
      ],
      minW: 0,
      maxW: 99999,
    })
    const m = { getRootRow: () => root } as never
    expect(rootNeededMin(m)).toBe(240 + 395 + 240 + 2)
  })

  it('regionCfgOfNode：读 config；非 tabset 返回 undefined', () => {
    const t = fakeTabset('a', { config: { region: 'left', rail: false } })
    expect(regionCfgOfNode(t as never)).toEqual({ region: 'left', track: false })
    const rowFake = Object.create(RowNode.prototype) as Record<string, unknown>
    rowFake.getChildren = () => []
    expect(regionCfgOfNode(rowFake as never)).toBeUndefined()
  })
})
