/**
 * composer 状态徽标的宿主接线（上游 SessionPane 的
 * `onOpenRunningBackgroundWorks` + `ConversationBackgroundWorkTrigger` 组合
 * 面，2026-11-20「全部对齐功能」轮）。计数 = 状态面板同一份真值：
 *
 * - 终端 = jobs-store 运行行（pi_job_list）；
 * - 工作流 = 本线程 plan / dispatch 工具调用派生（status-workflow-runs，
 *   与面板分区同函数同输入）；
 * - 智能体 = 引擎名册（pi_child_agents）优先，缺位时回工具调用派生——
 *   与面板 runningAgents 同判。
 *
 * 点击落点照上游：唯一在跑的工作流 run 直达其详情页；否则把状态面板
 * 切到 panel 形态并展开全部非空分区（expandRequest 走 status-panel-store，
 * 面板组件消费）。
 */
import { useMemo } from 'react'
import { useAuiState } from '@assistant-ui/react'
import { useStore } from 'zustand'

import { deriveWorkflowRuns } from '@/components/assistant-ui/status-workflow-runs'
import {
  ConversationBackgroundWorkTrigger,
  type ComposerBackgroundWorkCounts,
} from '@/components/assistant-ui/conversation-background-work-trigger'
import { jobsBridge } from '@/components/assistant-ui/jobs-store'
import { childAgentsBridge } from '@/components/assistant-ui/child-agents-store'
import { deriveAgentRows } from '@/components/assistant-ui/status-agent-rows'
import { openWorkflowRun } from '@/components/panes/status-pane-openers'
import { statusPanelStore } from '@/components/assistant-ui/status-panel-store'
import { workflowRunDisplayName } from '@/components/assistant-ui/status-workflow-runs'

export function ComposerStatusBadge() {
  const jobs = useStore(jobsBridge, (s) => s.jobs)
  const agents = useStore(childAgentsBridge, (s) => s.agents)
  const messages = useAuiState((s) => s.thread.messages)

  const bashCount = useMemo(
    () => jobs.filter((job) => job.status === 'running').length,
    [jobs],
  )
  const agentRows = useMemo(
    () => deriveAgentRows(messages as readonly unknown[]),
    [messages],
  )
  const runningAgents = useMemo(() => {
    const engine = agents.filter((agent) => agent.status === 'running')
    return engine.length > 0 ? engine : agentRows.running
  }, [agents, agentRows])
  const workflowRuns = useMemo(
    () => deriveWorkflowRuns(messages as readonly unknown[]),
    [messages],
  )

  const counts: ComposerBackgroundWorkCounts = {
    bashCount,
    workflowCount: workflowRuns.running.length,
    subagentCount: runningAgents.length,
    totalCount: bashCount + workflowRuns.running.length + runningAgents.length,
  }

  if (counts.totalCount === 0) return null

  // 唯一在跑的 run 直达详情（上游 resolveSoleRunningWorkflowRunTarget 同判：
  // 只有工作流一类在跑且恰好一条）。
  const soleWorkflow =
    bashCount === 0 && runningAgents.length === 0 && workflowRuns.running.length === 1
      ? workflowRuns.running[0]
      : null

  const handleOpen = () => {
    if (soleWorkflow !== null) {
      const name = workflowRunDisplayName(soleWorkflow)
      openWorkflowRun({ runId: soleWorkflow.runId, ...(name !== null ? { title: name } : {}) })
      return
    }
    statusPanelStore.getState().requestExpandSections({
      terminal: bashCount > 0,
      agent: runningAgents.length > 0,
      workflow: workflowRuns.running.length > 0,
    })
    statusPanelStore.getState().setOverride('panel')
  }

  return (
    <ConversationBackgroundWorkTrigger
      counts={counts}
      onOpen={handleOpen}
      openTarget={soleWorkflow !== null ? 'workflow-run' : 'panel'}
    />
  )
}
