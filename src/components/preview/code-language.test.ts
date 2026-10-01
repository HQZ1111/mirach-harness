import { describe, expect, it } from 'vitest'

import {
  CODE_BUDGET_MAX_BYTES,
  CODE_BUDGET_MAX_LINES,
  exceedsHighlightBudget,
  isCodePreviewFile,
  shikiLanguageForFilename,
} from './code-language'
import { chunkTextLines } from './fixed-row-window'

describe('shikiLanguageForFilename（扩展名 → Shiki 语言，未知不猜）', () => {
  it('任务清单内的扩展名逐一映射', () => {
    expect(shikiLanguageForFilename('src/main.ts')).toBe('typescript')
    expect(shikiLanguageForFilename('App.tsx')).toBe('tsx')
    expect(shikiLanguageForFilename('a.js')).toBe('javascript')
    expect(shikiLanguageForFilename('a.jsx')).toBe('jsx')
    expect(shikiLanguageForFilename('package.json')).toBe('json')
    expect(shikiLanguageForFilename('README.md')).toBe('markdown')
    expect(shikiLanguageForFilename('main.py')).toBe('python')
    expect(shikiLanguageForFilename('lib.rs')).toBe('rust')
    expect(shikiLanguageForFilename('Cargo.toml')).toBe('toml')
    expect(shikiLanguageForFilename('config.yaml')).toBe('yaml')
    expect(shikiLanguageForFilename('config.yml')).toBe('yaml')
    expect(shikiLanguageForFilename('style.css')).toBe('css')
    expect(shikiLanguageForFilename('index.html')).toBe('html')
    expect(shikiLanguageForFilename('index.htm')).toBe('html')
    expect(shikiLanguageForFilename('run.sh')).toBe('bash')
    expect(shikiLanguageForFilename('a.c')).toBe('c')
    expect(shikiLanguageForFilename('a.cpp')).toBe('cpp')
    expect(shikiLanguageForFilename('a.cc')).toBe('cpp')
    expect(shikiLanguageForFilename('a.cxx')).toBe('cpp')
    expect(shikiLanguageForFilename('a.h')).toBe('c')
    expect(shikiLanguageForFilename('main.go')).toBe('go')
    expect(shikiLanguageForFilename('A.java')).toBe('java')
  })

  it('Windows 反斜杠路径与裸文件名（Dockerfile）', () => {
    expect(shikiLanguageForFilename('G:\\proj\\src\\main.rs')).toBe('rust')
    expect(shikiLanguageForFilename('Dockerfile')).toBe('docker')
    expect(shikiLanguageForFilename('script.ps1')).toBe('powershell')
  })

  it('大小写不敏感（hermes normalize 小写语义）', () => {
    expect(shikiLanguageForFilename('MAIN.TS')).toBe('typescript')
    expect(shikiLanguageForFilename('ReadMe.MD')).toBe('markdown')
  })

  it('未知扩展名/无扩展名 → 空串（回退纯文本）', () => {
    expect(shikiLanguageForFilename('a.txt')).toBe('')
    expect(shikiLanguageForFilename('a.log')).toBe('')
    expect(shikiLanguageForFilename('a.unknownext')).toBe('')
    expect(shikiLanguageForFilename('Makefile2')).toBe('')
    expect(shikiLanguageForFilename('')).toBe('')
    expect(shikiLanguageForFilename(undefined)).toBe('')
  })

  it('isCodePreviewFile 与映射表一致', () => {
    expect(isCodePreviewFile('a.ts')).toBe(true)
    expect(isCodePreviewFile('a.txt')).toBe(false)
  })
})

describe('exceedsHighlightBudget（>512KB 或 >3k 行 → 纯文本分块）', () => {
  it('小文件在预算内', () => {
    expect(exceedsHighlightBudget('const x = 1\n'.repeat(10))).toBe(false)
  })

  it(`行数阈值：${CODE_BUDGET_MAX_LINES} 行以内放行，超出降级`, () => {
    const within = Array.from({ length: CODE_BUDGET_MAX_LINES }, () => 'x').join('\n')
    const over = Array.from({ length: CODE_BUDGET_MAX_LINES + 1 }, () => 'x').join('\n')
    expect(exceedsHighlightBudget(within)).toBe(false)
    expect(exceedsHighlightBudget(over)).toBe(true)
  })

  it(`字节阈值：恰 ${CODE_BUDGET_MAX_BYTES} 字节放行，多 1 字节降级`, () => {
    expect(exceedsHighlightBudget('a'.repeat(CODE_BUDGET_MAX_BYTES))).toBe(false)
    expect(exceedsHighlightBudget('a'.repeat(CODE_BUDGET_MAX_BYTES + 1))).toBe(true)
  })

  it('多字节字符按 UTF-8 字节计（CJK 3 字节/字）', () => {
    // 200k 个中文字符 = 600KB 字节，但仅 1 行——行数预算放行、字节预算降级。
    const cjk = '\u4e2d'.repeat(200_000)
    expect(cjk.length).toBeLessThan(CODE_BUDGET_MAX_BYTES)
    expect(exceedsHighlightBudget(cjk)).toBe(true)
  })
})

describe('chunkTextLines（200 行分块，窗口化渲染的数据底座）', () => {
  it('不超过单块行数时整块返回', () => {
    const chunks = chunkTextLines('a\nb\nc', 200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ start: 0, lines: ['a', 'b', 'c'], text: 'a\nb\nc' })
  })

  it('跨块切分：start 偏移与每块行数正确', () => {
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i}`)
    const chunks = chunkTextLines(lines.join('\n'), 200)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].lines).toHaveLength(200)
    expect(chunks[1].start).toBe(200)
    expect(chunks[1].lines).toEqual(['line-200', 'line-201', 'line-202', 'line-203', 'line-204'])
    expect(chunks[1].text).toBe('line-200\nline-201\nline-202\nline-203\nline-204')
  })

  it('分块可无损回拼原文', () => {
    const text = Array.from({ length: 640 }, (_, i) => `row ${i}`).join('\n')
    const chunks = chunkTextLines(text, 200)
    expect(chunks).toHaveLength(4)
    expect(chunks.map(c => c.text).join('\n')).toBe(text)
  })

  it('空字符串是单块单空行', () => {
    expect(chunkTextLines('', 200)).toEqual([{ start: 0, lines: [''], text: '' }])
  })

  it('结尾换行保留为末尾空行', () => {
    const chunks = chunkTextLines('a\nb\n', 200)
    expect(chunks[0].lines).toEqual(['a', 'b', ''])
  })
})
