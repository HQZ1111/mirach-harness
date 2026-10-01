/**
 * session-title 单测：derive_title（hermes title_generator.py 逐规则对标）、
 * 撞名谱系编号（hermes_state_titles.py get_next_title_in_lineage）与首条
 * user 消息文本提取。
 */
import { describe, expect, it } from 'vitest'

import {
  deriveTitle,
  firstUserMessageText,
  MAX_DERIVED_TITLE_CHARS,
  nextTitleInLineage,
} from './session-title'
import type { TurnMessage } from './turn-actor'

const msg = (id: string, role: 'user' | 'assistant', content: TurnMessage['content']): TurnMessage => ({
  id,
  role,
  content,
  createdAt: new Date(0),
})

describe('deriveTitle（hermes derive_title 规则段）', () => {
  it('takes the first non-empty line, ignoring leading blank lines', () => {
    expect(deriveTitle('\n\n  \n第二行才是正文\n第三行')).toBe('第二行才是正文')
  })

  it('collapses internal whitespace', () => {
    expect(deriveTitle('hello   \t world \n next')).toBe('hello world')
  })

  it('short lines pass through unchanged', () => {
    expect(deriveTitle('修复登录页的白屏')).toBe('修复登录页的白屏')
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(deriveTitle('')).toBeNull()
    expect(deriveTitle('  \n \t ')).toBeNull()
  })

  it('exactly 48 chars stays without ellipsis', () => {
    const line = 'a'.repeat(MAX_DERIVED_TITLE_CHARS)
    expect(deriveTitle(line)).toBe(line)
  })

  it('cuts at the last word boundary beyond the midpoint + ellipsis', () => {
    // cut（前 48 字符）内最后一个空格在 index 38 > 24 → 词边界截断
    const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do'
    const out = deriveTitle(line)
    expect(out).toBe('lorem ipsum dolor sit amet consectetur…')
  })

  it('hard-cuts when the last space is within the first half + ellipsis', () => {
    // 10×a + 空格 + 60×b：cut 内空格 index 10 ≤ 24 → 保留整段硬截
    const line = `${'a'.repeat(10)} ${'b'.repeat(60)}`
    expect(deriveTitle(line)).toBe(`${'a'.repeat(10)} ${'b'.repeat(37)}…`)
  })

  it('CJK text without spaces hard-cuts at 48 chars + ellipsis', () => {
    const line = '汉'.repeat(60)
    expect(deriveTitle(line)).toBe(`${'汉'.repeat(48)}…`)
  })

  it('trims trailing punctuation from the cut segment before the ellipsis', () => {
    // 截断点正好落在逗号/空格上：rstrip(" ,.;:—-") 去净再补 …
    const line = `${'x'.repeat(44)},  ${'y'.repeat(30)}`
    const out = deriveTitle(line)
    expect(out).toBe(`${'x'.repeat(44)}…`)
  })
})

describe('nextTitleInLineage（hermes get_next_title_in_lineage）', () => {
  it('returns the base unchanged when no conflict exists', () => {
    expect(nextTitleInLineage('新会话', ['别的会话', 'other #2'])).toBe('新会话')
  })

  it('returns base with empty list when no conflict', () => {
    expect(nextTitleInLineage('my session', [])).toBe('my session')
  })

  it('unnumbered original counts as #1 → next is #2', () => {
    expect(nextTitleInLineage('my session', ['my session', 'unrelated'])).toBe('my session #2')
  })

  it('increments past the highest existing number (max+1, not count+1)', () => {
    expect(nextTitleInLineage('X', ['X', 'X #2', 'X #5'])).toBe('X #6')
  })

  it('strips an incoming "#N" suffix before matching the lineage base', () => {
    expect(nextTitleInLineage('X #2', ['X', 'X #2'])).toBe('X #3')
  })

  it('non-numeric suffixes conflict but contribute no number', () => {
    // "X #extra" 以 "X #" 开头（LIKE 'X #%' 语义）→ 冲突存在但无可解析号
    expect(nextTitleInLineage('X', ['X #extra'])).toBe('X #2')
    expect(nextTitleInLineage('X', ['X #2 pro'])).toBe('X #2')
  })

  it('numbered collision without the unnumbered original still maxes correctly', () => {
    // 只有 "X #3"（原版被改名走）：hermes numbers=[3] → #4
    expect(nextTitleInLineage('X', ['X #3'])).toBe('X #4')
  })
})

describe('firstUserMessageText（标题原料）', () => {
  it('returns string content of the first user message', () => {
    const messages = [msg('a1', 'assistant', '回复'), msg('u1', 'user', '帮我写个脚本')]
    expect(firstUserMessageText(messages)).toBe('帮我写个脚本')
  })

  it('joins text parts only (images / tool-calls excluded) in parts content', () => {
    const messages = [
      msg('u1', 'user', [
        { type: 'text', text: '看这张图 ' },
        { type: 'image', image: 'data:image/png;base64,xx' },
        { type: 'text', text: '然后继续' },
      ]),
    ]
    expect(firstUserMessageText(messages)).toBe('看这张图 然后继续')
  })

  it('skips assistant messages before the first user message', () => {
    const messages = [msg('a1', 'assistant', [{ type: 'text', text: 'hi' }]), msg('u1', 'user', '问题')]
    expect(firstUserMessageText(messages)).toBe('问题')
  })

  it('returns null when there is no user message or no derivable text', () => {
    expect(firstUserMessageText([msg('a1', 'assistant', '回复')])).toBeNull()
    expect(firstUserMessageText([])).toBeNull()
    expect(firstUserMessageText([msg('u1', 'user', '')])).toBeNull()
    expect(firstUserMessageText([msg('u1', 'user', [{ type: 'image', image: 'data:image/png;base64,x' }])])).toBeNull()
  })
})
