import { describe, expect, it } from 'vitest'

import {
  consumeTerminalInputFallbackHandledData,
  createPendingTerminalInputFallback,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
} from './terminal-composed-input'

const ESC = String.fromCharCode(0x1b)

describe('createTerminalInputFallbackKeydownCandidate', () => {
  it('records plain single-character keys', () => {
    const candidate = createTerminalInputFallbackKeydownCandidate({
      eventTimeStamp: 10,
      key: 'a',
      now: 20,
    })
    expect(candidate).toEqual({ eventTimeStamp: 10, kind: 'text', recordedAt: 20, text: 'a' })
  })

  it('treats Enter/Process as IME commit keys', () => {
    for (const key of ['Enter', 'Process']) {
      expect(
        createTerminalInputFallbackKeydownCandidate({ eventTimeStamp: 1, key, now: 2 }),
      ).toEqual({ eventTimeStamp: 1, kind: 'imeCommit', recordedAt: 2, text: null })
    }
  })

  it('ignores modifier keys and escape sequences', () => {
    expect(
      createTerminalInputFallbackKeydownCandidate({ eventTimeStamp: 1, key: 'Shift', now: 1 }),
    ).toBeNull()
    expect(
      createTerminalInputFallbackKeydownCandidate({ eventTimeStamp: 1, key: ESC, now: 1 }),
    ).toBeNull()
    expect(
      createTerminalInputFallbackKeydownCandidate({ eventTimeStamp: 1, key: '\r', now: 1 }),
    ).toBeNull()
  })
})

describe('recordTerminalInputFallbackHandledData', () => {
  it('matches onData to the pending keydown within the window', () => {
    const candidate = createTerminalInputFallbackKeydownCandidate({
      eventTimeStamp: 10,
      key: 'a',
      now: 100,
    })
    const result = recordTerminalInputFallbackHandledData({
      candidate,
      data: 'a',
      history: [],
      maxAgeMs: 150,
      now: 120,
    })
    expect(result.usedCandidate).toBe(true)
    expect(result.history).toHaveLength(1)
    expect(result.history[0]).toMatchObject({ consumed: false, data: 'a', kind: 'text' })
  })

  it('drops a stale candidate (no dedupe window left)', () => {
    const candidate = createTerminalInputFallbackKeydownCandidate({
      eventTimeStamp: 10,
      key: 'a',
      now: 0,
    })
    const result = recordTerminalInputFallbackHandledData({
      candidate,
      data: 'a',
      history: [],
      maxAgeMs: 150,
      now: 500,
    })
    expect(result.usedCandidate).toBe(false)
    expect(result.history).toHaveLength(0)
  })

  it('extracts printable text for IME Enter commits merged with a control char', () => {
    const candidate = createTerminalInputFallbackKeydownCandidate({
      eventTimeStamp: 10,
      key: 'Enter',
      now: 10,
    })
    const result = recordTerminalInputFallbackHandledData({
      candidate,
      data: '中文\r',
      history: [],
      maxAgeMs: 150,
      now: 12,
    })
    expect(result.usedCandidate).toBe(true)
    expect(result.history[0]?.data).toBe('中文')
  })

  it('ignores escape sequences (arrow keys) instead of consuming them', () => {
    const candidate = createTerminalInputFallbackKeydownCandidate({
      eventTimeStamp: 10,
      key: 'a',
      now: 10,
    })
    const result = recordTerminalInputFallbackHandledData({
      candidate,
      data: `${ESC}[D`,
      history: [],
      maxAgeMs: 150,
      now: 12,
    })
    expect(result.usedCandidate).toBe(false)
  })
})

describe('consumeTerminalInputFallbackHandledData / resolveAction', () => {
  it('suppresses the fallback write when xterm already sent the text', () => {
    const pending = createPendingTerminalInputFallback('空格')
    const history = [
      {
        consumed: false,
        data: '空格',
        keydownEventTimeStamp: 10,
        kind: 'text' as const,
        recordedAt: 100,
      },
    ]
    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 20,
      maxAgeMs: 150,
      maxInputDelayMs: 40,
      now: 110,
      pending,
    })
    expect(pending.handled).toBe(true)
    expect(history[0]?.consumed).toBe(true)

    const action = resolveTerminalInputFallbackAction({
      pending,
      textareaValue: '空格',
    })
    expect(action).toEqual({ shouldClearTextarea: true, shouldWrite: false })
  })

  it('writes when nothing claimed the composed text, and clears the textarea', () => {
    const pending = createPendingTerminalInputFallback('字')
    const action = resolveTerminalInputFallbackAction({ pending, textareaValue: '字' })
    expect(action).toEqual({ shouldClearTextarea: true, shouldWrite: true })
  })

  it('does nothing when the textarea is already empty', () => {
    const pending = createPendingTerminalInputFallback('字')
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: '' })).toEqual({
      shouldClearTextarea: false,
      shouldWrite: false,
    })
  })
})

describe('recentData window', () => {
  it('records plain onData as a short-lived dedupe entry', () => {
    const history = recordTerminalInputFallbackRecentData({
      data: '中文',
      history: [],
      maxAgeMs: 150,
      now: 10,
    })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ data: '中文', kind: 'recentData' })
  })

  it('consumes a same-拍 composed input within maxInputDelayMs', () => {
    const history = recordTerminalInputFallbackRecentData({
      data: '中文',
      history: [],
      maxAgeMs: 150,
      now: 100,
    })
    const pending = createPendingTerminalInputFallback('中文')
    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 101,
      maxAgeMs: 150,
      maxInputDelayMs: 40,
      now: 110,
      pending,
    })
    expect(pending.handled).toBe(true)
  })

  it('expires entries past maxAgeMs', () => {
    const history = recordTerminalInputFallbackRecentData({
      data: 'old',
      history: [],
      maxAgeMs: 150,
      now: 0,
    })
    const pending = createPendingTerminalInputFallback('old')
    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1,
      maxAgeMs: 150,
      maxInputDelayMs: 40,
      now: 500,
      pending,
    })
    expect(pending.handled).toBe(false)
  })
})

describe('markTerminalInputFallbackHandled', () => {
  it('marks pending entries whose text showed up in onData', () => {
    const first = createPendingTerminalInputFallback('你好')
    const second = createPendingTerminalInputFallback('世界')
    markTerminalInputFallbackHandled([first, second], '你好')
    expect(first.handled).toBe(true)
    expect(second.handled).toBe(false)
  })

  it('matches only the first occurrence when the same text repeats', () => {
    const first = createPendingTerminalInputFallback('a')
    const second = createPendingTerminalInputFallback('a')
    markTerminalInputFallbackHandled([first, second], 'a')
    expect(first.handled).toBe(true)
    expect(second.handled).toBe(false)
  })
})
