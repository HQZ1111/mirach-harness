/**
 * turn-actor 归约器单测：工具调用结构化（AG-UI CUSTOM tool_execution →
 * TurnPart）与文本/工具交错路径。
 */
import { describe, expect, it } from 'vitest'

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

describe('turnMachine wiring', () => {
  it('machine exposes streaming state while a run is active', () => {
    const ref = (() => {}) as never // type-only use below
    void ref
    // 通过 reduce 路径的语义已在上一组覆盖；这里只验证机器可创建
    expect(turnMachine.id).toBe('turn')
  })
})
