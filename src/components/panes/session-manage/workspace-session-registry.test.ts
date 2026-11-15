/* 跨工作区会话登记表：目录名编码/会话根解析/合并语义/持久化。
 * 上游编解码依据：rpi-harness/src/session/jsonl/repo.rs:106-133。 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  WORKSPACE_SESSIONS_KEY,
  joinSessionPath,
  mergeWorkspaceSessionRows,
  resolveSessionRoot,
  sessionDirectoryName,
  workspaceSessionIndex,
  type WorkspaceSessionRecord,
} from './workspace-session-registry'

const record = (
  id: string,
  overrides: Partial<WorkspaceSessionRecord> = {},
): WorkspaceSessionRecord => ({
  id,
  cwd: 'C:\\work\\demo',
  messageCount: 0,
  createdAtMs: 1000,
  lastModifiedMs: 1000,
  ...overrides,
})

describe('sessionDirectoryName（逐字对齐上游 repo.rs:106-126）', () => {
  it('Windows 盘符 + 反斜杠', () => {
    expect(sessionDirectoryName('C:\\dev')).toBe('--C--dev--')
    expect(sessionDirectoryName('C:\\Users\\Administrator')).toBe(
      '--C--Users-Administrator--',
    )
  })

  it('POSIX 前导斜杠被剥掉一个，其余 / 与 : 换 -', () => {
    expect(sessionDirectoryName('/home/user')).toBe('--home-user--')
  })

  it('末尾分隔符不影响目录名', () => {
    expect(sessionDirectoryName('/home/user/proj/')).toBe('--home-user-proj--')
  })
})

describe('joinSessionPath', () => {
  it('Windows 基路径用反斜杠', () => {
    expect(joinSessionPath('C:\\work\\demo', '.rpi', 'sessions')).toBe(
      'C:\\work\\demo\\.rpi\\sessions',
    )
    expect(joinSessionPath('C:\\work\\demo\\', '.rpi')).toBe('C:\\work\\demo\\.rpi')
  })

  it('POSIX 基路径用斜杠', () => {
    expect(joinSessionPath('/home/user', '.rpi', 'sessions')).toBe(
      '/home/user/.rpi/sessions',
    )
  })
})

describe('resolveSessionRoot（对齐 pi_session.rs:302-321）', () => {
  it('无 sessionDir → <cwd>/.rpi/sessions', () => {
    expect(resolveSessionRoot('C:\\work\\demo', null)).toBe(
      'C:\\work\\demo\\.rpi\\sessions',
    )
    expect(resolveSessionRoot('/home/user', {})).toBe('/home/user/.rpi/sessions')
  })

  it('绝对 sessionDir 原样使用', () => {
    expect(resolveSessionRoot('C:\\work\\demo', { sessionDir: 'D:\\sessions' })).toBe(
      'D:\\sessions',
    )
    expect(resolveSessionRoot('/home/user', { session_dir: '/var/sessions' })).toBe(
      '/var/sessions',
    )
  })

  it('相对 sessionDir 相对 cwd 解析', () => {
    expect(resolveSessionRoot('C:\\work\\demo', { sessionDir: '.data' })).toBe(
      'C:\\work\\demo\\.data',
    )
  })
})

describe('mergeWorkspaceSessionRows', () => {
  it('pi 列表已有的 id 以 pi 为准（不重复、不覆盖）', () => {
    const rows = [{ id: 'a', custom: { cwd: 'C:\\a', messageCount: 3 } }]
    const merged = mergeWorkspaceSessionRows(rows, [
      record('a', { cwd: 'C:\\other', title: 'stale' }),
      record('b', { cwd: 'C:\\b', path: 'C:\\b\\s\\b.jsonl', title: '项目 B' }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(rows[0])
    const added = merged[1] as {
      id: string
      title?: string
      custom: Record<string, unknown>
    }
    expect(added.id).toBe('b')
    expect(added.title).toBe('项目 B')
    expect(added.custom).toMatchObject({
      path: 'C:\\b\\s\\b.jsonl',
      cwd: 'C:\\b',
      messageCount: 0,
      lastModifiedMs: 1000,
      timestamp: 1000,
    })
  })

  it('路径缺失的登记行仍保留（不编造 path）', () => {
    const merged = mergeWorkspaceSessionRows([], [record('c')])
    const added = merged[0] as { custom: Record<string, unknown> }
    expect(added.custom.path).toBeUndefined()
  })
})

describe('workspaceSessionIndex 持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    workspaceSessionIndex.setState({ entries: {} })
  })

  it('register / patch / setTitle / updateStats / remove 同步 localStorage', () => {
    workspaceSessionIndex.getState().register(record('x', { path: 'p' }))
    expect(workspaceSessionIndex.getState().entries.x).toMatchObject({
      id: 'x',
      cwd: 'C:\\work\\demo',
      path: 'p',
    })
    expect(JSON.parse(localStorage.getItem(WORKSPACE_SESSIONS_KEY) ?? '[]')).toHaveLength(1)

    workspaceSessionIndex.getState().patch('x', { messageCount: 2 })
    expect(workspaceSessionIndex.getState().entries.x?.messageCount).toBe(2)

    workspaceSessionIndex.getState().setTitle('x', ' 派生标题 ')
    expect(workspaceSessionIndex.getState().entries.x?.title).toBe('派生标题')

    workspaceSessionIndex.getState().updateStats('x', 4, 2000)
    expect(workspaceSessionIndex.getState().entries.x).toMatchObject({
      messageCount: 4,
      lastModifiedMs: 2000,
    })

    workspaceSessionIndex.getState().remove('x')
    expect(workspaceSessionIndex.getState().entries.x).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(WORKSPACE_SESSIONS_KEY) ?? '[]')).toEqual([])
  })

  it('patch/setTitle/updateStats 对未登记 id 是无操作（不凭空建档）', () => {
    workspaceSessionIndex.getState().patch('missing', { title: 'x' })
    workspaceSessionIndex.getState().setTitle('missing', 'x')
    workspaceSessionIndex.getState().updateStats('missing', 1, 1)
    expect(workspaceSessionIndex.getState().entries).toEqual({})
  })
})
