/**
 * session-queue-store 单测：按会话分桶的队列纯逻辑——enqueue 追加序、
 * takeFirst FIFO 出队、remove 中段删除、clearSession 清空、**跨会话隔离**
 * （A 的排队消息不因切换/B 的操作丢失）、持久化落盘（localStorage 写入
 * 形状可被 loadPersisted 守卫接受）。IPC/POST 不在测试面（drain 的发送
 * 路径由 runtime 真实环境验证）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { sessionQueue } from './session-queue-store'
import { sessionThreadKey } from './session-thread-key'

const item = (id: string, text: string) => ({ id, text })

const A = sessionThreadKey('session-a')
const B = sessionThreadKey('session-b')

beforeEach(() => {
  sessionQueue.getState().clearSession(A)
  sessionQueue.getState().clearSession(B)
  sessionQueue.getState().setActiveKey(A)
})

describe('sessionQueue（按会话分桶）', () => {
  it('enqueue 追加保持提交顺序（按会话键分桶）', () => {
    sessionQueue.getState().enqueue(A, item('a', '第一条'))
    sessionQueue.getState().enqueue(A, item('b', '第二条'))
    expect(sessionQueue.getState().bySession[A].map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('takeFirst FIFO：每次出队最旧一条，其余保留', () => {
    sessionQueue.getState().enqueue(A, item('a', '一'))
    sessionQueue.getState().enqueue(A, item('b', '二'))
    sessionQueue.getState().enqueue(A, item('c', '三'))
    expect(sessionQueue.getState().takeFirst(A)?.id).toBe('a')
    expect(sessionQueue.getState().bySession[A].map((m) => m.id)).toEqual(['b', 'c'])
    expect(sessionQueue.getState().takeFirst(A)?.id).toBe('b')
    expect(sessionQueue.getState().takeFirst(A)?.id).toBe('c')
    expect(sessionQueue.getState().bySession[A]).toHaveLength(0)
  })

  it('takeFirst 携带文本与图片载荷（drain 原样发出）', () => {
    sessionQueue.getState().enqueue(A, {
      id: 'q1',
      text: '带图消息',
      images: [{ data: 'base64==', mimeType: 'image/png' }],
      imageDataUrls: ['data:image/png;base64,base64=='],
    })
    const taken = sessionQueue.getState().takeFirst(A)
    expect(taken?.text).toBe('带图消息')
    expect(taken?.images).toEqual([{ data: 'base64==', mimeType: 'image/png' }])
    expect(taken?.imageDataUrls).toEqual(['data:image/png;base64,base64=='])
  })

  it('remove 删中段不影响其余顺序（队列项可删除）', () => {
    sessionQueue.getState().enqueue(A, item('a', '一'))
    sessionQueue.getState().enqueue(A, item('b', '二'))
    sessionQueue.getState().enqueue(A, item('c', '三'))
    sessionQueue.getState().remove(A, 'b')
    expect(sessionQueue.getState().bySession[A].map((m) => m.id)).toEqual(['a', 'c'])
    expect(sessionQueue.getState().takeFirst(A)?.id).toBe('a')
  })

  it('空队列 takeFirst 返回 null 且状态不变', () => {
    expect(sessionQueue.getState().takeFirst(A)).toBeNull()
    expect(sessionQueue.getState().bySession[A] ?? []).toEqual([])
  })

  it('跨会话隔离：A/B 各自独立，互不串桶', () => {
    sessionQueue.getState().enqueue(A, item('a1', 'A 的消息'))
    sessionQueue.getState().enqueue(B, item('b1', 'B 的消息'))
    // drain A 不动 B
    expect(sessionQueue.getState().takeFirst(A)?.id).toBe('a1')
    expect(sessionQueue.getState().bySession[B].map((m) => m.id)).toEqual(['b1'])
    // 清 A 不动 B
    sessionQueue.getState().clearSession(A)
    expect(sessionQueue.getState().bySession[A] ?? []).toEqual([])
    expect(sessionQueue.getState().bySession[B].map((m) => m.id)).toEqual(['b1'])
  })

  it('持久化：enqueue 落盘，形状可被 loadPersisted 守卫接受', () => {
    sessionQueue.getState().enqueue(A, item('p1', '重启前排的消息'))
    const raw = localStorage.getItem('mirach:session-queue.v1')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { bySession: Record<string, { id: string }[]> }
    expect(parsed.bySession[A]?.map((m) => m.id)).toContain('p1')
  })
})
