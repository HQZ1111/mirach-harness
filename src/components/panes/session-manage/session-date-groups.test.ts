/**
 * 日期分组纯函数单测（hermes lib/session-date-groups.ts + lib/time.ts
 * calendarBucket 行为断言；nowMs/weekStartsOn 显式注入，不依赖宿主时钟与
 * locale 周起始）。覆盖：未标名头部切点（真实停顿才出刀）、粗日历桶
 * （今天/昨天/本周/上周/月）、第一条渲染行永不带标签、凌晨 4 点日滚、
 * 折叠只藏行不留白、手挑序仅桶内重排不跨桶、可见序拼回。
 */
import { describe, expect, it } from 'vitest'

import {
  calendarBucket,
  groupEntriesByRecency,
  hideCollapsedGroupRows,
  nominalDayStart,
  orderRowsWithinGroups,
  startOfLocalDay,
} from './session-date-groups'

const NOW = new Date(2026, 9, 21, 12, 0).getTime() // 2026-10-21 周三 12:00 本地
const WEEK_START = 1 // 周一
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime()

const ids = (
  rows: ReturnType<typeof groupEntriesByRecency>,
): string[] => rows.map((r) => (r.kind === 'session' ? r.id : `#${r.key}`))

describe('calendarBucket（粗日历桶 + 4AM 日滚）', () => {
  it('今天早些时候 / 昨天 / 本周 / 上周 / 本月键位', () => {
    expect(calendarBucket(at(21, 10), NOW, WEEK_START).key).toBe('today')
    expect(calendarBucket(at(20, 15), NOW, WEEK_START).key).toBe('yesterday')
    expect(calendarBucket(at(19, 15), NOW, WEEK_START).key).toBe('this-week') // 周一起算
    expect(calendarBucket(at(18, 15), NOW, WEEK_START).key).toBe('last-week')
    expect(calendarBucket(at(10, 15), NOW, WEEK_START).key).toBe('this-month')
    expect(calendarBucket(new Date(2026, 7, 15).getTime(), NOW, WEEK_START).key).toBe('m-2026-7')
    expect(calendarBucket(new Date(2025, 8, 15).getTime(), NOW, WEEK_START).key).toBe('my-2025-8')
  })

  it('凌晨 4 点前的会话算前一晚（10-21 01:00 → 昨天）', () => {
    expect(calendarBucket(at(21, 1), NOW, WEEK_START).key).toBe('yesterday')
    expect(nominalDayStart(at(21, 1))).toBe(startOfLocalDay(at(20, 0)))
  })
})

describe('groupEntriesByRecency（头部未标名 + 每簇一条分隔线）', () => {
  it('真实停顿后约最新几条为头部；以下按桶出线，首条渲染行永不带标签', () => {
    const rows = groupEntriesByRecency(
      [
        { id: 'a', ms: at(21, 10) },
        { id: 'b', ms: at(21, 9) },
        { id: 'c', ms: at(20, 15) },
        { id: 'd', ms: at(18, 12) },
        { id: 'e', ms: new Date(2026, 8, 15).getTime() },
      ],
      { nowMs: NOW, weekStartsOn: WEEK_START },
    )
    // a/b 之间 1 小时间歇 ≥30min 是候选刀口，但 |log(1/5)|>|log(2/5)|——
    // b 之后切更贴近"最近 5 条"；c(昨天)/d(上周)/e(9月) 各出一条分隔线。
    expect(ids(rows)).toEqual(['a', 'b', '#yesterday', 'c', '#last-week', 'd', '#m-2026-8', 'e'])
  })

  it('密集突发（间隔全 <30min）不切、不出线——整列表是头部', () => {
    const rows = groupEntriesByRecency(
      [
        { id: 'a', ms: new Date(2026, 9, 21, 11, 50).getTime() },
        { id: 'b', ms: new Date(2026, 9, 21, 11, 30).getTime() },
        { id: 'c', ms: new Date(2026, 9, 21, 11, 10).getTime() },
      ],
      { nowMs: NOW, weekStartsOn: WEEK_START },
    )
    expect(rows.every((r) => r.kind === 'session')).toBe(true)
  })

  it('单条会话 = 整列表一个突发，无线', () => {
    const rows = groupEntriesByRecency([{ id: 'a', ms: at(21, 10) }], {
      nowMs: NOW,
      weekStartsOn: WEEK_START,
    })
    expect(rows.every((r) => r.kind === 'session')).toBe(true)
  })
})

describe('hideCollapsedGroupRows（折叠只藏行，分隔线保留可再展开）', () => {
  const rows = [
    { id: 'head', kind: 'session' as const },
    { key: 'yesterday', kind: 'divider' as const, label: '昨天' },
    { id: 'y1', kind: 'session' as const },
    { key: 'last-week', kind: 'divider' as const, label: '上周' },
    { id: 'w1', kind: 'session' as const },
  ]

  it('收起昨天桶：线在行没了；头部（首条线之前）永不折叠', () => {
    const out = hideCollapsedGroupRows(rows, (key) => key !== 'yesterday')
    expect(out.map((r) => (r.kind === 'session' ? r.id : `#${r.key}`))).toEqual([
      'head',
      '#yesterday',
      '#last-week',
      'w1',
    ])
  })

  it('全展开返回原数组引用（虚化列表 rows ref 稳定）', () => {
    expect(hideCollapsedGroupRows(rows, () => true)).toBe(rows)
  })
})

describe('orderRowsWithinGroups（手挑序仅桶内重排，绝不跨桶）', () => {
  it('桶内簇按持久化序重放槽位；未被点名的行保持新近槽位', () => {
    const rows = [
      { id: 'a', kind: 'session' as const },
      { id: 'b', kind: 'session' as const },
      { key: 'yesterday', kind: 'divider' as const, label: '昨天' },
      { id: 'c', kind: 'session' as const },
      { id: 'd', kind: 'session' as const },
    ]
    // 持久化序把 b 提到 a 前；昨天桶（c、d）未点名——保持原样
    const out = orderRowsWithinGroups(rows, ['b', 'a'])
    expect(out.map((r) => (r.kind === 'session' ? r.id : `#${r.key}`))).toEqual([
      'b',
      'a',
      '#yesterday',
      'c',
      'd',
    ])
  })

  it('无持久化顺序 → 原样（引用不变）', () => {
    const rows = [{ id: 'a', kind: 'session' as const }]
    expect(orderRowsWithinGroups(rows, [])).toBe(rows)
  })
})
