/**
 * 活动面板「工作流」分区的宿主派生面（纯函数，无 DOM/React——可单测）——
 * ZCode `WorkflowStatusSection` / `conversationStatusPanelModel.buildRunningWorkflowRuns`
 * 的数据对偶。
 *
 * ZCode 的 workflow run 是 CLI 的 CreateWorkflow 脚本实例（协议投影
 * `workflowRuns` + 后台工作 kind=workflow）；rpi 没有该子系统，最接近的真值
 * = **rpi-orchestrator 的 DAG**：`plan`（action=set/update/show）与 `dispatch`
 * （一轮就绪波）工具调用，成功结果 `details = {nodes:[{id,task,deps,status,…}]}`
 * （`packages/rpi-orchestrator/src/graph.rs` 的 `to_details`；status ∈
 * pending / running / done / failed / skipped）。
 *
 * 投影规则（每条都可回溯到引擎事实，不编造）：
 * - 一次成功的 `plan(action=set)` = 一条 run（runId = 该 toolCallId）；其后
 *   同会话的 `plan update` / `dispatch` 成功调用更新**同一张图**；新的 set
 *   替换旧图 = 旧 run 不复存在（引擎语义；未收敛的旧图不造假成 completed /
 *   errored，console.warn 留痕后丢弃）。
 * - 行状态（对齐上游 pending/running 只在活动列表、终态折进目录）：
 *   还没 dispatch 过 = pending；有未收敛节点或调用在途 = running；
 *   全部节点 done/failed/skipped = completed（有 failed = errored）。
 * - 步数：settled = done|failed|skipped 数，total = 节点数（上游
 *   `workflowRunStepCounts` 同义）；图快照缺席（旧投影 / 结果未落）→ 步数
 *   字段缺席，而不是 0/0（一个假的 0/0 会显示成「一步都没跑」）。
 * - 标题 = 首个节点的 task（引擎没有 run 名；首节点任务是真实可辨认的题名，
 *   截断在渲染层）；无节点 → null（渲染层用上游兜底名「工作流脚本」）。
 * - Stop 不渲染：orchestrator 没有取消面（不放假按钮）。
 */

export const WORKFLOW_TOOL_NAMES = new Set(['plan', 'dispatch'])

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StatusPanelWorkflowNode {
  id: string
  task: string
  status: WorkflowNodeStatus
  deps: string[]
}

export interface StatusPanelWorkflowRun {
  runId: string
  toolCallId: string
  title: string | null
  status: 'pending' | 'running' | 'completed' | 'errored'
  /** 图快照缺席时为 null（渲染层据此不画步数——缺席不用 0 代替）。 */
  nodesSettled: number | null
  nodesTotal: number | null
  startedAt: number | null
  completedAt: number | null
  nodes: StatusPanelWorkflowNode[]
}

const NODE_STATUSES = new Set<WorkflowNodeStatus>([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
])

function isSettled(status: WorkflowNodeStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped'
}

/** 工具结果里的图快照：`result.details.nodes`（对象形状）。其余 → null。 */
function graphNodesFromResult(result: unknown): StatusPanelWorkflowNode[] | null {
  if (typeof result !== 'object' || result === null) return null
  const details = (result as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return null
  const nodes = (details as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return null
  const parsed: StatusPanelWorkflowNode[] = []
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as Record<string, unknown>
    const id = typeof node.id === 'string' ? node.id : ''
    const task = typeof node.task === 'string' ? node.task : ''
    const status = typeof node.status === 'string' ? node.status : ''
    if (id === '' || !NODE_STATUSES.has(status as WorkflowNodeStatus)) {
      console.error('[status-panel] workflow 节点行损坏——丢弃该节点', node)
      continue
    }
    const deps = Array.isArray(node.deps)
      ? node.deps.filter((dep): dep is string => typeof dep === 'string')
      : []
    parsed.push({ id, task, deps, status: status as WorkflowNodeStatus })
  }
  return parsed
}

/** `plan(action=set)` 入参里的节点（结果未回时也能显示图；状态一律 pending）。 */
function graphNodesFromSetArgs(args: Record<string, unknown>): StatusPanelWorkflowNode[] | null {
  const nodes = args.nodes
  if (!Array.isArray(nodes)) return null
  const parsed: StatusPanelWorkflowNode[] = []
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as Record<string, unknown>
    const id = typeof node.id === 'string' ? node.id.trim() : ''
    const task = typeof node.task === 'string' ? node.task.trim() : ''
    if (id === '') continue
    const deps = Array.isArray(node.deps)
      ? node.deps.filter((dep): dep is string => typeof dep === 'string')
      : []
    parsed.push({ id, task, deps, status: 'pending' })
  }
  return parsed.length > 0 ? parsed : null
}

function isFailed(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  )
}

interface MutableRun {
  runId: string
  toolCallId: string
  nodes: StatusPanelWorkflowNode[] | null
  sawDispatch: boolean
  inFlight: boolean
  startedAt: number | null
  completedAt: number | null
}

function finalize(run: MutableRun): StatusPanelWorkflowRun {
  let status: StatusPanelWorkflowRun['status']
  if (run.inFlight) {
    status = 'running'
  } else if (run.nodes !== null && run.nodes.length > 0 && run.nodes.every((n) => isSettled(n.status))) {
    status = run.nodes.some((n) => n.status === 'failed') ? 'errored' : 'completed'
  } else if (!run.sawDispatch) {
    status = 'pending'
  } else {
    status = 'running'
  }
  const total = run.nodes === null ? null : run.nodes.length
  const settled =
    run.nodes === null ? null : run.nodes.filter((n) => isSettled(n.status)).length
  const firstTask = run.nodes?.find((n) => n.task.trim() !== '')?.task.trim() ?? null
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    title: firstTask,
    status,
    nodesSettled: settled,
    nodesTotal: total,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    nodes: run.nodes ?? [],
  }
}

/**
 * 从线程消息派生工作量图 run（输入形状 = assistant-ui ThreadMessageState 的
 * 最小结构：`{role, content: [{type:'tool-call', toolName, toolCallId, args,
 * result, timing}]}`）。输出分两段：活动（pending/running，面板行）与已结束
 * （completed/errored，目录计数/目录页），均按启动序。
 */
export function deriveWorkflowRuns(messages: readonly unknown[]): {
  running: StatusPanelWorkflowRun[]
  ended: StatusPanelWorkflowRun[]
} {
  const runs: StatusPanelWorkflowRun[] = []
  let current: MutableRun | null = null

  const closeCurrent = (superseded: boolean) => {
    if (current === null) return
    const run = finalize(current)
    if (superseded && run.status !== 'completed' && run.status !== 'errored') {
      // 被新 plan 替换、且未收敛：引擎图已不存在，标成任何终态都是编造。
      console.warn('[status-panel] 旧工作流图被替换且未收敛——不计入面板', run.runId)
    } else {
      runs.push(run)
    }
    current = null
  }

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const role = (message as { role?: unknown }).role
    if (role !== 'assistant') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const p = part as Record<string, unknown>
      if (p.type !== 'tool-call') continue
      const toolName = typeof p.toolName === 'string' ? p.toolName : ''
      if (!WORKFLOW_TOOL_NAMES.has(toolName)) continue
      const args = (p.args ?? {}) as Record<string, unknown>
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : ''
      if (toolCallId === '') continue
      const timing = p.timing as { startedAt?: number; completedAt?: number } | undefined
      const startedAt = typeof timing?.startedAt === 'number' ? timing.startedAt : null
      const completedAt = typeof timing?.completedAt === 'number' ? timing.completedAt : null
      const inFlight = completedAt === null
      const action = typeof args.action === 'string' ? args.action : null

      if (toolName === 'plan') {
        // 只认 orchestrator 的形状（plan-mode 等别的插件没有 action 字段）。
        if (action !== 'set' && action !== 'update' && action !== 'show') continue
        if (action === 'set') {
          closeCurrent(true)
          const nodes = graphNodesFromSetArgs(args)
          current = {
            runId: toolCallId,
            toolCallId,
            nodes,
            sawDispatch: false,
            inFlight,
            startedAt,
            completedAt,
          }
          continue
        }
      }
      if (current === null) continue // 转录截断处的半程调用：没有 set 可归属
      const result = p.result
      if (!inFlight && !isFailed(result)) {
        const nodes = graphNodesFromResult(result)
        if (nodes !== null) current.nodes = nodes
      }
      if (toolName === 'dispatch') current.sawDispatch = true
      if (inFlight) current.inFlight = true
      if (completedAt !== null) {
        current.inFlight = false
        current.completedAt = completedAt
      } else if (startedAt !== null) {
        current.startedAt = current.startedAt ?? startedAt
      }
    }
  }
  closeCurrent(false)

  const running: StatusPanelWorkflowRun[] = []
  const ended: StatusPanelWorkflowRun[] = []
  for (const run of runs) {
    if (run.status === 'completed' || run.status === 'errored') ended.push(run)
    else running.push(run)
  }
  return { running, ended }
}

/** 未命名的判定（上游 `workflowRunDisplayName` 同义：没有可读题名 = 兜底名）。 */
export function workflowRunDisplayName(run: StatusPanelWorkflowRun): string | null {
  return run.title !== null && run.title !== '' ? run.title : null
}

/**
 * run「此刻在做什么」的词（上游 `workflowRunWords` 的宿主子集：无 phase 面，
 * 只在 pending/running 状态词与步数之间选择）。降级行（无图快照）没有可说
 * 的词 → 回状态词。
 */
export type StatusPanelWorkflowRunWords =
  | { kind: 'status'; status: 'pending' | 'running' }
  | { kind: 'steps'; done: number; total: number }

export function workflowRunWords(
  run: StatusPanelWorkflowRun,
): StatusPanelWorkflowRunWords | null {
  if (run.status === 'pending') return { kind: 'status', status: 'pending' }
  if (run.status === 'completed' || run.status === 'errored') return null
  if (run.nodesSettled !== null && run.nodesTotal !== null && run.nodesTotal > 0) {
    return { kind: 'steps', done: run.nodesSettled, total: run.nodesTotal }
  }
  return { kind: 'status', status: 'running' }
}
