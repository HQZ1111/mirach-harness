/**
 * cost-bridge 单测：纯逻辑——formatUsd 数字格式化（小值 4 位、≥1 美元
 * 2 位、非有限 "—"）、accumulateSessionCost 会话累计入账（null 会话/
 * 非有限金额跳过、不改入参）、recordRun 的 store 行为（per-session 累计、
 * 无活动会话不入账且错误可见、lastRun 快照、pi 未报成本不累计）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  accumulateSessionCost,
  costBridge,
  formatUsd,
} from './cost-bridge'

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

beforeEach(() => {
  costBridge.setState({ costBySession: {}, activeSessionId: null, lastRun: null })
})

describe('formatUsd', () => {
  it('小值 4 位小数（$0.0123 口径）', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123')
    expect(formatUsd(0.5)).toBe('$0.5000')
  })

  it('≥1 美元 2 位小数', () => {
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  it('非有限值 → "—"（不编造数字）', () => {
    expect(formatUsd(Number.NaN)).toBe('—')
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('accumulateSessionCost', () => {
  it('按会话键累加，不改入参 map', () => {
    const base = { 's1': 0.01 }
    const next = accumulateSessionCost(base, 's1', 0.02)
    expect(next['s1']).toBeCloseTo(0.03, 10)
    expect(base['s1']).toBe(0.01)
  })

  it('null 会话（域异常）与非有限金额 → 原样返回', () => {
    const base = { 's1': 1 }
    expect(accumulateSessionCost(base, null, 0.5)).toBe(base)
    expect(accumulateSessionCost(base, 's1', Number.NaN)).toBe(base)
  })
})

describe('costBridge.recordRun', () => {
  it('同会话多次 run 累加，lastRun 为最新快照', () => {
    costBridge.getState().recordRun({
      sessionId: 's1',
      model: 'p/m1',
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 10,
    })
    costBridge.getState().recordRun({ sessionId: 's1', model: 'p/m1', costUsd: 0.02 })
    const s = costBridge.getState()
    expect(s.costBySession['s1']).toBeCloseTo(0.03, 10)
    expect(s.activeSessionId).toBe('s1')
    expect(s.lastRun).toEqual({ model: 'p/m1', costUsd: 0.02 })
  })

  it('不同会话按键隔离累计', () => {
    costBridge.getState().recordRun({ sessionId: 's1', model: 'p/m1', costUsd: 0.01 })
    costBridge.getState().recordRun({ sessionId: 's2', model: 'p/m2', costUsd: 0.5 })
    const s = costBridge.getState()
    expect(s.costBySession['s1']).toBeCloseTo(0.01, 10)
    expect(s.costBySession['s2']).toBeCloseTo(0.5, 10)
    expect(s.activeSessionId).toBe('s2')
  })

  it('pi 未报 costUsd：不累计，lastRun.costUsd = null（显示 —）', () => {
    costBridge.getState().recordRun({ sessionId: 's1', model: 'p/m1', inputTokens: 7 })
    const s = costBridge.getState()
    expect(s.costBySession).toEqual({})
    expect(s.lastRun).toEqual({ model: 'p/m1', costUsd: null, inputTokens: 7 })
  })

  it('无活动会话（null sessionId）→ 错误可见且不入账', () => {
    const spy = silenceErrors()
    costBridge.getState().recordRun({ sessionId: null, model: 'p/m1', costUsd: 0.01 })
    const s = costBridge.getState()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(s.costBySession).toEqual({})
    expect(s.lastRun).toBeNull()
    spy.mockRestore()
  })
})

describe('costBridge.resetSession', () => {
  it('会话切换：活动会话指向新 id、lastRun 清，累计按键保留', () => {
    costBridge.getState().recordRun({ sessionId: 's1', model: 'p/m1', costUsd: 0.01 })
    costBridge.getState().resetSession('s2')
    const s = costBridge.getState()
    expect(s.activeSessionId).toBe('s2')
    expect(s.lastRun).toBeNull()
    expect(s.costBySession['s1']).toBeCloseTo(0.01, 10)
  })
})
