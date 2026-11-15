import { describe, expect, it, vi } from 'vitest'
import { convertTurnMessage, hydratePiMessages } from './pi-hydrate'
import type { TurnMessage, TurnPart } from './turn-actor'

const user = (text: string, timestamp: number) => ({ role: 'user', content: text, timestamp })
const assistant = (content: unknown[], timestamp: number) => ({
  role: 'assistant',
  content,
  timestamp,
})
const toolResult = (
  toolCallId: string,
  text: string,
  timestamp: number,
  extra: Record<string, unknown> = {},
) => ({
  role: 'toolResult',
  toolCallId,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp,
  ...extra,
})

const TOOL_CHAIN = [
  user('你好', 1000),
  assistant(
    [
      { type: 'thinking', thinking: '先看看目录' },
      { type: 'text', text: '我看看。' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
    ],
    2000,
  ),
  toolResult('c1', 'a.txt', 3000, { details: { x: 1 } }),
  assistant(
    [
      { type: 'text', text: '好，a.txt。' },
      { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'a.txt' } },
    ],
    4000,
  ),
  toolResult('c2', '内容', 5000),
  assistant([{ type: 'text', text: '完成' }], 6000),
  user('下一轮', 7000),
  assistant([{ type: 'text', text: '好的' }], 8000),
]

describe('hydratePiMessages：按 turn 合并连续 assistant 消息', () => {
  const messages = hydratePiMessages(TOOL_CHAIN)

  it('一个 turn 只产出一条 assistant 消息（不是每条 pi 消息一条）', () => {
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('合并消息 id 用首条 assistant 的下标（稳定键）', () => {
    expect(messages[1]?.id).toBe('hydrate-1-assistant')
  })

  it('合并消息 createdAt = 前一条 user 时间戳（turn 起点）', () => {
    expect(messages[1]?.createdAt?.getTime()).toBe(1000)
  })

  it('合并消息 completedAt = 本轮最后一条消息时间戳（turn 终点）', () => {
    expect((messages[1] as TurnMessage).completedAt).toBe(6000)
  })

  it('parts 顺序原样保留（思考 → 文本 → 工具 → 文本 → 工具 → 文本）', () => {
    const parts = messages[1]?.content as TurnPart[]
    expect(parts.map((p) => (p.type === 'tool-call' ? `tool:${p.toolCallId}` : p.type))).toEqual([
      'thinking',
      'text',
      'tool:c1',
      'text',
      'tool:c2',
      'text',
    ])
  })

  it('tool-call 计时：startedAt = 所在消息时间戳，completedAt = toolResult 时间戳', () => {
    const parts = messages[1]?.content as TurnPart[]
    const c1 = parts.find((p) => p.type === 'tool-call' && p.toolCallId === 'c1')
    const c2 = parts.find((p) => p.type === 'tool-call' && p.toolCallId === 'c2')
    expect(c1).toMatchObject({ startedAt: 2000, completedAt: 3000 })
    expect(c2).toMatchObject({ startedAt: 4000, completedAt: 5000 })
  })

  it('toolResult 的 details 原样进 result（edit 的 diff 不丢）', () => {
    const parts = messages[1]?.content as TurnPart[]
    const c1 = parts.find((p) => p.type === 'tool-call' && p.toolCallId === 'c1')
    expect(c1).toMatchObject({
      result: { content: [{ type: 'text', text: 'a.txt' }], isError: false, details: { x: 1 } },
    })
  })

  it('text / thinking 至少带 message 时间戳（startedAt + 被后续消息闭合的 completedAt）', () => {
    const parts = messages[1]?.content as TurnPart[]
    const thinking = parts[0]!
    expect(thinking).toMatchObject({ type: 'thinking', startedAt: 2000, completedAt: 3000 })
    const lastText = parts[5]!
    expect(lastText).toMatchObject({ type: 'text', text: '完成', startedAt: 6000 })
    expect((lastText as { completedAt?: number }).completedAt).toBeUndefined()
  })

  it('下一轮（user 之后）重新开一条 assistant，不并进上一轮', () => {
    expect(messages[3]?.createdAt?.getTime()).toBe(7000)
    expect((messages[3] as TurnMessage).completedAt).toBe(8000)
  })

  it('空 content 的 assistant 也参与合并（不产空消息）', () => {
    const out = hydratePiMessages([
      user('q', 100),
      assistant([], 200),
      assistant([{ type: 'text', text: '答案' }], 300),
    ])
    expect(out).toHaveLength(2)
    expect((out[1]?.content as TurnPart[]).map((p) => p.type)).toEqual(['text'])
  })

  it('孤儿 toolResult：跳过并 console.error 可见（不静默）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = hydratePiMessages([user('q', 100), toolResult('nope', 'x', 200)])
    expect(out).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('user 的多段文本拼成一条 string 内容', () => {
    const out = hydratePiMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], timestamp: 1 },
    ])
    expect(out[0]?.content).toBe('ab')
  })

  it('旧语音委托的 note/context 从显示内容中剥掉，只留 spoken prompt', () => {
    const raw = [
      '[Note: this message is a delegation from a live spoken conversation. The text is a voice transcript (it may contain mis-hearings; use the latest intent). Answer in plain conversational sentences, keep it short, no markdown.]',
      '',
      '[Spoken context, oldest first]',
      '[object Object]',
      '',
      '帮我列出当前目录的文件',
    ].join('\n')
    const out = hydratePiMessages([{ role: 'user', content: raw, timestamp: 1 }])
    expect(out[0]?.content).toBe('帮我列出当前目录的文件')
  })
})

describe('convertTurnMessage：投影到 assistant-ui', () => {
  it('tool-call 的 startedAt/completedAt → timing（官方 useToolCallElapsed 读它）', () => {
    const messages = hydratePiMessages(TOOL_CHAIN)
    const converted = convertTurnMessage(messages[1]!)
    const parts = converted.content as readonly { type: string; timing?: unknown }[]
    const toolPart = parts.find((p) => p.type === 'tool-call')
    expect(toolPart?.timing).toEqual({ startedAt: 2000, completedAt: 3000 })
  })

  it('thinking → reasoning 部件', () => {
    const messages = hydratePiMessages(TOOL_CHAIN)
    const converted = convertTurnMessage(messages[1]!)
    const parts = converted.content as readonly { type: string; text?: string }[]
    expect(parts[0]).toMatchObject({ type: 'reasoning', text: '先看看目录' })
  })

  it('消息级工作段边界进 metadata.custom（外层「已工作」时长兜底）', () => {
    const messages = hydratePiMessages(TOOL_CHAIN)
    const converted = convertTurnMessage(messages[1]!)
    expect(converted.metadata?.custom).toEqual({ workStartedAt: 1000, workEndedAt: 6000 })
  })

  it('实时消息（无 completedAt）只写 workStartedAt', () => {
    const converted = convertTurnMessage({
      id: 'run-1',
      role: 'assistant',
      content: '',
      createdAt: new Date(5000),
    })
    expect(converted.metadata?.custom).toEqual({ workStartedAt: 5000 })
  })

  it('无 createdAt 的实时消息不带 metadata', () => {
    const converted = convertTurnMessage({ id: 'run-1', role: 'assistant', content: '' })
    expect(converted.metadata).toBeUndefined()
  })
})
