/**
 * flexlayout-rowfix 单测：RowNode.calcMinMaxSize 运行时修正的语义验证。
 * 核心：沿轴 max = Σ 子项（从 0 起算，不再被 DefaultMax(99999) 污染）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Orientation, RowNode, TabSetNode } from 'flexlayout-react'

import './flexlayout-rowfix'

type TabOpts = { minW: number; maxW: number; minH: number; maxH: number }

function fakeTabset(o: TabOpts) {
  const n = Object.create(TabSetNode.prototype) as Record<string, unknown>
  n.getMinWidth = () => o.minW
  n.getMaxWidth = () => o.maxW
  n.getMinHeight = () => o.minH
  n.getMaxHeight = () => o.maxH
  // 子项的 calcMinMaxSize 由各自原型执行（tabset 假节点是自算字段，无需动）
  n.calcMinMaxSize = () => {}
  return n
}

function fakeRow(orientation: Orientation, children: Record<string, unknown>[]) {
  const n = Object.create(RowNode.prototype) as Record<string, unknown>
  n.children = children
  n.model = { getSplitterSize: () => 1 }
  n.getOrientation = () => orientation
  return n
}

describe('RowNode.calcMinMaxSize（flexlayout-rowfix 修正后）', () => {
  /** @internal 方法不在公开类型里——经 unknown 调用 */
  const calc = (row: Record<string, unknown>) => (row.calcMinMaxSize as unknown as () => void)()

  it('HORZ 行：宽 max = Σ 子项 max（无 99999 污染）', () => {
    const row = fakeRow(Orientation.HORZ, [
      fakeTabset({ minW: 240, maxW: 420, minH: 0, maxH: 99999 }),
      fakeTabset({ minW: 240, maxW: 420, minH: 0, maxH: 99999 }),
    ])
    calc(row)
    expect(row.maxWidth).toBe(841) // 420+420+1 缝（修正前 = 99999+841 = 100840）
    expect(row.minWidth).toBe(482) // Σ min + 1px 缝（min 基座 1，上游原样）
  })

  it('VERT 行：宽 max = MIN 子项 cMaxW（跨轴）；高 max = Σ（沿轴）', () => {
    const inner = fakeRow(Orientation.HORZ, [
      fakeTabset({ minW: 240, maxW: 420, minH: 0, maxH: 99999 }),
      fakeTabset({ minW: 240, maxW: 420, minH: 0, maxH: 99999 }),
    ])
    calc(inner)
    const soft = fakeTabset({ minW: 0, maxW: 99999, minH: 0, maxH: 99999 })
    const col = fakeRow(Orientation.VERT, [inner as never, soft as never])
    calc(col)
    expect(col.maxWidth).toBe(841) // MIN(841, 99999)
    expect(col.minWidth).toBe(482) // MAX(482, 0)——内行自身 min（含 min 基座 1）
    expect(col.maxHeight).toBe(99999 + 99999 + 1) // Σ 跨轴柔性子项
  })

  it('收口：max ≥ min（病态子项不产生反向界限）', () => {
    const row = fakeRow(Orientation.HORZ, [
      fakeTabset({ minW: 500, maxW: 300, minH: 0, maxH: 99999 }),
      fakeTabset({ minW: 500, maxW: 300, minH: 0, maxH: 99999 }),
    ])
    calc(row)
    expect(row.minWidth).toBe(1002) // Σ min + 1px 缝
    expect(row.maxWidth).toBeGreaterThanOrEqual(row.minWidth as number)
  })
})
