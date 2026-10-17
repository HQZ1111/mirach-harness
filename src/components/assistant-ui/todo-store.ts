/**
 * 待办桥（活动面板 Todo 分区数据面）：pi `todo` 工具的 `todo_list.v1`
 * 结构化输出投影。
 *
 * - 真相在 pi（会话树 Custom `todo_list.v1` 条目，`latest_from_entries`
 *   重放；todo.rs:547 持久化 → 会话切回来能恢复）。
 * - 双通道：
 *   ①拉取面 `refresh()` → `pi_todo_state` IPC（Rust 重放活动路径 Custom
 *     条目，与 pi `latest_from_entries` 同逻辑）——挂载/切会话时拉，解决
 *     "重启后模型未再调 todo 工具前拿不到历史待办"（docs/engine-gaps.md
 *     G2，宿主侧过渡方案，不需上游改）。
 *   ②事件面 `CUSTOM tool_execution` 的
 *     `details = { schema: "todo_list.v1", list: TodoList, summary?: string }`
 *     —— 模型每次调 todo 工具（init/start/done/...）经 tool-sidecar 归约
 *     到此（即时）。
 *   zustand vanilla 模式，照抄 checkpoint-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi `todo::TodoStatus`（serde tag="state" snake_case）+ flatten：
 * 任务行 = `{ content, state, reason? }`（blocked 才有 reason）。 */
export type TodoStatus = 'open' | 'in_progress' | 'done' | 'dropped' | 'blocked'

export interface TodoTask {
  content: string
  status: TodoStatus
  /** blocked 状态的原因（其余状态无） */
  reason?: string
}

export interface TodoPhase {
  /** 阶段名（flat 列表 = 单个无 name 的 phase） */
  name: string | null
  tasks: TodoTask[]
}

export interface TodoProjection {
  phases: TodoPhase[]
  /** pi 生成的摘要行（`TodoList::summary_line()`，可空） */
  summary: string | null
}

const TODO_STATUSES = new Set<TodoStatus>([
  'open',
  'in_progress',
  'done',
  'dropped',
  'blocked',
])

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

/** 解析单个任务的扁平形状 `{ content, state, reason? }`（serde
 * `#[serde(flatten)] status` + `TodoStatus` 的 `tag="state"`）。非法 → null
 * （调用方 console.error + 跳过该任务）。 */
function parseTask(raw: unknown): TodoTask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const content = asString(r.content)
  const state = asString(r.state)
  if (content === null || state === null) return null
  if (!TODO_STATUSES.has(state as TodoStatus)) return null
  const task: TodoTask = { content, status: state as TodoStatus }
  if (state === 'blocked') {
    const reason = asString(r.reason)
    if (reason === null) return null // blocked 必带 reason（上游形状）
    task.reason = reason
  }
  return task
}

/** 解析 `todo_list.v1` 的 details.list（`TodoList { phases: [...] }`）。 */
export function parseTodoList(raw: unknown): TodoProjection | null {
  if (typeof raw !== 'object' || raw === null) {
    console.error('[todo] todo_list.v1 list 形状非法——丢弃', raw)
    return null
  }
  const r = raw as Record<string, unknown>
  const rawPhases = r.phases
  if (!Array.isArray(rawPhases)) {
    console.error('[todo] todo_list.v1 phases 非数组——丢弃', raw)
    return null
  }
  const phases: TodoPhase[] = []
  for (const rawPhase of rawPhases) {
    if (typeof rawPhase !== 'object' || rawPhase === null) {
      console.error('[todo] phase 形状非法——跳过', rawPhase)
      continue
    }
    const p = rawPhase as Record<string, unknown>
    const rawTasks = p.tasks
    if (!Array.isArray(rawTasks)) {
      console.error('[todo] phase.tasks 非数组——跳过该 phase', rawPhase)
      continue
    }
    const tasks: TodoTask[] = []
    for (const rawTask of rawTasks) {
      const task = parseTask(rawTask)
      if (task === null) {
        console.error('[todo] 任务行字段缺失/非法——跳过', rawTask)
        continue
      }
      tasks.push(task)
    }
    phases.push({ name: asString(p.name), tasks })
  }
  return { phases, summary: null }
}

/** 扁平化任务（分区行渲染：phases 分组或单列）。 */
export const flatTasks = (proj: TodoProjection): TodoTask[] =>
  proj.phases.flatMap((p) => p.tasks)

interface TodoBridgeState {
  /** 待办投影；null = 本会话尚未观察到 todo（诚实空态，不编造） */
  todo: TodoProjection | null
  /** 拉取面：`pi_todo_state` IPC 重放会话 Custom 条目（挂载/切会话拉） */
  refresh: () => Promise<void>
  /** 事件面提交（CUSTOM tool_execution details.schema = todo_list.v1） */
  applyTodo: (raw: unknown, summary: unknown) => void
  resetProjection: () => void
}

export const todoBridge = createStore<TodoBridgeState>((set) => ({
  todo: null,
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_todo_state')
      if (typeof raw !== 'object' || raw === null) {
        console.error('[todo] pi_todo_state 返回形状非法——清投影', raw)
        set({ todo: null })
        return
      }
      const r = raw as Record<string, unknown>
      // schema null = 无 todo 条目（诚实空态，非错误）
      if (r.schema === null || r.schema === undefined) {
        set({ todo: null })
        return
      }
      const parsed = parseTodoList(r.list)
      if (parsed === null) return // 形状非法：console.error 已发，保留旧投影
      parsed.summary = asString(r.summary)
      set({ todo: parsed })
    } catch (e) {
      if (String(e).includes('no active session')) {
        // 首启 / New Chat / 删除活动会话后的预期域状态：无会话 = 无待办
        set({ todo: null })
        return
      }
      console.error('[todo] 待办状态拉取失败——清投影', e)
      set({ todo: null })
    }
  },
  applyTodo: (raw, summary) => {
    const parsed = parseTodoList(raw)
    if (parsed === null) return // 非法形状：console.error 已发，保留旧投影
    parsed.summary = asString(summary)
    set({ todo: parsed })
  },
  resetProjection: () => set({ todo: null }),
}))

export const useTodoBridge = () => useStore(todoBridge)
