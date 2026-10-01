/**
 * checkpoint-store 单测：纯逻辑——parseCheckpoints（pi_list_checkpoints
 * 裸数组的严格解析：合法行原样、行形状非法跳行、整体非数组丢弃、可空
 * 字段 entryId/note 的宽容与可见告警）、formatCheckpointTime（时间戳
 * 格式化与非法值）、rewind 请求信令（seq 单调 + clear 定向）与
 * resetProjection（会话域投影清空）。IPC 不在测试面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkpointBridge,
  formatCheckpointTime,
  parseCheckpoints,
} from './checkpoint-store'

/** 静音解析失败的 console.error（被测行为就是报错——断言调用而非听噪声） */
const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const validRow = {
  entryId: 'entry-1',
  name: '重写前',
  note: null,
  tokenEstimate: 1200,
  messageCount: 4,
  atMs: 1735689600000,
}

beforeEach(() => {
  checkpointBridge.getState().resetProjection()
  checkpointBridge.setState({ rewindRequest: null })
})

describe('parseCheckpoints', () => {
  it('合法行原样解析（entryId = 宿主手工带的树条目 id）', () => {
    const spy = silenceErrors()
    expect(parseCheckpoints([validRow])).toEqual([
      {
        entryId: 'entry-1',
        name: '重写前',
        note: null,
        tokenEstimate: 1200,
        messageCount: 4,
        atMs: 1735689600000,
      },
    ])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('entryId/note 可空（Option 字段）；类型非法按 null 处理且可见告警', () => {
    const spy = silenceErrors()
    const out = parseCheckpoints([
      { ...validRow, entryId: null, note: 42 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.entryId).toBeNull()
    expect(out[0]?.note).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('单行字段缺失/非法 → 跳过该行保留其余（name 是回退查找键）', () => {
    const spy = silenceErrors()
    const out = parseCheckpoints([
      validRow,
      { ...validRow, name: undefined },
      'not-an-object',
      { ...validRow, name: '好的', tokenEstimate: 'many' },
      { ...validRow, name: '好的2' },
    ])
    expect(out.map((r) => r.name)).toEqual(['重写前', '好的2'])
    expect(spy).toHaveBeenCalledTimes(3)
    spy.mockRestore()
  })

  it('整体非数组 → [] 且 console.error 可见', () => {
    const spy = silenceErrors()
    expect(parseCheckpoints({ checkpoints: [] })).toEqual([])
    expect(parseCheckpoints('nope')).toEqual([])
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })
})

describe('formatCheckpointTime', () => {
  it('时间戳 → MM/DD HH:mm（zh-CN 24h）', () => {
    // 2025-01-01 08:00 UTC+8 = 1735689600000
    const label = formatCheckpointTime(1735689600000)
    expect(label).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/)
  })

  it('非法时间戳 → "—"（不编造日期）', () => {
    expect(formatCheckpointTime(Number.NaN)).toBe('—')
  })
})

describe('checkpointBridge 信令', () => {
  it('requestRewind 单调 seq + clearRewindRequest 定向清除', () => {
    checkpointBridge.getState().requestRewind('A')
    const first = checkpointBridge.getState().rewindRequest
    checkpointBridge.getState().requestRewind('B')
    const second = checkpointBridge.getState().rewindRequest
    expect(first?.name).toBe('A')
    expect(second?.name).toBe('B')
    expect(second!.seq).toBeGreaterThan(first!.seq)
    // 过期 seq 的 clear 不误清新请求
    checkpointBridge.getState().clearRewindRequest(first!.seq)
    expect(checkpointBridge.getState().rewindRequest?.seq).toBe(second!.seq)
    checkpointBridge.getState().clearRewindRequest(second!.seq)
    expect(checkpointBridge.getState().rewindRequest).toBeNull()
  })

  it('resetProjection 清检查点清单与 currentId（会话更换）', () => {
    checkpointBridge.setState({
      checkpoints: [validRow as never],
      currentId: '重写前',
    })
    checkpointBridge.getState().resetProjection()
    expect(checkpointBridge.getState().checkpoints).toEqual([])
    expect(checkpointBridge.getState().currentId).toBeNull()
  })
})
