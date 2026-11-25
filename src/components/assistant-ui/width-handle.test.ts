/**
 * 对话宽度轴的单测：`resolveContentWidth`（与 CSS clamp 同语义）与
 * `scalePreference`（列宽迁移的**幂等性**——2026-10-18 修累积漂移的判据）。
 *
 * 背景：旧实现每帧 `pref × (新列宽/旧列宽)` 并把结果写回存储，侧栏收放
 * 补间 13 帧 → 一轮写 13 次，链式取整累积（实测 828→1153→831 漂 +3px）。
 * 现在迁移永远相对**同一基准**算，同一 (基准, 目标列宽) 必须恒等。
 */
import { describe, expect, it } from 'vitest'

import { resolveContentWidth, scalePreference } from './width-handle'

describe('resolveContentWidth（与 CSS 同语义）', () => {
  it('无偏好时 = 最大（列宽−176），地板 330（2026-11-25 用户：默认最大）', () => {
    expect(resolveContentWidth(1400, null)).toBe(1224)
    expect(resolveContentWidth(2000, null)).toBe(1824)
    expect(resolveContentWidth(300, null)).toBe(330)
  })

  it('有偏好时夹在 [330, 列宽−176]', () => {
    expect(resolveContentWidth(1000, 800)).toBe(800)
    expect(resolveContentWidth(1000, 100)).toBe(330)
    expect(resolveContentWidth(1000, 2000)).toBe(824) // 1000-176
  })
})

describe('scalePreference（列宽迁移）', () => {
  const base = { column: 1000, preference: 800 }

  it('同一基准 + 同一目标 = 恒等（幂等的核心）', () => {
    expect(scalePreference(base, 1400)).toBe(1120)
    // 重复求值结果不变（旧实现会因链式相乘而漂）
    expect(scalePreference(base, 1400)).toBe(1120)
    expect(scalePreference(base, 1400)).toBe(1120)
  })

  it('往返可逆：放大再缩回，回到原值（±取整半像素内）', () => {
    const widened = scalePreference(base, 1400)
    const back = scalePreference({ column: 1400, preference: widened }, 1000)
    expect(Math.abs(back - base.preference)).toBeLessThanOrEqual(1)
  })

  it('列宽不变 → 偏好不变', () => {
    expect(scalePreference(base, base.column)).toBe(base.preference)
  })
})
