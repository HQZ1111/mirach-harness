/**
 * 会话工作态单测（busy 双源 / 停浪探针节流 / 清键）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  STALL_MS,
  isSessionBusy,
  noteStallIfAny,
  resetSessionWorkForTests,
  sessionWork,
} from './session-work-store'

const key = 'main:s1'

beforeEach(() => {
  resetSessionWorkForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionWork', () => {
  it('busy = actorStreaming 或 laneBusy（双源）', () => {
    expect(isSessionBusy(key)).toBe(false)
    sessionWork.getState().setActorStreaming(key, true)
    expect(isSessionBusy(key)).toBe(true)
    sessionWork.getState().setActorStreaming(key, false)
    expect(isSessionBusy(key)).toBe(false)
    sessionWork.getState().setLaneBusy(true)
    expect(isSessionBusy(key)).toBe(true)
  })

  it('markEvent 刷新 lastEventAt', () => {
    const before = Date.now()
    sessionWork.getState().markEvent(key)
    expect(sessionWork.getState().byKey[key]!.lastEventAt).toBeGreaterThanOrEqual(before)
  })

  it('停浪探针：streaming 且超阈值才触发，且节流只记一次', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    sessionWork.getState().setActorStreaming(key, true)
    sessionWork.getState().markEvent(key)
    const now = Date.now()
    expect(noteStallIfAny(key, now)).toBe(false)
    // 超阈值 → 触发并可见
    expect(noteStallIfAny(key, now + STALL_MS + 1)).toBe(true)
    expect(err).toHaveBeenCalledTimes(1)
    // 节流窗内不复记
    expect(noteStallIfAny(key, now + STALL_MS + 2)).toBe(true)
    expect(err).toHaveBeenCalledTimes(1)
    // 非 streaming 不判停浪
    sessionWork.getState().setActorStreaming(key, false)
    expect(noteStallIfAny(key, now + STALL_MS * 3)).toBe(false)
  })

  it('clearKey 幂等', () => {
    sessionWork.getState().setActorStreaming(key, true)
    sessionWork.getState().clearKey(key)
    expect(sessionWork.getState().byKey[key]).toBeUndefined()
    expect(() => sessionWork.getState().clearKey(key)).not.toThrow()
  })
})
