/**
 * 活动面板数据 → 官方 elements 组件的形状适配（纯函数，可单测）。
 *
 * 官方组件的 props 是 ZCode/ai-elements 的形状，pi 的 JSON 是另一套——
 * 适配住在这里，**组件本身不改**（上游更新不影响）。
 *
 * 映射原则：pi 有语义的逐项对应；pi 没有的**不编造**（返回 null 让调用方
 * 走另一条渲染路径，而不是塞假值）。
 */
import type { TodoItem as AuiTodoItem, TodoStatus as AuiTodoStatus } from './elements/todo-list'
import type { SubagentItem } from './elements/subagent-list'
import type { TaskCardState } from './elements/task-card'
import type { ChildEntry, ChildStatus } from './agent-hub-store'
import type { TodoTask } from './todo-store'
import type { JobSnapshot } from './jobs-store'

/** pi TodoStatus → 官方 TodoList 的 TodoStatus。
 * pi: open / in_progress / done / dropped / blocked{reason}
 * 官方: pending / active / done / failed
 * - open→pending、in_progress→active、done→done
 * - dropped（用户主动删）→ 官方无对应：映射 done（终态、划掉）——**这是语义
 *   最接近的**，且 reason 会写"已删除"让状态可见，不静默当完成。
 * - blocked{reason}→failed + reason（官方 failed 正是带原因的错误态）。 */
export function toAuiTodoStatus(t: TodoTask): { status: AuiTodoStatus; reason?: string } {
  switch (t.status) {
    case 'open':
      return { status: 'pending' }
    case 'in_progress':
      return { status: 'active' }
    case 'done':
      return { status: 'done' }
    case 'dropped':
      return { status: 'done', reason: '已删除' }
    case 'blocked':
      return { status: 'failed', reason: t.reason ?? '阻塞' }
  }
}

/** TodoTask[] → 官方 TodoItem[]（id 用序号——官方只当 React key）。 */
export function toAuiTodoItems(tasks: readonly TodoTask[]): AuiTodoItem[] {
  return tasks.map((t, i) => {
    const { status, reason } = toAuiTodoStatus(t)
    return {
      id: String(i),
      text: t.content,
      status,
      ...(reason === undefined ? {} : { reason }),
    }
  })
}

/** pi ChildStatus → TaskCardState（官方五态）。
 * starting/running → working；done → done；failed → failed；
 * cancelled/killed → cancelled。 */
export function childToTaskCardState(s: ChildStatus): TaskCardState {
  switch (s) {
    case 'starting':
    case 'running':
      return 'working'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'killed':
      return 'cancelled'
  }
}

/** ChildEntry → 官方 SubagentItem（官方只要 name + model；pi 的 ChildEntry
 * 无 model 字段——用 kind 当"模型"位**会撒谎**，所以用 pid 之外的稳定标识：
 * 这里取 `kind`（subagent/tan），它是真实存在的字段。 */
export function childToSubagentItem(c: ChildEntry): SubagentItem {
  return { name: c.name, model: c.kind }
}

/** JobSnapshot[] → JobProgress 的 stages 需要权重与阶段，pi 的 bash job
 * 是**单阶段**（一条命令跑到底）——所以 JobProgress 只适合"有阶段"的任务，
 * 不适合 bash job。此函数返回 null 表示"该任务无阶段数据，别用 JobProgress"。
 * （诚实：不把单条 bash 命令硬塞成多阶段进度条。） */
export function jobStages(_j: JobSnapshot): null {
  return null
}

/** 终态判定（与官方 TaskCardState 对齐：done/failed/cancelled 是终态） */
export const isTerminalTaskState = (s: TaskCardState): boolean =>
  s === 'done' || s === 'failed' || s === 'cancelled'

// 未接 checkpoint-history：官方组件第三行硬编码 "{files} files"，而 pi 只有
// messageCount（无文件数）——塞进去会把「3 条消息」显示成「3 files」（撒谎）。
// 故 CheckpointBar 保留自己的行渲染。若上游加 unit/label 参数即可接。
