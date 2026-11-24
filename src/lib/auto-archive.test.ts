import { describe, expect, it } from 'vitest'

import { autoArchiveCutoff, pickAutoArchiveIds } from './auto-archive'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)

describe('autoArchiveCutoff（ZCode taskAutoArchiveOlderThanDays 同口径）', () => {
  it('按天回推；不足 1 天按 1 天（0/负数不产生「立即归档」）', () => {
    expect(autoArchiveCutoff(NOW, 7)).toBe(NOW - 7 * DAY)
    expect(autoArchiveCutoff(NOW, 0)).toBe(NOW - DAY)
    expect(autoArchiveCutoff(NOW, -3)).toBe(NOW - DAY)
    expect(autoArchiveCutoff(NOW, 2.9)).toBe(NOW - 2 * DAY)
  })
})

describe('pickAutoArchiveIds（archiveInactive 语义）', () => {
  const sessions = [
    { id: 'old', lastModified: NOW - 40 * DAY },
    { id: 'fresh', lastModified: NOW - 1 * DAY },
    { id: 'pinned-old', lastModified: NOW - 40 * DAY },
    { id: 'archived-old', lastModified: NOW - 40 * DAY },
    { id: 'active-old', lastModified: NOW - 40 * DAY },
    { id: 'no-time', lastModified: 0 },
  ]
  const base = {
    now: NOW,
    olderThanDays: 30,
    pinned: ['pinned-old'],
    archived: ['archived-old'],
    activeId: 'active-old',
  }

  it('只挑：早于截止、未归档、非置顶、非当前会话', () => {
    expect(pickAutoArchiveIds(sessions, base)).toEqual(['old'])
  })

  it('去掉保护后，所有超期会话都进候选（置顶/当前/已归档仅因保护而排除）', () => {
    const ids = pickAutoArchiveIds(sessions, {
      ...base,
      pinned: [],
      archived: [],
      activeId: null,
    })
    expect(ids.sort()).toEqual(['active-old', 'archived-old', 'old', 'pinned-old'])
  })

  it('没有时间事实（lastModified=0）的条目跳过，不按「旧」处理', () => {
    const ids = pickAutoArchiveIds([{ id: 'x', lastModified: 0 }], base)
    expect(ids).toEqual([])
  })
})
