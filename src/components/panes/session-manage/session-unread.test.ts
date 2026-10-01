/**
 * 会话未读态单测（hermes store/session-unread.ts 水位语义的客户端化面）：
 * 严格解析、isRowUnread 判定（标记优先/水位差距）、ingestRows 播种三规则
 * （未知播种不亮绿/选中恒确认/已知未选中不动）、ack/markUnread/ackAll/
 * prune 写通与持久化。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  parseSeenCounts,
  parseUnreadMarkers,
  SEEN_COUNTS_KEY,
  isRowUnread,
  sessionUnreadStore,
  UNREAD_MARKERS_KEY,
} from './session-unread'

/** 静音解析失败的 console.error（被测行为就是报错——断言调用而非听噪声） */
const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const resetStore = () => {
  localStorage.clear()
  sessionUnreadStore.setState({ seen: {}, markers: [] })
}

beforeEach(() => {
  silenceErrors()
  resetStore()
})

describe('严格解析', () => {
  it('null → 空态（无持久化数据是常态非错误）', () => {
    expect(parseSeenCounts(null)).toEqual({})
    expect(parseUnreadMarkers(null)).toEqual([])
  })

  it('非法 JSON / 非法形状 console.error 并回空态（不冒充旧数据）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseSeenCounts('{oops')).toEqual({})
    expect(parseSeenCounts('["a"]')).toEqual({})
    expect(parseSeenCounts('{"a": "x"}')).toEqual({})
    expect(parseUnreadMarkers('[1,2]')).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('合法形状原样解析；水位表剔除非有限条目', () => {
    expect(parseSeenCounts('{"a": 3}')).toEqual({ a: 3 })
    expect(parseUnreadMarkers('["a","a","b"]')).toEqual(['a', 'b'])
  })
})

describe('isRowUnread（hermes recomputeUnread 判定）', () => {
  it('显式标记命中即未读（水位之外的第二源）', () => {
    expect(isRowUnread({ id: 'a', messageCount: 2 }, { a: 5 }, ['a'])).toBe(true)
  })

  it('live count > 水位 → 未读；≤ 水位 → 已读', () => {
    expect(isRowUnread({ id: 'a', messageCount: 6 }, { a: 5 }, [])).toBe(true)
    expect(isRowUnread({ id: 'a', messageCount: 5 }, { a: 5 }, [])).toBe(false)
  })

  it('无水位行按「有消息即未读」处理（播种窗口的防御面）', () => {
    expect(isRowUnread({ id: 'a', messageCount: 1 }, {}, [])).toBe(true)
    expect(isRowUnread({ id: 'a', messageCount: 0 }, {}, [])).toBe(false)
  })
})

describe('ingestRows（hermes ingestRows 三规则）', () => {
  it('未知会话按当前 count 播种（首见不亮绿）', () => {
    sessionUnreadStore.getState().ingestRows(
      [ { id: 'a', messageCount: 4 }, { id: 'b', messageCount: 0 } ],
      null,
    )
    const s = sessionUnreadStore.getState()
    expect(s.seen).toEqual({ a: 4, b: 0 })
    expect(isRowUnread({ id: 'a', messageCount: 4 }, s.seen, s.markers)).toBe(false)
  })

  it('选中会话恒跟踪 live count（在屏幕上 = 已读）', () => {
    sessionUnreadStore.setState({ seen: { a: 3 } })
    sessionUnreadStore.getState().ingestRows([{ id: 'a', messageCount: 9 }], 'a')
    expect(sessionUnreadStore.getState().seen).toEqual({ a: 9 })
  })

  it('已知未选中行不动——水位与 live count 的差就是未读信号', () => {
    sessionUnreadStore.setState({ seen: { a: 3, b: 7 } })
    sessionUnreadStore.getState().ingestRows(
      [ { id: 'a', messageCount: 9 }, { id: 'b', messageCount: 7 } ],
      null,
    )
    expect(sessionUnreadStore.getState().seen).toEqual({ a: 3, b: 7 })
  })

  it('非有限 count 跳过；无变化不写 localStorage', () => {
    const before = localStorage.getItem(SEEN_COUNTS_KEY)
    const changed = sessionUnreadStore.getState().ingestRows(
      [ { id: 'a', messageCount: Number.NaN } ],
      null,
    )
    expect(changed).toBe(false)
    expect(localStorage.getItem(SEEN_COUNTS_KEY)).toBe(before)
  })
})

describe('ack / markUnread / ackAll / prune', () => {
  it('ackSession：水位 := count + 撤销显式标记', () => {
    sessionUnreadStore.setState({ seen: { a: 1 }, markers: ['a'] })
    sessionUnreadStore.getState().ackSession('a', 5)
    const s = sessionUnreadStore.getState()
    expect(s.seen.a).toBe(5)
    expect(s.markers).toEqual([])
  })

  it('markSessionUnread：加显式标记（幂等）', () => {
    sessionUnreadStore.getState().markSessionUnread('a')
    sessionUnreadStore.getState().markSessionUnread('a')
    expect(sessionUnreadStore.getState().markers).toEqual(['a'])
  })

  it('ackAll：确认全部已加载行（含撤标记）；空行面不动', () => {
    sessionUnreadStore.setState({ seen: { a: 1 }, markers: ['b'] })
    sessionUnreadStore.getState().ackAll([
      { id: 'a', messageCount: 4 },
      { id: 'b', messageCount: 2 },
    ])
    const s = sessionUnreadStore.getState()
    expect(s.seen).toEqual({ a: 4, b: 2 })
    expect(s.markers).toEqual([])
    expect(localStorage.getItem(SEEN_COUNTS_KEY)).toBe(JSON.stringify({ a: 4, b: 2 }))
    expect(localStorage.getItem(UNREAD_MARKERS_KEY)).toBe('[]')
  })

  it('ackAll 空行 = 无事（不装作已读）', () => {
    sessionUnreadStore.setState({ seen: { a: 1 } })
    sessionUnreadStore.getState().ackAll([])
    expect(sessionUnreadStore.getState().seen).toEqual({ a: 1 })
  })

  it('prune：只清消失会话的键；空列表不动（首帧是未加载不是删光）', () => {
    sessionUnreadStore.setState({ seen: { a: 1, b: 2 }, markers: ['a', 'c'] })
    sessionUnreadStore.getState().prune(['a', 'b'])
    const s = sessionUnreadStore.getState()
    expect(s.seen).toEqual({ a: 1, b: 2 })
    expect(s.markers).toEqual(['a'])
    sessionUnreadStore.getState().prune([])
    expect(sessionUnreadStore.getState().seen).toEqual({ a: 1, b: 2 })
  })
})
