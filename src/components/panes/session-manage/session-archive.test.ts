/**
 * 会话归档单测（客户端归档——hermes archiveSession 交互面）：严格解析、
 * toggleArchive 对偶、prune 纪律（列表非空才清）与持久化写通。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ARCHIVED_KEY, parseArchived, sessionArchiveStore } from './session-archive'

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const resetStore = () => {
  localStorage.clear()
  sessionArchiveStore.setState({ archived: [] })
}

beforeEach(() => {
  silenceErrors()
  resetStore()
})

describe('严格解析', () => {
  it('null → 空归档（常态非错误）', () => {
    expect(parseArchived(null)).toEqual([])
  })

  it('非法 JSON / 非法形状 console.error 并回空', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseArchived('{oops')).toEqual([])
    expect(parseArchived('{"a":1}')).toEqual([])
    expect(parseArchived('["a",1]')).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('合法数组去重保序', () => {
    expect(parseArchived('["b","a","b"]')).toEqual(['b', 'a'])
  })
})

describe('toggleArchive / prune', () => {
  it('toggle：未归档 → 归档 → 取消归档（写通 localStorage）', () => {
    sessionArchiveStore.getState().toggleArchive('a')
    expect(sessionArchiveStore.getState().archived).toEqual(['a'])
    expect(localStorage.getItem(ARCHIVED_KEY)).toBe(JSON.stringify(['a']))
    sessionArchiveStore.getState().toggleArchive('a')
    expect(sessionArchiveStore.getState().archived).toEqual([])
    expect(localStorage.getItem(ARCHIVED_KEY)).toBe('[]')
  })

  it('prune：删除会话清键；空列表不动（首帧是未加载不是删光）', () => {
    sessionArchiveStore.setState({ archived: ['a', 'b'] })
    sessionArchiveStore.getState().prune(['a', 'c'])
    expect(sessionArchiveStore.getState().archived).toEqual(['a'])
    sessionArchiveStore.getState().prune([])
    expect(sessionArchiveStore.getState().archived).toEqual(['a'])
  })
})
