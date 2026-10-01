/* fs_list 适配层用例：形状映射 + 错误码显式抛出（禁止吞错成空目录）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fsEntryToWorkspaceFileEntry, listWorkspaceDirectory } from './fs-adapter'
import { fsList } from '@/lib/fs'
import type { FsListResult } from '@/lib/fs'

vi.mock('@/lib/fs', () => ({
  fsList: vi.fn(),
}))

const fsListMock = vi.mocked(fsList)

beforeEach(() => {
  fsListMock.mockReset()
})

describe('fsEntryToWorkspaceFileEntry', () => {
  it('目录/文件类型映射', () => {
    expect(
      fsEntryToWorkspaceFileEntry({ name: 'src', path: 'G:/r/src', isDirectory: true }),
    ).toEqual({ path: 'G:/r/src', name: 'src', type: 'directory' })
    expect(
      fsEntryToWorkspaceFileEntry({ name: 'a.ts', path: 'G:/r/a.ts', isDirectory: false }),
    ).toEqual({ path: 'G:/r/a.ts', name: 'a.ts', type: 'file' })
  })
  it('isSymlink 映射为 isSymbolicLink，false 不带字段', () => {
    expect(
      fsEntryToWorkspaceFileEntry({
        name: 'link',
        path: 'G:/r/link',
        isDirectory: true,
        isSymlink: true,
      }),
    ).toEqual({ path: 'G:/r/link', name: 'link', type: 'directory', isSymbolicLink: true })
    expect(
      fsEntryToWorkspaceFileEntry({ name: 'd', path: 'G:/r/d', isDirectory: true, isSymlink: false }),
    ).toEqual({ path: 'G:/r/d', name: 'd', type: 'directory' })
  })
})

describe('listWorkspaceDirectory', () => {
  it('成功返回映射后的条目', async () => {
    const result: FsListResult = {
      entries: [
        { name: 'src', path: 'G:/r/src', isDirectory: true, isSymlink: false },
        { name: 'a.ts', path: 'G:/r/a.ts', isDirectory: false },
      ],
    }
    fsListMock.mockResolvedValue(result)
    await expect(listWorkspaceDirectory('G:/r')).resolves.toEqual([
      { path: 'G:/r/src', name: 'src', type: 'directory' },
      { path: 'G:/r/a.ts', name: 'a.ts', type: 'file' },
    ])
  })

  it('fs_list 错误码显式抛成 Error（不静默吞成空目录）', async () => {
    fsListMock.mockResolvedValue({ entries: [], error: 'EACCES' })
    await expect(listWorkspaceDirectory('G:/r')).rejects.toThrow('EACCES')
  })

  it('invoke 拒绝原样传播', async () => {
    fsListMock.mockRejectedValue(new Error('ipc-down'))
    await expect(listWorkspaceDirectory('G:/r')).rejects.toThrow('ipc-down')
  })
})
