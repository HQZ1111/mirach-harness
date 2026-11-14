import { describe, expect, it, vi } from 'vitest'

import {
  CHAT_MIN_WIDTH,
  clampRailWidth,
  leftRailDefaultWidth,
  panelsRailDefaultWidth,
  RAIL_BOUNDS,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from './rail-metrics'

describe('rail-metrics（用户定稿：默认 300 / min 270 / max 400）', () => {
  it('三个值就是用户给的数，不存在比例换算', () => {
    expect(RAIL_DEFAULT_WIDTH).toBe(300)
    expect(RAIL_MIN_WIDTH).toBe(270)
    expect(RAIL_MAX_WIDTH).toBe(400)
    expect(RAIL_BOUNDS).toEqual({ min: 270, max: 400 })
  })

  it('左栏与面板栏默认宽同值 300，且不接收容器宽（不随窗口缩放）', () => {
    expect(leftRailDefaultWidth()).toBe(300)
    expect(panelsRailDefaultWidth()).toBe(300)
    // 函数签名不带参数——容器宽变化不会影响栏宽
    expect(leftRailDefaultWidth.length).toBe(0)
    expect(panelsRailDefaultWidth.length).toBe(0)
  })

  it('clampRailWidth 夹在 [270, 400]', () => {
    expect(clampRailWidth(300)).toBe(300)
    expect(clampRailWidth(270)).toBe(270)
    expect(clampRailWidth(400)).toBe(400)
    expect(clampRailWidth(100)).toBe(270)
    expect(clampRailWidth(9999)).toBe(400)
  })

  it('clampRailWidth 四舍五入到整数（dockview 的 px 是整数）', () => {
    expect(clampRailWidth(300.4)).toBe(300)
    expect(clampRailWidth(300.6)).toBe(301)
  })

  it('非法宽度报错可见并回落到默认宽（不静默当成合法值）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(clampRailWidth(Number.NaN)).toBe(300)
      expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(300)
      expect(spy).toHaveBeenCalledTimes(2)
      expect(String(spy.mock.calls[0]?.[0])).toContain('[rail-metrics]')
    } finally {
      spy.mockRestore()
    }
  })

  it('合法宽度不打日志', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      clampRailWidth(350)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('自定义边界（纯函数，可复用）', () => {
    expect(clampRailWidth(500, { min: 100, max: 200 })).toBe(200)
    expect(clampRailWidth(50, { min: 100, max: 200 })).toBe(100)
  })

  it('主栏最小宽独立于栏宽口径', () => {
    expect(CHAT_MIN_WIDTH).toBe(395)
  })
})
