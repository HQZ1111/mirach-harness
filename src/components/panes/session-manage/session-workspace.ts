/**
 * 「选择工作区」请求桥（hermes projects store 的最小对偶）：侧栏菜单投递
 * 选中的目录，runtime（唯一能动 pi 会话 handle 的层）订阅执行
 * pi_new_session（working_directory 透传）。branch-store 同款请求-执行
 * 形态——UI 不直呼 IPC，真相在 runtime。
 *
 * 禁止兜底：目录选择取消（用户关掉对话框）不发请求；执行失败
 * console.error 并丢弃请求（不排队重试——用户重选即可）。
 */
import { createStore } from 'zustand'

export interface SessionWorkspaceRequest {
  readonly seq: number
  /** 用户选中的工作区目录（绝对路径）。 */
  readonly cwd: string
}

interface SessionWorkspaceState {
  request: SessionWorkspaceRequest | null
  requestCreate(cwd: string): void
  clearRequest(seq: number): void
}

let seqCounter = 0

export const sessionWorkspaceStore = createStore<SessionWorkspaceState>((set, get) => ({
  request: null,
  requestCreate: (cwd) => {
    const trimmed = cwd.trim()
    if (!trimmed) {
      console.error('[session-workspace] 空目录请求——忽略')
      return
    }
    set({ request: { seq: ++seqCounter, cwd: trimmed } })
  },
  clearRequest: (seq) => {
    const current = get().request
    if (current && current.seq === seq) {
      set({ request: null })
    }
  },
}))
