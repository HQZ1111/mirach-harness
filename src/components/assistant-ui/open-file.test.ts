import { describe, expect, it } from 'vitest'
import { resolveWorkspaceFilePath } from './open-file'

describe('resolveWorkspaceFilePath（工具路径 → 代码查看器绝对路径）', () => {
  it('绝对路径原样返回（Windows 盘符 / UNC / POSIX）', () => {
    expect(resolveWorkspaceFilePath('G:\\proj\\src\\a.ts', 'C:\\other')).toBe(
      'G:\\proj\\src\\a.ts',
    )
    expect(resolveWorkspaceFilePath('G:/proj/src/a.ts', null)).toBe('G:/proj/src/a.ts')
    expect(resolveWorkspaceFilePath('/home/u/a.ts', null)).toBe('/home/u/a.ts')
    expect(resolveWorkspaceFilePath('\\\\server\\share\\a.ts', null)).toBe(
      '\\\\server\\share\\a.ts',
    )
  })

  it('相对路径按会话 cwd 拼接（分隔符归一为 /，去掉 ./）', () => {
    expect(resolveWorkspaceFilePath('src/a.ts', 'G:\\proj')).toBe('G:\\proj/src/a.ts')
    expect(resolveWorkspaceFilePath('./src/a.ts', 'G:/proj/')).toBe('G:/proj/src/a.ts')
    expect(resolveWorkspaceFilePath('src\\a.ts', 'G:/proj')).toBe('G:/proj/src/a.ts')
    // 根开头的 POSIX 路径按绝对路径处理（不是 cwd 相对）
    expect(resolveWorkspaceFilePath('/src/a.ts', 'G:/proj')).toBe('/src/a.ts')
  })

  it('空路径 / 无 cwd → null（调用方 console.error，不静默打开）', () => {
    expect(resolveWorkspaceFilePath(undefined, 'G:/proj')).toBeNull()
    expect(resolveWorkspaceFilePath('   ', 'G:/proj')).toBeNull()
    expect(resolveWorkspaceFilePath('src/a.ts', null)).toBeNull()
  })
})
