/**
 * 发件箱单测（journal/retire/恢复语义 + 会话删除清理）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  lastPendingSend,
  resetSendOutboxForTests,
  sendOutbox,
} from './send-outbox'

const key = 'main:s1'
const entry = (id: string, text = 'hi') => ({
  id,
  text,
  submission: text,
  createdAt: Date.now(),
})

beforeEach(() => {
  resetSendOutboxForTests()
})

describe('sendOutbox', () => {
  it('journal 落盘、retire 退场、lastPendingSend 读最后一条', () => {
    sendOutbox.getState().journalSend(key, entry('a', '第一'))
    expect(lastPendingSend(key)?.text).toBe('第一')
    sendOutbox.getState().journalSend(key, entry('b', '第二'))
    expect(lastPendingSend(key)?.text).toBe('第二')
    sendOutbox.getState().retireSend(key, 'b')
    expect(lastPendingSend(key)?.text).toBe('第一')
    sendOutbox.getState().retireSend(key, 'a')
    expect(lastPendingSend(key)).toBeNull()
  })

  it('同 id 重写不重复（重试沿用同 submission id）', () => {
    sendOutbox.getState().journalSend(key, entry('a', '旧'))
    sendOutbox.getState().journalSend(key, entry('a', '新'))
    expect(sendOutbox.getState().bySession[key]).toHaveLength(1)
    expect(lastPendingSend(key)?.text).toBe('新')
  })

  it('clearSession 整键清（删除会话生命周期）', () => {
    sendOutbox.getState().journalSend(key, entry('a'))
    sendOutbox.getState().clearSession(key)
    expect(lastPendingSend(key)).toBeNull()
  })

  it('retire 未知 id 幂等', () => {
    expect(() => sendOutbox.getState().retireSend(key, 'nope')).not.toThrow()
  })
})
