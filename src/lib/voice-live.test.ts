/**
 * voice-live 桥接层纯函数单测（hermes 同名用例的宿主版）：
 * chunkForCommentary（句界切块）/ toLiveHistory（种子 history 预算）/
 * delegationPrompt（片段流折轮）/ liveEndedMessage（结束文案）。
 * WebRTC 传输类不在此测（无媒体环境）——会话命令面经实机 CDP 验证。
 */
import { describe, expect, it } from 'vitest'

import {
  chunkForCommentary,
  delegationPrompt,
  liveEndedMessage,
  toLiveHistory,
  type LiveTranscriptFragment
} from './voice-live'

describe('chunkForCommentary（hermes :106-149 逐语义）', () => {
  it('空/纯空白 → 空数组', () => {
    expect(chunkForCommentary('')).toEqual([])
    expect(chunkForCommentary('   \n  ')).toEqual([])
  })

  it('短文本原样一块', () => {
    expect(chunkForCommentary('测试通过。')).toEqual(['测试通过。'])
  })

  it('按句界合并，不超限', () => {
    const text = '第一句。第二句。第三句。'
    const chunks = chunkForCommentary(text, 10)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(10)
    }
    expect(chunks.join(' ')).toContain('第一句')
  })

  it('超长句硬切（句子本身超过 limit）', () => {
    const long = 'a'.repeat(25)
    const chunks = chunkForCommentary(long, 10)
    expect(chunks.length).toBe(3)
    expect(chunks.join('')).toBe(long)
  })

  it('全部内容保序保留（空格归一）', () => {
    const text = 'alpha beta. gamma delta. epsilon.  '
    const chunks = chunkForCommentary(text, 15)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      text.replace(/\s+/g, ' ').trim(),
    )
  })
})

describe('toLiveHistory（hermes :151-180 逐语义）', () => {
  it('最新轮靠近输入端（unshift 到头部）', () => {
    const history = toLiveHistory([
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: '第二问' },
    ])
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(history.at(-1)).toMatchObject({ role: 'user' })
    // 数组序 = 最旧在前
    expect(history.map((h) => h.content[0].text)).toEqual(['第一问', '第一答', '第二问'])
  })

  it('maxMessages 截断最旧的', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      text: `t${i}`,
    }))
    const history = toLiveHistory(turns, 3)
    expect(history.map((h) => h.content[0].text)).toEqual(['t2', 't3', 't4'])
  })

  it('字符预算封顶', () => {
    const turns = [
      { role: 'user' as const, text: 'a'.repeat(10) },
      { role: 'user' as const, text: 'b'.repeat(10) },
    ]
    const history = toLiveHistory(turns, 10, 15)
    // 预算 15：第二条放不下 → 只留最新一条
    expect(history.map((h) => h.content[0].text)).toEqual(['bbbbbbbbbb'])
  })

  it('空白轮跳过', () => {
    const history = toLiveHistory([
      { role: 'user', text: '   ' },
      { role: 'assistant', text: 'ok' },
    ])
    expect(history).toHaveLength(1)
  })
})

describe('delegationPrompt（hermes :46-71 逐语义）', () => {
  const frag = (speaker: 'user' | 'assistant', text: string): LiveTranscriptFragment => ({
    speaker,
    text,
    startMs: 0,
    endMs: 0,
  })

  it('同说话人相邻片段合并；prompt = 用户最后说的', () => {
    const out = delegationPrompt([
      frag('user', '帮我'),
      frag('user', '跑测试'),
      frag('assistant', '好的，正在跑'),
      frag('user', '顺便看看日志'),
    ])
    expect(out.prompt).toBe('顺便看看日志')
    expect(out.context).toBe(
      'User: 帮我跑测试\nVoice assistant: 好的，正在跑\nUser: 顺便看看日志',
    )
  })

  it('无用户片段 → prompt 回落 transcript 尾部', () => {
    const out = delegationPrompt([frag('assistant', '在听')])
    expect(out.prompt).toBe('Voice assistant: 在听'.slice(-400))
  })
})

describe('liveEndedMessage（hermes :73-94 逐语义）', () => {
  const copy = { liveEndedClosed: '会话已结束', liveEndedConnectionLost: '连接中断' }

  it('机器原因换文案；vendor 原因透传', () => {
    expect(liveEndedMessage('connection_lost', null, copy)).toBe('连接中断')
    expect(liveEndedMessage('closed', null, copy)).toBe('会话已结束')
    expect(liveEndedMessage('', null, copy)).toBe('会话已结束')
    expect(liveEndedMessage('vendor reason', null, copy)).toBe('vendor reason')
  })

  it('秒数追加（取整）', () => {
    expect(liveEndedMessage('closed', 42.6, copy)).toBe('会话已结束 (43s)')
    expect(liveEndedMessage('closed', null, copy)).toBe('会话已结束')
  })
})
