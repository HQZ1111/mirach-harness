/* 工作区请求桥：请求/失败/清理的可见性与序号守卫。 */
import { beforeEach, describe, expect, it } from 'vitest'

import { sessionWorkspaceStore } from './session-workspace'

describe('sessionWorkspaceStore', () => {
  beforeEach(() => {
    sessionWorkspaceStore.setState({ request: null, error: null })
  })

  it('requestCreate 发请求并清掉旧错误', () => {
    sessionWorkspaceStore.setState({ error: 'old' })
    sessionWorkspaceStore.getState().requestCreate('  C:\\work  ')
    expect(sessionWorkspaceStore.getState().request).toMatchObject({ cwd: 'C:\\work' })
    expect(sessionWorkspaceStore.getState().error).toBeNull()
  })

  it('空目录是接线错误——不产生请求，错误可见', () => {
    sessionWorkspaceStore.getState().requestCreate('   ')
    expect(sessionWorkspaceStore.getState().request).toBeNull()
    expect(sessionWorkspaceStore.getState().error).toBe('没有选择文件夹路径')
  })

  it('failRequest 只接受当前请求序号（旧失败不踩新选择）', () => {
    sessionWorkspaceStore.getState().requestCreate('C:\\a')
    const seq = sessionWorkspaceStore.getState().request!.seq
    sessionWorkspaceStore.getState().requestCreate('C:\\b')
    sessionWorkspaceStore.getState().failRequest(seq, '旧请求失败')
    expect(sessionWorkspaceStore.getState().error).toBeNull()

    const current = sessionWorkspaceStore.getState().request!.seq
    sessionWorkspaceStore.getState().failRequest(current, '目录不存在')
    expect(sessionWorkspaceStore.getState().error).toBe('目录不存在')
  })

  it('clearRequest 只清匹配序号；clearError 单独清错误', () => {
    sessionWorkspaceStore.getState().requestCreate('C:\\a')
    const seq = sessionWorkspaceStore.getState().request!.seq
    sessionWorkspaceStore.getState().clearRequest(seq - 1)
    expect(sessionWorkspaceStore.getState().request?.seq).toBe(seq)
    sessionWorkspaceStore.getState().clearRequest(seq)
    expect(sessionWorkspaceStore.getState().request).toBeNull()

    sessionWorkspaceStore.setState({ error: 'x' })
    sessionWorkspaceStore.getState().clearError()
    expect(sessionWorkspaceStore.getState().error).toBeNull()
  })
})
