/**
 * 自动朗读回复——纯逻辑单测（hermes use-auto-speak-replies.test 的宿主
 * 对偶子集：宿主的触发边沿/占用挂起在 hook 里，依赖 React，这里锁纯函数
 * 合同 + 去重表行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assistantReplyText,
  latestReply,
  resetSpokenForTests,
  type AutoSpeakOptions,
} from './auto-speak'
import type { TurnMessage } from './turn-actor'

const msg = (over: Partial<TurnMessage> & { id: string }): TurnMessage => ({
  role: 'assistant',
  content: '',
  ...over,
})

beforeEach(() => {
  resetSpokenForTests()
})

describe('assistantReplyText', () => {
  it('string content passes through (trimmed)', () => {
    expect(assistantReplyText(msg({ id: 'a', content: '  你好 \n' }))).toBe('你好')
  })

  it('joins text parts, ignoring thinking/tool parts', () => {
    const m = msg({
      id: 'a',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'thinking', text: '内部思考' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'read', args: {} },
        { type: 'text', text: '第二段' },
      ] as TurnMessage['content'],
    })
    expect(assistantReplyText(m)).toBe('第一段\n第二段')
  })

  it('returns null for user messages and text-less assistant messages', () => {
    expect(assistantReplyText(msg({ id: 'u', role: 'user', content: '问题' }))).toBeNull()
    expect(
      assistantReplyText(
        msg({ id: 'a', content: [{ type: 'thinking', text: '只想不说' }] } as TurnMessage),
      ),
    ).toBeNull()
    expect(assistantReplyText(msg({ id: 'e', content: '' }))).toBeNull()
  })
})

describe('latestReply', () => {
  it('returns the last assistant message with text (skips text-less ones)', () => {
    const messages: TurnMessage[] = [
      msg({ id: 'u1', role: 'user', content: '问' }),
      msg({ id: 'a1', content: [{ type: 'tool-call', toolCallId: 't', toolName: 'bash', args: {} }] as TurnMessage['content'] }),
      msg({ id: 'a2', content: '结论' }),
    ]
    expect(latestReply(messages)).toMatchObject({ id: 'a2', text: '结论' })
  })

  it('returns null when no assistant text exists', () => {
    expect(latestReply([msg({ id: 'u1', role: 'user', content: '问' })])).toBeNull()
    expect(latestReply([])).toBeNull()
  })
})

describe('spoken dedupe options shape', () => {
  // hook 的边沿语义（true→false 才读）依赖 React；这里锁 options 合同，
  // 防止字段改名后主/分栏两处挂载静默失配。
  it('AutoSpeakOptions exposes messages + isRunning', () => {
    const opts: AutoSpeakOptions = { messages: [], isRunning: false }
    expect(opts.messages).toEqual([])
    expect(opts.isRunning).toBe(false)
  })
})

describe('resetSpokenForTests', () => {
  it('is a callable isolation hook', () => {
    expect(() => resetSpokenForTests()).not.toThrow()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
