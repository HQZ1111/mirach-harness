/**
 * 工作流实例详情 / 目录页（状态面板「工作流」分区的行与页脚落点；上游
 * `OpenWorkflowRunDirectorySideTabRequest` / `onOpenWorkflowRun` 的宿主对偶 =
 * 面板栏标签页）。
 *
 * 数据 = 本线程 `plan` / `dispatch` 工具调用派生（`status-workflow-runs.ts`），
 * 与面板行同源；`runId` 省略 = 目录（全部实例），给定 = 单实例详情。
 * 图被新 plan 替换后实例可能消失——如实空态，不留过期快照。
 */
import { useAuiState } from '@assistant-ui/react'
import { useMemo } from 'react'
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  SkipForwardIcon,
  Workflow,
  XCircleIcon,
} from 'lucide-react'

import {
  deriveWorkflowRuns,
  type StatusPanelWorkflowNode,
  type StatusPanelWorkflowRun,
} from '@/components/assistant-ui/status-workflow-runs'

const NODE_STATUS_LABEL: Record<StatusPanelWorkflowNode['status'], string> = {
  pending: '待运行',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
}

function NodeStatusIcon({ status }: { status: StatusPanelWorkflowNode['status'] }) {
  if (status === 'done') {
    return <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
  }
  if (status === 'failed') {
    return <XCircleIcon className="text-destructive mt-0.5 size-3.5 shrink-0" aria-hidden />
  }
  if (status === 'running') {
    return <ArrowRightIcon className="text-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
  }
  if (status === 'skipped') {
    return <SkipForwardIcon className="text-(--text-4) mt-0.5 size-3.5 shrink-0" aria-hidden />
  }
  return <CircleIcon className="text-(--text-4) mt-0.5 size-3.5 shrink-0" aria-hidden />
}

function RunSection({ run }: { run: StatusPanelWorkflowRun }) {
  return (
    <section className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2 px-2 pt-1 pb-1.5">
        <span className="text-(--text) min-w-0 flex-1 truncate text-[13px] font-semibold">
          {run.title ?? '工作流脚本'}
        </span>
        <span className="text-(--text-4) shrink-0 text-[11px] tabular-nums">
          {run.nodesSettled ?? 0}/{run.nodesTotal ?? 0} 步 · {run.status}
        </span>
      </div>
      {run.nodes.length === 0 ? (
        <p className="text-(--text-4) px-2 py-1 text-[12px]">没有图快照（结果尚未落盘）。</p>
      ) : (
        <ul className="space-y-0">
          {run.nodes.map((node) => (
            <li
              key={node.id}
              data-workflow-node-id={node.id}
              data-workflow-node-status={node.status}
              className="hover:bg-foreground/[0.04] flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5"
            >
              <NodeStatusIcon status={node.status} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-(--text) line-clamp-3 text-[13px] leading-5">
                  {node.task !== '' ? node.task : node.id}
                </span>
                <span className="text-(--text-4) flex min-w-0 flex-wrap gap-x-2 text-[11px]">
                  <span className="font-mono">{node.id}</span>
                  <span>{NODE_STATUS_LABEL[node.status]}</span>
                  {node.deps.length > 0 ? (
                    <span className="min-w-0 truncate">依赖 {node.deps.join(', ')}</span>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function WorkflowRunDetailPane({ runId }: { runId?: string }) {
  const messages = useAuiState((s) => s.thread.messages)
  const { running, ended } = useMemo(
    () => deriveWorkflowRuns(messages as readonly unknown[]),
    [messages],
  )
  const runs = useMemo(() => [...running, ...ended], [running, ended])
  const target = runId === undefined ? null : (runs.find((run) => run.runId === runId) ?? null)

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-(--surface)"
      data-slot="workflow-run-detail-pane"
      data-workflow-run-id={runId}
    >
      <div className="border-(--stroke-soft) flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md">
          <Workflow className="text-(--text-3) size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--text) truncate text-[13px] font-semibold">
            {runId === undefined
              ? `工作流实例 · ${runs.length}`
              : (target?.title ?? '工作流实例')}
          </div>
          <div className="text-(--text-4) truncate text-[11px]">
            {runId === undefined
              ? '本次会话的 plan / dispatch 图（运行中在前，已结束在后）。'
              : '该实例的节点图（数据来自本线程的 plan / dispatch 结果）。'}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {runId !== undefined ? (
          target !== null ? (
            <RunSection run={target} />
          ) : (
            <p className="text-(--text-4) px-2 py-2 text-[12px]">
              该工作流实例已不在当前会话中（图被新的 plan 替换或被会话切换清除）。
            </p>
          )
        ) : runs.length === 0 ? (
          <p className="text-(--text-4) px-2 py-2 text-[12px]">这条对话里还没有工作流实例。</p>
        ) : (
          runs.map((run) => (
            <div key={run.runId} className="mb-2">
              <RunSection run={run} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
