/**
 * 输入框下方统计条的折叠逻辑（DSH `deriveStats` 兜底路径同语义：
 * 只回答"屏幕上这一屏有什么"，不假装是整条日志的持久投影）。
 */
import { describe, expect, it } from 'vitest'

import { deriveStats } from './composer-stats-line'

const assistant = (content: unknown) => ({ role: 'assistant', content })
const user = (content: unknown) => ({ role: 'user', content })

describe('deriveStats', () => {
  it('只数 assistant 消息为轮/步', () => {
    const s = deriveStats([
      user('hi'),
      assistant([{ type: 'text', text: 'a' }]),
      assistant([{ type: 'text', text: 'b' }]),
    ])
    expect(s.turns).toBe(2)
    expect(s.steps).toBe(2)
  })

  it('首字延迟取每步首个带时间戳的 text/reasoning 部件', () => {
    const s = deriveStats([
      assistant([
        { type: 'reasoning', startedAt: 1000, completedAt: 1400 },
        { type: 'text', startedAt: 1400, completedAt: 3000 },
      ]),
      assistant([{ type: 'text', startedAt: 5000, completedAt: 5600 }]),
    ])
    // 样本 = 1400-1000 = 400；5600-5000 = 600 → 均值 500
    expect(s.ttftMs).toBe(500)
  })

  it('没有计时部件时 ttft 为 null（不编造 0）', () => {
    const s = deriveStats([assistant([{ type: 'text', text: 'no timing' }])])
    expect(s.ttftMs).toBeNull()
  })

  it('content 不是数组（历史字符串消息）不崩、不计 ttft', () => {
    const s = deriveStats([assistant('plain string'), user('x')])
    expect(s.turns).toBe(1)
    expect(s.ttftMs).toBeNull()
  })

  it('时间戳倒挂（completedAt < startedAt）不计入样本', () => {
    const s = deriveStats([assistant([{ type: 'text', startedAt: 900, completedAt: 100 }])])
    expect(s.ttftMs).toBeNull()
  })

  it('空列表返回全零', () => {
    expect(deriveStats([])).toMatchObject({ turns: 0, steps: 0, ttftMs: null })
  })

  it('工具耗时合计与 run 用时（新增口径）', () => {
    const s = deriveStats([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', startedAt: 1000, completedAt: 1500 },
          { type: 'tool-call', startedAt: 2000, completedAt: 2600 },
          { type: 'text', startedAt: 2600, completedAt: 3000 },
        ],
        createdAt: new Date(500),
        completedAt: 3000,
      },
    ])
    expect(s.toolMs).toBe(1100)
    expect(s.runWallMs).toBe(2500)
  })
})
