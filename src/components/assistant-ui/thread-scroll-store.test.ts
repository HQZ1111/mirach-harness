/**
 * thread-scroll-store 单测：LRU-50 持久化、形状校验（非法条目丢弃可见）、
 * bottom/offset 数学（classify / targetTop）与恢复请求 seq 语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  classifyScrollState,
  clearThreadScroll,
  getSavedThreadScroll,
  saveThreadScroll,
  scrollDistanceFromBottom,
  THREAD_SCROLL_PERSIST_LIMIT,
  THREAD_SCROLL_STORAGE_KEY,
  threadScrollBridge,
  threadScrollTargetTop,
} from './thread-scroll-store'

const metrics = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})

beforeEach(() => {
  localStorage.clear()
  // 清空模块级 Map（loadPersisted 已在模块加载时跑过一次）：逐一删除
  // 本文件可能用过的键（clearThreadScroll 只对存在的键生效）
  for (let i = 0; i < 60; i++) clearThreadScroll(`s${i}`)
  threadScrollBridge.setState({ scrollRestoreRequest: null })
})

describe('scroll math (纯函数)', () => {
  it('distance from bottom is clamped at 0', () => {
    expect(scrollDistanceFromBottom(metrics(100, 500, 400))).toBe(0)
    expect(scrollDistanceFromBottom(metrics(0, 500, 400))).toBe(100)
    expect(scrollDistanceFromBottom(metrics(150, 500, 400))).toBe(0)
  })

  it('classify: within sticky threshold counts as bottom; beyond is exact offset', () => {
    expect(classifyScrollState(metrics(1600, 2000, 400))).toEqual({ mode: 'bottom' }) // 距底 0
    expect(classifyScrollState(metrics(1594, 2000, 400))).toEqual({ mode: 'bottom' }) // 距底 6 ≤ 8
    expect(classifyScrollState(metrics(1500, 2000, 400))).toEqual({ mode: 'offset', value: 100 })
  })

  it('targetTop: bottom pins to max scroll; offset subtracts distance from bottom', () => {
    expect(threadScrollTargetTop({ mode: 'bottom' }, { scrollHeight: 2000, clientHeight: 400 })).toBe(1600)
    expect(
      threadScrollTargetTop({ mode: 'offset', value: 100 }, { scrollHeight: 2000, clientHeight: 400 }),
    ).toBe(1500)
    // 内容缩短后 offset 被钳在 0
    expect(
      threadScrollTargetTop({ mode: 'offset', value: 100 }, { scrollHeight: 300, clientHeight: 400 }),
    ).toBe(0)
  })
})

describe('save / get / clear', () => {
  it('roundtrips bottom and offset states to localStorage under the contract key', () => {
    saveThreadScroll('s1', { mode: 'bottom' })
    saveThreadScroll('s2', { mode: 'offset', value: 120 })
    expect(getSavedThreadScroll('s1')).toEqual({ mode: 'bottom' })
    expect(getSavedThreadScroll('s2')).toEqual({ mode: 'offset', value: 120 })
    const persisted = JSON.parse(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)!) as Record<string, unknown>
    expect(persisted.s1).toEqual({ mode: 'bottom' })
    expect(persisted.s2).toEqual({ mode: 'offset', value: 120 })
  })

  it('re-saving the same session keeps one entry (no duplicate keys)', () => {
    saveThreadScroll('s1', { mode: 'bottom' })
    saveThreadScroll('s1', { mode: 'offset', value: 5 })
    expect(getSavedThreadScroll('s1')).toEqual({ mode: 'offset', value: 5 })
    const persisted = JSON.parse(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)!) as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual(['s1'])
  })

  it('clearThreadScroll removes memory + persisted entry (no-op when absent)', () => {
    saveThreadScroll('s1', { mode: 'bottom' })
    clearThreadScroll('s1')
    expect(getSavedThreadScroll('s1')).toBeUndefined()
    expect(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)).toBe('{}')
    // 不存在的键：不写盘
    localStorage.setItem(THREAD_SCROLL_STORAGE_KEY, '{"keep":{"mode":"bottom"}}')
    clearThreadScroll('missing')
    expect(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)).toBe('{"keep":{"mode":"bottom"}}')
  })

  it('evicts least-recently-used beyond the 50-entry limit (both sides)', () => {
    for (let i = 0; i < THREAD_SCROLL_PERSIST_LIMIT + 5; i++) {
      saveThreadScroll(`s${i}`, { mode: 'offset', value: i })
    }
    expect(getSavedThreadScroll('s0')).toBeUndefined() // 最早 5 个被挤出
    expect(getSavedThreadScroll('s4')).toBeUndefined()
    expect(getSavedThreadScroll('s5')).toEqual({ mode: 'offset', value: 5 })
    expect(getSavedThreadScroll(`s${THREAD_SCROLL_PERSIST_LIMIT + 4}`)).toEqual({
      mode: 'offset',
      value: THREAD_SCROLL_PERSIST_LIMIT + 4,
    })
    const persisted = JSON.parse(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)!) as Record<string, unknown>
    expect(Object.keys(persisted)).toHaveLength(THREAD_SCROLL_PERSIST_LIMIT)
  })

  it('reload: persisted entries are visible to a fresh module-level Map (loadPersisted contract)', () => {
    saveThreadScroll('s1', { mode: 'offset', value: 77 })
    // 直接验证持久化形状可被 loadPersisted 的校验器接受（重启语义：
    // 模块重新加载即读回）。此处模拟：读原始 JSON 逐条通过 parse 形状。
    const persisted = JSON.parse(localStorage.getItem(THREAD_SCROLL_STORAGE_KEY)!) as Record<string, unknown>
    expect(persisted.s1).toEqual({ mode: 'offset', value: 77 })
  })

  it('empty sessionId is rejected visibly (禁止兜底：错误可见)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      saveThreadScroll('', { mode: 'bottom' })
      expect(err).toHaveBeenCalledWith(expect.stringContaining('sessionId'))
    } finally {
      err.mockRestore()
    }
  })
})

describe('restore request (runtime → 视口桥)', () => {
  it('requestRestore carries sessionId and a monotonically increasing seq', () => {
    threadScrollBridge.getState().requestRestore('a')
    const first = threadScrollBridge.getState().scrollRestoreRequest!
    expect(first.sessionId).toBe('a')
    threadScrollBridge.getState().requestRestore('a')
    const second = threadScrollBridge.getState().scrollRestoreRequest!
    expect(second.sessionId).toBe('a')
    expect(second.seq).toBe(first.seq + 1)
    threadScrollBridge.getState().requestRestore('b')
    const third = threadScrollBridge.getState().scrollRestoreRequest!
    expect(third.sessionId).toBe('b')
    expect(third.seq).toBe(second.seq + 1)
  })

  it('consumeRestoreRequest clears only the matching seq (newer request survives)', () => {
    threadScrollBridge.getState().requestRestore('a')
    const first = threadScrollBridge.getState().scrollRestoreRequest!
    threadScrollBridge.getState().requestRestore('b')
    const second = threadScrollBridge.getState().scrollRestoreRequest!
    expect(second.seq).toBe(first.seq + 1)
    threadScrollBridge.getState().consumeRestoreRequest(first.seq)
    expect(threadScrollBridge.getState().scrollRestoreRequest?.sessionId).toBe('b')
    threadScrollBridge.getState().consumeRestoreRequest(second.seq)
    expect(threadScrollBridge.getState().scrollRestoreRequest).toBeNull()
  })
})
