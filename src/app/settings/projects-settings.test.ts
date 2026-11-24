import { describe, expect, it } from 'vitest'

import type { PiProject, SessionsIndexSession } from '@/components/panes/session-manage/session-catalog'
import {
  projectSessionStats,
  projectUnusedReason,
  selectProjectRows,
  type ProjectRow,
} from './projects-settings'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)

const project = (over: Partial<PiProject>): PiProject => ({
  id: 'p1',
  name: 'mirach',
  roots: ['G:/work/mirach'],
  pinned: false,
  order: 0,
  createdAt: NOW - 400 * DAY,
  ...over,
})

const session = (over: Partial<SessionsIndexSession>): SessionsIndexSession => ({
  id: 's1',
  path: 'x',
  cwd: 'G:/work/mirach',
  name: 'chat',
  messageCount: 1,
  lastModified: NOW - 1 * DAY,
  createdAt: NOW - 30 * DAY,
  parentSessionId: null,
  projectId: 'p1',
  sourceRoot: 'sessionDir',
  source: 'sessionDir',
  ...over,
})

describe('projectSessionStats（按 projectId 聚合会话数与最近活动）', () => {
  it('只统计有归属的会话；最近活动取最大值', () => {
    const stats = projectSessionStats([
      session({ id: 'a', lastModified: NOW - 5 * DAY }),
      session({ id: 'b', lastModified: NOW - 2 * DAY }),
      session({ id: 'c', projectId: null, lastModified: NOW }),
    ])
    expect(stats.get('p1')).toEqual({ sessions: 2, lastActiveAt: NOW - 2 * DAY })
    expect(stats.has('null')).toBe(false)
  })
})

describe('projectUnusedReason（ZCode unusedReason）', () => {
  const used = { sessions: 2, lastActiveAt: NOW - DAY }

  it('置顶 / 已删除项目不参与', () => {
    expect(
      projectUnusedReason({
        project: project({ pinned: true }),
        stat: { sessions: 0, lastActiveAt: null },
        rootsAvailable: false,
        now: NOW,
      }),
    ).toBeNull()
    expect(
      projectUnusedReason({
        project: project({ deletedAt: NOW }),
        stat: used,
        rootsAvailable: undefined,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('根目录全部缺失 → missing；未探测（undefined）不判定', () => {
    expect(
      projectUnusedReason({
        project: project({ roots: ['G:/gone'] }),
        stat: used,
        rootsAvailable: false,
        now: NOW,
      }),
    ).toBe('missing')
    expect(
      projectUnusedReason({
        project: project({ roots: ['G:/gone'] }),
        stat: used,
        rootsAvailable: undefined,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('无会话且超过 7 天宽限期 → empty；7 天内不判定', () => {
    expect(
      projectUnusedReason({
        project: project({ createdAt: NOW - 30 * DAY }),
        stat: { sessions: 0, lastActiveAt: null },
        rootsAvailable: true,
        now: NOW,
      }),
    ).toBe('empty')
    expect(
      projectUnusedReason({
        project: project({ createdAt: NOW - 3 * DAY }),
        stat: { sessions: 0, lastActiveAt: null },
        rootsAvailable: true,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('最近活动超过 90 天 → idle；90 天内不判定', () => {
    expect(
      projectUnusedReason({
        project: project({}),
        stat: { sessions: 1, lastActiveAt: NOW - 91 * DAY },
        rootsAvailable: true,
        now: NOW,
      }),
    ).toBe('idle')
    expect(
      projectUnusedReason({
        project: project({}),
        stat: { sessions: 1, lastActiveAt: NOW - 30 * DAY },
        rootsAvailable: true,
        now: NOW,
      }),
    ).toBeNull()
  })
})

describe('selectProjectRows（过滤 + 排序）', () => {
  const rows: ProjectRow[] = [
    {
      project: project({ id: 'b', name: 'Beta' }),
      sessions: 5,
      lastActiveAt: NOW - 2 * DAY,
      reason: null,
    },
    {
      project: project({ id: 'a', name: 'Alpha' }),
      sessions: 1,
      lastActiveAt: NOW - 10 * DAY,
      reason: 'idle',
    },
    {
      project: project({ id: 'c', name: 'Gamma', roots: ['G:/work/gamma'] }),
      sessions: 0,
      lastActiveAt: null,
      reason: 'missing',
    },
  ]

  it('未使用过滤只留有原因的行', () => {
    expect(
      selectProjectRows(rows, { query: '', filter: 'unused', sort: 'name' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['a', 'c'])
  })

  it('排序：会话数降序 / 最近活动降序 / 名称升序', () => {
    expect(
      selectProjectRows(rows, { query: '', filter: 'all', sort: 'sessions' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['b', 'a', 'c'])
    expect(
      selectProjectRows(rows, { query: '', filter: 'all', sort: 'lastActive' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['b', 'a', 'c'])
    expect(
      selectProjectRows(rows, { query: '', filter: 'all', sort: 'name' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['a', 'b', 'c'])
  })

  it('搜索命中名称或根目录', () => {
    expect(
      selectProjectRows(rows, { query: 'gamma', filter: 'all', sort: 'name' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['c'])
    expect(
      selectProjectRows(rows, { query: 'BETA', filter: 'all', sort: 'name' }).map(
        (row) => row.project.id,
      ),
    ).toEqual(['b'])
  })
})
