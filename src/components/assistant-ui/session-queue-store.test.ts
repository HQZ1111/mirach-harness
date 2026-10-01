/**
 * session-queue-store 单测：队列纯逻辑——enqueue 追加序、takeFirst FIFO
 * 出队、remove 中段删除、clear 清空、空队列 takeFirst 返回 null 不动状态。
 * IPC/POST 不在测试面（drain 的发送路径由 runtime 真实环境验证）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { sessionQueue } from './session-queue-store'

const item = (id: string, text: string) => ({ id, text })

beforeEach(() => {
  sessionQueue.getState().clear()
})

describe('sessionQueue', () => {
  it('enqueue 追加保持提交顺序', () => {
    sessionQueue.getState().enqueue(item('a', '第一条'))
    sessionQueue.getState().enqueue(item('b', '第二条'))
    expect(sessionQueue.getState().items.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('takeFirst FIFO：每次出队最旧一条，其余保留', () => {
    sessionQueue.getState().enqueue(item('a', '一'))
    sessionQueue.getState().enqueue(item('b', '二'))
    sessionQueue.getState().enqueue(item('c', '三'))
    expect(sessionQueue.getState().takeFirst()?.id).toBe('a')
    expect(sessionQueue.getState().items.map((m) => m.id)).toEqual(['b', 'c'])
    expect(sessionQueue.getState().takeFirst()?.id).toBe('b')
    expect(sessionQueue.getState().takeFirst()?.id).toBe('c')
    expect(sessionQueue.getState().items).toHaveLength(0)
  })

  it('takeFirst 携带文本与图片载荷（drain 原样发出）', () => {
    sessionQueue.getState().enqueue({
      id: 'q1',
      text: '带图消息',
      images: [{ data: 'base64==', mimeType: 'image/png' }],
      imageDataUrls: ['data:image/png;base64,base64=='],
    })
    const taken = sessionQueue.getState().takeFirst()
    expect(taken?.text).toBe('带图消息')
    expect(taken?.images).toEqual([{ data: 'base64==', mimeType: 'image/png' }])
    expect(taken?.imageDataUrls).toEqual(['data:image/png;base64,base64=='])
  })

  it('remove 删中段不影响其余顺序（队列项可删除）', () => {
    sessionQueue.getState().enqueue(item('a', '一'))
    sessionQueue.getState().enqueue(item('b', '二'))
    sessionQueue.getState().enqueue(item('c', '三'))
    sessionQueue.getState().remove('b')
    expect(sessionQueue.getState().items.map((m) => m.id)).toEqual(['a', 'c'])
    expect(sessionQueue.getState().takeFirst()?.id).toBe('a')
  })

  it('空队列 takeFirst 返回 null 且状态不变', () => {
    expect(sessionQueue.getState().takeFirst()).toBeNull()
    expect(sessionQueue.getState().items).toEqual([])
  })

  it('clear 清空（会话更换时 runtime 调用）', () => {
    sessionQueue.getState().enqueue(item('a', '一'))
    sessionQueue.getState().clear()
    expect(sessionQueue.getState().items).toEqual([])
  })
})
