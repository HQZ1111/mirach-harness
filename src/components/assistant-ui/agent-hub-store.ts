/**
 * 子代理名册桥（活动面板 Agent 分区数据面）：pi `agent_hub` 进程级
 * registry 的投影。
 *
 * - 投影：refresh() 拉 `pi_hub_roster`（Rust 侧 `agent_hub::registry()
 *   .roster()` → `ChildEntry[]`）→ children。消费方 = ConversationStatus
 *   Panel 的 Agent 分区（运行中/已结束两段）。
 * - 双通道：①拉取面（本 store，挂载 / 收到 tool_execution 事件 / 操作后
 *   调用——registry 与会话解耦，模型没调 hub 工具时也要能看到已注册的子
 *   代理）；②事件面（`CUSTOM tool_execution` 的 details.schema =
 *   `pi.agent-hub.roster/v1` 经 turn-actor 归约——模型主动调 hub 工具的
 *   即时结果）。两侧同一真相（registry），拉取面为主。
 * - 真相在 pi（进程级 registry）；store 只持投影。
 *   zustand vanilla 模式，照抄 checkpoint-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi `agent_hub::ChildEntry`（serde camelCase 逐字段实锤）：
 * - id: `<agent>-<seq>`（registry 内单调）
 * - kind: "subagent" | "tan"
 * - status: "starting" | "running" | "done" | "failed" | "cancelled" | "killed"
 * - startedMs/finishedMs: epoch ms（finishedMs 仅终态有）
 * - outputBytes: 输出字节数（上游管道不带 token 数，这是诚实代理值）
 * - transcriptPath/steerPath: 磁盘产物路径
 * - revivedFrom: 续接的 run id（可空）
 */
export type ChildKind = 'subagent' | 'tan'
export type ChildStatus =
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'killed'

export interface ChildEntry {
  id: string
  name: string
  kind: ChildKind
  task: string
  pid: number | null
  status: ChildStatus
  startedMs: number
  finishedMs: number | null
  outputBytes: number
  transcriptPath: string
  steerPath: string
  revivedFrom: string | null
}

const CHILD_KINDS = new Set<ChildKind>(['subagent', 'tan'])
const CHILD_STATUSES = new Set<ChildStatus>([
  'starting',
  'running',
  'done',
  'failed',
  'cancelled',
  'killed',
])

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asNumberOrNull = (v: unknown): number | null =>
  v === null ? null : asNumber(v)
const asStringOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : asString(v)

/** 严格解析 pi_hub_roster 返回（裸数组 ChildEntry[]）：单行字段缺失/非法
 * → console.error + 跳过该行（不渲染坏行）；整体非数组 → console.error + []。
 * 不造缺省值、不隐瞒——错误可见（兜底禁令）。 */
export function parseChildEntries(raw: unknown): ChildEntry[] {
  if (!Array.isArray(raw)) {
    console.error('[hub] pi_hub_roster 返回非数组——名册丢弃', raw)
    return []
  }
  const out: ChildEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[hub] 子代理行形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const id = asString(r.id)
    const name = asString(r.name)
    const kind = asString(r.kind)
    const task = asString(r.task)
    const status = asString(r.status)
    const startedMs = asNumber(r.startedMs)
    const outputBytes = asNumber(r.outputBytes)
    const transcriptPath = asString(r.transcriptPath)
    const steerPath = asString(r.steerPath)
    if (
      id === null ||
      name === null ||
      kind === null ||
      task === null ||
      status === null ||
      startedMs === null ||
      outputBytes === null ||
      transcriptPath === null ||
      steerPath === null
    ) {
      console.error('[hub] 子代理行字段缺失/非法——跳过', item)
      continue
    }
    if (!CHILD_KINDS.has(kind as ChildKind)) {
      console.error(`[hub] 未知 kind（${kind}）——跳过`, item)
      continue
    }
    if (!CHILD_STATUSES.has(status as ChildStatus)) {
      console.error(`[hub] 未知 status（${status}）——跳过`, item)
      continue
    }
    const pid = asNumberOrNull(r.pid)
    const finishedMs = asNumberOrNull(r.finishedMs)
    const revivedFrom = asStringOrNull(r.revivedFrom)
    out.push({
      id,
      name,
      kind: kind as ChildKind,
      task,
      pid,
      status: status as ChildStatus,
      startedMs,
      finishedMs,
      outputBytes,
      transcriptPath,
      steerPath,
      revivedFrom,
    })
  }
  return out
}

/** 终态判定（与 pi `ChildStatus::settled()` 同语义）：非终态 = 运行中。
 * 分区用：running 段 = !settled，ended 段 = settled。 */
export const isSettled = (status: ChildStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled' || status === 'killed'

interface AgentHubBridgeState {
  /** 名册投影；[] = 无子代理/拉取失败（分区显示空态） */
  children: ChildEntry[]
  refresh: () => Promise<void>
  /** 收到 tool_execution 事件时的轻量提交（事件面即时结果；真相仍是 registry，
   * 下次 refresh 覆盖）。非法形状 console.error 后保留旧投影（不清成空）。 */
  applyRoster: (raw: unknown) => void
  /** 会话更换：registry 是进程级、跨会话残留——切会话时清投影等下次拉取 */
  resetProjection: () => void
}

export const agentHubBridge = createStore<AgentHubBridgeState>((set) => ({
  children: [],
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_hub_roster')
      set({ children: parseChildEntries(raw) })
    } catch (e) {
      // 真错误：console.error 可见 + 清投影（未知状态不冒充旧数据）
      console.error('[hub] 子代理名册拉取失败——清投影', e)
      set({ children: [] })
    }
  },
  applyRoster: (raw) => {
    if (!Array.isArray(raw)) {
      console.error('[hub] 事件面名册非数组——保留旧投影', raw)
      return
    }
    set({ children: parseChildEntries(raw) })
  },
  resetProjection: () => set({ children: [] }),
}))

export const useAgentHubBridge = () => useStore(agentHubBridge)
