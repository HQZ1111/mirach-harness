/**
 * speech-adapter 纯函数单测：segmentSpeechWords（CJK 逐字、拉丁整段、
 * 混排、空白、空文本、偏移量与 UTF-16 对齐）与 wordIndexAt（boundary
 * charIndex → 词下标映射：起点、中段、越界、空序列）。
 */
import { describe, expect, it } from 'vitest'

import {
  segmentSpeechWords,
  wordIndexAt,
  type SpeechWord,
} from './speech-adapter'

const words = segmentSpeechWords

describe('segmentSpeechWords', () => {
  it('拉丁连续段整段成词（按空白分隔）', () => {
    expect(words('Hello world')).toEqual([
      { word: 'Hello', start: 0 },
      { word: 'world', start: 6 },
    ])
  })

  it('CJK 逐字成词（中文无空格分词，与 boundary 粒度对齐）', () => {
    expect(words('你好世界')).toEqual([
      { word: '你', start: 0 },
      { word: '好', start: 1 },
      { word: '世', start: 2 },
      { word: '界', start: 3 },
    ])
  })

  it('混排：偏移量与原文 UTF-16 偏移对齐', () => {
    expect(words('Hello 世界 ok')).toEqual([
      { word: 'Hello', start: 0 },
      { word: '世', start: 6 },
      { word: '界', start: 7 },
      { word: 'ok', start: 9 },
    ])
  })

  it('连续空白与首尾空白不成词', () => {
    expect(words('  a   b  ')).toEqual([
      { word: 'a', start: 2 },
      { word: 'b', start: 6 },
    ])
  })

  it('空文本 → 空序列', () => {
    expect(words('')).toEqual([])
    expect(words('   ')).toEqual([])
  })
})

describe('wordIndexAt', () => {
  const seq: readonly SpeechWord[] = words('Hello 世界')

  it('charIndex 落在词起点 → 该词', () => {
    expect(wordIndexAt(seq, 0)).toBe(0)
    expect(wordIndexAt(seq, 6)).toBe(1)
    expect(wordIndexAt(seq, 7)).toBe(2)
  })

  it('charIndex 落在段中（英文词内）→ 该段', () => {
    expect(wordIndexAt(seq, 3)).toBe(0)
  })

  it('越界 → 最后一词（引擎补发到末尾）', () => {
    expect(wordIndexAt(seq, 999)).toBe(2)
  })

  it('空序列 → -1（面板侧 clamp 为 0）', () => {
    expect(wordIndexAt([], 0)).toBe(-1)
  })
})
