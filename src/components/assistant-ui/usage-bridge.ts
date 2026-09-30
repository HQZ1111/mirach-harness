/**
 * 用量桥：ContextDisplay 数据面——轮次机归约出的 usage 快照
 * （RUN_FINISHED.usage）经此传给 ComposerWired 的用量环。
 * 与 approval-bridge 同款 zustand vanilla 模式（桥不持真相，
 * 真相在轮次机 context）。
 */
import { createStore, useStore } from 'zustand'

export interface UsageState {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
}

interface UsageBridgeState {
  usage: UsageState | null
  setUsage: (usage: UsageState | null) => void
}

export const usageBridge = createStore<UsageBridgeState>(() => ({
  usage: null,
  setUsage: (usage) => usageBridge.setState({ usage }),
}))

export const useUsageBridge = () => useStore(usageBridge)
