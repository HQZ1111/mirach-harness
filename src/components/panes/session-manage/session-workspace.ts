/**
 * 「选择工作区」请求桥（hermes projects store 的最小对偶）：侧栏菜单投递
 * 选中的目录，runtime（唯一能动 pi 会话 handle 的层）订阅执行
 * pi_new_session（working_directory 透传）。branch-store 同款请求-执行
 * 形态——UI 不直呼 IPC，真相在 runtime。
 *
 * 禁止兜底：目录选择取消（用户关掉对话框）不发请求；执行失败
 * console.error 并在 `error` 上报错（composer 的工作区行直接可见——
 * 「选了文件夹没反应」/「新建失败但看起来成功」都是不允许的静默降级）。
 */
import { createStore } from 'zustand'

export interface SessionWorkspaceRequest {
  readonly seq: number
  /** 用户选中的工作区目录（绝对路径）。 */
  readonly cwd: string
}

interface SessionWorkspaceState {
  request: SessionWorkspaceRequest | null
  /** 最近一次工作区新建失败的可见文案（成功/新请求即清空）。 */
  error: string | null
  requestCreate(cwd: string): void
  clearRequest(seq: number): void
  /** runtime 执行失败时写回可见错误（seq 校验防旧请求踩新请求的错误）。 */
  failRequest(seq: number, message: string): void
  clearError(): void
}

let seqCounter = 0

export const sessionWorkspaceStore = createStore<SessionWorkspaceState>((set, get) => ({
  request: null,
  error: null,
  requestCreate: (cwd) => {
    const trimmed = cwd.trim()
    if (!trimmed) {
      // 空目录不是「取消」，是调用方接线错误——必须可见（规矩 12）。
      console.error('[session-workspace] 空目录请求——忽略')
      set({ error: '没有选择文件夹路径' })
      return
    }
    set({ request: { seq: ++seqCounter, cwd: trimmed }, error: null })
  },
  clearRequest: (seq) => {
    const current = get().request
    if (current && current.seq === seq) {
      set({ request: null })
    }
  },
  failRequest: (seq, message) => {
    // 只让当前请求的错误落地：旧请求的异步失败不能覆盖用户的新选择。
    if (get().request?.seq !== seq) return
    set({ error: message })
  },
  clearError: () => set({ error: null }),
}))
