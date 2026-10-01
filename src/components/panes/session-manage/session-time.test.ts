/**
 * 会话行时间标注单测（hermes lib/time.ts + timestamp.ts + session-row
 * formatAge 段的照抄面）：粗粒度桶、行 age 文案（刚刚/天/时/分）、绝对
 * 时间标注（今天/昨天/日期）、RFC3339 解析。Intl 措辞跟随系统 locale 的
 * 断言只用固定 locale 不可控的部分不写（工程规矩 11）。
 */
import { describe, expect, it } from 'vitest'

import {
  coarseElapsed,
  DAY,
  HOUR,
  MINUTE,
  parseTimestampMs,
  sessionRowAge,
  formatMessageTimestamp,
  THREAD_TIME_LABELS,
} from './session-time'

describe('coarseElapsed（hermes lib/time 逐语义）', () => {
  it('负数钳 0 → second 桶', () => {
    expect(coarseElapsed(-5)).toEqual({ unit: 'second', value: 0 })
  })

  it('分/时/天向下取整', () => {
    expect(coarseElapsed(90 * 1000)).toEqual({ unit: 'minute', value: 1 })
    expect(coarseElapsed(2 * HOUR + 3 * MINUTE)).toEqual({ unit: 'hour', value: 2 })
    expect(coarseElapsed(3 * DAY + 2 * HOUR)).toEqual({ unit: 'day', value: 3 })
  })
})

describe('sessionRowAge（hermes formatAge：侧栏永不显示秒）', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)

  it('一分钟内 = 「刚刚」', () => {
    expect(sessionRowAge(now - 30 * 1000, undefined, now)).toBe('刚刚')
    expect(sessionRowAge(now, undefined, now)).toBe('刚刚')
  })

  it('分/时/天后缀无单位词（`3天`/`5时`/`12分`）', () => {
    expect(sessionRowAge(now - 12 * MINUTE, undefined, now)).toBe('12分')
    expect(sessionRowAge(now - 5 * HOUR, undefined, now)).toBe('5时')
    expect(sessionRowAge(now - 3 * DAY, undefined, now)).toBe('3天')
  })
})

describe('formatMessageTimestamp（hermes timestamp.ts 逐语义）', () => {
  it('空/无效值 → 空串（不冒充有效时间）', () => {
    expect(formatMessageTimestamp(undefined, THREAD_TIME_LABELS)).toBe('')
    expect(formatMessageTimestamp('not-a-date', THREAD_TIME_LABELS)).toBe('')
  })

  it('今天/昨天分支走 labels（时钟由 Intl 提供，labels 收到它）', () => {
    const today = new Date()
    const yesterday = new Date(Date.now() - DAY)
    expect(formatMessageTimestamp(today, { today: (t) => `T[${t}]`, yesterday: (t) => `Y[${t}]` })).toMatch(/^T\[/)
    expect(formatMessageTimestamp(yesterday, { today: (t) => `T[${t}]`, yesterday: (t) => `Y[${t}]` })).toMatch(/^Y\[/)
  })
})

describe('parseTimestampMs（pi header.timestamp = RFC3339 millis）', () => {
  it('RFC3339 解析成功', () => {
    expect(parseTimestampMs('2026-10-01T12:00:00.000Z')).toBe(Date.UTC(2026, 9, 1, 12, 0, 0))
  })

  it('undefined/空串 → undefined；非法串 → undefined（不回 0 假装 1970）', () => {
    expect(parseTimestampMs(undefined)).toBeUndefined()
    expect(parseTimestampMs('')).toBeUndefined()
    expect(parseTimestampMs('garbage')).toBeUndefined()
  })
})
