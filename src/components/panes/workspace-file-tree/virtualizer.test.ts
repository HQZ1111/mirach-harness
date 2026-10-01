/* 固定行高虚拟化（@tanstack/react-virtual 等价替换）区间计算用例。 */
import { describe, expect, it } from 'vitest'

import { computeFileTreeVirtualRange } from './useFileTreeVirtualizer'

const ROW = 28

describe('computeFileTreeVirtualRange', () => {
  it('空列表返回空区间', () => {
    expect(computeFileTreeVirtualRange({ count: 0, rowHeight: ROW, overscan: 12, scrollOffset: 0, viewportHeight: 280 })).toEqual({
      startIndex: 0,
      endIndex: -1,
      totalSize: 0,
    })
  })

  it('顶部整屏可见（含恰好整除）', () => {
    const range = computeFileTreeVirtualRange({ count: 100, rowHeight: ROW, overscan: 0, scrollOffset: 0, viewportHeight: 280 })
    expect(range.startIndex).toBe(0)
    expect(range.endIndex).toBe(9)
    expect(range.totalSize).toBe(100 * ROW)
  })

  it('滚动到中间只渲染可见行', () => {
    const range = computeFileTreeVirtualRange({ count: 100, rowHeight: ROW, overscan: 0, scrollOffset: 140, viewportHeight: 28 })
    expect(range.startIndex).toBe(5)
    expect(range.endIndex).toBe(5)
  })

  it('overscan 向两侧扩张', () => {
    const range = computeFileTreeVirtualRange({ count: 100, rowHeight: ROW, overscan: 2, scrollOffset: 140, viewportHeight: 28 })
    expect(range.startIndex).toBe(3)
    expect(range.endIndex).toBe(7)
  })

  it('区间不越过列表两端', () => {
    const head = computeFileTreeVirtualRange({ count: 10, rowHeight: ROW, overscan: 12, scrollOffset: 0, viewportHeight: 280 })
    expect(head.startIndex).toBe(0)
    expect(head.endIndex).toBe(9)
    const tail = computeFileTreeVirtualRange({ count: 10, rowHeight: ROW, overscan: 12, scrollOffset: 9999, viewportHeight: 280 })
    expect(tail.startIndex).toBe(0)
    expect(tail.endIndex).toBe(9)
  })

  it('视口高度 0 时仍渲染 overscan 兜底行（挂载首帧）', () => {
    const range = computeFileTreeVirtualRange({ count: 100, rowHeight: ROW, overscan: 3, scrollOffset: 0, viewportHeight: 0 })
    expect(range.startIndex).toBe(0)
    expect(range.endIndex).toBe(3)
  })

  it('小数滚动偏移向下取整', () => {
    const range = computeFileTreeVirtualRange({ count: 100, rowHeight: ROW, overscan: 0, scrollOffset: 28.6, viewportHeight: 28 })
    expect(range.startIndex).toBe(1)
    expect(range.endIndex).toBe(2)
  })
})
