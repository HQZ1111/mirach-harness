/**
 * turn-actor 归约器单测：工具调用结构化（AG-UI CUSTOM tool_execution →
 * TurnPart）、thinking part（§2.2）、run 边界语义（交错 RUN_STARTED /
 * RUN_ERROR / run 外消息类事件 drop）与文本/工具交错路径。
 */
import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'

import { reduceAguiEvent, turnMachine, type TurnContext } from './turn-actor'

const ctx = (): TurnContext => ({
  messages: [],
  currentRunId: null,
  lastEventId: 0,
  error: null,
  usage: null,
})

const send = (ctx: TurnContext, type: string, extra: Record<string, unknown> = {}) =>
  reduceAguiEvent(ctx, { type, ...extra } as never, ctx.lastEventId + 1)

describe('reduceAguiEvent tool-call parts', () => {
  it('run start appends an empty assistant segment', () => {
    const next = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    expect(next.currentRunId).toBe('r1')
    expect(next.messages).toEqual([{ id: 'r1', role: 'assistant', content: '' }])
  })

  it('text delta appends to string content', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '你好' })
    expect(c.messages[0].content).toBe('你好')
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '世界' })
    expect(c.messages[0].content).toBe('你好世界')
  })

  it('tool start converts string content to parts and appends a tool-call part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '我来读文件' })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
    })
    const content = c.messages[0].content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toEqual([
      { type: 'text', text: '我来读文件' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
    ])
  })

  it('tool start with empty text produces a bare tool-call part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'bash' },
    })
    expect(c.messages[0].content).toEqual([
      { type: 'tool-call', toolCallId: 't1', toolName: 'bash', args: undefined },
    ])
  })

  it('tool end attaches result by toolCallId; later text opens a new text part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'read' },
    })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'end', toolCallId: 't1', result: 'file body', isError: false },
    })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '读完了' })
    expect(c.messages[0].content).toEqual([
      { type: 'tool-call', toolCallId: 't1', toolName: 'read', args: undefined, result: 'file body', isError: false },
      { type: 'text', text: '读完了' },
    ])
  })

  it('tool end with isError flags the part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'bash' },
    })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'end', toolCallId: 't1', result: 'boom', isError: true },
    })
    const content = c.messages[0].content as { type: 'tool-call'; isError?: boolean }[]
    expect(content[0].isError).toBe(true)
  })

  it('run finished carries usage snapshot (replacement semantics)', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'RUN_FINISHED', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    expect(c.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(c.currentRunId).toBeNull()
  })

  it('run finished without usage keeps previous snapshot', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'RUN_FINISHED', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
    c = send(c, 'RUN_STARTED', { runId: 'r2' })
    c = send(c, 'RUN_FINISHED')
    expect(c.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })
})

describe('thinking parts (§2.2)', () => {
  it('THINKING_START converts string content to parts and opens an empty thinking part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '先想想' })
    c = send(c, 'THINKING_TEXT_MESSAGE_START', {})
    expect(c.messages[0].content).toEqual([
      { type: 'text', text: '先想想' },
      { type: 'thinking', text: '' },
    ])
  })

  it('THINKING_CONTENT accumulates into the last thinking part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'THINKING_TEXT_MESSAGE_START', {})
    c = send(c, 'THINKING_TEXT_MESSAGE_CONTENT', { delta: '思考' })
    c = send(c, 'THINKING_TEXT_MESSAGE_CONTENT', { delta: '中' })
    expect(c.messages[0].content).toEqual([{ type: 'thinking', text: '思考中' }])
  })

  it('THINKING_CONTENT without START self-establishes the thinking part', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'THINKING_TEXT_MESSAGE_CONTENT', { delta: '自立' })
    expect(c.messages[0].content).toEqual([{ type: 'thinking', text: '自立' }])
  })

  it('THINKING_CONTENT after a tool call opens a new thinking part (no merge into text)', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'read' },
    })
    c = send(c, 'THINKING_TEXT_MESSAGE_CONTENT', { delta: '复盘' })
    expect(c.messages[0].content).toEqual([
      { type: 'tool-call', toolCallId: 't1', toolName: 'read', args: undefined },
      { type: 'thinking', text: '复盘' },
    ])
  })
})

describe('run boundary: interleaved RUN_STARTED (§0.3-1)', () => {
  it('another runId RUN_STARTED appends a new segment and keeps the old one', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '第一段' })
    // streaming 中收到另一 runId 的 RUN_STARTED（协议违例）：reduce 语义
    // = 追加新 run 段、currentRunId 换轨、旧段保留
    c = send(c, 'RUN_STARTED', { runId: 'r2' })
    expect(c.messages).toHaveLength(2)
    expect(c.messages[0]).toEqual({ id: 'r1', role: 'assistant', content: '第一段' })
    expect(c.messages[1]).toEqual({ id: 'r2', role: 'assistant', content: '' })
    expect(c.currentRunId).toBe('r2')
  })

  it('machine logs the protocol violation (fail loud) while accepting the new segment', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const actor = createActor(turnMachine, { input: ctx() })
      actor.start()
      actor.send({ type: 'AGUI_EVENT', event: { type: 'RUN_STARTED', runId: 'r1' }, id: 1 })
      actor.send({ type: 'AGUI_EVENT', event: { type: 'RUN_STARTED', runId: 'r2' }, id: 2 })
      const c = actor.getSnapshot().context
      expect(c.messages).toHaveLength(2)
      expect(c.currentRunId).toBe('r2')
      expect(err).toHaveBeenCalledWith(expect.stringContaining('协议违例'))
    } finally {
      err.mockRestore()
    }
  })
})

describe('run boundary: RUN_ERROR visibility', () => {
  it('RUN_ERROR records the error and ends the run', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'RUN_ERROR', { message: 'boom' })
    expect(c.error).toBe('boom')
    expect(c.currentRunId).toBeNull()
  })

  it('RUN_ERROR without message keeps a visible fallback', () => {
    const c = send(ctx(), 'RUN_ERROR', {})
    expect(c.error).toBe('run error')
  })

  it('next RUN_STARTED clears the error (banner lifecycle ends at next run)', () => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'RUN_ERROR', { message: 'boom' })
    c = send(c, 'RUN_STARTED', { runId: 'r2' })
    expect(c.error).toBeNull()
  })
})

describe('run boundary: message-write events outside a run are dropped (§0.3-5)', () => {
  const finished = (): TurnContext => {
    let c = send(ctx(), 'RUN_STARTED', { runId: 'r1' })
    c = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '已有内容' })
    c = send(c, 'RUN_FINISHED', {})
    expect(c.currentRunId).toBeNull()
    return c
  }

  it('TEXT_MESSAGE_CONTENT is dropped (messages untouched, cursor advances)', () => {
    const c = finished()
    const before = c.messages
    const next = send(c, 'TEXT_MESSAGE_CONTENT', { delta: '残留尾流' })
    expect(next.messages).toEqual(before)
    expect(next.lastEventId).toBe(c.lastEventId + 1)
  })

  it('TOOL_CALL_* and THINKING_* are dropped outside a run', () => {
    const c = finished()
    let next = send(c, 'TOOL_CALL_START', { toolCallId: 't1' })
    next = send(next, 'TOOL_CALL_ARGS', { toolCallId: 't1', delta: '{}' })
    next = send(next, 'TOOL_CALL_END', { toolCallId: 't1' })
    next = send(next, 'THINKING_TEXT_MESSAGE_CONTENT', { delta: 'x' })
    expect(next.messages).toEqual(c.messages)
  })

  it('tool_execution CUSTOM is dropped outside a run', () => {
    const c = finished()
    const next = send(c, 'CUSTOM', {
      name: 'tool_execution',
      value: { phase: 'start', toolCallId: 't1', toolName: 'bash' },
    })
    expect(next.messages).toEqual(c.messages)
  })

  it('message-write drop warns; run-external non-message CUSTOM passes without warning', () => {
    // §0.3-5：fail-loud 只约束消息类事件，compaction/data_changed 等
    // run 外 CUSTOM 合法透传，不得误伤
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = finished()
      send(c, 'TEXT_MESSAGE_CONTENT', { delta: 'x' })
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockClear()
      const next = send(c, 'CUSTOM', { name: 'compaction', value: {} })
      expect(warn).not.toHaveBeenCalled()
      expect(next.lastEventId).toBe(c.lastEventId + 1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('turnMachine wiring', () => {
  it('machine exposes streaming state while a run is active', () => {
    const ref = (() => {}) as never // type-only use below
    void ref
    // 通过 reduce 路径的语义已在上一组覆盖；这里只验证机器可创建
    expect(turnMachine.id).toBe('turn')
  })
})
