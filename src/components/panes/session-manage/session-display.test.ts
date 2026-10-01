/**
 * 展示投影新增面单测（重审计 #2/#3 落地面）：工作区分组
 * （groupEntriesByWorkspace——cwd 直投影 + Home 桶）、created 排序
 * （hermes rankBy 'created' = -started_at）、buildSessionDisplay 的
 * project/created 组合、pathLeaf/workspaceGroupLabel（hermes
 * display-path 照抄面）。
 */
import { describe, expect, it } from 'vitest'

import {
  buildSessionDisplay,
  groupEntriesByWorkspace,
  pathLeaf,
  workspaceGroupLabel,
} from './session-display'
import { createdCompare } from './sidebar-view'
import type { SessionRowMeta } from './session-order'

describe('pathLeaf / workspaceGroupLabel（hermes display-path 照抄面）', () => {
  it('取末段；Windows 反斜杠规整；尾斜杠去掉', () => {
    expect(pathLeaf('C:\\work\\mirach')).toBe('mirach')
    expect(pathLeaf('/home/u/projects/pi/')).toBe('pi')
    expect(pathLeaf('C:/')).toBe('C:/')
    expect(pathLeaf('')).toBe('')
  })

  it('无 cwd → Home 桶「主页」（hermes zh sidebar.projects.home）', () => {
    expect(workspaceGroupLabel(undefined)).toBe('主页')
    expect(workspaceGroupLabel('')).toBe('主页')
    expect(workspaceGroupLabel('C:\\work\\mirach')).toBe('mirach')
  })
})

describe('groupEntriesByWorkspace', () => {
  it('同 cwd 的行全收进同一组（组头一次），组内保持传入序；组序 = 首现序', () => {
    const rows = groupEntriesByWorkspace([
      { id: 'a', cwd: 'C:\\w\\alpha' },
      { id: 'b', cwd: 'C:\\w\\alpha' },
      { id: 'c' },
      { id: 'd', cwd: 'C:\\w\\beta' },
      { id: 'e' }, // 与 c 同 Home 桶——收进同一组，不重复出线
    ])
    expect(rows).toEqual([
      { key: 'w:C:\\w\\alpha', kind: 'divider', label: 'alpha', variant: 'project' },
      { id: 'a', kind: 'session' },
      { id: 'b', kind: 'session' },
      { key: 'w:', kind: 'divider', label: '主页', variant: 'project' },
      { id: 'c', kind: 'session' },
      { id: 'e', kind: 'session' },
      { key: 'w:C:\\w\\beta', kind: 'divider', label: 'beta', variant: 'project' },
      { id: 'd', kind: 'session' },
    ])
  })
})

describe('createdCompare / created 排序（hermes rankBy created）', () => {
  it('创建时间降序；缺省 createdMs 按 0（沉底）；同毫秒按 id 稳定', () => {
    const rows: { id: string; createdMs?: number }[] = [
      { id: 'old', createdMs: 100 },
      { id: 'new', createdMs: 300 },
      { id: 'mid', createdMs: 200 },
      { id: 'none' },
    ]
    expect([...rows].sort(createdCompare).map((r) => r.id)).toEqual(['new', 'mid', 'old', 'none'])
    expect([...rows].sort(createdCompare).map((r) => r.id)).toEqual(['new', 'mid', 'old', 'none'])
  })
})

describe('buildSessionDisplay：project 分组 × created 排序', () => {
  const metas: SessionRowMeta[] = [
    { id: 'a1', lastActiveMs: 500, cwd: 'C:\\w\\alpha', createdMs: 100 },
    { id: 'b1', lastActiveMs: 400, cwd: 'C:\\w\\beta', createdMs: 300 },
    { id: 'a2', lastActiveMs: 300, cwd: 'C:\\w\\alpha', createdMs: 200 },
    { id: 'p1', lastActiveMs: 100, createdMs: 400 },
  ]

  it('project 分组吃排序序：created 键下组序由首行的创建时间决定', () => {
    const display = buildSessionDisplay(
      metas,
      [],
      {},
      {},
      { view: { grouping: 'project', ordering: 'created' } },
    )
    // created 降序全局序 = p1(400) a2(200)? 不对——created: p1=400, b1=300,
    // a2=200, a1=100 → 顺序 p1, b1, a2, a1。分组 partition 保序：
    // p1 → Home；b1 → beta；a2,a1 → alpha。
    expect(display.rows).toEqual([
      { key: 'w:', kind: 'divider', label: '主页', variant: 'project' },
      { id: 'p1', kind: 'session' },
      { key: 'w:C:\\w\\beta', kind: 'divider', label: 'beta', variant: 'project' },
      { id: 'b1', kind: 'session' },
      { key: 'w:C:\\w\\alpha', kind: 'divider', label: 'alpha', variant: 'project' },
      { id: 'a2', kind: 'session' },
      { id: 'a1', kind: 'session' },
    ])
    expect(display.allUnpinnedIds).toEqual(['p1', 'b1', 'a2', 'a1'])
  })

  it('project 分组 × updated（默认）：recency 即序，组序随首现', () => {
    const display = buildSessionDisplay(
      metas,
      [],
      {},
      {},
      { view: { grouping: 'project', ordering: 'updated' } },
    )
    expect(display.allUnpinnedIds).toEqual(['a1', 'b1', 'a2', 'p1'])
    expect(display.rows).toEqual([
      { key: 'w:C:\\w\\alpha', kind: 'divider', label: 'alpha', variant: 'project' },
      { id: 'a1', kind: 'session' },
      { id: 'a2', kind: 'session' },
      { key: 'w:C:\\w\\beta', kind: 'divider', label: 'beta', variant: 'project' },
      { id: 'b1', kind: 'session' },
      { key: 'w:', kind: 'divider', label: '主页', variant: 'project' },
      { id: 'p1', kind: 'session' },
    ])
  })

  it('工作区组头可折叠（键 = w:<cwd>；组头保留、行隐藏）', () => {
    const display = buildSessionDisplay(
      metas,
      [],
      {},
      { 'w:C:\\w\\alpha': true },
      { view: { grouping: 'project', ordering: 'updated' } },
    )
    const ids = display.rows.map((r) => (r.kind === 'session' ? r.id : `|${r.key}`))
    expect(ids).toEqual([
      '|w:C:\\w\\alpha',
      '|w:C:\\w\\beta',
      'b1',
      '|w:',
      'p1',
    ])
  })

  it('置顶区不受分组影响（hermes：pins 不被分组吞掉）', () => {
    const display = buildSessionDisplay(
      metas,
      ['b1'],
      {},
      {},
      { view: { grouping: 'project', ordering: 'updated' } },
    )
    expect(display.pinnedIds).toEqual(['b1'])
    const sessionIds = display.rows
      .filter((r) => r.kind === 'session')
      .map((r) => (r.kind === 'session' ? r.id : ''))
    expect(sessionIds).not.toContain('b1')
  })

  it('date 分组回归：created 键在日期桶内应用（桶成员仍由 recency 钉死）', () => {
    const display = buildSessionDisplay(
      [
        { id: 'x1', lastActiveMs: 9_000_000, createdMs: 1 },
        { id: 'x2', lastActiveMs: 8_000_000, createdMs: 9 },
      ],
      [],
      {},
      {},
      { nowMs: 10_000_000, view: { grouping: 'date', ordering: 'created' } },
    )
    // 同一今天桶内 created 降序 → x2 前
    expect(display.rows.map((r) => (r.kind === 'session' ? r.id : '|'))).toEqual(['x2', 'x1'])
  })
})
