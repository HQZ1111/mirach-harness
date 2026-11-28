/**
 * resume 状态机单测（退避曲线 / 4 次耗尽 / 显式重试清 latch）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_RESUME_ATTEMPTS,
  resetSessionResumeForTests,
  resumeBackoffMs,
  sessionResume,
} from './session-resume-state'

beforeEach(() => {
  resetSessionResumeForTests()
})

describe('resumeBackoffMs', () => {
  it('1s→2s→4s→8s 封顶', () => {
    expect(resumeBackoffMs(1)).toBe(1000)
    expect(resumeBackoffMs(2)).toBe(2000)
    expect(resumeBackoffMs(3)).toBe(4000)
    expect(resumeBackoffMs(4)).toBe(8000)
    expect(resumeBackoffMs(9)).toBe(8000)
  })
})

describe('sessionResume', () => {
  it('第 MAX 次失败才 exhausted（自动重试期间不锁）', () => {
    const id = 's1'
    for (let i = 1; i < MAX_RESUME_ATTEMPTS; i++) {
      const e = sessionResume.getState().noteFailure(id, `err${i}`)
      expect(e.attempts).toBe(i)
      expect(e.exhausted).toBe(false)
    }
    const last = sessionResume.getState().noteFailure(id, 'final')
    expect(last.attempts).toBe(MAX_RESUME_ATTEMPTS)
    expect(last.exhausted).toBe(true)
  })

  it('成功清条目；reset 清 latch 且计数从 1 重来', () => {
    const id = 's1'
    for (let i = 0; i < MAX_RESUME_ATTEMPTS; i++) sessionResume.getState().noteFailure(id, 'e')
    expect(sessionResume.getState().byId[id]?.exhausted).toBe(true)
    sessionResume.getState().reset(id)
    expect(sessionResume.getState().byId[id]).toBeUndefined()
    const next = sessionResume.getState().noteFailure(id, 'again')
    expect(next.attempts).toBe(1)
    expect(next.exhausted).toBe(false)
    sessionResume.getState().noteSuccess(id)
    expect(sessionResume.getState().byId[id]).toBeUndefined()
  })
})
