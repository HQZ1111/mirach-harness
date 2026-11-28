/**
 * 消息表情反应 store 单测（纯逻辑：键稳定性 / tapback 切换 / 撤销）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  QUICK_REACTIONS,
  DOUBLE_CLICK_REACTION,
  reactionKey,
  reactionsStore,
  resetReactionsForTests,
} from './reactions-store'

beforeEach(() => {
  resetReactionsForTests()
})

describe('reactionKey', () => {
  it('is stable for identical inputs', () => {
    expect(reactionKey('s1', 'assistant', '你好')).toBe(reactionKey('s1', 'assistant', '你好'))
  })

  it('separates sessions, roles and texts', () => {
    expect(reactionKey('s1', 'assistant', 'x')).not.toBe(reactionKey('s2', 'assistant', 'x'))
    expect(reactionKey('s1', 'assistant', 'x')).not.toBe(reactionKey('s1', 'user', 'x'))
    expect(reactionKey('s1', 'assistant', 'x')).not.toBe(reactionKey('s1', 'assistant', 'y'))
  })
})

describe('reactionsStore', () => {
  it('toggle sets then retracts the same emoji (tapback semantics)', () => {
    const key = reactionKey('s1', 'assistant', 'hello')
    reactionsStore.getState().toggle(key, '❤️')
    expect(reactionsStore.getState().byKey[key]).toBe('❤️')
    // same emoji again = retract
    reactionsStore.getState().toggle(key, '❤️')
    expect(reactionsStore.getState().byKey[key]).toBeUndefined()
  })

  it('toggle with a different emoji replaces the previous one', () => {
    const key = reactionKey('s1', 'assistant', 'hello')
    reactionsStore.getState().toggle(key, '❤️')
    reactionsStore.getState().toggle(key, '👍')
    expect(reactionsStore.getState().byKey[key]).toBe('👍')
  })

  it('retract is idempotent for unknown keys', () => {
    expect(() => reactionsStore.getState().retract('missing')).not.toThrow()
    expect(reactionsStore.getState().byKey['missing']).toBeUndefined()
  })
})

describe('quick reactions', () => {
  it('exposes six quick emoji and the double-click tapback is the first', () => {
    expect(QUICK_REACTIONS).toHaveLength(6)
    expect(DOUBLE_CLICK_REACTION).toBe(QUICK_REACTIONS[0])
  })
})
