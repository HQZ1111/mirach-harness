/**
 * 项目注册表 + 跨根会话索引的前端投影单测（2026-11-15 P0）。
 *
 * 覆盖三块纯逻辑：
 * 1. mergeSessionRows：pi_list_sessions 基线 × pi_sessions_index 索引的合并
 *    纪律（基线序保留、索引覆盖 projectId、索引独有行按新近追加）；
 * 2. ingest 的 projectId 三态（缺键保留 / null 清除 / 新值覆盖）；
 * 3. 项目分组（侧栏 project 分组 + 归档页分组）：projectId 优先、cwd 仅
 *    兼容旧数据、组序 = 注册表序（置顶优先）+ 未知 + 主页殿后。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  mergeSessionRows,
  sessionCatalog,
  sessionProjectId,
  type SessionCatalogRow,
  type SessionCatalogState,
  type SessionsIndexSession,
} from './session-catalog'
import {
  buildSessionDisplay,
  groupEntriesByProject,
  projectGroupLabel,
  type ProjectGroupRef,
} from './session-display'
import { groupSessionsByProject } from '@/app/settings/archives-settings'

const resetCatalog = (): void => {
  localStorage.clear()
  const empty: Partial<SessionCatalogState> = {
    entries: {},
    piOrder: [],
    activeId: null,
    pendingCwd: null,
    pinned: [],
    manualOrder: {},
    archived: [],
    seen: {},
    markers: [],
    groupsCollapsed: {},
    projects: [],
    projectsLoaded: false,
    projectsError: null,
    sessionProjects: {},
    sessionsIndex: null,
    sessionsIndexError: null,
  }
  sessionCatalog.setState(empty as unknown as SessionCatalogState)
}

beforeEach(resetCatalog)

const baseRow = (id: string, extra?: Partial<NonNullable<SessionCatalogRow['custom']>>) => ({
  status: 'regular' as const,
  id,
  title: `pi-${id}`,
  custom: {
    path: `/sessions/${id}.jsonl`,
    cwd: 'C:\\work\\a',
    messageCount: 1,
    lastModifiedMs: 100,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...extra,
  },
})

const indexSession = (id: string, extra?: Partial<SessionsIndexSession>): SessionsIndexSession => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: 'C:\\work\\a',
  name: null,
  messageCount: 2,
  lastModified: 200,
  createdAt: 100,
  parentSessionId: null,
  projectId: null,
  profile: null,
  sourceRoot: 'C:\\work\\a\\.rpi\\sessions',
  source: 'projectRoot',
  ...extra,
})

describe('mergeSessionRows（pi_list_sessions 基线 + pi_sessions_index 索引）', () => {
  it('基线序保留；同 id 用索引覆盖字段并保留 timestamp；索引独有行按新近降序追加', () => {
    const merged = mergeSessionRows(
      [baseRow('a'), baseRow('b')],
      [
        indexSession('b', {
          name: '正式名B',
          messageCount: 9,
          lastModified: 300,
          projectId: 'p1',
          parentSessionId: 'root',
        }),
        indexSession('c', { lastModified: 500, projectId: 'p2' }),
        indexSession('d', { lastModified: 700 }),
      ],
    )
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'd', 'c'])
    const b = merged[1]!
    expect(b.title).toBe('正式名B')
    expect(b.custom?.messageCount).toBe(9)
    expect(b.custom?.projectId).toBe('p1')
    expect(b.custom?.parentSessionId).toBe('root')
    // 索引不带 header.timestamp（创建时刻）——基线值不得被抹掉
    expect(b.custom?.timestamp).toBe('2026-01-01T00:00:00.000Z')
  })

  it('索引 name=null 时不覆盖基线的 pi name', () => {
    const merged = mergeSessionRows([baseRow('a')], [indexSession('a', { name: null })])
    expect(merged[0]!.title).toBe('pi-a')
  })

  it('索引 projectId=null = 明确无归属（ingest 清除旧值）；缺键 = 不提供该维（保留）', () => {
    sessionCatalog.setState({
      entries: { a: { id: 'a', projectId: 'old' }, b: { id: 'b', projectId: 'old' } },
      piOrder: ['a', 'b'],
    } as unknown as SessionCatalogState)
    sessionCatalog.getState().ingest(
      mergeSessionRows(
        [{ id: 'a', custom: { projectId: null } }, { id: 'b' }],
        [indexSession('a'), indexSession('b')],
      ),
      null,
    )
    const s = sessionCatalog.getState()
    // 索引行都带 projectId:null → 两者都被清除
    expect(s.entries.a.projectId).toBeUndefined()
    expect(s.entries.b.projectId).toBeUndefined()

    // 纯基线（无 projectId 键）→ 保留先前推断值
    sessionCatalog.setState({
      entries: { c: { id: 'c', projectId: 'kept' } },
      piOrder: ['c'],
    } as unknown as SessionCatalogState)
    sessionCatalog.getState().ingest([{ id: 'c', custom: { path: '/x' } }], null)
    expect(sessionCatalog.getState().entries.c.projectId).toBe('kept')
  })
})

describe('sessionProjectId（显式映射压过索引推断）', () => {
  it('显式优先；无显式用 entry.projectId', () => {
    expect(sessionProjectId({ id: 's', projectId: 'inferred' }, { s: 'explicit' })).toBe('explicit')
    expect(sessionProjectId({ id: 's', projectId: 'inferred' }, {})).toBe('inferred')
    expect(sessionProjectId(undefined, { s: 'x' })).toBeUndefined()
  })
})

const projects: ProjectGroupRef[] = [
  { id: 'p2', name: 'Beta', pinned: false, order: 1 },
  { id: 'p1', name: 'Alpha', pinned: true, order: 2 },
  { id: 'p3', name: 'Gone', pinned: false, order: 3, deletedAt: 123 },
]

describe('groupEntriesByProject（侧栏 project 分组 = projectId）', () => {
  it('组序：置顶项目 → 其它注册项目 → 未知 projectId（首现）→ cwd 兼容桶 → 主页', () => {
    const rows = groupEntriesByProject(
      [
        { id: 'x', cwd: 'C:\\legacy' },
        { id: 'u', projectId: 'ghost' },
        { id: 'b1', projectId: 'p2' },
        { id: 'a1', projectId: 'p1' },
        { id: 'h' },
        { id: 'b2', projectId: 'p2' },
      ],
      projects,
    )
    expect(rows).toEqual([
      { key: 'pj:p1', kind: 'divider', label: 'Alpha', variant: 'project' },
      { id: 'a1', kind: 'session' },
      { key: 'pj:p2', kind: 'divider', label: 'Beta', variant: 'project' },
      { id: 'b1', kind: 'session' },
      { id: 'b2', kind: 'session' },
      { key: 'pj:ghost', kind: 'divider', label: '未知项目 ghost', variant: 'project' },
      { id: 'u', kind: 'session' },
      { key: 'w:C:\\legacy', kind: 'divider', label: 'legacy', variant: 'project' },
      { id: 'x', kind: 'session' },
      { key: 'w:', kind: 'divider', label: '主页', variant: 'project' },
      { id: 'h', kind: 'session' },
    ])
  })

  it('软删项目只要有归属行仍出组，标签注明（已删除）', () => {
    const rows = groupEntriesByProject([{ id: 'g1', projectId: 'p3' }], projects)
    expect(rows[0]).toEqual({
      key: 'pj:p3',
      kind: 'divider',
      label: 'Gone（已删除）',
      variant: 'project',
    })
  })
})

describe('projectGroupLabel', () => {
  it('注册名 / 未知 id 直示前 8 位 / 无归属 = 主页', () => {
    expect(projectGroupLabel('p1', projects)).toBe('Alpha')
    expect(projectGroupLabel('p3', projects)).toBe('Gone（已删除）')
    expect(projectGroupLabel('1234567890', projects)).toBe('未知项目 12345678')
    expect(projectGroupLabel(undefined, projects)).toBe('主页')
  })
})

describe('buildSessionDisplay：project 分组接注册表（缺省仍走 cwd 兼容）', () => {
  const metas = [
    { id: 'a', lastActiveMs: 300, cwd: 'C:\\w\\alpha', projectId: 'p1', messageCount: 1 },
    { id: 'b', lastActiveMs: 200, cwd: 'C:\\w\\beta', projectId: 'p2', messageCount: 1 },
    { id: 'c', lastActiveMs: 100, cwd: 'C:\\w\\alpha', messageCount: 1 },
  ]

  it('给了 projects：组头 = 项目名（置顶优先）；无 projectId 但有 cwd 的行落 cwd 兼容桶', () => {
    const display = buildSessionDisplay(metas, [], {}, {}, {
      view: { grouping: 'project', projects },
    })
    expect(
      display.rows.map((r) => (r.kind === 'session' ? r.id : r.label)),
    ).toEqual(['Alpha', 'a', 'Beta', 'b', 'alpha', 'c'])
  })

  it('不给 projects（表未加载/旧数据）：退回 cwd 分组（行为不变）', () => {
    const display = buildSessionDisplay(metas, [], {}, {}, {
      view: { grouping: 'project' },
    })
    expect(
      display.rows.map((r) => (r.kind === 'session' ? r.id : r.label)),
    ).toEqual(['alpha', 'a', 'c', 'beta', 'b'])
  })
})

describe('groupSessionsByProject（设置页 · 归档会话分组）', () => {
  it('按 projectId 分组；注册表组序在前，未知随后，主页殿后；组内保持输入序', () => {
    const groups = groupSessionsByProject(
      [
        indexSession('h1'),
        indexSession('g1', { projectId: 'ghost' }),
        indexSession('b1', { projectId: 'p2' }),
        indexSession('b2', { projectId: 'p2' }),
        indexSession('a1', { projectId: 'p1' }),
      ],
      projects,
    )
    expect(groups.map((g) => g.label)).toEqual(['Alpha', 'Beta', '已移除项目', '未归类'])
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([
      ['a1'],
      ['b1', 'b2'],
      ['g1'],
      ['h1'],
    ])
  })
})
