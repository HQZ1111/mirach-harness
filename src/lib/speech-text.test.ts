import { describe, expect, it } from 'vitest'

import { nextSpeechChunk } from './speech-text'

/**
 * 委托回复的流式切句（2026-11-15 用户："像 TTS 念稿"的根因）：
 * 旧实现只认英文 `. `，中文整段要等 turn 结束才播。这里锁 CJK 行为。
 */
describe('nextSpeechChunk', () => {
  it('cuts at a Chinese full stop without requiring a space', () => {
    expect(nextSpeechChunk('目录列出来了。里面有一个文件。')).toBe('目录列出来了。')
  })

  it('cuts at every CJK terminator', () => {
    expect(nextSpeechChunk('好的！')).toBe('好的！')
    expect(nextSpeechChunk('可以吗？')).toBe('可以吗？')
    expect(nextSpeechChunk('第一项；')).toBe('第一项；')
    expect(nextSpeechChunk('我想想…')).toBe('我想想…')
  })

  it('holds an unfinished short tail', () => {
    expect(nextSpeechChunk('正在读取配置文件，马上')).toBeNull()
  })

  it('cuts an English sentence only at a real sentence end', () => {
    expect(nextSpeechChunk('Version 3.14 is ready. Next')).toBe('Version 3.14 is ready.')
    expect(nextSpeechChunk('Version 3.14 is')).toBeNull()
  })

  it('long unpunctated text falls back at a comma or 80 chars', () => {
    const long = `${'很长的句子'.repeat(20)}，后面还有内容`
    const first = nextSpeechChunk(long)
    expect(first).not.toBeNull()
    expect(first!.length).toBeLessThan(long.length)
    expect(first!.endsWith('，')).toBe(true)

    const noPunct = 'x'.repeat(200)
    expect(nextSpeechChunk(noPunct)).toHaveLength(80)
  })
})
