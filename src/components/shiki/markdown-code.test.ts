/**
 * 代码块纯判定单测：预算（exceedsHighlightBudget）、分块（chunkByLines）、
 * 语言标签清洗（sanitizeLanguageTag）与 prose 判定
 * （isLikelyProseCodeBlock：要点散文 / 真代码 / 配置否决 / 已知语言否决）。
 */
import { describe, expect, it } from 'vitest'

import {
  chunkByLines,
  exceedsHighlightBudget,
  isLikelyProseCodeBlock,
  sanitizeLanguageTag,
} from './markdown-code'
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from './shiki-config'

describe('exceedsHighlightBudget', () => {
  it('短代码不超预算', () => {
    expect(exceedsHighlightBudget('const x = 1;\nconst y = 2;')).toBe(false)
  })

  it('恰好 MAX_HIGHLIGHT_CHARS 字符不超，超过即超', () => {
    expect(exceedsHighlightBudget('a'.repeat(MAX_HIGHLIGHT_CHARS))).toBe(false)
    expect(exceedsHighlightBudget('a'.repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(true)
  })

  it('恰好 MAX_HIGHLIGHT_LINES 行不超，超过即超', () => {
    const lines = (n: number) => Array.from({ length: n }, () => 'x').join('\n')

    expect(exceedsHighlightBudget(lines(MAX_HIGHLIGHT_LINES))).toBe(false)
    expect(exceedsHighlightBudget(lines(MAX_HIGHLIGHT_LINES + 1))).toBe(true)
  })
})

describe('chunkByLines', () => {
  it('不超过单块容量时整体单块返回', () => {
    expect(chunkByLines('a\nb', 2)).toEqual([{ text: 'a\nb', lines: 2 }])
  })

  it('按行切块且拼回原文逐字相等（含空行）', () => {
    const code = 'line1\n\nline3\nline4\nline5'
    const chunks = chunkByLines(code, 2)

    expect(chunks.map(c => c.lines)).toEqual([2, 2, 1])
    expect(chunks.map(c => c.text).join('\n')).toBe(code)
  })

  it('空串是 1 行的单块', () => {
    expect(chunkByLines('', 200)).toEqual([{ text: '', lines: 1 }])
  })
})

describe('sanitizeLanguageTag', () => {
  it('取首 token、小写化', () => {
    expect(sanitizeLanguageTag('TypeScript title=x.ts')).toBe('typescript')
  })

  it('允许 +#-（c++ / objective-c / c#）', () => {
    expect(sanitizeLanguageTag('c++')).toBe('c++')
    expect(sanitizeLanguageTag('objective-c')).toBe('objective-c')
  })

  it('非法（标点起头/超长）返回空串', () => {
    expect(sanitizeLanguageTag('$hell')).toBe('')
    expect(sanitizeLanguageTag('a'.repeat(17))).toBe('')
    expect(sanitizeLanguageTag('')).toBe('')
  })
})

describe('isLikelyProseCodeBlock', () => {
  it('无语言 + 3 行平行散文、零代码信号 → 当文本', () => {
    const prose = '这是一段普通说明\n第二行说明文字\n第三行还在说明'
    expect(isLikelyProseCodeBlock('', prose)).toBe(true)
  })

  it('真代码（≥3 个代码信号）永不当文本', () => {
    const code = 'const x = 1;\nfunction y() {\n  return x;\n}'
    expect(isLikelyProseCodeBlock('ts', code)).toBe(false)
    expect(isLikelyProseCodeBlock('', code)).toBe(false)
  })

  it('带 markdown 强调的要点清单 → 当文本', () => {
    const bullets = '- **重点一**说明\n- *重点二*说明\n- 重点三说明'
    expect(isLikelyProseCodeBlock('', bullets)).toBe(true)
  })

  it('SSH config 形态（缩进续行）→ 配置否决，保留围栏', () => {
    const ssh = 'Host example\n  HostName 10.0.0.1\nPort 22'
    expect(isLikelyProseCodeBlock('', ssh)).toBe(false)
  })

  it('已知代码语言标签 → 保留围栏（即使内容偏散文）', () => {
    const prose = 'some prose line one here\nanother prose line here'
    expect(isLikelyProseCodeBlock('ts', prose)).toBe(false)
  })

  it('未知语言 + 2 行散文、≤1 代码信号 → 当文本', () => {
    const prose = 'please run the thing\nthen check the output'
    expect(isLikelyProseCodeBlock('foobar', prose)).toBe(true)
  })

  it('空内容/纯空白不当文本（空围栏走渲染空操作）', () => {
    expect(isLikelyProseCodeBlock('', '   \n  ')).toBe(false)
    expect(isLikelyProseCodeBlock('', '')).toBe(false)
  })

  it('带句末标点的多行散文（无语言）→ 当文本', () => {
    const prose = 'Here is the plan.\nWe start tomorrow.\nThen we review.'
    expect(isLikelyProseCodeBlock('', prose)).toBe(true)
  })
})
