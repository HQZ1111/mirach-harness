/**
 * 轮次错误桥：RUN_ERROR 的用户可见面——runtime.tsx 从轮次机 useSelector
 * 读 context.error 经此传给 thread.aui 的错误条（机器在下一个 run 的
 * RUN_STARTED 归约里清 error，横幅随之消失）。与 usage-bridge 同款
 * zustand vanilla 模式（桥不持真相，真相在轮次机 context）。
 */
import { createStore, useStore } from 'zustand'

interface ErrorBridgeState {
  error: string | null
  setError: (error: string | null) => void
}

export const errorBridge = createStore<ErrorBridgeState>(() => ({
  error: null,
  setError: (error) => errorBridge.setState({ error }),
}))

export const useErrorBridge = () => useStore(errorBridge)
