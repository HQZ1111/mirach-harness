/**
 * session-manage-store 单测：持久化键读写（严格解析——非法形状 console.error
 * 可见且从空态起）、togglePin/setOrder 的写通持久化、prune 的"非空才清"守卫、
 * 拖拽落点信号的 set/clear。IPC/渲染不在测试面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ORDER_KEY,
  PINNED_KEY,
  parseOrder,
  parsePinned,
  sessionManageStore,
} from './session-manage-store'

/** 静音解析失败的 console.error（被测行为就是报错——断言调用而非听噪声） */
const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const resetStore = () => {
  localStorage.clear()
  sessionManageStore.setState({ pinned: [], order: {}, drag: null })
}

describe('parsePinned / parseOrder（严格解析）', () => {
  it('null → 空态（无持久化数据是常态非错误）', () => {
    expect(parsePinned(null)).toEqual([])
    expect(parseOrder(null)).toEqual({})
  })

  it('合法形状原样解析（置顶去重）', () => {
    expect(parsePinned(JSON.stringify(['a', 'b', 'a']))).toEqual(['a', 'b'])
    expect(parseOrder(JSON.stringify({ a: 0, b: 2 }))).toEqual({ a: 0, b: 2 })
  })

  it('非法形状 → console.error + 空态（不冒充旧数据）', () => {
    const spy = silenceErrors()
    expect(parsePinned('not-json')).toEqual([])
    expect(parsePinned(JSON.stringify({ a: 1 }))).toEqual([])
    expect(parsePinned(JSON.stringify([1, 2]))).toEqual([])
    expect(parseOrder('not-json')).toEqual({})
    expect(parseOrder(JSON.stringify([1]))).toEqual({})
    expect(parseOrder(JSON.stringify({ a: 'x' }))).toEqual({})
    expect(parseOrder(JSON.stringify({ a: Number.NaN }))).toEqual({})
    expect(spy).toHaveBeenCalledTimes(7)
    spy.mockRestore()
  })
})

describe('sessionManageStore（zustand vanilla + localStorage 写通）', () => {
  beforeEach(resetStore)

  it('初始态从 localStorage 水合（合法数据）', () => {
    // 重设一次持久化再建"新 store 视角"：模块级 store 只初始化一次，这里
    // 直接验证 parse→state 的同一路径（loadX = parse(safeGetItem(key))）。
    localStorage.setItem(PINNED_KEY, JSON.stringify(['s1']))
    localStorage.setItem(ORDER_KEY, JSON.stringify({ s2: 0 }))
    expect(parsePinned(localStorage.getItem(PINNED_KEY))).toEqual(['s1'])
    expect(parseOrder(localStorage.getItem(ORDER_KEY))).toEqual({ s2: 0 })
  })

  it('togglePin 写通 PINNED_KEY；再切一次移除', () => {
    sessionManageStore.getState().togglePin('s1')
    expect(sessionManageStore.getState().pinned).toEqual(['s1'])
    expect(JSON.parse(localStorage.getItem(PINNED_KEY)!)).toEqual(['s1'])

    sessionManageStore.getState().togglePin('s1')
    expect(sessionManageStore.getState().pinned).toEqual([])
    expect(JSON.parse(localStorage.getItem(PINNED_KEY)!)).toEqual([])
  })

  it('setOrder 写通 ORDER_KEY', () => {
    sessionManageStore.getState().setOrder({ s1: 0, s2: 1 })
    expect(sessionManageStore.getState().order).toEqual({ s1: 0, s2: 1 })
    expect(JSON.parse(localStorage.getItem(ORDER_KEY)!)).toEqual({ s1: 0, s2: 1 })
  })

  it('prune 清掉已消失会话的两类键并写通', () => {
    sessionManageStore.setState({ pinned: ['s1', 's2'], order: { s1: 0, s3: 1 } })
    sessionManageStore.getState().prune(['s1', 's2', 's4'])
    expect(sessionManageStore.getState().pinned).toEqual(['s1', 's2'])
    expect(sessionManageStore.getState().order).toEqual({ s1: 0 })
    expect(JSON.parse(localStorage.getItem(ORDER_KEY)!)).toEqual({ s1: 0 })
  })

  it('prune 对空列表是 no-op（首帧未加载不得毁持久化）', () => {
    sessionManageStore.setState({ pinned: ['s1'], order: { s1: 0 } })
    sessionManageStore.getState().prune([])
    expect(sessionManageStore.getState().pinned).toEqual(['s1'])
    expect(sessionManageStore.getState().order).toEqual({ s1: 0 })
    expect(localStorage.getItem(PINNED_KEY)).toBeNull() // 从未写通过
  })

  it('prune 无变化时不产生写入', () => {
    sessionManageStore.setState({ pinned: ['s1'], order: { s1: 0 } })
    sessionManageStore.getState().prune(['s1'])
    // setState 不写 localStorage——prune 无变化也不写；键保持不存在
    expect(localStorage.getItem(PINNED_KEY)).toBeNull()
    expect(localStorage.getItem(ORDER_KEY)).toBeNull()
  })

  it('setDrag / 清空：拖拽落点信号随会话更新', () => {
    const st = sessionManageStore.getState()
    st.setDrag({ sessionId: 's1', target: { kind: 'list', beforeId: 's2' } })
    expect(sessionManageStore.getState().drag).toEqual({
      sessionId: 's1',
      target: { kind: 'list', beforeId: 's2' },
    })
    st.setDrag({ sessionId: 's1', target: { kind: 'main-tab' } })
    expect(sessionManageStore.getState().drag?.target).toEqual({ kind: 'main-tab' })
    st.setDrag(null)
    expect(sessionManageStore.getState().drag).toBeNull()
  })
})
