/**
 * composer 徽标（上游 v4/composer/ConversationBackgroundWorkTrigger.tsx 完整
 * 移植，2026-11-20「全部对齐功能」轮）：实时活动的直达入口——typed 布局
 * 逐类计数（终端 / 工作流 / 智能体），<480px 收紧凑 Activity + 总数；点击
 * 落点由宿主编排（`panel` = 展开状态面板 + 非空分区，`workflow-run` =
 * 唯一在跑的工作流直达详情页，宿主判定）。计数 = 状态面板同一份真值
 * （jobs-store / child-agents-store / plan-dispatch 派生），不多造一路。
 */
import { memo } from 'react'
import { ActivityIcon, SquareTerminalIcon, Workflow } from 'lucide-react'

export interface ComposerBackgroundWorkCounts {
  bashCount: number
  workflowCount: number
  subagentCount: number
  totalCount: number
}

export interface ConversationBackgroundWorkTriggerProps {
  counts: ComposerBackgroundWorkCounts
  onOpen?: () => void
  openTarget?: 'panel' | 'workflow-run'
}

const L = {
  tooltipTerminal: '运行中的终端',
  tooltipAgent: '打开运行中的智能体',
  tooltipWorkflow: '打开运行中的工作流',
  tooltipWorkflowDetails: '打开工作流详情',
  tooltipMixed: '打开运行中的终端与智能体',
  ariaLabel: (bash: number, workflow: number, subagent: number, count: number) =>
    `打开运行中的后台任务：Bash ${bash} 个，工作流 ${workflow} 个，子智能体 ${subagent} 个，共 ${count} 个`,
} as const

function ConversationBackgroundWorkTriggerImpl({
  counts,
  onOpen,
  openTarget = 'panel',
}: ConversationBackgroundWorkTriggerProps) {
  if (!onOpen || counts.totalCount === 0) return null

  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length
  const tooltip =
    openTarget === 'workflow-run'
      ? L.tooltipWorkflowDetails
      : activeKindCount > 1
        ? L.tooltipMixed
        : counts.bashCount > 0
          ? L.tooltipTerminal
          : counts.workflowCount > 0
            ? L.tooltipWorkflow
            : L.tooltipAgent

  return (
    <button
      type="button"
      data-testid="composer-background-work-trigger"
      data-background-bash-count={counts.bashCount}
      data-background-workflow-count={counts.workflowCount}
      data-background-subagent-count={counts.subagentCount}
      data-background-total-count={counts.totalCount}
      data-background-open-target={openTarget}
      aria-label={L.ariaLabel(
        counts.bashCount,
        counts.workflowCount,
        counts.subagentCount,
        counts.totalCount,
      )}
      title={tooltip}
      onClick={onOpen}
      className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-foreground/20 inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[13px] tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <span
        data-composer-background-layout="typed"
        className="inline-flex items-center gap-1 [@container/composer(max-width:479px)]:hidden"
        aria-hidden
      >
        {counts.bashCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <SquareTerminalIcon aria-hidden className="size-3.5" />
            <span>{counts.bashCount}</span>
          </span>
        ) : null}
        {counts.workflowCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <Workflow aria-hidden className="size-3.5" />
            <span>{counts.workflowCount}</span>
          </span>
        ) : null}
        {counts.subagentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <BotGlyph aria-hidden />
            <span>{counts.subagentCount}</span>
          </span>
        ) : null}
      </span>
      <span
        data-composer-background-layout="compact"
        className="hidden items-center gap-0.5 [@container/composer(max-width:479px)]:inline-flex"
        aria-hidden
      >
        <ActivityIcon aria-hidden className="size-3.5" />
        <span>{counts.totalCount}</span>
      </span>
    </button>
  )
}

/** 智能体类徽标（上游 SubagentCollectionIcon 是头像集；宿主无该资源，用
 *  Bot 图标同语义替代——计数语义不变）。 */
function BotGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? 'size-3.5'}
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl)
