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

export const approvalBridge = createStore<ApprovalBridgeState>(() => ({
  pending: [],
  refresh: async () => {
    const list = await invoke<PendingUiRequest[]>('pi_pending_approvals')
    approvalBridge.setState({ pending: list ?? [] })
  },
}))

export const useApprovalBridge = () => useStore(approvalBridge)
