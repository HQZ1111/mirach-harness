import { describe, expect, it } from 'vitest'

import { diffFromToolResult, extractDiffText, parsePiDiff } from './diff-parse'

/**
 * 2026-11-15 引擎补丁后 `write` 也带 `details.diff`（与 edit 同形状）。
 * 这三个用例锁住：write 走 diff 卡；旧引擎/读不到旧内容时回退；别的工具不吃。
 */
describe('diff-parse', () => {
  const piDiff = ' 1 alpha\n-2 beta\n+2 BETA\n 3 gamma\n+4 delta'
  const writeResult = { details: { diff: piDiff, patch: '', first_changed_line: 2 } }

  it('write 的 details.diff 能解析成 added/removed/context', () => {
    const parsed = diffFromToolResult('write', writeResult)
    expect(parsed).not.toBeNull()
    expect(parsed?.additions).toBe(2)
    expect(parsed?.deletions).toBe(1)
    expect(parsed?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'context:alpha',
      'removed:beta',
      'added:BETA',
      'context:gamma',
      'added:delta',
    ])
  })

  it('没有 diff（diff_skipped / 空串）时返回 null，调用方回退通用卡', () => {
    expect(
      diffFromToolResult('write', { details: { diff_skipped: 'content_too_large' } }),
    ).toBeNull()
    expect(diffFromToolResult('write', { details: { diff: '' } })).toBeNull()
    expect(extractDiffText({ details: { diff_skipped: 'not_found' } })).toBeNull()
  })

  it('非 diff 工具（read/bash）返回 null', () => {
    expect(diffFromToolResult('read', writeResult)).toBeNull()
    expect(diffFromToolResult('bash', writeResult)).toBeNull()
  })

  it('parsePiDiff 跳过 skip marker', () => {
    const parsed = parsePiDiff('+1 a\n  ...\n+9 b')
    expect(parsed?.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })
})
