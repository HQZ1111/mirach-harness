/**
 * 会话 bridge 的新栏门（2026-11-20「在新标签页中打开机器人聊天 → 新栏」）：
 * 登记/派发/未登记报错，以及 focus 短路语义。模块级单例状态，测后复位。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  focusSessionColumnBridge,
  openSessionColumnBridge,
  openStoredSessionBridge,
  setSessionColumnOpener,
  setStoredSessionOpener,
} from './session-tab-bridge'

afterEach(() => {
  setSessionColumnOpener(null)
  setStoredSessionOpener(null)
  vi.restoreAllMocks()
})

describe('session-tab-bridge 新栏门', () => {
  it('未登记时 openSessionColumnBridge 报错可见（不静默）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    openSessionColumnBridge('s1')
    expect(spy).toHaveBeenCalled()
  })

  it('登记后按 (id, options) 派发；focus 返回实现结果', () => {
    const open = vi.fn()
    const focus = vi.fn().mockReturnValue(true)
    setSessionColumnOpener(open, focus)
    openSessionColumnBridge('s1', { title: 'Bot Chat' })
    expect(open).toHaveBeenCalledWith('s1', { title: 'Bot Chat' })
    expect(focusSessionColumnBridge('s1')).toBe(true)
    expect(focus).toHaveBeenCalledWith('s1')
  })

  it('未登记 focus 返回 false（调用方继续走主会话切换）', () => {
    expect(focusSessionColumnBridge('s1')).toBe(false)
  })

  it('复位后不再派发（unmount 清理语义）', () => {
    const open = vi.fn()
    setSessionColumnOpener(open, vi.fn().mockReturnValue(false))
    setSessionColumnOpener(null)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    openSessionColumnBridge('s1')
    expect(open).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
  })

  it('主会开门不受新栏门影响', () => {
    const stored = vi.fn()
    setStoredSessionOpener(stored)
    openStoredSessionBridge('s1')
    expect(stored).toHaveBeenCalledWith('s1')
  })
})