/**
 * highlight-cache 单测：内容寻址 LRU（键 = scope+lang+code）的往返、
 * get 刷新新近度、条数/总量双上限逐出、同键覆盖记账与 clear。
 */
import { describe, expect, it } from 'vitest'

import { HighlightCache, HIGHLIGHT_CACHE_MAX_ENTRIES, highlightCacheKey } from './highlight-cache'

describe('highlightCacheKey', () => {
  it('用 \u0000 连接 scope/language/code，逐字代码进键', () => {
    expect(highlightCacheKey('s', 'ts', 'const x')).toBe('s\u0000ts\u0000const x')
  })

  it('不同 language 或代码得到不同键', () => {
    expect(highlightCacheKey('s', 'ts', 'a')).not.toBe(highlightCacheKey('s', 'js', 'a'))
    expect(highlightCacheKey('s', 'ts', 'a')).not.toBe(highlightCacheKey('s', 'ts', 'ab'))
  })
})

describe('HighlightCache', () => {
  it('set/get 往返与 has', () => {
    const cache = new HighlightCache<string>(10, 1000)

    expect(cache.get('k')).toBeUndefined()
    expect(cache.has('k')).toBe(false)

    cache.set('k', 'v', 1)

    expect(cache.get('k')).toBe('v')
    expect(cache.has('k')).toBe(true)
    expect(cache.size).toBe(1)
    expect(cache.totalChars).toBe(1)
  })

  it('get 刷新新近度：最久未用的先被逐出', () => {
    const cache = new HighlightCache<string>(2, 1000)

    cache.set('a', 'A', 1)
    cache.set('b', 'B', 1)
    expect(cache.get('a')).toBe('A') // a 变最新
    cache.set('c', 'C', 1) // 超条数上限 → 逐出最旧的 b

    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
  })

  it('超总量上限逐出，直到 chars 回到上限内', () => {
    const cache = new HighlightCache<string>(10, 10)

    cache.set('a', 'A'.repeat(6), 6)
    cache.set('b', 'B'.repeat(6), 6) // 12 > 10 → 逐出 a
    cache.set('c', 'C'.repeat(6), 6) // 12 > 10 → 逐出 b

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(false)
    expect(cache.get('c')).toBe('C'.repeat(6))
    expect(cache.totalChars).toBeLessThanOrEqual(10)
  })

  it('同键覆盖重记账，不重复计 chars', () => {
    const cache = new HighlightCache<string>(10, 100)

    cache.set('k', '12345', 5)
    cache.set('k', '1234567890', 10)

    expect(cache.size).toBe(1)
    expect(cache.totalChars).toBe(10)
  })

  it('clear 清空条目与总量', () => {
    const cache = new HighlightCache<string>(10, 100)

    cache.set('k', 'v', 1)
    cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.totalChars).toBe(0)
    expect(cache.get('k')).toBeUndefined()
  })

  it('默认上限条数 = HIGHLIGHT_CACHE_MAX_ENTRIES', () => {
    const cache = new HighlightCache<string>()

    for (let i = 0; i < HIGHLIGHT_CACHE_MAX_ENTRIES + 5; i += 1) {
      cache.set(`k${i}`, 'v', 1)
    }

    expect(cache.size).toBe(HIGHLIGHT_CACHE_MAX_ENTRIES)
  })
})
