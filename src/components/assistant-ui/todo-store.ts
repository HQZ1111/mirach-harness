/**
 * 待办桥（活动面板 Todo 分区数据面）：pi `todo` 工具的 `todo_list.v1`
 * 结构化输出投影。
 *
 * - 真相在 pi（会话树 Custom `todo_list.v1` 条目，`latest_from_entries`
 *   重放；todo.rs:547 持久化 → 会话切回来能恢复）。
 * - 通道：唯一来源是 `CUSTOM tool_execution` 的
 *   `details = { schema: "todo_list.v1", list: TodoList, summary?: string }`
 *   —— 模型每次调 todo 工具（init/start/done/...）经 turn-actor 归约到此。
 *   没有 IPC 拉取面：pi 的 `plan_state()`/todo 状态在 Agent 上，SDK
 *   `AgentSessionHandle` 未暴露（见 docs/engine-gaps.md §2 缺口 G2）——
 *   重启后未调工具前拿不到历史 todo（诚实空态，不编造）。
 *   zustand vanilla 模式，照抄 checkpoint-store。
 */
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
  /** 事件面提交（CUSTOM tool_execution details.schema = todo_list.v1） */
  applyTodo: (raw: unknown, summary: unknown) => void
  resetProjection: () => void
}

export const todoBridge = createStore<TodoBridgeState>((set) => ({
  todo: null,
  applyTodo: (raw, summary) => {
    const parsed = parseTodoList(raw)
    if (parsed === null) return // 非法形状：console.error 已发，保留旧投影
    parsed.summary = asString(summary)
    set({ todo: parsed })
  },
  resetProjection: () => set({ todo: null }),
}))

export const useTodoBridge = () => useStore(todoBridge)
