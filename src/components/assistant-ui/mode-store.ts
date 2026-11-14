/**
 * 模式切换的数据面（2026-11-01 用户："输入框的加号右边加个zcode的切换模式
 * 按钮，计划模式，文件内修改，完全访问"）。
 *
 * 三态全部映射 pi 原生能力（Rust 侧 pi_session.rs「模式切换」段）：
 * - 计划模式 = pi plan gate（Planning 态拒绝变更/进程类工具，模型经
 *   submit_plan 提交、宿主批准/驳回——Rust `pi_set_plan_mode` /
 *   `pi_decide_plan`）；
 * - 文件内修改 = ApprovalMode::Write（写文件自动批、其余照问）；
 * - 完全访问 = ApprovalMode::Yolo（全部自动批，硬策略闸除外）；
 * - 默认（变更前确认）= AlwaysAsk。
 *
 * ZCode 的同位组件 = V4ComposerModeSwitch（菜单 = 计划独立勾选 + 权限
 * 单选组）。审批卡经 pi 的 approval_handler_via_ask 自动桥到 ask 面 =
 * 宿主现有 AskCards，无需新通道。
 *
 * 错误即错误：IPC 失败写 `error`（菜单/卡片内可见）+ console.error，
 * 不静默假装切换成功（兜底禁令）。
 */
import { createStore } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type ApprovalMode = 'always-ask' | 'write' | 'yolo'
export type PlanModeState = 'off' | 'planning' | 'pending_approval' | 'approved'

export interface ModeState {
  approvalMode: ApprovalMode
  planMode: PlanModeState
  /** 待审计划文本（非空 = 显示批准/驳回卡）。 */
  planPending: string | null
  /** 最近一次 IPC 失败（切换钮/计划卡内可见；非空时也算"没有生效"）。 */
  error: string | null
  loaded: boolean
}

interface ModeStoreState extends ModeState {
  refresh(): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  setPlanMode(enabled: boolean): Promise<void>
  decidePlan(approve: boolean): Promise<void>
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

export const modeStore = createStore<ModeStoreState>((set, get) => ({
  approvalMode: 'always-ask',
  planMode: 'off',
  planPending: null,
  error: null,
  loaded: false,

  refresh: async () => {
    try {
      const raw = await invoke<Record<string, unknown>>('pi_mode_state')
      const approvalMode = asString(raw.approvalMode)
      const planMode = asString(raw.planMode)
      set({
        approvalMode:
          approvalMode === 'write' || approvalMode === 'yolo'
            ? approvalMode
            : 'always-ask',
        planMode:
          planMode === 'planning' || planMode === 'pending_approval' || planMode === 'approved'
            ? planMode
            : 'off',
        planPending: asString(raw.planPending),
        error: null,
        loaded: true,
      })
    } catch (e) {
      // 无会话等域状态也是失败（Rust 侧 mode_state 无会话时返回默认值，
      // 不会到这里）——错误可见，保留旧投影
      console.error('[mode] 模式状态拉取失败', e)
      set({ error: String(e), loaded: true })
    }
  },

  setApprovalMode: async (mode) => {
    try {
      await invoke('pi_set_approval_mode', { mode })
      await get().refresh()
    } catch (e) {
      console.error(`[mode] 切换审批模式 ${mode} 失败（保持原模式）`, e)
      set({ error: `切换失败：${String(e)}` })
    }
  },

  setPlanMode: async (enabled) => {
    try {
      await invoke('pi_set_plan_mode', { enabled })
      await get().refresh()
    } catch (e) {
      console.error(`[mode] ${enabled ? '进入' : '退出'}计划模式失败（保持原态）`, e)
      set({ error: `${enabled ? '进入' : '退出'}计划模式失败：${String(e)}` })
    }
  },

  decidePlan: async (approve) => {
    try {
      await invoke('pi_decide_plan', { approve })
      await get().refresh()
    } catch (e) {
      console.error(`[mode] ${approve ? '批准' : '驳回'}计划失败`, e)
      set({ error: `${approve ? '批准' : '驳回'}计划失败：${String(e)}` })
    }
  },
}))
