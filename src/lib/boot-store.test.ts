import { describe, expect, it } from 'vitest'

import { bootBridge } from './boot-store'

describe('bootBridge', () => {
  it('starts booting with no error', () => {
    const s = bootBridge.getState()
    expect(s.phase === 'booting' || s.phase === 'ready' || s.phase === 'failed').toBe(true)
    expect(s.error === null || typeof s.error === 'string').toBe(true)
  })

  it('ready clears the error and is idempotent', () => {
    bootBridge.getState().setFailed('boom')
    expect(bootBridge.getState().phase).toBe('failed')
    bootBridge.getState().setReady()
    expect(bootBridge.getState()).toMatchObject({ phase: 'ready', error: null })
    const first = bootBridge.getState()
    bootBridge.getState().setReady()
    expect(bootBridge.getState()).toBe(first)
  })

  it('requestRetry re-enters booting and bumps retrySeq once per call', () => {
    bootBridge.getState().setFailed('boom')
    const before = bootBridge.getState().retrySeq
    bootBridge.getState().requestRetry()
    expect(bootBridge.getState()).toMatchObject({ phase: 'booting', error: null })
    expect(bootBridge.getState().retrySeq).toBe(before + 1)
  })
})
