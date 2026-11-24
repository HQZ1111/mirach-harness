import { describe, expect, it } from 'vitest'

import { formatSyncTime, summarizePushResult } from './data-sync-summary'

describe('summarizePushResult', () => {
  it('reports added and unchanged counts', () => {
    expect(
      summarizePushResult({
        connectionId: 'c1',
        added: ['a', 'b'],
        unchanged: ['c'],
        different: [],
        failed: [],
        totalLocal: 3,
      }),
    ).toBe('已推送 2 个；已是最新 1 个')
  })

  it('reports differences and failures', () => {
    expect(
      summarizePushResult({
        connectionId: 'c1',
        added: [],
        unchanged: [],
        different: ['x'],
        failed: [{ name: 'y', error: 'boom' }],
        totalLocal: 2,
      }),
    ).toBe('有差异未覆盖 1 个；失败 1 个')
  })

  it('says there is nothing to push when the local list is empty', () => {
    expect(
      summarizePushResult({
        connectionId: 'c1',
        added: [],
        unchanged: [],
        different: [],
        failed: [],
        totalLocal: 0,
      }),
    ).toBe('本机没有可推送的 MCP 服务器')
  })
})

describe('formatSyncTime', () => {
  it('returns empty for invalid timestamps', () => {
    expect(formatSyncTime(0)).toBe('')
    expect(formatSyncTime(Number.NaN)).toBe('')
  })

  it('formats a real timestamp', () => {
    expect(formatSyncTime(Date.UTC(2026, 10, 22, 12, 0, 0))).not.toBe('')
  })
})
