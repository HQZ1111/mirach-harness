/**
 * 子代理名册桥（活动面板「智能体」分区真值）：引擎 host 的 `ChildAgents`
 * registry（delegate_task 的 in-memory 子会话）经 `pi_child_agents` 投影。
 *
 * - 每行 = {childId, status(running|done|failed), turns, startedMs,
 *   finishedMs, role, taskPreview, error}；`pi_child_agent_stop` 按 id 真取消。
 * - 与 `status-agent-rows.ts` 的工具调用派生互补：名册是引擎真值（运行态），
 *   派生面覆盖已结束目录（含报告 payload）。名册拉取失败 → console.error 可见
 *   + 空投影（分区回退派生行，不伪造名册）。
 * - 插件/扩展桥缺失 = `pi_child_agents` Err → 错误可见（不静默）。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

export type ChildAgentStatus = 'running' | 'done' | 'failed'

const CHILD_STATUSES = new Set<ChildAgentStatus>(['running', 'done', 'failed'])

export interface ChildAgentRow {
  childId: string
  status: ChildAgentStatus
  turns: number
  startedMs: number
  finishedMs: number | null
  role: string
  taskPreview: string
  error: string | null
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asNumberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : asNumber(v)

/** 严格解析 pi_child_agents 返回（裸数组）。坏行 console.error + 跳过。 */
export function parseChildAgents(raw: unknown): ChildAgentRow[] {
  if (!Array.isArray(raw)) {
    console.error('[child-agents] pi_child_agents 返回非数组——名册丢弃', raw)
    return []
  }
  const out: ChildAgentRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[child-agents] 名册行形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const childId = asString(r.childId)
    const status = asString(r.status)
    const createdAt = asNumber(r.startedMs)
    if (childId === null || childId === '' || status === null || createdAt === null) {
      console.error('[child-agents] 名册行字段缺失/非法——跳过', item)
      continue
    }
    if (!CHILD_STATUSES.has(status as ChildAgentStatus)) {
      console.error(`[child-agents] 未知 status（${status}）——跳过`, item)
      continue
    }
    out.push({
      childId,
      status: status as ChildAgentStatus,
      turns: asNumberOrNull(r.turns) ?? 0,
      startedMs: createdAt,
      finishedMs: asNumberOrNull(r.finishedMs),
      role: asString(r.role) ?? '子代理',
      taskPreview: asString(r.taskPreview) ?? '',
      error: asString(r.error),
    })
  }
  return out
}

interface ChildAgentsBridgeState {
  agents: ChildAgentRow[]
  refresh: () => Promise<void>
  resetProjection: () => void
}

export const childAgentsBridge = createStore<ChildAgentsBridgeState>((set) => ({
  agents: [],
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_child_agents')
      set({ agents: parseChildAgents(raw) })
    } catch (e) {
      console.error('[child-agents] 子代理名册拉取失败——清投影', e)
      set({ agents: [] })
    }
  },
  resetProjection: () => set({ agents: [] }),
}))

export const useChildAgentsBridge = () => useStore(childAgentsBridge)
