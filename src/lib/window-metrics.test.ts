import { describe, expect, it, vi } from 'vitest'

import {
  hermesWindowSize,
  WINDOW_MAX_H,
  WINDOW_MAX_W,
  WINDOW_MIN_H,
  WINDOW_MIN_W,
  WINDOW_SHARE_H,
  WINDOW_SHARE_W,
} from './window-metrics'

describe('hermesWindowSize（hermes window-state.ts 同款公式）', () => {
  it('份额常量与 hermes 一致：0.88 × 0.88', () => {
    expect(WINDOW_SHARE_W).toBe(0.88)
    expect(WINDOW_SHARE_H).toBe(0.88)
  })

  it('夹取边界与 hermes 一致：1280×820 ~ 1760×1100', () => {
    expect(WINDOW_MIN_W).toBe(1280)
    expect(WINDOW_MIN_H).toBe(820)
    expect(WINDOW_MAX_W).toBe(1760)
    expect(WINDOW_MAX_H).toBe(1100)
  })

  it('大工作区撞上限：2560×1440 → 1760×1100', () => {
    expect(hermesWindowSize(2560, 1440)).toEqual({ width: 1760, height: 1100 })
  })

  it('中等工作区按份额：1920×1040 → 1690×915', () => {
    expect(hermesWindowSize(1920, 1040)).toEqual({ width: 1690, height: 915 })
  })

  it('小工作区被下限抬起、但不超过工作区本身：1366×728 → 1280×728', () => {
    expect(hermesWindowSize(1366, 728)).toEqual({ width: 1280, height: 728 })
  })

  it('工作区小于下限时以工作区为准（不撑出屏幕）：1024×600', () => {
    expect(hermesWindowSize(1024, 600)).toEqual({ width: 1024, height: 600 })
  })

  it('工作区正好等于下限：1280×820 保持', () => {
    expect(hermesWindowSize(1280, 820)).toEqual({ width: 1280, height: 820 })
  })

  it('份额取整用四舍五入：1601×0.88 = 1408.88 → 1409', () => {
    expect(hermesWindowSize(1601, 1000).width).toBe(1409)
  })

  it('工作区非法时报错可见并给下限（不静默假装算过）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(hermesWindowSize(0, 1040)).toEqual({ width: 1280, height: 820 })
      expect(hermesWindowSize(1920, Number.NaN)).toEqual({ width: 1280, height: 820 })
      expect(hermesWindowSize(-100, -100)).toEqual({ width: 1280, height: 820 })
      expect(spy).toHaveBeenCalledTimes(3)
      expect(String(spy.mock.calls[0]?.[0])).toContain('[window-metrics]')
    } finally {
      spy.mockRestore()
    }
  })

  it('合法工作区不打日志', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      hermesWindowSize(1920, 1040)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
