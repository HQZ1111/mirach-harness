import { describe, expect, it } from 'vitest'

import { planWorkspaceProjects, workspaceProjectName } from './workspace-projects'

const session = (cwd: string) => ({ cwd })

describe('workspaceProjectName', () => {
  it('取目录最后一段，Windows/斜杠都兼容', () => {
    expect(workspaceProjectName('G:\\mirach-harness')).toBe('mirach-harness')
    expect(workspaceProjectName('G:/mirach-harness/')).toBe('mirach-harness')
    expect(workspaceProjectName('C:\\')).toBe('C:')
  })
})

describe('planWorkspaceProjects（工作区 = 项目）', () => {
  it('distinct cwd 建项目；已有根（含子目录）覆盖的跳过', () => {
    expect(
      planWorkspaceProjects(
        [session('G:\\mirach-harness'), session('G:\\mirach-harness'), session('G:\\other')],
        [{ roots: ['G:\\mirach-harness'] }],
      ),
    ).toEqual([{ cwd: 'G:\\other', name: 'other' }])
  })

  it('项目根覆盖子目录 cwd；大小写/分隔符归一', () => {
    expect(
      planWorkspaceProjects(
        [session('g:/MIRACH-harness/sub'), session('G:\\work\\a')],
        [{ roots: ['G:\\mirach-harness'] }],
      ),
    ).toEqual([{ cwd: 'G:\\work\\a', name: 'a' }])
  })

  it('软删项目的根也算覆盖（不自动复活用户移除的项目）', () => {
    expect(
      planWorkspaceProjects([session('G:\\removed')], [{ roots: ['G:\\removed'] }]),
    ).toEqual([])
  })

  it('空 cwd 忽略', () => {
    expect(planWorkspaceProjects([session('  ')], [])).toEqual([])
  })
})
