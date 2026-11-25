/**
 * 启动状态桥（hermes `store/boot.ts` 的宿主对偶，2026-11-25）。
 *
 * 宿主没有 Electron 主进程的 bootstrap 事件流；"启动" = 引擎 AG-UI 端点
 * 可发现 + 事件流（SSE）首连成功。runtime.tsx 是唯一的写入口：
 *   · 端点发现（含自动重试）失败 → `setFailed(错误)`
 *   · SSE onopen → `setReady()`
 *   · 用户点启动页「重试」→ `requestRetry()`（reconnectSeq 触发 runtime
 *     重跑整条发现/水合链）
 *
 * LaunchOverlay 只读此 store；真相仍在 runtime 的 IPC 与 EventSource。
 */
import { createStore } from 'zustand'

export type BootPhase = 'booting' | 'ready' | 'failed'

interface BootBridgeState {
  phase: BootPhase
  /** failed 时的用户可读错误（IPC 原文，不加工）。 */
  error: string | null
  /** 重试请求序号：runtime 依赖它重跑端点发现/水合。 */
  retrySeq: number
  setBooting: () => void
  setReady: () => void
  setFailed: (error: string) => void
  requestRetry: () => void
}

export const bootBridge = createStore<BootBridgeState>((set) => ({
  phase: 'booting',
  error: null,
  retrySeq: 0,
  setBooting: () => set({ phase: 'booting', error: null }),
  setReady: () => set((s) => (s.phase === 'ready' ? s : { phase: 'ready', error: null })),
  setFailed: (error) => set((s) => (s.phase === 'failed' && s.error === error ? s : { phase: 'failed', error })),
  requestRetry: () =>
    set((s) => ({ phase: 'booting', error: null, retrySeq: s.retrySeq + 1 })),
}))
