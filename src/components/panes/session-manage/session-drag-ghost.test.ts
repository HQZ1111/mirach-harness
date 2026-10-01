/**
 * 行拖拽浮层定位纯函数单测：抓取偏移 = 按下点 − 原行左上角；transform
 * 恒使被抓取的行点落在光标下（DragOverlay「整行跟手」的几何契约）。
 */
import { describe, expect, it } from 'vitest'

import { rowGhostOffset, rowGhostTransform } from './session-drag-ghost'

describe('rowGhostOffset', () => {
  it('is the press point minus the row top-left', () => {
    expect(rowGhostOffset(100, 200, { left: 90, top: 180 })).toEqual({ dx: 10, dy: 20 })
  })

  it('is zero when the row was grabbed exactly at its corner', () => {
    expect(rowGhostOffset(50, 60, { left: 50, top: 60 })).toEqual({ dx: 0, dy: 0 })
  })
})

describe('rowGhostTransform', () => {
  it('keeps the grabbed row point under the cursor', () => {
    // 偏移 (10, 20) = 光标按在行内 (10, 20) 处；浮层左上角 = 指针 − 偏移。
    expect(rowGhostTransform(110, 210, { dx: 10, dy: 20 })).toBe('translate3d(100px, 190px, 0)')
  })

  it('stays correct for negative pointer positions (window left of origin)', () => {
    expect(rowGhostTransform(-5, -5, { dx: 10, dy: 20 })).toBe('translate3d(-15px, -25px, 0)')
  })

  it('round-trips: transform + offset restores the pointer point', () => {
    const offset = rowGhostOffset(123, 234, { left: 100, top: 200 })
    const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\)/.exec(rowGhostTransform(345, 456, offset))
    expect(m).not.toBeNull()
    expect(Number(m![1]) + offset.dx).toBe(345)
    expect(Number(m![2]) + offset.dy).toBe(456)
  })
})
