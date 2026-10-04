/**
 * constraints.ts 纯函数单测：聚合界限 / 顶带判定 / region 读取。
 * （v5.0：clampRowWeights/heightBounds 已随 max 上限废除；轨用例删——
 * 竖轨形态已废。）
 * 假节点 = Object.create(真原型) + 自有字段/方法——instanceof 判定真实。
 */
import { describe, expect, it } from 'vitest'
import { Orientation, RowNode, TabSetNode } from 'flexlayout-react'

import {
  isTopBand,
  regionCfgOfNode,
  rootNeededMin,
  widthBounds,
} from './constraints'

type TabOpts = { minW?: number; maxW?: number; config?: unknown }

function fakeTabset(id: string, o: TabOpts = {}) {
  const n = Object.create(TabSetNode.prototype) as Record<string, unknown>
  n.getId = () => id
  n.getConfig = () => o.config
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getMinHeight = () => 0
  n.getMaxHeight = () => 99999
  return n
}

type RowOpts = {
  orientation: Orientation
  children: Record<string, unknown>[]
  minW?: number
  maxW?: number
}

function fakeRow(id: string, o: RowOpts) {
  const n = Object.create(RowNode.prototype) as Record<string, unknown>
  n.getId = () => id
  n.getChildren = () => o.children
  n.getOrientation = () => o.orientation
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getMinHeight = () => 0
  n.getMaxHeight = () => 99999
  return n
}

const HORZ = Orientation.HORZ
const VERT = Orientation.VERT

describe('widthBounds 聚合', () => {
  it('tabset：min 读自身声明；max 恒无上限（v5.0）', () => {
    const t = fakeTabset('a', { minW: 240, maxW: 420 })
    expect(widthBounds(t as never, false)).toEqual({ min: 240, max: 99999 })
  })

  it('HORZ 行：宽 min = Σ 子项（+1px 缝）；max 无上限', () => {
    const row = fakeRow('col', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240 }),
        fakeTabset('b', { minW: 240 }),
      ],
    })
    expect(widthBounds(row as never, false)).toEqual({ min: 481, max: 99999 })
  })

  it('VERT 行：宽 min = MAX(子 min)', () => {
    const inner = fakeRow('inner', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240 }),
        fakeTabset('b', { minW: 240 }),
      ],
      minW: 481,
    })
    const soft = fakeTabset('soft', { minW: 0 })
    const col = fakeRow('col', { orientation: VERT, children: [inner, soft] })
    expect(widthBounds(col as never, true)).toEqual({ min: 481, max: 99999 })
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

  it('VERT 行的第二个孩子不在顶带', () => {
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
})

describe('rootNeededMin / regionCfgOfNode', () => {
  it('根行所需最小宽 = Σ(列聚合 min) + 缝', () => {
    const root = fakeRow('root', {
      orientation: HORZ,
      children: [
        fakeTabset('a', { minW: 240 }),
        fakeTabset('mid', { minW: 395 }),
        fakeTabset('c', { minW: 240 }),
      ],
      minW: 0,
      maxW: 99999,
    })
    const m = { getRootRow: () => root } as never
    expect(rootNeededMin(m)).toBe(240 + 395 + 240 + 2)
  })

  it('regionCfgOfNode：读 config；非 tabset 返回 undefined', () => {
    const t = fakeTabset('a', { config: { region: 'left' } })
    expect(regionCfgOfNode(t as never)).toEqual({ region: 'left', track: false })
    const rowFake = Object.create(RowNode.prototype) as Record<string, unknown>
    rowFake.getChildren = () => []
    expect(regionCfgOfNode(rowFake as never)).toBeUndefined()
  })
})
