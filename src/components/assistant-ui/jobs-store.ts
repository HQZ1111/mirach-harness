/**
 * 后台任务桥（活动面板 Terminal 分区数据面）：rpi-background-tasks 插件
 * 的 `background-tasks` 会话快照投影。
 *
 * - 真相 = `~/.rpi/agent/extensions/rpi_background_tasks.dll` 注册的
 *   `background` / `jobs` 工具：每次作业状态变化都 AppendEntry 一条自包含
 *   快照（`data.jobs` 全表，只含本会话行）——宿主读最新一条（`pi_job_list`）。
 * - 字段（插件 `Job::snapshot` 逐字）：id / kind / label / command / status /
 *   pid? / exitCode? / startedAt(ms) / finishedAt?。宿主只投影真字段：缺失
 *   的可选项留 null，不补 0；`status` ∈ running/completed/failed/
 *   interrupted/cancelled，其余视为坏行（console.error 可见 + 跳过，规矩 12）。
 * - 插件未安装 = 没有条目 = 空列表（诚实空态，分区不渲染）。
 * - 双通道：①拉取面（本 store）；②事件面（`CUSTOM tool_execution`
 *   details.schema = `pi.bash_job.v1` 经 turn-actor 归约）。真相在引擎。
 * zustand vanilla 模式，照抄 checkpoint-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** rpi-background-tasks 的作业状态词表（插件 `STATUS_*` 逐字）。 */
export type JobStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

const JOB_STATUSES = new Set<JobStatus>([
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
])

export interface JobSnapshot {
  schema: string
  id: string
  kind: string | null
  label: string | null
  command: string | null
  status: JobStatus
  startedAtMs: number
  finishedAtMs: number | null
  exitCode: number | null
  pid: number | null
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asNumberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : asNumber(v)
const asStringOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : asString(v)

/** 严格解析 pi_job_list 返回（裸数组）：`startedAtMs` 是插件必填字段，
 * 缺失/非法 = 坏行 → console.error + 跳过；非数组 → console.error + []。 */
export function parseJobs(raw: unknown): JobSnapshot[] {
  if (!Array.isArray(raw)) {
    console.error('[jobs] pi_job_list 返回非数组——清单丢弃', raw)
    return []
  }
  const out: JobSnapshot[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[jobs] 任务行形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const schema = asString(r.schema)
    const id = asString(r.id)
    const status = asString(r.status)
    const startedAtMs = asNumber(r.startedAtMs)
    if (
      schema === null ||
      id === null ||
      id === '' ||
      status === null ||
      startedAtMs === null
    ) {
      console.error('[jobs] 任务行字段缺失/非法——跳过', item)
      continue
    }
    if (!JOB_STATUSES.has(status as JobStatus)) {
      console.error(`[jobs] 未知 status（${status}）——跳过`, item)
      continue
    }
    out.push({
      schema,
      id,
      kind: asStringOrNull(r.kind),
      label: asStringOrNull(r.label),
      command: asStringOrNull(r.command),
      status: status as JobStatus,
      startedAtMs,
      finishedAtMs: asNumberOrNull(r.finishedAtMs),
      exitCode: asNumberOrNull(r.exitCode),
      pid: asNumberOrNull(r.pid),
    })
  }
  return out
}

interface JobsBridgeState {
  /** 任务投影；[] = 无任务/插件未安装（分区显示空态） */
  jobs: JobSnapshot[]
  refresh: () => Promise<void>
  /** 事件面即时提交（details.schema = pi.bash_job.v1 的单条快照 upsert） */
  applyJob: (raw: unknown) => void
  resetProjection: () => void
}

export const jobsBridge = createStore<JobsBridgeState>((set) => ({
  jobs: [],
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_job_list')
      set({ jobs: parseJobs(raw) })
    } catch (e) {
      console.error('[jobs] 后台任务清单拉取失败——清投影', e)
      set({ jobs: [] })
    }
  },
  applyJob: (raw) => {
    const parsed = parseJobs(Array.isArray(raw) ? raw : [raw])
    if (parsed.length === 0) return
    set((s) => {
      const byId = new Map(s.jobs.map((j) => [j.id, j]))
      for (const j of parsed) byId.set(j.id, j)
      return { jobs: [...byId.values()] }
    })
  },
  resetProjection: () => set({ jobs: [] }),
}))

export const useJobsBridge = () => useStore(jobsBridge)