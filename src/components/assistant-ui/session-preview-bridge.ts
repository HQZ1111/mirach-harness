/**
 * 会话预览请求桥（peek-first 的通用入口）。
 *
 * 场景：runtime 之外的模块（bots-pane 的机器人行）要打开一个**已存在**
 * 的会话——它们直接调 `pi_open_session`（引擎整树 replay，巨会话数秒）。
 * 这里投递一个预览请求，runtime 侧执行「不打开引擎的尾读预览」立即把
 * 会话画出来；真正的打开与对齐仍由原调用方/reconnect 流程完成。
 *
 * 守卫在 runtime 执行器里：身份不符（文件被换）、用户已切走、引擎已完成
 * 水合（store 已是该会话）都不覆盖。
 */
import { createStore } from 'zustand'

export interface SessionPreviewRequest {
  seq: number
  path: string
  /** 期望的会话 id（双锚；peek 的 header id 不符则不预览） */
  sessionId: string
}

interface SessionPreviewState {
  request: SessionPreviewRequest | null
  requestPreview: (path: string, sessionId: string) => void
  clear: (seq: number) => void
}

let previewSeq = 0

export const sessionPreviewBridge = createStore<SessionPreviewState>((set) => ({
  request: null,
  requestPreview: (path, sessionId) =>
    set({ request: { seq: ++previewSeq, path, sessionId } }),
  clear: (seq) =>
    set((state) => (state.request?.seq === seq ? { request: null } : state)),
}))