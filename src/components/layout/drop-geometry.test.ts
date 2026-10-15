/**
 * 径向落点几何单测（hermes radialPosition 语义移植）——「上下判定不灵敏」
 * 的修复以 CDP 实测值锁死：旧 dockview quadrant 在对话列 (15%, 90%) 判
 * left（先横后纵 + 固定 20% 带），新几何必须判 bottom。
 */
import { describe, expect, it } from 'vitest'
import type { Position } from 'dockview-react'

import { ALL_DROP_ZONES, CENTER_RADIUS, radialResolve } from './drop-geometry'

const W = 400
const H = 900

const at = (fx: number, fy: number, zones: ReadonlySet<Position> = ALL_DROP_ZONES) =>
  radialResolve(zones, fx * W, fy * H, W, H)

describe('radialResolve（hermes radialPosition 语义）', () => {
  it('中心椭圆内 = center（0.62 半径逐字值）', () => {
    expect(at(0.5, 0.5)).toBe('center')
    expect(at(0.5, 0.5 + CENTER_RADIUS * 0.45)).toBe('center')
  })

  it('主轴主导：上/下/左/右四边', () => {
    expect(at(0.5, 0.05)).toBe('top')
    expect(at(0.5, 0.95)).toBe('bottom')
    expect(at(0.03, 0.5)).toBe('left')
    expect(at(0.97, 0.5)).toBe('right')
  })

  it('CDP 实锤修复点：(15%, 90%) 判 bottom 不再判 left', () => {
    expect(at(0.15, 0.9)).toBe('bottom')
    // 同角区更贴左（|dx| 主导）才倒向 left——对角线分界。
    expect(at(0.05, 0.9)).toBe('left')
  })

  it('角区沿象限对角线倒向最近边（归一化主导轴）', () => {
    // 右下角：dy 归一更大 → bottom
    expect(at(0.9, 0.95)).toBe('bottom')
    // 左上角：dx 归一更大 → left
    expect(at(0.08, 0.3)).toBe('left')
    // 下中偏左：dx=-0.6, dy=0.8 → bottom
    expect(at(0.2, 0.9)).toBe('bottom')
  })

  it('受限 zones：主轴不在集内回退次轴', () => {
    const verticalOnly = new Set<Position>(['top', 'bottom', 'center'])
    // 横向主导（left）不在集 → 次轴纵向按 dy 符号回退。
    expect(at(0.03, 0.5, verticalOnly)).toBe('bottom')
    expect(at(0.1, 0.9, verticalOnly)).toBe('bottom')
    const leftRightOnly = new Set<Position>(['left', 'right'])
    // 纵向主导（top）不在集 → 次轴横向按 dx 符号回退（左偏）。
    expect(at(0.1, 0.05, leftRightOnly)).toBe('left')
  })

  it('空 zones → null（无提示帧，一处真相）', () => {
    expect(at(0.5, 0.5, new Set<Position>())).toBeNull()
  })
})
