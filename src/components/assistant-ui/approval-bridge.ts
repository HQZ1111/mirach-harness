/**
 * 审批/问题卡桥（docs/pi-integration.md §4.4）：
 * SSE 上的 CUSTOM extension_ui_request 只是"有新请求"的信号——卡片详情
 * 以 Rust 端 ApprovalRegistry 为唯一真相（挂载/收到信号/应答后经 IPC
 * 拉取全量挂起列表），断线重放流不会造成卡片重复。
 * 机器铁律不破：SSE 事件照常全部喂 XState actor（轮次态）；这里的拉取
 * 是宿主 UI 桥对信号的反应，不是第二条事件订阅。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

export interface PendingUiRequest {
  id: string
  method: string
  payload: unknown
  extensionId: string | null
}

interface ApprovalBridgeState {
  pending: PendingUiRequest[]
  refresh: () => Promise<void>
}

/** 结构相等判定（id/method/extensionId/payload 逐项）。
 *
 * **为什么需要**（2026-11-19 性能轮实测）：挂起列表每秒轮询一次
 * （approval-cards），IPC 每次都返回**新数组**——无条件 setState 会让全部
 * 订阅者（含侧栏 useThreadDisplay → 整棵会话树）每秒重渲染一次。空转
 * profile 里这是每秒 ~100ms 主线程尖峰的唯一来源。真变化才落 state。 */
function samePending(a: PendingUiRequest[], b: PendingUiRequest[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.method !== y.method || x.extensionId !== y.extensionId) {
      return false
    }
    if (JSON.stringify(x.payload) !== JSON.stringify(y.payload)) return false
  }
  return true
}

export const approvalBridge = createStore<ApprovalBridgeState>(() => ({
  pending: [],
  refresh: async () => {
    const list = await invoke<PendingUiRequest[]>('pi_pending_approvals')
    const next = list ?? []
    if (samePending(approvalBridge.getState().pending, next)) return
    approvalBridge.setState({ pending: next })
  },
}))

export const useApprovalBridge = () => useStore(approvalBridge)
