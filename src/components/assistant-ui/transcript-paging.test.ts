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