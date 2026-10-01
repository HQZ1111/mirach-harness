/* 文件树模型纯函数用例（flatten/压缩/过滤/路径推导）——ZCode 语义逐条对齐。 */
import { describe, expect, it } from 'vitest'

import {
  filterWorkspaceFileTreeRows,
  flattenWorkspaceFileTreeRows,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  getWorkspaceFileRelativePath,
  isWorkspaceFileTreeAutoFlattenableDirectory,
  type WorkspaceFileTreeNode,
} from './model'

const dir = (path: string, name: string, depth: number, isSymbolicLink?: boolean): WorkspaceFileTreeNode => ({
  path,
  name,
  type: 'directory',
  depth,
  ...(isSymbolicLink !== undefined ? { isSymbolicLink } : {}),
})
const file = (path: string, name: string, depth: number): WorkspaceFileTreeNode => ({
  path,
  name,
  type: 'file',
  depth,
})

describe('getWorkspaceFileRelativePath', () => {
  it('workspace 内的路径返回相对路径', () => {
    expect(getWorkspaceFileRelativePath('G:/repo', 'G:/repo/src/a.ts')).toBe('src/a.ts')
  })
  it('与 workspace 相同返回 "."', () => {
    expect(getWorkspaceFileRelativePath('G:/repo', 'G:/repo')).toBe('.')
  })
  it('workspace 外回退路径叶名', () => {
    expect(getWorkspaceFileRelativePath('G:/repo', 'G:/other/a.ts')).toBe('a.ts')
  })
})

describe('getWorkspaceFileAncestorDirectories', () => {
  it('逐级返回祖先目录', () => {
    expect(getWorkspaceFileAncestorDirectories('G:/repo', 'G:/repo/a/b/c.txt')).toEqual([
      'G:/repo/a',
      'G:/repo/a/b',
    ])
  })
  it('单层文件无祖先', () => {
    expect(getWorkspaceFileAncestorDirectories('G:/repo', 'G:/repo/a.txt')).toEqual([])
  })
  it('workspace 外无祖先', () => {
    expect(getWorkspaceFileAncestorDirectories('G:/repo', 'G:/other/a.txt')).toEqual([])
  })
  it('Windows 反斜杠路径用反斜杠拼接', () => {
    expect(getWorkspaceFileAncestorDirectories('G:\\repo', 'G:\\repo\\x\\y.txt')).toEqual([
      'G:\\repo\\x',
    ])
  })
})

describe('getWorkspaceFileDirectoryChildDepth', () => {
  it('根为 0，逐层 +1，外部为 0', () => {
    expect(getWorkspaceFileDirectoryChildDepth('G:/repo', 'G:/repo')).toBe(0)
    expect(getWorkspaceFileDirectoryChildDepth('G:/repo', 'G:/repo/src')).toBe(1)
    expect(getWorkspaceFileDirectoryChildDepth('G:/repo', 'G:/repo/src/lib')).toBe(2)
    expect(getWorkspaceFileDirectoryChildDepth('G:/repo', 'G:/other')).toBe(0)
  })
})

describe('getWorkspaceFileParentDirectory', () => {
  it('子目录返回父目录', () => {
    expect(getWorkspaceFileParentDirectory('G:/repo', 'G:/repo/src')).toBe('G:/repo')
  })
  it('根返回 null', () => {
    expect(getWorkspaceFileParentDirectory('G:/repo', 'G:/repo')).toBeNull()
  })
  it('深层目录逐级回退', () => {
    expect(getWorkspaceFileParentDirectory('G:/repo', 'G:/repo/a/b')).toBe('G:/repo/a')
  })
})

describe('isWorkspaceFileTreeAutoFlattenableDirectory', () => {
  it('普通目录可压缩，软链接目录不可，非目录/undefined 不可', () => {
    expect(isWorkspaceFileTreeAutoFlattenableDirectory(dir('p', 'd', 0))).toBe(true)
    expect(isWorkspaceFileTreeAutoFlattenableDirectory(dir('p', 'd', 0, true))).toBe(false)
    expect(isWorkspaceFileTreeAutoFlattenableDirectory(file('p', 'f', 0))).toBe(false)
    expect(isWorkspaceFileTreeAutoFlattenableDirectory(undefined)).toBe(false)
  })
})

describe('flattenWorkspaceFileTreeRows', () => {
  // 常规树：src 有两个子目录（不构成单子目录链，不触发压缩）
  const childrenByDirectory = new Map<string, WorkspaceFileTreeNode[]>([
    ['G:/repo', [dir('G:/repo/src', 'src', 0), file('G:/repo/README.md', 'README.md', 0)]],
    ['G:/repo/src', [dir('G:/repo/src/lib', 'lib', 1), dir('G:/repo/src/utils', 'utils', 1)]],
    ['G:/repo/src/lib', [file('G:/repo/src/lib/a.ts', 'a.ts', 2)]],
    ['G:/repo/src/utils', [file('G:/repo/src/utils/b.ts', 'b.ts', 2)]],
  ])
  const flatten = (params: {
    childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>
    expandedPaths: Set<string>
    loadedDirectoryPaths: Set<string>
    loadingDirectoryPaths?: Set<string>
    errorByDirectory?: Map<string, Error>
  }) =>
    flattenWorkspaceFileTreeRows({
      rootPath: 'G:/repo',
      flattenEmptyDirectories: true,
      loadingDirectoryPaths: new Set(),
      errorByDirectory: new Map(),
      ...params,
    })

  it('未展开目录只出一行', () => {
    const rows = flatten({
      childrenByDirectory,
      expandedPaths: new Set(),
      loadedDirectoryPaths: new Set(['G:/repo', 'G:/repo/src']),
    })
    expect(rows.map((r) => [r.name, r.depth, r.expanded])).toEqual([
      ['src', 0, false],
      ['README.md', 0, false],
    ])
  })

  it('展开目录按行扁平化，深度递增', () => {
    const rows = flatten({
      childrenByDirectory,
      expandedPaths: new Set(['G:/repo/src']),
      loadedDirectoryPaths: new Set(['G:/repo', 'G:/repo/src', 'G:/repo/src/lib', 'G:/repo/src/utils']),
    })
    expect(rows.map((r) => [r.name, r.depth, r.expanded])).toEqual([
      ['src', 0, true],
      ['lib', 1, false],
      ['utils', 1, false],
      ['README.md', 0, false],
    ])
  })

  it('空目录链压缩成单行（projects/mirach/deep 形态），展开后子行深度扣除压缩偏移', () => {
    const chain = new Map<string, WorkspaceFileTreeNode[]>([
      ['G:/repo', [dir('G:/repo/projects', 'projects', 0), file('G:/repo/README.md', 'README.md', 0)]],
      ['G:/repo/projects', [dir('G:/repo/projects/mirach', 'mirach', 1)]],
      ['G:/repo/projects/mirach', [dir('G:/repo/projects/mirach/deep', 'deep', 2)]],
      ['G:/repo/projects/mirach/deep', [
        file('G:/repo/projects/mirach/deep/a.ts', 'a.ts', 3),
        file('G:/repo/projects/mirach/deep/b.ts', 'b.ts', 3),
      ]],
    ])
    const loaded = new Set([
      'G:/repo',
      'G:/repo/projects',
      'G:/repo/projects/mirach',
      'G:/repo/projects/mirach/deep',
    ])
    const collapsed = flatten({ childrenByDirectory: chain, expandedPaths: new Set(), loadedDirectoryPaths: loaded })
    expect(collapsed.map((r) => [r.name, r.depth, r.compactedPaths])).toEqual([
      ['projects/mirach/deep', 0, ['G:/repo/projects', 'G:/repo/projects/mirach', 'G:/repo/projects/mirach/deep']],
      ['README.md', 0, undefined],
    ])
    const expanded = flatten({ childrenByDirectory: chain, expandedPaths: new Set(['G:/repo/projects']), loadedDirectoryPaths: loaded })
    expect(expanded.map((r) => [r.name, r.depth, r.expanded])).toEqual([
      ['projects/mirach/deep', 0, true],
      ['a.ts', 1, false],
      ['b.ts', 1, false],
      ['README.md', 0, false],
    ])
  })

  it('软链接目录不参与压缩链', () => {
    const withLink = new Map<string, WorkspaceFileTreeNode[]>([
      ['G:/repo', [dir('G:/repo/src', 'src', 0), file('G:/repo/README.md', 'README.md', 0)]],
      ['G:/repo/src', [dir('G:/repo/src/link', 'link', 1, true)]],
      ['G:/repo/src/link', [file('G:/repo/src/link/x.ts', 'x.ts', 2)]],
    ])
    const rows = flatten({
      childrenByDirectory: withLink,
      expandedPaths: new Set(['G:/repo/src']),
      loadedDirectoryPaths: new Set(['G:/repo', 'G:/repo/src', 'G:/repo/src/link']),
    })
    expect(rows.map((r) => [r.name, r.depth, r.compactedPaths])).toEqual([
      ['src', 0, undefined],
      ['link', 1, undefined],
      ['README.md', 0, undefined],
    ])
  })

  it('加载中的目录不压缩（等待结果）', () => {
    const single = new Map<string, WorkspaceFileTreeNode[]>([
      ['G:/repo', [dir('G:/repo/src', 'src', 0), file('G:/repo/README.md', 'README.md', 0)]],
      ['G:/repo/src', [dir('G:/repo/src/lib', 'lib', 1)]],
    ])
    const rows = flatten({
      childrenByDirectory: single,
      expandedPaths: new Set(),
      loadedDirectoryPaths: new Set(['G:/repo', 'G:/repo/src']),
      loadingDirectoryPaths: new Set(['G:/repo/src']),
    })
    expect(rows.map((r) => [r.name, r.loading])).toEqual([
      ['src', true],
      ['README.md', false],
    ])
  })

  it('目录错误出现在行上', () => {
    const boom = new Error('EACCES')
    const rows = flatten({
      childrenByDirectory,
      expandedPaths: new Set(['G:/repo/src']),
      loadedDirectoryPaths: new Set(['G:/repo', 'G:/repo/src', 'G:/repo/src/lib', 'G:/repo/src/utils']),
      errorByDirectory: new Map([['G:/repo/src/lib', boom]]),
    })
    const libRow = rows.find((r) => r.name === 'lib')
    expect(libRow?.error).toBe(boom)
  })
})

describe('filterWorkspaceFileTreeRows', () => {
  const rows = flattenWorkspaceFileTreeRows({
    rootPath: 'G:/repo',
    flattenEmptyDirectories: true,
    childrenByDirectory: new Map<string, WorkspaceFileTreeNode[]>([
      [
        'G:/repo',
        [
          dir('G:/repo/src', 'src', 0),
          file('G:/repo/src/a.ts', 'a.ts', 1),
          file('G:/repo/README.md', 'README.md', 0),
          file('G:/repo/readme-legacy.txt', 'readme-legacy.txt', 0),
        ],
      ],
    ]),
    expandedPaths: new Set(['G:/repo/src']),
    loadedDirectoryPaths: new Set(['G:/repo']),
    loadingDirectoryPaths: new Set(),
    errorByDirectory: new Map(),
  })

  it('空查询原样返回', () => {
    expect(filterWorkspaceFileTreeRows({ rows, searchQuery: '  ' })).toEqual(rows)
  })
  it('名称大小写不敏感匹配', () => {
    expect(
      filterWorkspaceFileTreeRows({ rows, searchQuery: 'README' }).map((r) => r.name),
    ).toEqual(['README.md', 'readme-legacy.txt'])
  })
  it('命中目录保留其子行', () => {
    expect(filterWorkspaceFileTreeRows({ rows, searchQuery: 'src' }).map((r) => r.name)).toEqual([
      'src',
      'a.ts',
    ])
  })
  it('无命中返回空', () => {
    expect(filterWorkspaceFileTreeRows({ rows, searchQuery: 'nope' })).toEqual([])
  })
})
