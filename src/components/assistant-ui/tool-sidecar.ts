/**
 * pi 工具输出的结构化 sidecar 分派（活动面板数据面桥）。
 *
 * 纯函数（无 store、无副作用）：从 `CUSTOM tool_execution` 事件里提取
 * `ToolOutput.details.schema` 分派信息，交给 runtime 边界喂对应 store。
 * 保持 turn-actor 纯投影（它只管消息段），sidecar（todo/roster/jobs）走
 * 本模块——**唯一消费者是 runtime.tsx 的 onMessage**（与 approvalBridge
 * 在 onMessage 刷新列表同款：L1 桥只读投影，真相在 pi）。
 *
 * details 形状（pi 侧逐字段实锤）：
 * - `{ schema: "todo_list.v1", list: TodoList, summary?: string }`（todo.rs:556）
 * - `{ schema: "pi.agent-hub.roster/v1", children: ChildEntry[] }`（tools.rs hub）
 * - `{ schema: "pi.bash_job.v1", ...JobSnapshot 字段 }`（jobs JobSnapshot.schema）
 * - 其余 schema（plan 的 `planReview` 等）无活动面板消费方——透传不处理。
 */
import { agentHubBridge } from './agent-hub-store'
import { jobsBridge } from './jobs-store'
import { todoBridge } from './todo-store'

/** todo 工具输出 schema（todo.rs `TODO_LIST_SCHEMA`） */
export const TODO_LIST_SCHEMA = 'todo_list.v1'
/** hud 工具 roster 动作输出 schema（tools.rs dispatch_agent "roster"） */
export const AGENT_HUB_ROSTER_SCHEMA = 'pi.agent-hub.roster/v1'
/** jobs 快照 schema（jobs.rs `JOB_SCHEMA`） */
export const JOB_SCHEMA = 'pi.bash_job.v1'

/** CUSTOM tool_execution 的 value 形状（agui.rs map_agent_event 逐字段）。 */
interface ToolExecutionValue {
  phase?: unknown
  toolCallId?: unknown
  toolName?: unknown
  /** update 相位：整包 ToolOutput（含 details） */
  partial?: unknown
  /** end 相位：整包 ToolOutput（含 details） */
  result?: unknown
}

/** 从 ToolOutput（partial/result）里取 details 对象；非对象/缺省 → null。 */
const detailsOf = (out: unknown): Record<string, unknown> | null => {
  if (typeof out !== 'object' || out === null) return null
  const d = (out as Record<string, unknown>).details
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null
  return d as Record<string, unknown>
}

/**
 * 分派一条 CUSTOM tool_execution 事件的 details 到对应 store。
 * 非 tool_execution / 无 details / 未识别 schema → 静默返回（不是错误：
 * 绝大多数工具没有结构化输出）。识别但形状非法 → 各 store 内 console.error
 * 可见（不在此吞）。
 *
 * 返回是否消费（供测试断言；运行期调用方忽略）。
 */
export function dispatchToolDetails(name: unknown, value: unknown): boolean {
  if (name !== 'tool_execution') return false
  if (typeof value !== 'object' || value === null) return false
  const v = value as ToolExecutionValue
  // update 相位取 partial、end 相位取 result（start 相位无输出）
  const out = v.phase === 'update' ? v.partial : v.phase === 'end' ? v.result : null
  const details = detailsOf(out)
  if (details === null) return false
  const schema = details.schema
  if (typeof schema !== 'string') return false

  switch (schema) {
    case TODO_LIST_SCHEMA:
      todoBridge.getState().applyTodo(details.list, details.summary)
      return true
    case AGENT_HUB_ROSTER_SCHEMA:
      agentHubBridge.getState().applyRoster(details.children)
      return true
    case JOB_SCHEMA:
      jobsBridge.getState().applyJob(details)
      return true
    default:
      // 无活动面板消费方的 schema（planReview 等）：透传不处理
      return false
  }
}
