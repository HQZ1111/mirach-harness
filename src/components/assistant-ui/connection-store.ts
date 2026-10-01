/**
 * SSE 连接态桥（L1 可见性）：EventSource onopen/onerror 置位——thread.aui
 * 顶部横幅（官方 connection-state 元素，四相）消费。EventSource 原生自动
 * 重连（带 Last-Event-ID）保留不动，服务端修好后重连续放；这里只持连接
 * 的投影态，真相在 EventSource 本身。与 usage-bridge / approval-bridge
 * 同款 zustand vanilla 模式（createStore + useStore 订阅）。
 *
 * 四相派生（useConnectionPhase，EventSource 事件驱动）：
 * - connecting：connected === null（挂载后首连之前）——横幅不显示，避免
 *   启动瞬间"连接已断开"误报（既有语义）；
 * - online：onopen（attempts 清零）；
 * - reconnecting：onerror 且 readyState = CONNECTING——浏览器自动重试
 *   进行中，attempts = 失败重试次数（每次失败重试都会再发 onerror）；
 * - dropped：onerror 且 readyState = CLOSED——浏览器放弃自动重连（致命
 *   错误），唯一提供手动 Reconnect 的相（requestReconnect → runtime
 *   重开 EventSource）。
 */
import { createStore, useStore } from 'zustand'

export type ConnectionPhase = 'online' | 'reconnecting' | 'connecting' | 'dropped'

interface ConnectionBridgeState {
  connected: boolean | null
  /** 重连中 onerror 累计次数（onopen 清零） */
  reconnectAttempts: number
  /** onerror 时 readyState=CLOSED（浏览器放弃自动重连）置位 */
  dropped: boolean
  /** 手动重连请求序号：requestReconnect 递增，runtime 依赖它重开连接 */
  reconnectSeq: number
  setConnected: (connected: boolean) => void
  /** onerror 路径：fatal = readyState CLOSED（放弃重连），否则计入重试 */
  setDisconnected: (fatal: boolean) => void
  requestReconnect: () => void
}

export const connectionBridge = createStore<ConnectionBridgeState>(() => ({
  connected: null,
  reconnectAttempts: 0,
  dropped: false,
  reconnectSeq: 0,
  setConnected: (connected) =>
    connectionBridge.setState({ connected, reconnectAttempts: 0, dropped: false }),
  setDisconnected: (fatal) =>
    connectionBridge.setState((s) =>
      fatal
        ? { connected: false, dropped: true }
        : { connected: false, dropped: false, reconnectAttempts: s.reconnectAttempts + 1 },
    ),
  requestReconnect: () =>
    connectionBridge.setState((s) => ({ reconnectSeq: s.reconnectSeq + 1 })),
}))

export const useConnectionBridge = () => useStore(connectionBridge)

/** 四相派生（真相在 store 的 connected/dropped 投影） */
export const useConnectionPhase = (): ConnectionPhase =>
  useStore(connectionBridge, (s) =>
    s.connected === true
      ? 'online'
      : s.connected === null
        ? 'connecting'
        : s.dropped
          ? 'dropped'
          : 'reconnecting',
  )
