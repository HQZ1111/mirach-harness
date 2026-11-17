/**
 * 会话计划桥（活动面板「会话计划」分区数据面）：rpi-plan-mode 的
 * `plan-mode` 会话条目投影。
 *
 * - 真相 = 当前分支上的 `plan-mode` custom 条目（插件每次
 *   `plan_mode_complete` 追加一条，data `{active, plan}`，plan = 完整
 *   markdown——见 pi_plugin_state.rs 模块头证据）；Rust 侧
 *   `pi_plan_entries` 已过滤出**有 plan 文本**的条目并按 seq 降序。
 * - 本 store 只持投影（zustand vanilla，照抄 jobs-store）；严格解析：
 *   坏行 console.error 可见 + 跳过，整体非数组 → 空投影 + 错误可见
 *   （规矩 12：不静默、不造缺省值）。
 * - 刷新时机 = 面板挂载 / 切会话 / run 收尾（计划在轮之间完成）。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

export interface PlanEntryRow {
  entryId: string
  seq: number
  timestamp: number
  plan: string
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** 严格解析 pi_plan_entries 返回（裸数组）：
 * 行缺字段/类型不符 → console.error + 跳过该行；非数组 → [] + 错误可见。 */
export function parsePlanEntries(raw: unknown): PlanEntryRow[] {
  if (!Array.isArray(raw)) {
    console.error('[plan-entries] pi_plan_entries 返回非数组——目录丢弃', raw)
    return []
  }
  const out: PlanEntryRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[plan-entries] 计划行形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const entryId = asString(r.entryId)
    const seq = asNumber(r.seq)
    const timestamp = asNumber(r.timestamp)
    const plan = asString(r.plan)
    if (entryId === null || seq === null || timestamp === null || plan === null) {
      console.error('[plan-entries] 计划行字段缺失/非法——跳过', item)
      continue
    }
    if (plan.trim() === '') {
      console.error('[plan-entries] 计划行为空文本——跳过', item)
      continue
    }
    out.push({ entryId, seq, timestamp, plan })
  }
  return out
}

interface PlanEntriesBridgeState {
  /** 计划目录投影；[] = 无计划/拉取失败（分区不渲染） */
  entries: PlanEntryRow[]
  refresh: () => Promise<void>
  /** 会话更换：条目属于某条分支，切会话清投影等下次拉取 */
  resetProjection: () => void
}

export const planEntriesBridge = createStore<PlanEntriesBridgeState>((set) => ({
  entries: [],
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_plan_entries')
      set({ entries: parsePlanEntries(raw) })
    } catch (e) {
      // 真错误：console.error 可见 + 清投影（未知状态不冒充旧数据）
      console.error('[plan-entries] 计划目录拉取失败——清投影', e)
      set({ entries: [] })
    }
  },
  resetProjection: () => set({ entries: [] }),
}))

export const usePlanEntriesBridge = () => useStore(planEntriesBridge)
