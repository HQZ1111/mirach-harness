/**
 * 状态面板的详情面开启器（宿主对偶：ZCode 的 workspace side tab）。
 *
 * - 计划详情（上游 `OpenPlanDetailSideTabRequest`）：payload = 会话计划条目
 *   （rpi-plan-mode 的 plan markdown）；
 * - 已结束智能体目录（上游 `OpenSubagentDirectorySideTabRequest`）：无
 *   payload——目录页自己从线程消息派生（`status-agent-rows.ts`）；
 * - 工作流实例详情 / 目录（上游 `onOpenWorkflowRun` +
 *   `OpenWorkflowRunDirectorySideTabRequest`）：payload = `{runId?}`——
 *   给定 = 单实例，省略 = 目录（页面自己从 `status-workflow-runs.ts` 派生）。
 *
 * 与 preview-opener / subagent-detail-opener 同形态：布局壳
 * （dockview-shell）注册实现，组件层只投递（解耦不引环）。
 */
export interface PlanDetailPanePayload {
  entryId: string
  title?: string
  markdown: string
}

export interface WorkflowRunPanePayload {
  /** 省略 = 工作流目录（全部实例）。 */
  runId?: string
  title?: string
}

type PlanDetailOpener = (payload: PlanDetailPanePayload) => void
type AgentDirectoryOpener = () => void
type WorkflowRunOpener = (payload: WorkflowRunPanePayload) => void

let planDetailOpener: PlanDetailOpener | null = null
let agentDirectoryOpener: AgentDirectoryOpener | null = null
let workflowRunOpener: WorkflowRunOpener | null = null

export function setPlanDetailOpener(fn: PlanDetailOpener | null) {
  planDetailOpener = fn
}

export function setAgentDirectoryOpener(fn: AgentDirectoryOpener | null) {
  agentDirectoryOpener = fn
}

export function setWorkflowRunOpener(fn: WorkflowRunOpener | null) {
  workflowRunOpener = fn
}

export function openPlanDetail(payload: PlanDetailPanePayload) {
  if (!planDetailOpener) {
    console.error('[status-pane] 计划详情通道未注册（布局壳未挂载）', payload.entryId)
    return
  }
  planDetailOpener(payload)
}

export function openAgentDirectory() {
  if (!agentDirectoryOpener) {
    console.error('[status-pane] 智能体目录通道未注册（布局壳未挂载）')
    return
  }
  agentDirectoryOpener()
}

export function openWorkflowRun(payload: WorkflowRunPanePayload) {
  if (!workflowRunOpener) {
    console.error('[status-pane] 工作流实例通道未注册（布局壳未挂载）', payload.runId ?? 'directory')
    return
  }
  workflowRunOpener(payload)
}
