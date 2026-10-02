/**
 * 边缘自动滚步长纯函数单测（reorderable-list 的 edgeScrollStep）：
 * 指针在容器上/下缘 48px 带内 → 按帧滚动；带外 → 0；到边界后由浏览器
 * scrollTop 钳制（到顶/到底自动停——用户定稿）。
 */
import { describe, expect, it } from 'vitest'

import { edgeScrollStep } from './reorderable-list'

const rect = { top: 100, bottom: 900 }

describe('edgeScrollStep', () => {
  it('pointer inside the top edge zone scrolls up', () => {
    expect(edgeScrollStep(120, rect)).toBe(-8)
  })

  it('pointer inside the bottom edge zone scrolls down', () => {
    expect(edgeScrollStep(880, rect)).toBe(8)
  })

  it('pointer in the middle zone does not scroll', () => {
    expect(edgeScrollStep(500, rect)).toBe(0)
  })

  it('zone boundary is exclusive (exactly 48px from edge = no scroll)', () => {
    expect(edgeScrollStep(rect.top + 48, rect)).toBe(0)
    expect(edgeScrollStep(rect.bottom - 48, rect)).toBe(0)
    expect(edgeScrollStep(rect.top + 47, rect)).toBe(-8)
    expect(edgeScrollStep(rect.bottom - 47, rect)).toBe(8)
  })

  it('custom edge zone and step are honored', () => {
    expect(edgeScrollStep(rect.top + 10, rect, 12, 5)).toBe(-5)
    expect(edgeScrollStep(rect.top + 20, rect, 12, 5)).toBe(0)
  })
})
