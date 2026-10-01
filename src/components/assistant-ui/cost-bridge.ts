/**
 * 成本账本（官方 cost-meter 元素的数据面）：runtime 在 run 收尾时经
 * pi_get_state 取活动会话 id / 当前模型，把 RUN_FINISHED.usage 的 costUsd
 * 入账（per-session 累计）。口径：**会话累计 = 本进程内该会话所有 run 的
 * costUsd 之和**——打开历史会话不回算 pi 落盘的历史成本（历史消息的
 * usage 不在水合面里，重算是编造）；会话切换后显示新会话的进程内累计
 * （无记录 = 0）。
 *
 * pi 未报 costUsd 的 run：runCost/lines 的 cost 显示 "—" 且不累计
 * （不估算、不假装——token 明细照实展示）。
 * zustand vanilla 模式，照抄 usage-bridge / connection-store。
 */
import { createStore, useStore } from 'zustand'

/** 最近一次收尾 run 的成本明细（cost-meter 的 runCost/lines 数据源） */
export interface CostRun {
  model: string
  /** null = pi 未报成本（显示 "—"，不累计） */
  costUsd: number | null
  inputTokens?: number
  outputTokens?: number
}

/** 美元格式化：小值 4 位小数（$0.0123）、≥1 美元 2 位（$1.50）；
 * 非有限值 → "—"（不编造数字） */
export const formatUsd = (costUsd: number): string => {
  if (!Number.isFinite(costUsd)) return '—'
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`
}

/** 会话累计入账（纯函数，可单测）：sessionId 为 null（无活动会话——域
 * 异常）或 costUsd 非有限 → 原样返回；否则返回新增累计的新 map（不改入参） */
export const accumulateSessionCost = (
  map: Record<string, number>,
  sessionId: string | null,
  costUsd: number,
): Record<string, number> => {
  if (sessionId === null || !Number.isFinite(costUsd)) return map
  return { ...map, [sessionId]: (map[sessionId] ?? 0) + costUsd }
}

export interface RecordRunInput {
  sessionId: string | null
  model: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

interface CostBridgeState {
  /** 每会话进程内累计成本（sessionId → USD） */
  costBySession: Record<string, number>
  /** 当前活动会话（最近一次 recordRun/resetSession 写入；UI 据此取显示值） */
  activeSessionId: string | null
  lastRun: CostRun | null
  recordRun: (input: RecordRunInput) => void
  /** 会话切换：活动会话指向新 id 并清 lastRun（上一会话的 run 明细对
   * 新会话不适用；累计按 map 键隔离，不清） */
  resetSession: (sessionId: string | null) => void
}

export const costBridge = createStore<CostBridgeState>((set) => ({
  costBySession: {},
  activeSessionId: null,
  lastRun: null,
  recordRun: ({ sessionId, model, costUsd, inputTokens, outputTokens }) => {
    if (sessionId === null) {
      // run 收尾时无活动会话是域异常（消息发成功了）——错误可见，不入账
      console.error('[cost] run 收尾时无活动会话——成本不入账')
      return
    }
    const cost =
      typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : null
    set((s) => ({
      costBySession:
        cost !== null
          ? accumulateSessionCost(s.costBySession, sessionId, cost)
          : s.costBySession,
      activeSessionId: sessionId,
      lastRun: {
        model,
        costUsd: cost,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    }))
  },
  resetSession: (sessionId) =>
    set({ activeSessionId: sessionId, lastRun: null }),
}))

export const useCostBridge = () => useStore(costBridge)
