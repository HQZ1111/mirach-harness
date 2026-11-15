import { describe, expect, it } from 'vitest'

import {
  STREAM_REVEAL_DEFAULTS,
  peakLimit,
  resolveStreamRevealOptions,
  smoothRate,
} from './stream-reveal'

describe('resolveStreamRevealOptions', () => {
  it('无实测速率 → 默认参数（历史消息不编造节奏）', () => {
    expect(resolveStreamRevealOptions()).toEqual(STREAM_REVEAL_DEFAULTS)
    expect(resolveStreamRevealOptions(0)).toEqual(STREAM_REVEAL_DEFAULTS)
    expect(resolveStreamRevealOptions(-5)).toEqual(STREAM_REVEAL_DEFAULTS)
    expect(resolveStreamRevealOptions(Number.NaN)).toEqual(STREAM_REVEAL_DEFAULTS)
  })

  it('速率越快每字间隔越小，但夹在 4–24ms（不慢于 125 字/秒观感）', () => {
    const slow = resolveStreamRevealOptions(20) // 50ms/字 → 夹到 24
    const fast = resolveStreamRevealOptions(400) // 2.5ms/字 → 夹到 4
    expect(slow.maxCharIntervalMs).toBe(24)
    expect(fast.maxCharIntervalMs).toBe(4)
    expect(resolveStreamRevealOptions(100).maxCharIntervalMs).toBe(10)
  })

  it('单帧字符预算随速率增长且至少 1 字', () => {
    expect(resolveStreamRevealOptions(10).maxCharsPerFrame).toBe(1)
    // 60 字/秒 → 20 提交/秒 → 3 字/帧
    expect(resolveStreamRevealOptions(60).maxCharsPerFrame).toBe(3)
  })

  it('排空时长与提交间隔恒为平滑口径（突发 chunk 不整块跳出）', () => {
    for (const rate of [1, 30, 120, 1000]) {
      const options = resolveStreamRevealOptions(rate)
      expect(options.drainMs).toBe(300)
      expect(options.minCommitMs).toBe(48)
    }
  })
})

describe('smoothRate', () => {
  it('首个样本直接采用', () => {
    expect(smoothRate(undefined, 40)).toBe(40)
  })

  it('按 α=0.32 向新样本靠拢（突发不会一步顶满）', () => {
    expect(smoothRate(10, 110)).toBeCloseTo(10 + 0.32 * 100, 5)
    // 连续突发逐步抬升，不会跳到样本值
    let level = 10
    for (let i = 0; i < 3; i++) level = smoothRate(level, 110)
    expect(level).toBeLessThan(110)
    expect(level).toBeGreaterThan(10)
  })
})

describe('peakLimit', () => {
  it('空/全零 → 1（不产生非法揭示率）', () => {
    expect(peakLimit([])).toBe(1)
    expect(peakLimit([0, 0])).toBe(1)
  })

  it('p85×1.35 与中位数×1.8 取大者，裁掉极端 chunk', () => {
    const values = [...Array(20).fill(4), 200]
    const limit = peakLimit(values)
    expect(limit).toBeGreaterThanOrEqual(4 * 1.8)
    expect(limit).toBeLessThan(200)
  })
})
