/**
 * SSE 连接态桥（L1 可见性）：EventSource onopen/onerror 置位——断开时
 * thread.aui 顶部渲染细横幅。EventSource 原生自动重连（带 Last-Event-ID）
 * 保留不动，服务端修好后重连续放；这里只持连接的投影态，真相在
 * EventSource 本身。与 usage-bridge / approval-bridge 同款 zustand
 * vanilla 模式（createStore + useStore 订阅）。
 * connected: null = 未判定（挂载后首连之前）——不算断开，横幅不显示，
 * 避免启动瞬间"连接已断开"的误报。
 */
import { createStore, useStore } from 'zustand'

interface ConnectionBridgeState {
  connected: boolean | null
  setConnected: (connected: boolean) => void
}

export const connectionBridge = createStore<ConnectionBridgeState>(() => ({
  connected: null,
  setConnected: (connected) => connectionBridge.setState({ connected }),
}))

export const useConnectionBridge = () => useStore(connectionBridge)
