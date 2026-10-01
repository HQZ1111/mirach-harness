/* 手动刷新目录集合用例（ZCode refreshDirectories 语义对齐）。 */
import { describe, expect, it } from 'vitest'

import { getWorkspaceFileTreeRefreshDirectoryPaths } from './refreshDirectories'

describe('getWorkspaceFileTreeRefreshDirectoryPaths', () => {
  it('根恒在首位，去重，workspace 外剔除', () => {
    const paths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath: 'G:/repo',
      expandedPaths: new Set(['G:/repo/src/lib', 'G:/repo/src']),
      loadedDirectoryPaths: new Set(['G:/repo/src', 'G:/repo', 'G:/other']),
    })
    expect(paths).toEqual(['G:/repo', 'G:/repo/src', 'G:/repo/src/lib'])
  })

  it('空树只刷根', () => {
    const paths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath: 'G:/repo',
      expandedPaths: new Set(),
      loadedDirectoryPaths: new Set(),
    })
    expect(paths).toEqual(['G:/repo'])
  })
})
