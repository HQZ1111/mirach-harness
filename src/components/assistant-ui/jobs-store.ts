/**
 * 后台任务桥（活动面板 Terminal 分区数据面）：pi `jobs` 进程级 registry 的
 * 投影（按 owner session 过滤）。
 *
 * - 投影：refresh() 拉 `pi_job_list`（Rust 侧 `jobs::list(ownerSessionId)`
 *   → `JobSnapshot[]`）→ jobs。消费方 = ConversationStatusPanel 的
 *   Terminal 分区（运行中的 bash 任务行 + Stop）。
 * - 双通道：①拉取面（本 store）；②事件面（`CUSTOM tool_execution`
 *   details.schema = `pi.bash_job.v1` 经 turn-actor 归约）。真相在 pi。
 *   zustand vanilla 模式，照抄 checkpoint-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi `jobs::JobSnapshot`（serde camelCase）：status = "running" | "exited"
 * | "killed" | "timedOut" | "failed"。 */
export type JobStatus = 'running' | 'exited' | 'killed' | 'timedOut' | 'failed'

export interface JobSnapshot {
  schema: string
  id: string
  command: string
  startedAtMs: number
  status: JobStatus
  exitCode: number | null
  pid: number | null
  artifactPath: string
  artifactTruncated: boolean
  artifactError: string | null
  outputTail: string
  outputComplete: boolean
}

const JOB_STATUSES = new Set<JobStatus>([
  'running',
  'exited',
  'killed',
  'timedOut',
  'failed',
])

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asNumberOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : asNumber(v)
const asStringOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : asString(v)
const asBool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null

/** 严格解析 pi_job_list 返回（裸数组 JobSnapshot[]）：单行字段缺失/非法 →
 * console.error + 跳过；整体非数组 → console.error + []。不造缺省值。 */
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
    const command = asString(r.command)
    const startedAtMs = asNumber(r.startedAtMs)
    const status = asString(r.status)
    const artifactPath = asString(r.artifactPath)
    const outputTail = asString(r.outputTail)
    const outputComplete = asBool(r.outputComplete)
    const artifactTruncated = asBool(r.artifactTruncated)
    if (
      schema === null ||
      id === null ||
      command === null ||
      startedAtMs === null ||
      status === null ||
      artifactPath === null ||
      outputTail === null ||
      outputComplete === null ||
      artifactTruncated === null
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
      command,
      startedAtMs,
      status: status as JobStatus,
      exitCode: asNumberOrNull(r.exitCode),
      pid: asNumberOrNull(r.pid),
      artifactPath,
      artifactTruncated,
      artifactError: asStringOrNull(r.artifactError),
      outputTail,
      outputComplete,
    })
  }
  return out
}

interface JobsBridgeState {
  /** 任务投影；[] = 无任务/拉取失败（分区显示空态） */
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
