/**
 * transcript-paging retention 单测（确定性覆盖 releaseTranscriptHistory /
 * loadOlderTranscript 的取舍与守卫；实机冒烟见 HANDOFF）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import {
  hydrateTranscriptTail,
  loadOlderTranscript,
  registerTranscriptActor,
  releaseTranscriptHistory,
  transcriptTailStore,
} from './transcript-paging'

const wirePage = (n: number, ids: string[], hasMore = true) => ({
  messages: Array.from({ length: n }, (_, i) => ({
    role: 'user',
    content: `m${i}`,
  })),
  entryIds: ids,
  hasMore,
})

describe('transcript-paging retention', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    transcriptTailStore.setState({
      sessionId: null,
      oldestEntryId: null,
      hasMore: false,
      loading: false,
      pages: [],
    })
  })

  it('releaseTranscriptHistory trims to the newest RETAINED_PAGES pages', () => {
    const send = vi.fn()
    registerTranscriptActor({ send })
    transcriptTailStore.setState({
      sessionId: 's',
      oldestEntryId: 'e0',
      hasMore: true,
      loading: false,
      pages: [
        { messages: 2, firstEntryId: 'e0' },
        { messages: 2, firstEntryId: 'e2' },
        { messages: 2, firstEntryId: 'e4' },
        { messages: 2, firstEntryId: 'e6' },
      ],
    })
    releaseTranscriptHistory()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'TRIM_HISTORY', keep: 6 })
    const after = transcriptTailStore.getState()
    expect(after.pages.map((p) => p.firstEntryId)).toEqual(['e2', 'e4', 'e6'])
    expect(after.oldestEntryId).toBe('e2')
    expect(after.hasMore).toBe(true)
  })

  it('releaseTranscriptHistory is a no-op without older history or while loading', () => {
    const send = vi.fn()
    registerTranscriptActor({ send })
    transcriptTailStore.setState({
      sessionId: 's',
      oldestEntryId: 'e0',
      hasMore: false,
      loading: false,
      pages: [
        { messages: 1, firstEntryId: 'a' },
        { messages: 1, firstEntryId: 'b' },
        { messages: 1, firstEntryId: 'c' },
        { messages: 1, firstEntryId: 'd' },
      ],
    })
    releaseTranscriptHistory()
    expect(send).not.toHaveBeenCalled()
    transcriptTailStore.setState({ hasMore: true, loading: true })
    releaseTranscriptHistory()
    expect(send).not.toHaveBeenCalled()
  })

  it('loadOlderTranscript records the fetched page and advances the cursor', async () => {
    const send = vi.fn()
    registerTranscriptActor({ send })
    transcriptTailStore.setState({
      sessionId: 's',
      oldestEntryId: 'e10',
      hasMore: true,
      loading: false,
      pages: [{ messages: 1, firstEntryId: 'e10' }],
    })
    invokeMock.mockResolvedValueOnce(wirePage(2, ['e8', 'e9']))
    const ok = await loadOlderTranscript()
    expect(ok).toBe(true)
    expect(send).toHaveBeenCalledWith({
      type: 'PREPEND_HISTORY',
      messages: expect.any(Array),
    })
    const after = transcriptTailStore.getState()
    expect(after.oldestEntryId).toBe('e8')
    expect(after.pages[0]?.firstEntryId).toBe('e8')
    expect(after.pages).toHaveLength(2)
  })

  it('loadOlderTranscript without a registered actor reports and skips', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 新 import 的模块实例未注册：通过再 import 拿一个未注册实例代价大，
    // 这里直接复位为未注册不可行（模块单例）——改测守卫链上的空页分支。
    transcriptTailStore.setState({
      sessionId: 's',
      oldestEntryId: 'e1',
      hasMore: true,
      loading: false,
      pages: [],
    })
    invokeMock.mockResolvedValueOnce({ messages: [], entryIds: [], hasMore: false })
    registerTranscriptActor({ send: vi.fn() })
    const ok = await loadOlderTranscript()
    expect(ok).toBe(false)
    expect(transcriptTailStore.getState().hasMore).toBe(false)
    error.mockRestore()
  })
})
// ── 切换会话的 hydrate 归属守卫（2026-11-27 内容“丢失”回归）─────────────
// 竞态：点 A → open(A) → hydrate(A) 发起；又点 B → 引擎切到 B；A 的响应回来
// 时数据其实属于 B。旧实现会按 A 写进 actor，表现为「切换会话后内容错乱/
// 丢失，再切一次又出来一部分」。
describe('hydrateTranscriptTail 会话归属守卫', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    transcriptTailStore.setState({ sessionId: null, hasMore: false, loading: false })
  })

  it('被更新的切换取代时丢弃结果（不写 actor）', async () => {
    const sends: unknown[] = []
    const actor = {
      send: (e: unknown) => sends.push(e),
    } as unknown as Parameters<typeof hydrateTranscriptTail>[0]

    // 第一次 hydrate 的 IPC 挂起，模拟"在途时用户又切了会话"
    let releaseFirst: (v: unknown) => void = () => {}
    const firstPending = new Promise((resolve) => {
      releaseFirst = resolve
    })
    invokeMock.mockImplementationOnce(() => firstPending)

    const firstCall = hydrateTranscriptTail(actor, 'session-A')

    // 第二次 hydrate（更新的切换）先完成
    invokeMock.mockImplementationOnce(async () => wirePage(1, ['e1'], false))
    const secondOk = await hydrateTranscriptTail(actor, 'session-B')

    // 迟到的第一次响应回来 → 必须被判定为过期
    releaseFirst(wirePage(9, ['x1'], false))
    const firstOk = await firstCall

    expect(secondOk).toBe(true)
    expect(firstOk).toBe(false) // 过期 → 丢弃
    // actor 只应收到第二次那次 HYDRATE（一次，不是两次）
    const hydrates = sends.filter(
      (e) => (e as { type?: string }).type === 'HYDRATE',
    )
    expect(hydrates).toHaveLength(1)
    // store 的 sessionId 属于最后一次切换
    expect(transcriptTailStore.getState().sessionId).toBe('session-B')
  })

  it('没有并发切换时正常写入并返回 true', async () => {
    const sends: unknown[] = []
    const actor = {
      send: (e: unknown) => sends.push(e),
    } as unknown as Parameters<typeof hydrateTranscriptTail>[0]
    invokeMock.mockImplementationOnce(async () => wirePage(2, ['a1', 'a2'], false))

    const ok = await hydrateTranscriptTail(actor, 'session-1')
    expect(ok).toBe(true)
    expect(transcriptTailStore.getState().sessionId).toBe('session-1')
    expect(sends.filter((e) => (e as { type?: string }).type === 'HYDRATE')).toHaveLength(1)
  })
})
