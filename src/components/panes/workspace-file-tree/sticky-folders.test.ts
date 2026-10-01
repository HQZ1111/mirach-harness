/* 吸顶目录计算用例（ZCode sticky folders 语义对齐）。
 * fixture 选型说明：探测循环在「吸顶栈高度 ≥ 最深展开目录剩余子树」时会
 * 收敛到空栈（算法固有的收敛语义），故用例取栈稳定收敛的滚动位。 */
import { describe, expect, it } from 'vitest'

import { computeFileTreeStickyFolders, type WorkspaceFileTreeStickyFolderItem } from './useFileTreeStickyFolders'
import type { WorkspaceFileTreeRow } from './model'

const ROW = 28

function row(partial: {
  name: string
  path: string
  depth: number
  type: 'directory' | 'file'
  expanded?: boolean
}): WorkspaceFileTreeRow {
  return {
    path: partial.path,
    name: partial.name,
    type: partial.type,
    depth: partial.depth,
    expanded: partial.expanded ?? false,
    loaded: partial.type === 'directory',
    loading: false,
    error: null,
  }
}

/** 固定测试树（扁平化输出，行序 = 视觉序）：
 *  0 src(d0,目录,展开) / 1 components(d1,目录,展开) / 2 layout(d2,目录,展开)
 *  3..6 a.ts b.ts c.ts d.ts（layout 的四个文件）
 *  7 README.md(d0) */
const ROWS: WorkspaceFileTreeRow[] = [
  row({ name: 'src', path: '/src', depth: 0, type: 'directory', expanded: true }),
  row({ name: 'components', path: '/src/components', depth: 1, type: 'directory', expanded: true }),
  row({ name: 'layout', path: '/src/components/layout', depth: 2, type: 'directory', expanded: true }),
  row({ name: 'a.ts', path: '/src/components/layout/a.ts', depth: 3, type: 'file' }),
  row({ name: 'b.ts', path: '/src/components/layout/b.ts', depth: 3, type: 'file' }),
  row({ name: 'c.ts', path: '/src/components/layout/c.ts', depth: 3, type: 'file' }),
  row({ name: 'd.ts', path: '/src/components/layout/d.ts', depth: 3, type: 'file' }),
  row({ name: 'README.md', path: '/README.md', depth: 0, type: 'file' }),
]

const pathsOf = (items: WorkspaceFileTreeStickyFolderItem[]) => items.map((i) => i.row.path)

describe('computeFileTreeStickyFolders', () => {
  it('未滚动不吸顶', () => {
    expect(computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: 0 })).toEqual([])
    expect(computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: 0.5 })).toEqual([])
  })

  it('enabled=false 关闭吸顶', () => {
    expect(
      computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: ROW * 3, enabled: false }),
    ).toEqual([])
  })

  it('滚到深层文件时祖先目录链吸顶（视口顶部刚过 src 时三层全吸）', () => {
    // offset 14：src(0)/components(28)/layout(56) 的原行位都已被吸顶栈覆盖
    expect(pathsOf(computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: 14 }))).toEqual([
      '/src',
      '/src/components',
      '/src/components/layout',
    ])
    expect(pathsOf(computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: ROW * 3 }))).toEqual([
      '/src',
      '/src/components',
      '/src/components/layout',
    ])
  })

  it('祖先收起后从吸顶链中消失', () => {
    const collapsed = ROWS.map((r) =>
      r.path === '/src' ? { ...r, expanded: false } : r,
    )
    expect(pathsOf(computeFileTreeStickyFolders({ rows: collapsed, scrollOffset: ROW * 3 }))).toEqual([
      '/src/components',
      '/src/components/layout',
    ])
  })

  it('滚过所有子树后无吸顶', () => {
    // 视口顶部 = README.md（index 7）：全树滚完，无展开祖先在视口上方
    expect(computeFileTreeStickyFolders({ rows: ROWS, scrollOffset: ROW * 8 })).toEqual([])
  })
})
