import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ReasoningRoot,
  ReasoningTrigger,
  resolveReasoningStreamingSummary,
} from './reasoning'

const render = (streaming: boolean, text: string) =>
  renderToStaticMarkup(
    <ReasoningRoot streaming={streaming}>
      <ReasoningTrigger active={streaming} streamingText={text} />
    </ReasoningRoot>,
  )

const triggerText = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('resolveReasoningStreamingSummary（折叠态单行摘要）', () => {
  it('取最后一条非空行，key 是行号', () => {
    expect(resolveReasoningStreamingSummary('第一行\n\n第二行\n')).toEqual({
      key: '2',
      text: '第二行',
    })
  })

  it('空文本没有摘要', () => {
    expect(resolveReasoningStreamingSummary('   \n\n')).toBeNull()
  })

  it('\\r\\n 归一化', () => {
    expect(resolveReasoningStreamingSummary('a\r\nb')).toEqual({ key: '1', text: 'b' })
  })
})

describe('ReasoningTrigger 文案（ZCode reasoning-streaming-auto-collapse）', () => {
  it('流式 + 收起：正在思考 · 最后一行', () => {
    const text = triggerText(render(true, '先看目录结构\n现在读 tools.rs'))
    expect(text).toContain('正在思考')
    expect(text).toContain('现在读 tools.rs')
    // 不展示已过期的上一行
    expect(text).not.toContain('先看目录结构')
  })

  it('流式 + 无内容：只有「正在思考」，不带分隔点', () => {
    const text = triggerText(render(true, ''))
    expect(text).toContain('正在思考')
    expect(text).not.toContain('·')
  })

  it('完成态（SSR 无计时）：思考 · 持续了几秒', () => {
    const text = triggerText(render(false, '完整思考内容'))
    expect(text).toContain('思考')
    // SSR 不跑 effect，所以拿不到实测耗时 → 走"持续了几秒"兜底文案
    // （客户端会在流式结束后把实测秒数填进来）。
    expect(text).toContain('持续了几秒')
    // 完成态不再展示流式摘要
    expect(text).not.toContain('完整思考内容')
  })
})
