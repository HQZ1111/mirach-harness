/**
 * 活动状态面板（对话栏右上角浮层）—— **ZCode 原版结构完整移植**
 * （2026-11-01 首版；2026-11-17 按用户「完整移植」补齐会话计划 / 终端 /
 * 目标控制 / 智能体目录 / 胶囊链）。
 *
 * 上游 = packages/ui/src/v4/ConversationStatusPanel.tsx（2293 行）+
 * conversationStatusPanelModel.ts。本文件按上游结构逐段移植：
 *
 * - **三态**（auto / panel / mini）：auto = 容器查询裁决——对话列
 *   （`.assistant-thread-pane` 是 named container `thread`）≥1280px 出
 *   panel、窄了收 mini 胶囊；panel/mini 为用户钉死态（Ellipsis 菜单选，
 *   localStorage `mirach:status-panel-variant` 持久化）。
 * - **控制行**：右上角 Ellipsis（显示策略菜单）+ Minimize2（收起为胶囊）。
 *   上游菜单只挂了 auto 一项（panel/mini 的 i18n 键与 handler 都在但条目
 *   缺失——上游缺陷），这里补全三项。
 * - **分区顺序**（上游同序）：Git 工具 → 目标 → 会话计划 → 进程 Todo →
 *   终端 → 工作流 → 智能体。每类限高滚动（STATUS_SECTION_SCROLL_POLICY）+
 *   separated 上边线 + trailing 随开合切换；分区标题行 = 标题 + 悬停出现的
 *   箭头 + 内联 trailing。
 * - **已结束目录行**（上游 EndedDirectoryRow）：智能体分区的页脚行
 *   「已结束的智能体 · N ›」→ 面板栏标签页 `agent-directory`（上游
 *   OpenSubagentDirectorySideTabRequest 的宿主对偶），行可再开子代理详情页
 *   （既有 openSubagentDetail 通道）。
 * - **mini 胶囊**：完整优先级链（运行待办 → 目标(活) → git 变更 → 目标(完)
 *   → 最近完成项 → 待办计数 → 最新会话计划 → 运行计数 → 宿主诚实空态）。
 *
 * 数据面（全部真值）：
 * - 待办（rpi-todo todo-state 条目 → todo-store）；
 * - git 变更（fs_git_diff_stat → git-store）；
 * - 目标（rpi-goal goal-state 条目 → pi_goal_state；迭代行 = rpi-goal-iterations
 *   插件的 `goal-iterations` 逐轮快照并入 active.iterations——ZCode
 *   `GoalStatusSection` 的行结构逐条照抄；暂停/恢复走 `/goal pause|resume`
 *   扩展命令）；
 * - 会话计划（rpi-plan-mode plan-mode 条目 → pi_plan_entries → 新 store）；
 * - 终端（pi_job_list → jobs-store；真源 = rpi-background-tasks 插件的
 *   `background-tasks` 会话快照——插件已安装
 *   `~/.rpi/agent/extensions/rpi_background_tasks.dll`，无作业时为空、分区
 *   不渲染，与上游"无数据不渲染"同判）；
 * - 智能体（**引擎名册优先**：pi_child_agents 真运行态，running 行带停止钮；
 *   delegate_task / subagent / dispatch 工具调用派生仅剩已结束目录用途）。
 * - 工作流（宿主从 rpi-orchestrator 的 plan / dispatch 工具调用派生：一次
 *   plan set = 一条 run，dispatch 波次更新节点状态；ZCode
 *   WorkflowStatusSection 的行结构照抄。rpi 没有 CreateWorkflow 子系统，
 *   DAG 是唯一可核对真值；Stop 面不存在 → 不渲染）。
 *
 * **与上游的宿主适配（都有因）**：
 * 1. Todo 折叠预览：上游 HoverCard，宿主无 → motion Popover trigger="hover"
 *    （同一交互语义）；预览 side 只有 top/bottom（上游 left），用 bottom。
 * 2. git 区：上游有分支切换器 / git 动作菜单；宿主分支切换接
 *    fs_git_branches/fs_git_checkout（真），提交/推送由审查面板承担
 *    （GitActionMenu 不在面板重复）。
 * 3. 详情落点 = 面板栏标签页（宿主没有 ZCode 的 workspace side tab）：
 *    计划详情 = 每计划一个 `plan-detail:<entryId>` 标签（payload = plan
 *    markdown 原文），已结束智能体目录 = 单实例 `agent-directory`（数据自
 *    线程消息派生，与分区页脚计数同源）。开合器 = status-pane-openers 投递、
 *    dockview-shell 注册（与 preview / subagent-detail 同形态）。
 * 4. 面板卸载闸门照抄上游：`!hasContent → null`（2026-11-17「全部对齐」轮
 *    推翻 2026-11-15 的"常驻空态"宿主选择）；draft（无会话）同样不挂。
 * 5. 终端/智能体分区开合 = 上游受控 state 语义（默认折起、归零折起、换
 *    会话复位）；上游另有 composer 徽标入口驱动展开，宿主 composer 没有
 *    该徽标面（不另造自动展开）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAuiState } from '@assistant-ui/react'
import { useStore } from 'zustand'
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  EllipsisIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  LoaderCircle,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  TargetIcon,
  Workflow,
  XCircleIcon,
} from 'lucide-react'
import type { DockviewApi } from 'dockview-react'

import { cn } from '@/lib/utils'
import { ghostButton, paper } from '@/components/assistant-ui/elements/surfaces'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover'
import {
  ContextMenu,
  ContextMenuAnchor,
  ContextMenuContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
} from '@/components/motion/context-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { openPagePanel } from '@/components/layout/open-page-actions'
import { gitBridge, useGitBridge } from '@/components/assistant-ui/git-store'
import { flatTasks, todoBridge, useTodoBridge } from '@/components/assistant-ui/todo-store'
import { sessionThreadKey } from '@/components/assistant-ui/session-thread-key'
import { jobsBridge, useJobsBridge } from '@/components/assistant-ui/jobs-store'
import {
  childAgentsBridge,
  useChildAgentsBridge,
} from '@/components/assistant-ui/child-agents-store'
import {
  planEntriesBridge,
  usePlanEntriesBridge,
} from '@/components/assistant-ui/plan-entries-store'
import {
  sessionCatalog,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog'
import {
  buildConversationGoalIterationSummaries,
  buildStatusPanelModel,
  getStatusPanelTodoFocusWindow,
  goalElapsedSeconds,
  type StatusPanelAgentRow,
  type StatusPanelGitModel,
  type StatusPanelGoalModel,
  type StatusPanelModel,
  type StatusPanelPlanItem,
  type StatusPanelSessionPlanItem,
} from '@/components/assistant-ui/conversation-status-panel-model'
import { statusPanelStore, type StatusPanelVariant } from '@/components/assistant-ui/status-panel-store'
import { openSubagentDetail } from '@/components/panes/subagent-detail-opener'
import {
  openAgentDirectory,
  openPlanDetail,
  openWorkflowRun,
} from '@/components/panes/status-pane-openers'
import { deriveAgentRows, type EndedAgentRow } from '@/components/assistant-ui/status-agent-rows'
import {
  deriveWorkflowRuns,
  workflowRunDisplayName,
  workflowRunWords,
  type StatusPanelWorkflowRun,
} from '@/components/assistant-ui/status-workflow-runs'
import { formatWorkDuration } from '@/components/assistant-ui/work-segment'

// ── 文案（ZCode zh-CN 原文，硬编码——宿主无 i18n）───────────────────
const L = {
  panelTitle: '状态',
  showMini: '收起为胶囊',
  showPanel: '展开状态',
  displayMode: '状态面板展开策略',
  displayModeAuto: '自动展开',
  displayModeExpanded: '始终展开',
  displayModeCollapsed: '始终收起',
  environment: 'Git 工具',
  changes: '更改',
  todo: '进程',
  goal: '目标',
  sessionPlans: '会话计划',
  planFallback: '计划',
  terminals: '终端',
  agents: '智能体',
  goalActive: '进行中',
  goalPaused: '已暂停',
  goalComplete: '已完成',
  goalPause: '暂停目标',
  goalResume: '恢复目标',
  // ZCode 校验器面词表（chat.goalVerification.* zh 原文；failed 上游没有
  // 对应字串——宿主补一个中性词）。
  goalVerifying: '目标校验中',
  goalNotSatisfied: '目标未完成，任务继续',
  goalFailed: '目标校验失败',
  goalVerified: '目标已完成，任务结束',
  // rpi-goal v2 的停止词（ZCode 面板没有对应字串；宿主按插件真实语义补词）。
  goalBlocked: '已阻塞',
  goalWaiting: '等待中',
  goalUsageLimited: '用量受限',
  goalBudgetLimited: '预算耗尽',
  goalVerdictCancelled: '本轮未出校验结论',
  goalIteration: (n: number) => `第 ${n} 次迭代`,
  agentsRunning: (n: number) => `${n} 个运行中`,
  endedAgents: '已结束的智能体',
  workflows: '工作流',
  workflowsLive: (n: number) => `${n} 个运行中`,
  endedWorkflows: '已结束的工作流',
  workflowFallbackName: '工作流脚本',
  workflowStatusPending: '待启动',
  workflowStatusRunning: '运行中',
  workflowSteps: (done: number, total: number) => `${done}/${total} 步`,
  openWorkflowRun: '查看实例详情',
  stopAgent: '停止子代理',
  cancel: '停止',
  openPlan: (title: string) => `查看计划：${title}`,
  openAgent: '查看子代理详情',
} as const

// ── 显示策略（variant）──────────────────────────────────────────────
// override/持久化住在 status-panel-store（对话内容列的让位类要消费同一
// 份策略；本组件还负责把"此刻以面板形态在场"写回 store）。

// ── 可折叠分区（上游 StatusSection 逐条照抄）────────────────────────
type StatusSectionKind =
  | 'environment'
  | 'goal'
  | 'sessionPlans'
  | 'plan'
  | 'terminal'
  | 'workflow'
  | 'agent'

const STATUS_SECTION_SCROLL_POLICY = {
  environment: null,
  // 目标行最多 3 行，单条不滚；多条迭代（上游）也只是少量行。
  goal: 'max-h-48',
  // 计划目录通常个位数；超过后滚动。
  sessionPlans: 'max-h-48',
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: 'max-h-80',
  // 并行后台任务通常个位数；超过后滚动。
  terminal: 'max-h-48',
  // 并行工作流实例通常个位数；超过后滚动（上游同策略）。
  workflow: 'max-h-48',
  // 并行子代理通常个位数；超过后滚动。
  agent: 'max-h-48',
} as const satisfies Record<StatusSectionKind, string | null>

function StatusSectionHeader({
  children,
  isOpen,
  section,
  title,
}: {
  children?: ReactNode
  isOpen: boolean
  section: StatusSectionKind
  title: string
}) {
  return (
    <div className="mb-0.5 flex h-8 min-w-0 shrink-0 items-center gap-1.5 px-2 pr-8">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={isOpen}
          data-status-section-trigger={section}
          className="group flex min-w-0 shrink-0 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
        >
          <span className="text-foreground/45 shrink-0 text-[13px]">{title}</span>
          {isOpen ? (
            <ChevronDownIcon className="text-foreground/45 size-[var(--size-icon-sm)] shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          ) : (
            <ChevronRightIcon className="text-foreground/45 size-[var(--size-icon-sm)] shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          )}
        </button>
      </CollapsibleTrigger>
      {children ? (
        <div className="text-foreground/30 inline-flex min-w-0 max-w-full shrink items-center gap-1.5 text-[12px]">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function StatusSection({
  children,
  defaultOpen = true,
  footer,
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode
  defaultOpen?: boolean
  /** 固定在滚动视口之外的页脚（如已结束目录入口）：列表再长也滚不走它。 */
  footer?: ReactNode
  onOpenChange?: (open: boolean) => void
  open?: boolean
  separated?: boolean
  section: StatusSectionKind
  title: string
  trailing?: (isOpen: boolean) => ReactNode
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isControlled = open !== undefined
  const isOpen = open ?? uncontrolledOpen
  // 限高按完整区块类型表统一裁决（上游同判：漏配时直接触发类型检查）。
  const scrollViewportMaxHeightClass = STATUS_SECTION_SCROLL_POLICY[section]
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [isControlled, onOpenChange],
  )

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-status-section={section}
      className={cn('min-w-0 flex-none', separated && 'border-foreground/[0.06] border-t pt-2')}
    >
      <section className="min-w-0 flex-none">
        <StatusSectionHeader isOpen={isOpen} section={section} title={title}>
          {trailing?.(isOpen)}
        </StatusSectionHeader>
        <CollapsibleContent>
          {scrollViewportMaxHeightClass ? (
            // 滚动边界放在折叠内容层内部：固定区块标题，也不破坏高度动画（上游同判）
            <div
              data-status-section-scroll={section}
              className={cn(scrollViewportMaxHeightClass, 'min-h-0 overflow-x-hidden overflow-y-auto pr-1')}
            >
              {children}
            </div>
          ) : (
            children
          )}
          {footer}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** 「已结束的 X · N ›」页脚行（上游 EndedDirectoryRow 逐段照抄）：
 *  count<=0 或缺回调即整行缺席——一个点了没反应的入口比没有入口更糟。 */
function EndedDirectoryRow({
  count,
  icon,
  label,
  onOpen,
  separated,
}: {
  count: number
  icon: ReactNode
  label: string
  onOpen?: () => void
  separated: boolean
}) {
  if (count <= 0 || !onOpen) return null
  return (
    <div className={cn(separated && 'border-foreground/[0.06] border-t pt-2')}>
      <button
        type="button"
        className="text-foreground hover:bg-foreground/[0.04] focus-visible:ring-foreground/20 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="text-foreground/30 ml-auto">{count}</span>
        <ChevronRightIcon className="text-foreground/45 size-[var(--size-icon-md)]" />
      </button>
    </div>
  )
}

// ── 分区：Git 工具（上游 GitStatusSection + GitBranchSwitcher 数据面）─
/** 分支切换器（ZCode GitBranchSwitcher 的宿主移植）：当前分支行 → 弹层
 *  （搜索 + 本地分支列表）→ checkout。数据面 = fs_git_branches /
 *  fs_git_checkout（2026-11-01 新增 IPC，git 子进程，语义与审查面同源）；
 *  提交/推送不重复列——宿主由审查面板承担，「更改」行即入口。 */
function BranchSwitcherRow({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<{ name: string; isCurrent: boolean }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const { stat } = useGitBridge()
  const gitBranch = stat?.branch

  const load = useCallback(async (dir: string) => {
    setError(null)
    try {
      const list = await invoke<{ name: string; isCurrent: boolean }[]>('fs_git_branches', {
        path: dir,
      })
      setBranches(list)
    } catch (e) {
      console.error('[status-panel] 分支列表拉取失败', e)
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(cwd)
  }, [open, cwd, load])

  const checkout = async (name: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke('fs_git_checkout', { path: cwd, branch: name })
      setOpen(false)
      await gitBridge.getState().refresh(cwd)
    } catch (e) {
      // 脏工作区冲突等——错误可见（禁止静默假装切换成功）
      console.error('[status-panel] 分支切换失败', e)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const visible = (branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <Popover align="start" open={open} side="bottom" sideOffset={4}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label="切换分支"
          aria-expanded={open}
          className="text-foreground hover:bg-foreground/[0.04] focus-visible:ring-foreground/20 flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <CircleIcon className="text-foreground/30 size-[var(--size-icon-md)] shrink-0" />
          <span className="font-mono min-w-0 flex-1 truncate text-[12px]">
            {gitBranch ?? 'HEAD'}
          </span>
          <ChevronDownIcon className="text-foreground/45 size-[var(--size-icon-sm)] shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1">
        <div className="border-foreground/[0.06] shrink-0 border-b p-1" onKeyDown={(e) => e.stopPropagation()}>
          <div className="bg-foreground/[0.04] flex h-8 items-center gap-2 rounded-lg px-2.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索分支"
              className="text-(--text) placeholder:text-(--text-4) h-full w-full bg-transparent text-[13px] outline-none"
            />
          </div>
        </div>
        <div className="max-h-56 min-h-0 overflow-y-auto p-1">
          {error !== null && (
            <div role="alert" className="text-destructive px-2 py-2 text-[12px]">
              {error}
            </div>
          )}
          {branches === null && error === null ? (
            <div className="text-foreground/45 px-2 py-2 text-[13px]">加载中…</div>
          ) : null}
          {visible.map((b) => (
            <button
              key={b.name}
              type="button"
              disabled={busy}
              onClick={() => void checkout(b.name)}
              className={cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors',
                b.isCurrent ? 'text-foreground' : 'text-foreground/70 hover:bg-foreground/[0.04]',
                busy && 'opacity-40',
              )}
            >
              <span className="size-4 shrink-0 text-center">
                {b.isCurrent ? <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400 inline size-[var(--size-icon-md)]" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{b.name}</span>
            </button>
          ))}
          {branches !== null && visible.length === 0 && error === null ? (
            <div className="text-foreground/45 px-2 py-2 text-[13px]">没有匹配的分支</div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * 「提交或推送」行（上游 GitActionMenu 的 status-row 形态，宿主移植）。
 *
 * 上游在 Git 分区第三行放 commit/push/PR 主入口（GitActionMenu）；宿主
 * 首版把这块留给审查面板（有意差异），2026-11-17「全部对齐」轮按上游
 * 收回面板。数据面 = 同一套 fs_git_* IPC（commit / push / create_pr /
 * ship_info），错误如实显示在对话框内（规矩 12）。
 */
function GitActionRow({ cwd, git }: { cwd: string; git: StatusPanelGitModel }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ship, setShip] = useState<{ ghReady: boolean; prUrl: string | null }>({
    ghReady: false,
    prUrl: null,
  })

  const loadShip = useCallback(async () => {
    try {
      const info = await invoke<{ ghReady: boolean; pr: { url?: string } | null }>(
        'fs_git_ship_info',
        { path: cwd },
      )
      setShip({ ghReady: info.ghReady, prUrl: info.pr?.url ?? null })
    } catch (e) {
      console.error('[status-panel] ship 信息读取失败', e)
      setError(String(e))
    }
  }, [cwd])

  useEffect(() => {
    if (!open) return
    void loadShip()
  }, [open, loadShip])

  const run = async (action: 'commit' | 'commitPush' | 'push' | 'pr') => {
    if (busy) return
    setError(null)
    const trimmed = message.trim()
    if ((action === 'commit' || action === 'commitPush') && trimmed === '') {
      setError('提交信息不能为空')
      return
    }
    setBusy(true)
    try {
      if (action === 'commit' || action === 'commitPush') {
        await invoke('fs_git_commit', { path: cwd, message: trimmed, push: action === 'commitPush' })
      } else if (action === 'push') {
        await invoke('fs_git_push', { path: cwd })
      } else if (ship.prUrl) {
        await invoke('fs_open_url', { url: ship.prUrl })
        return
      } else {
        const { url } = await invoke<{ url: string }>('fs_git_create_pr', { path: cwd })
        if (url) await invoke('fs_open_url', { url })
      }
      await gitBridge.getState().refresh(cwd)
      void loadShip()
      setOpen(false)
      setMessage('')
    } catch (e) {
      // 错误可见（不静默假装成功）
      console.error('[status-panel] git 操作失败', action, e)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="提交或推送"
        onClick={() => setOpen(true)}
        className="text-foreground hover:bg-foreground/[0.04] focus-visible:ring-foreground/20 flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <GitCommitIcon className="text-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">提交或推送</span>
      </button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : (setOpen(false), setError(null)))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>提交或推送</DialogTitle>
            <DialogDescription>
              {git.dirtyFileCount} 个文件已更改 · {git.branchName ?? 'HEAD'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提交信息…（Ctrl+Enter 提交）"
              rows={3}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void run('commit')
                }
              }}
            />
            {error !== null ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={ship.prUrl ? '打开 PR' : '创建 PR'}
                title={ship.ghReady ? (ship.prUrl ? '打开 PR' : '创建 PR') : 'gh CLI 不可用或未登录'}
                disabled={!ship.ghReady || busy}
                onClick={() => void run('pr')}
                className={cn(ghostButton, 'size-7 shrink-0', (!ship.ghReady || busy) && 'opacity-40')}
              >
                <GitPullRequestIcon className="size-[var(--size-icon-md)]" />
              </button>
              <span className="flex-1" />
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('push')}
                className="text-foreground hover:bg-foreground/[0.06] flex h-8 items-center rounded-lg px-3 text-[13px] transition-colors disabled:opacity-40"
              >
                推送
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('commit')}
                className="text-foreground hover:bg-foreground/[0.06] flex h-8 items-center rounded-lg px-3 text-[13px] transition-colors disabled:opacity-40"
              >
                提交
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('commitPush')}
                className="bg-foreground text-background flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-opacity disabled:opacity-40"
              >
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                提交并推送
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function GitStatusSection({
  model,
  cwd,
  onOpenGitReview,
  separated,
}: {
  model: StatusPanelModel
  cwd: string
  onOpenGitReview?: () => void
  separated: boolean
}) {
  const git = model.git
  if (!git) return null
  const hasChanges = git.added + git.removed > 0
  const canOpenReview = Boolean(onOpenGitReview)

  return (
    <StatusSection
      section="environment"
      separated={separated}
      title={L.environment}
      trailing={(isOpen) =>
        isOpen ? null : (
          <span className="shrink-0 font-mono text-[12px] tabular-nums">
            <span className={cn('text-emerald-600 dark:text-emerald-400', !hasChanges && 'opacity-50')}>
              +{git.added}
            </span>{' '}
            <span className={cn('text-red-600 dark:text-red-400', !hasChanges && 'opacity-50')}>
              -{git.removed}
            </span>
          </span>
        )
      }
    >
      <div className="space-y-0">
        <button
          type="button"
          disabled={!canOpenReview}
          className={cn(
            'text-foreground hover:bg-foreground/[0.04] flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors',
            canOpenReview
              ? 'focus-visible:ring-foreground/20 focus-visible:ring-2 focus-visible:outline-none'
              : 'cursor-default opacity-50',
          )}
          onClick={onOpenGitReview}
        >
          <FileDiffIcon className="text-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{L.changes}</span>
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{git.added}</span>{' '}
            <span className="text-red-600 dark:text-red-400">-{git.removed}</span>
          </span>
        </button>
        {git.branchName !== null && <BranchSwitcherRow cwd={cwd} />}
        <GitActionRow cwd={cwd} git={git} />
      </div>
    </StatusSection>
  )
}

// ── 分区：目标（上游 GoalStatusSection；数据 = rpi-goal goal-state +
// rpi-goal-iterations 逐轮快照）────────────────────────────────────
/** 迭代行（上游 GoalStatusSection 的行结构逐条照抄）：完成轮 = 数字圆环，
 *  未完成 = 目标图标；标题取行的 title（首轮 = 目标标题，后续轮 =
 *  上一轮校验的 nextAction——rpi 无校验器时退回「第 N 次迭代」）；
 *  items 计数只在有 items 时出现（0/0 不渲染）。 */
function GoalIterationRow({
  row,
  verifying,
}: {
  row: ReturnType<typeof buildConversationGoalIterationSummaries>[number]
  /** 该轮正在校验（宿主在途态 `verifying.iteration === row.iteration`）。 */
  verifying: boolean
}) {
  const title = row.title ?? L.goalIteration(row.iteration)
  // 校验结论徽章（上游行里只有 `data-goal-verification-outcome` 属性；
  // 宿主把它渲染出来——结论词/颜色/提示语都来自真实结论，没有就不画）。
  const badge = verifying ? (
    <span title={L.goalVerifying} aria-label={L.goalVerifying} className="flex shrink-0">
      <LoaderCircle className="text-foreground/45 size-[var(--size-icon-sm)] animate-spin" />
    </span>
  ) : row.verificationOutcome === 'pass' ? (
    <span
      role="img"
      aria-label={L.goalVerified}
      title={row.verificationReason ?? L.goalVerified}
      className="flex shrink-0"
    >
      <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400 size-[var(--size-icon-sm)]" />
    </span>
  ) : row.verificationOutcome === 'notSatisfied' ? (
    <span
      role="img"
      aria-label={L.goalNotSatisfied}
      title={row.verificationReason ?? L.goalNotSatisfied}
      className="flex shrink-0"
    >
      <CircleAlertIcon className="size-[var(--size-icon-sm)] text-amber-600 dark:text-amber-400" />
    </span>
  ) : row.verificationOutcome === 'failed' ? (
    <span
      role="img"
      aria-label={L.goalFailed}
      title={row.verificationReason ?? L.goalFailed}
      className="flex shrink-0"
    >
      <XCircleIcon className="text-destructive size-[var(--size-icon-sm)]" />
    </span>
  ) : row.verificationOutcome === 'cancelled' ? (
    <span
      role="img"
      aria-label={L.goalVerdictCancelled}
      title={row.verificationReason ?? L.goalVerdictCancelled}
      className="flex shrink-0"
    >
      <CircleAlertIcon className="text-foreground/45 size-[var(--size-icon-sm)]" />
    </span>
  ) : null
  return (
    <div
      data-goal-iteration={row.iteration}
      data-goal-iteration-completed={row.completed}
      data-goal-verification-outcome={row.verificationOutcome ?? undefined}
      data-goal-verifying={verifying ? 'true' : undefined}
      title={title}
      className="hover:bg-foreground/[0.04] flex min-w-0 cursor-default items-start gap-2 rounded-lg px-2 py-2"
    >
      {row.completed ? (
        <span className="border-emerald-600 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums">
          {row.iteration}
        </span>
      ) : (
        <TargetIcon className="text-foreground/30 size-4 shrink-0" aria-hidden />
      )}
      <p className="text-foreground line-clamp-3 min-w-0 flex-1 text-[14px] leading-4">{title}</p>
      {badge}
      {row.totalCount > 0 ? (
        <span className="text-foreground/45 shrink-0 text-[12px] tabular-nums">
          {row.completedCount}/{row.totalCount}
        </span>
      ) : null}
    </div>
  )
}

function GoalStatusSection({
  goal,
  separated,
  onPauseGoal,
  onResumeGoal,
  actionPending,
  actionError,
}: {
  goal: StatusPanelGoalModel
  separated: boolean
  onPauseGoal?: () => void
  onResumeGoal?: () => void
  actionPending: boolean
  actionError: string | null
}) {
  // 展示态：rpi-goal v2 的 `verifying` 就是 status 本身；v1 宿主另写过
  // `verifying` 对象——parseGoalState 已把两条来源归一，这里只读现值。
  const displayStatus: StatusPanelGoalModel['status'] =
    goal.verifying !== null ? 'verifying' : goal.status
  // 用时秒针只看「在不在跑」这一个布尔（上游注释同文：不能以整个 goal
  // 对象为依赖重建 interval）。waiting / 停止词都不走秒针。
  const ticking =
    displayStatus === 'active' ||
    displayStatus === 'verifying' ||
    displayStatus === 'notSatisfied'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])
  const elapsedSeconds = goalElapsedSeconds(goal, now)
  const statusLabel =
    displayStatus === 'paused'
      ? L.goalPaused
      : displayStatus === 'verified'
        ? L.goalComplete
        : displayStatus === 'verifying'
          ? L.goalVerifying
          : displayStatus === 'notSatisfied'
            ? L.goalNotSatisfied
            : displayStatus === 'failed'
              ? L.goalFailed
              : displayStatus === 'blocked'
                ? L.goalBlocked
                : displayStatus === 'waiting'
                  ? L.goalWaiting
                  : displayStatus === 'usageLimited'
                    ? L.goalUsageLimited
                    : displayStatus === 'budgetLimited'
                      ? L.goalBudgetLimited
                      : L.goalActive
  const iterationRows = useMemo(
    () => buildConversationGoalIterationSummaries(goal),
    [goal],
  )
  // 在途校验的迭代行（v2 的 verifyIteration 是权威行号；v1 只剩 rows 可推，
  // 按最大 iteration 判定——rows 会被「完成优先」重排，不能用数组末位）。
  const verifyingIteration =
    displayStatus === 'verifying'
      ? (goal.verifying?.iteration ??
        goal.iterations.reduce((max, row) => Math.max(max, row.iteration), 0))
      : null
  // 控制：active/verifying/notSatisfied/waiting → 暂停；paused 与 v2 的各
  // 停止词（blocked/usageLimited/budgetLimited/failed）→ 恢复；verified → 完成图标。
  const isPausable =
    displayStatus === 'active' ||
    displayStatus === 'verifying' ||
    displayStatus === 'notSatisfied' ||
    displayStatus === 'waiting'
  const isResumable =
    displayStatus === 'paused' ||
    displayStatus === 'blocked' ||
    displayStatus === 'usageLimited' ||
    displayStatus === 'budgetLimited' ||
    displayStatus === 'failed'
  const control =
    isPausable && onPauseGoal !== undefined ? (
      <button
        type="button"
        data-goal-action="pause"
        disabled={actionPending}
        aria-label={L.goalPause}
        title={L.goalPause}
        onClick={onPauseGoal}
        className={cn(ghostButton, 'size-6 shrink-0', actionPending && 'opacity-40')}
      >
        <PauseIcon className="size-3.5" />
      </button>
    ) : isResumable && onResumeGoal !== undefined ? (
      <button
        type="button"
        data-goal-action="resume"
        disabled={actionPending}
        aria-label={L.goalResume}
        title={L.goalResume}
        onClick={onResumeGoal}
        className={cn(ghostButton, 'size-6 shrink-0', actionPending && 'opacity-40')}
      >
        <PlayIcon className="size-3.5" />
      </button>
    ) : displayStatus === 'verified' ? (
      <CheckCircle2Icon
        aria-label={L.goalComplete}
        className="text-emerald-600 dark:text-emerald-400 size-4 shrink-0"
      />
    ) : null
  const showBudget = goal.maxTurns !== null && goal.maxTurns > 0

  return (
    <StatusSection
      section="goal"
      separated={separated}
      title={L.goal}
      trailing={() => (
        <>
          <span className="shrink-0 tabular-nums" data-goal-elapsed-seconds={elapsedSeconds ?? undefined}>
            {elapsedSeconds === null ? statusLabel : formatWorkDuration(elapsedSeconds * 1000)}
          </span>
          {control ? <span className="shrink-0">·</span> : null}
          {control}
        </>
      )}
    >
      <div className="space-y-0">
        {/* notes / 轮次预算是宿主真字段（上游 goal 没有这两项）——守在迭代行
            上方一行小字，不占行数。 */}
        {goal.notes.trim() !== '' || showBudget ? (
          <div className="text-foreground/45 flex min-w-0 items-start gap-2 px-2 pt-1 pb-0.5 text-[12px] leading-4">
            <p className="line-clamp-2 min-w-0 flex-1">{goal.notes.trim()}</p>
            {showBudget ? (
              <span className="shrink-0 tabular-nums">
                {goal.turnsUsed}/{goal.maxTurns}
              </span>
            ) : null}
          </div>
        ) : null}
        {iterationRows.map((row) => (
          <GoalIterationRow
            key={row.iteration}
            row={row}
            verifying={
              verifyingIteration !== null
                ? row.iteration === verifyingIteration
                : goal.verifying?.iteration === row.iteration
            }
          />
        ))}
        {actionError !== null ? (
          <p role="alert" className="text-destructive px-2 py-1 text-[12px]">
            {actionError}
          </p>
        ) : null}
      </div>
    </StatusSection>
  )
}

// ── 分区：会话计划（上游 SessionPlansStatusSection；数据 = rpi-plan-mode）──
function SessionPlansStatusSection({
  model,
  separated,
  onOpenPlan,
}: {
  model: StatusPanelModel
  separated: boolean
  onOpenPlan?: (item: StatusPanelSessionPlanItem) => void
}) {
  const sessionPlans = model.sessionPlans
  if (!sessionPlans) return null

  return (
    <StatusSection
      section="sessionPlans"
      separated={separated}
      title={L.sessionPlans}
      trailing={() => <span className="tabular-nums">{sessionPlans.items.length}</span>}
    >
      <ul className="space-y-0">
        {sessionPlans.items.map((item) => {
          const title = item.title ?? L.planFallback
          const canOpen = Boolean(onOpenPlan)
          return (
            <li key={item.entryId}>
              <button
                type="button"
                data-plan-directory-entry-id={item.entryId}
                disabled={!canOpen}
                aria-label={L.openPlan(title)}
                onClick={() => onOpenPlan?.(item)}
                className={cn(
                  'text-foreground focus-visible:ring-foreground/20 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none',
                  canOpen && 'hover:bg-foreground/[0.04]',
                )}
              >
                <ListChecksIcon className="text-foreground/45 size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </StatusSection>
  )
}

// ── 会话计划详情 = 面板栏标签页（status-pane-openers，上游 side tab 对偶）──

// ── 分区：进程（Todo，上游 PlanStatusSection 全套）──────────────────
function PlanStatusIcon({ status }: { status: StatusPanelPlanItem['status'] }) {
  if (status === 'completed') {
    return (
      <CheckCircle2Icon aria-hidden className="text-emerald-600 dark:text-emerald-400 mt-0.5 size-[var(--size-icon-sm)] shrink-0" />
    )
  }
  if (status === 'inProgress') {
    return <ArrowRightIcon aria-hidden className="text-foreground mt-0.5 size-[var(--size-icon-sm)] shrink-0" />
  }
  return <CircleIcon aria-hidden className="text-foreground/30 mt-0.5 size-[var(--size-icon-sm)] shrink-0" />
}

function PlanStatusItemRows({ items }: { items: StatusPanelPlanItem[] }) {
  return items.map((item) => (
    <li
      key={item.id}
      data-plan-status={item.status}
      className="hover:bg-foreground/[0.04] flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]"
    >
      <PlanStatusIcon status={item.status} />
      <span
        title={item.content}
        className={cn(
          'line-clamp-2 min-w-0 flex-1 break-words leading-5',
          item.status === 'completed' ? 'text-foreground/30 line-through' : 'text-foreground',
        )}
      >
        {item.content}
      </span>
    </li>
  ))
}

/** 折叠组预览（上游 HoverCard 的宿主替身：motion Popover trigger="hover"）。 */
function TodoHiddenGroupPreview({
  label,
  items,
}: {
  label: string
  items: StatusPanelPlanItem[]
}) {
  return (
    <Popover align="start" side="bottom" sideOffset={4} trigger="hover">
      {/* PopoverTrigger 克隆唯一子元素（无 asChild——beui 原版 API） */}
      <PopoverTrigger>
        <button
          type="button"
          aria-label={label}
          className="text-foreground/45 hover:bg-foreground/[0.04] focus-visible:ring-foreground/20 flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
        >
          <ChevronLeftIcon className="size-[var(--size-icon-sm)] shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3">
        <div className="flex max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 flex-col">
          <p className="text-foreground/45 flex h-8 shrink-0 items-center px-2 text-[13px]">{label}</p>
          <ul className="min-h-0 space-y-0 overflow-y-auto pr-1">
            <PlanStatusItemRows items={items} />
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function foldLabel(items: StatusPanelPlanItem[], kind: 'preceding' | 'following'): string {
  if (kind === 'preceding') {
    return items.every((item) => item.status === 'completed')
      ? `已完成 ${items.length} 项`
      : `前面 ${items.length} 项`
  }
  return items.every((item) => item.status === 'pending')
    ? `待处理 ${items.length} 项`
    : `后面 ${items.length} 项`
}

function PlanStatusItems({ plan }: { plan: NonNullable<StatusPanelModel['plan']> }) {
  const window = getStatusPanelTodoFocusWindow(plan.displayItems)

  return (
    <ul className="space-y-0 pb-1">
      {window.compact && window.precedingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            items={window.precedingItems}
            label={foldLabel(window.precedingItems, 'preceding')}
          />
        </li>
      ) : null}
      <PlanStatusItemRows items={window.focusItems} />
      {window.compact && window.followingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            items={window.followingItems}
            label={foldLabel(window.followingItems, 'following')}
          />
        </li>
      ) : null}
    </ul>
  )
}

function PlanStatusSection({
  model,
  separated,
}: {
  model: StatusPanelModel
  separated: boolean
}) {
  const plan = model.plan
  if (!plan) return null
  const isCompleted = plan.totalCount > 0 && plan.completedCount >= plan.totalCount

  return (
    <StatusSection
      section="plan"
      separated={separated}
      title={L.todo}
      trailing={() => (
        <span
          className={cn(
            'tabular-nums',
            isCompleted ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground/45',
          )}
        >
          {plan.completedCount}/{plan.totalCount}
        </span>
      )}
    >
      <PlanStatusItems
        key={plan.displayItems
          .map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`)
          .join('\u0001')}
        plan={plan}
      />
    </StatusSection>
  )
}

// ── 分区：终端（上游 BackgroundWorkStatusSection；数据 = pi_job_list）──
/** 真源 = rpi-background-tasks 插件每次作业状态变化追加的 `background-tasks`
 *  会话快照（宿主 pi_job_list 只读投影）。插件未安装 / 无作业 → works 为空 →
 *  整区不渲染（上游"无数据不渲染"同判）。行 = 标签（或命令行）+ 用时；
 *  Stop 不渲染：kill 面在插件进程内（Job Object），宿主没有按 id 终止面。 */
function TerminalStatusSection({
  model,
  separated,
  open,
  onOpenChange,
  onCancelJob,
}: {
  model: StatusPanelModel
  separated: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCancelJob?: (jobId: string) => void
}) {
  const works = model.runningJobs
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (works.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [works.length])
  const ordered = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  )
  if (works.length === 0) return null

  const longestMs = ordered.reduce(
    (longest, work) => Math.max(longest, Math.max(0, now - work.startedAt)),
    0,
  )

  return (
    <StatusSection
      section="terminal"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={L.terminals}
      trailing={(isOpen) =>
        isOpen ? (
          <span>{L.agentsRunning(works.length)}</span>
        ) : (
          <>
            <span className="min-w-0 truncate tabular-nums">
              {formatWorkDuration(Math.max(1000, Math.floor(longestMs / 1000) * 1000))}
            </span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{L.agentsRunning(works.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((work) => (
          <li
            key={work.workId}
            data-slot="aui_status-terminal-row"
            data-work-id={work.workId}
            className="hover:bg-foreground/[0.04] flex min-w-0 items-start gap-2 rounded-lg px-2 py-2"
          >
            <SquareTerminalIcon className="text-foreground/45 mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-foreground line-clamp-2 font-mono text-[13px] leading-5">
                {work.title}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-foreground/45 shrink-0 text-[13px] tabular-nums">
                  {formatWorkDuration(Math.max(0, now - work.startedAt))}
                </span>
                {work.cancellable && onCancelJob ? (
                  <button
                    type="button"
                    className="text-foreground hover:bg-foreground/[0.06] ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] transition-colors"
                    onClick={() => onCancelJob(work.workId)}
                  >
                    <SquareIcon aria-hidden className="size-3 fill-current" />
                    {L.cancel}
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 分区：智能体（上游 SubagentStatusSection 的宿主派生面）───────────
/** 数据 = 本线程的 delegate_task / subagent / dispatch 工具调用：
 *  运行中 = 无 timing.completedAt；已结束 = 有完成时间（目录行计数）。
 *  rpi 子代理运行态在插件进程内（hub_roster 如实 Err），工具调用是唯一
 *  真值；行点击开既有子代理详情页（openSubagentDetail）。 */
function AgentStatusSection({
  model,
  separated,
  open,
  onOpenChange,
  onOpenAgent,
  onOpenDirectory,
  onStopAgent,
}: {
  model: StatusPanelModel
  separated: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenAgent?: (agent: StatusPanelAgentRow) => void
  onOpenDirectory?: () => void
  onStopAgent?: (agentId: string) => void
}) {
  const agents = model.runningAgents
  const endedCount = model.endedAgentCount
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (agents.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [agents.length])
  const ordered = useMemo(
    () => [...agents].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    [agents],
  )
  if (agents.length === 0 && endedCount <= 0) return null
  const longestMs = ordered.reduce(
    (longest, agent) => Math.max(longest, Math.max(0, now - (agent.startedAt ?? now))),
    0,
  )

  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={L.agents}
      trailing={(isOpen) =>
        agents.length === 0 ? null : isOpen ? (
          <span>{L.agentsRunning(agents.length)}</span>
        ) : (
          <>
            <span className="min-w-0 truncate tabular-nums">
              {formatWorkDuration(Math.max(1000, Math.floor(longestMs / 1000) * 1000))}
            </span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{L.agentsRunning(agents.length)}</span>
          </>
        )
      }
      footer={
        <EndedDirectoryRow
          count={endedCount}
          icon={<CheckCircle2Icon className="text-foreground/45 size-4 shrink-0" />}
          label={L.endedAgents}
          separated={agents.length > 0}
          onOpen={onOpenDirectory}
        />
      }
    >
      <ul className="space-y-0">
        {ordered.map((agent) => (
          <li
            key={agent.id}
            data-slot="aui_status-agent-row"
            data-agent-tool-call-id={agent.id}
            className={cn(
              'group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-foreground/[0.04]',
              onOpenAgent && 'cursor-pointer',
            )}
          >
            {onOpenAgent ? (
              // 行同时含"打开详情"与潜在操作，透明同级按钮承接详情
              // （上游同款：避免嵌套按钮）。
              <button
                type="button"
                aria-label={L.openAgent}
                onClick={() => onOpenAgent(agent)}
                className="focus-visible:ring-foreground/20 absolute inset-0 z-0 rounded-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
              />
            ) : null}
            <span className="pointer-events-none relative z-[1] flex h-5 w-3.5 shrink-0 items-center justify-center">
              <BotIcon className="text-muted-foreground size-3.5" aria-hidden />
            </span>
            <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-foreground line-clamp-2 text-[14px] leading-5">{agent.title}</span>
              <span className="text-muted-foreground text-[14px] leading-5 tabular-nums">
                {agent.startedAt === null ? '—' : formatWorkDuration(Math.max(0, now - agent.startedAt))}
              </span>
            </div>
            {agent.stoppable && onStopAgent ? (
              <button
                type="button"
                aria-label={L.stopAgent}
                title={L.stopAgent}
                onClick={(event) => {
                  event.stopPropagation()
                  onStopAgent(agent.id)
                }}
                className="text-foreground hover:bg-foreground/[0.06] relative z-[2] ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] transition-colors"
              >
                <SquareIcon aria-hidden className="size-3 fill-current" />
                {L.cancel}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 分区：工作流（上游 WorkflowStatusSection 的宿主派生面）────────────
/** 单盏状态灯（上游 WorkflowRunLamp 同形：pending 空心、running 脉冲）。 */
function WorkflowRunLamp({ status }: { status: 'pending' | 'running' }) {
  return (
    <span
      aria-hidden="true"
      data-workflow-run-lamp={status}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'pending'
          ? 'border-foreground/40 border'
          : 'animate-pulse bg-emerald-600 dark:bg-emerald-400',
      )}
    />
  )
}

/** run 行（上游 WorkflowRunRow 的两行结构：名字 + 时长 / 灯 + 在做什么）；
 *  Stop 按上游 WorkflowRunStopButton（悬停显形、盖在时长上的幽灵钮）：
 *  rpi 的 dispatch 是**轮内的工具调用**，引擎的 per-call 取消链
 *  （run abort → 插件 ABI cancel → Control → 杀进程组 + 未启动节点回
 *  pending）经由 pi_interrupt 可达——停的是这一轮 dispatch，不是造面。
 *  详情按钮 = 面板栏标签页（openWorkflowRun），与上游 onOpenWorkflowRun 同义。 */
function WorkflowRunRow({
  run,
  now,
  onOpen,
  onCancel,
}: {
  run: StatusPanelWorkflowRun
  now: number
  onOpen?: (run: StatusPanelWorkflowRun) => void
  onCancel?: () => void
}) {
  const name = workflowRunDisplayName(run)
  const displayName = name ?? L.workflowFallbackName
  const words = workflowRunWords(run)
  const wordsText =
    words === null
      ? null
      : words.kind === 'status'
        ? words.status === 'pending'
          ? L.workflowStatusPending
          : L.workflowStatusRunning
        : L.workflowSteps(words.done, words.total)
  const elapsed =
    run.startedAt === null
      ? null
      : formatWorkDuration(Math.max(0, now - run.startedAt))
  return (
    <li
      data-workflow-run-id={run.runId}
      data-work-status={run.status}
      className={cn(
        'group/wf-run hover:bg-foreground/[0.04] relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg p-2',
        onOpen && 'cursor-pointer',
      )}
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={`${L.openWorkflowRun} ${displayName}`}
          title={displayName}
          onClick={() => onOpen(run)}
          className="focus-visible:ring-foreground/20 absolute inset-0 z-0 rounded-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
        />
      ) : null}
      <Workflow className="text-foreground/45 pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 self-start" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-0.5">
        <div className="flex h-5 min-w-0 items-baseline gap-2 leading-5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[14px]',
              name ? 'text-foreground' : 'text-foreground/45',
            )}
          >
            {displayName}
          </span>
          {elapsed !== null ? (
            <span className="text-foreground/45 shrink-0 text-[12px] tabular-nums">{elapsed}</span>
          ) : null}
        </div>
        {wordsText !== null ? (
          <div className="text-foreground/45 flex h-4.5 min-w-0 items-center gap-1.5 text-[13px]">
            <WorkflowRunLamp status={run.status === 'pending' ? 'pending' : 'running'} />
            <span className="min-w-0 flex-1 truncate">{wordsText}</span>
          </div>
        ) : null}
      </div>
      {run.status === 'running' && onCancel ? (
        <button
          type="button"
          aria-label={L.cancel}
          data-workflow-run-stop
          onClick={(event) => {
            event.stopPropagation()
            onCancel()
          }}
          className={cn(
            'bg-[var(--surface)] text-foreground pointer-events-none absolute top-1.5 right-1.5 z-[2] flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] opacity-0 transition-opacity',
            'hover:bg-foreground/[0.08]',
            'group-hover/wf-run:pointer-events-auto group-hover/wf-run:opacity-100 group-focus-within/wf-run:pointer-events-auto group-focus-within/wf-run:opacity-100',
            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100',
          )}
        >
          <SquareIcon aria-hidden className="size-2.5 fill-current [@media(hover:none)]:size-3" />
          <span className="[@media(hover:none)]:sr-only">{L.cancel}</span>
        </button>
      ) : null}
    </li>
  )
}

/** Workflows 分区（上游 WorkflowStatusSection）：活动行 + 已结束目录页脚；
 *  `runs.length === 0 && endedRunCount <= 0` 整区不渲染。数据 = 本线程的
 *  plan / dispatch 调用派生（`status-workflow-runs.ts`），无数据不造假。 */
function WorkflowStatusSection({
  model,
  separated,
  open,
  onOpenChange,
  onOpenRun,
  onOpenDirectory,
  onCancelRun,
}: {
  model: StatusPanelModel
  separated: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenRun?: (run: StatusPanelWorkflowRun) => void
  onOpenDirectory?: () => void
  onCancelRun?: () => void
}) {
  const runs = model.runningWorkflows
  const endedRunCount = model.endedWorkflowCount
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (runs.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runs.length])
  if (runs.length === 0 && endedRunCount <= 0) return null

  return (
    <StatusSection
      section="workflow"
      defaultOpen={runs.length > 0}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={L.workflows}
      trailing={() =>
        runs.length > 0 ? (
          <>
            <WorkflowRunLamp status="running" />
            <span>{L.workflowsLive(runs.length)}</span>
          </>
        ) : null
      }
      footer={
        <EndedDirectoryRow
          count={endedRunCount}
          icon={<CheckCircle2Icon className="text-foreground/45 size-4 shrink-0" />}
          label={L.endedWorkflows}
          separated={runs.length > 0}
          onOpen={onOpenDirectory}
        />
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => (
          <WorkflowRunRow
            key={run.runId}
            run={run}
            now={now}
            onOpen={onOpenRun}
            onCancel={run.status === 'running' ? onCancelRun : undefined}
          />
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 已结束智能体目录 = 面板栏标签页（status-pane-openers，上游 side tab 对偶）──

// ── mini 胶囊（上游 StatusSummaryRow，完整优先级链）───────────────────
function StatusSummaryMetric({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="text-foreground flex h-8 w-max max-w-full min-w-0 items-center gap-1.5 pl-2 pr-3 text-[13px]">
      <span className="relative size-4 shrink-0">
        <span className="absolute inset-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
          {icon}
        </span>
        <Maximize2Icon className="text-foreground absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      {children}
    </div>
  )
}

function getCurrentPlanItem(plan: StatusPanelModel['plan']) {
  return (
    plan?.items.find((item) => item.status === 'inProgress') ??
    plan?.items.find((item) => item.status === 'pending') ??
    null
  )
}

function getCompletedPlanItem(plan: StatusPanelModel['plan']) {
  return [...(plan?.items ?? [])].reverse().find((item) => item.status === 'completed') ?? null
}

function StatusSummaryRow({
  model,
  onVariantChange,
}: {
  model: StatusPanelModel
  onVariantChange?: (variant: 'panel') => void
}) {
  const currentPlanItem = getCurrentPlanItem(model.plan)
  const completedPlanItem = getCompletedPlanItem(model.plan)
  const goalTitle = model.goal?.title ?? null
  // v2 停止词（blocked / waiting / usage_limited / budget_limited）仍是"在场
  // 的目标"，胶囊按活跃项展示；只有 verified 走完成位。
  const isActiveGoal =
    model.goal?.status === 'active' ||
    model.goal?.status === 'paused' ||
    model.goal?.status === 'verifying' ||
    model.goal?.status === 'notSatisfied' ||
    model.goal?.status === 'blocked' ||
    model.goal?.status === 'waiting' ||
    model.goal?.status === 'usageLimited' ||
    model.goal?.status === 'budgetLimited' ||
    model.goal?.status === 'failed'
  const isDoneGoal = model.goal?.status === 'verified'
  const added = model.git?.added ?? 0
  const removed = model.git?.removed ?? 0
  const hasGitMiniSummary = Boolean(model.git && added + removed > 0)
  const latestSessionPlan = model.sessionPlans?.items[0] ?? null
  const runningCount = model.runningJobs.length + model.runningAgents.length
  const hasRunningJobs = model.runningJobs.length > 0
  const hasRunningAgents = model.runningAgents.length > 0
  const RunningSummaryIcon =
    hasRunningJobs && hasRunningAgents
      ? ActivityIcon
      : hasRunningJobs
        ? SquareTerminalIcon
        : BotIcon

  // 优先级链（上游 StatusSummaryRow 同序）：当前待办 → 目标(活) → git 变更
  // → 目标(完) → 最近完成项 → 待办计数 → 最新会话计划 → 运行计数 → 无
  // （无摘要项时胶囊不渲染——上游同款）。
  const summaryMetric = currentPlanItem ? (
    <StatusSummaryMetric icon={<ArrowRightIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{currentPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isActiveGoal ? (
    <StatusSummaryMetric icon={<TargetIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : hasGitMiniSummary ? (
    <StatusSummaryMetric icon={<FileDiffIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{L.changes}</span>
      <span className="text-emerald-600 dark:text-emerald-400 shrink-0">+{added}</span>
      <span className="text-red-600 dark:text-red-400 shrink-0">-{removed}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isDoneGoal ? (
    <StatusSummaryMetric icon={<TargetIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : completedPlanItem ? (
    <StatusSummaryMetric icon={<CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400 size-4" />}>
      <span className="min-w-0 truncate">{completedPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : model.plan ? (
    <StatusSummaryMetric icon={<ListChecksIcon className="text-foreground/45 size-4" />}>
      <span className="min-w-0 truncate">{L.todo}</span>
      <span className="text-foreground/45 shrink-0">
        {model.plan.completedCount}/{model.plan.totalCount}
      </span>
    </StatusSummaryMetric>
  ) : latestSessionPlan ? (
    <StatusSummaryMetric icon={<ListChecksIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{latestSessionPlan.title ?? L.planFallback}</span>
    </StatusSummaryMetric>
  ) : runningCount > 0 ? (
    <StatusSummaryMetric icon={<RunningSummaryIcon className="text-foreground size-4" />}>
      <span className="shrink-0">
        {hasRunningAgents && !hasRunningJobs
          ? L.agentsRunning(runningCount)
          : `${runningCount} 个运行中`}
      </span>
    </StatusSummaryMetric>
  ) : null

  if (!summaryMetric) {
    return null
  }

  return (
    <button
      type="button"
      aria-label={L.showPanel}
      title={L.showPanel}
      className="hover:bg-foreground/[0.06] focus-visible:ring-foreground/20 group inline-flex w-max max-w-full cursor-pointer flex-col items-stretch rounded-2xl text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      onClick={() => onVariantChange?.('panel')}
    >
      {summaryMetric}
    </button>
  )
}

// 智能体行的派生面在 `status-agent-rows.ts`（纯函数：delegate_task /
// subagent / dispatch 三种工具调用 → 运行/已结束两段，可单测）。

// ── 面板主体（上游 ConversationStatusPanelImpl 结构）────────────────
const statusPanelApi = (): DockviewApi | null => {
  const a = (globalThis as { __dvApi?: DockviewApi }).__dvApi
  return a ?? null
}

function ConversationStatusPanelImpl() {
  // **draft 态不挂**（上游同款：SessionPane 只在有会话时渲染本面板）——
  // New Chat / 启动无会话时没有工作区可查，面包屑也还不存在。
  // panel 的卸载闸门在渲染处照抄上游（`!model.hasContent → null`；
  // 2026-11-17 用户「全部对齐」轮推翻了 2026-11-15 的"常驻空态"宿主选择）。
  const activeId = useStore(sessionCatalog, (s) => s.activeId)
  const { todo } = useTodoBridge()
  const { stat: gitStat } = useGitBridge()
  const { jobs } = useJobsBridge()
  const { agents: childAgents } = useChildAgentsBridge()
  const { entries: planEntries } = usePlanEntriesBridge()
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const threadMessages = useAuiState((s) => s.thread.messages)
  // 活动会话工作区（git 变更统计的目标目录）；数据源与对话栏列头同源
  const cwd = useStore(sessionCatalog, (s) =>
    sessionProjectCwd(s.activeId ? s.entries[s.activeId] : undefined, s.pendingCwd),
  )

  const override = useStore(statusPanelStore, (s) => s.override)

  const variant: StatusPanelVariant = override ?? 'auto'
  useEffect(() => {
    statusPanelStore.getState().setMounted(true)
    return () => statusPanelStore.getState().setMounted(false)
  }, [])

  // 挂载/聚焦拉取：待办重放 + git 变更统计 + 后台任务 + 计划目录。
  // git/待办随 cwd 变化；计划与任务在 run 收尾时也要重拉（都发生在轮之间）。
  useEffect(() => {
    void todoBridge.getState().refresh()
    void gitBridge.getState().refresh(cwd ?? null)
    void planEntriesBridge.getState().refresh()
    void jobsBridge.getState().refresh()
    void childAgentsBridge.getState().refresh()
  }, [cwd, isRunning, activeId])

  // run 进行中：插件作业/待办/计划条目会在**轮中途**追加会话条目（background
  // 工具起作业、todo 更新、plan_mode_complete），没有事件面可推，运行期 2s 轮询
  // 才能让「终端 / 进程」分区在跑的时候就在场（上游面板订阅会话投影，同语义）。
  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => {
      void jobsBridge.getState().refresh()
      void todoBridge.getState().refresh()
      void planEntriesBridge.getState().refresh()
      void childAgentsBridge.getState().refresh()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  // 后台作业会**跨轮存活**：60s 任务在本轮回复结束后才收尾，settle 发生在
  // run 之外。没有事件面，挂载期常驻一条慢轮询（3s）兜住收尾，否则行会
  // 永远停在「运行中」。插件未安装时 pi_job_list 返回 []，开销可忽略。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void jobsBridge.getState().refresh()
      void childAgentsBridge.getState().refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  // 目标态：条目随 goal 工具/命令变化；3s 轮询（宿主没有 goal 事件面）。
  const [goalRaw, setGoalRaw] = useState<unknown>(null)
  const refreshGoal = useCallback(() => {
    invoke<unknown>('pi_goal_state')
      .then((raw) => setGoalRaw(raw))
      .catch((e) => console.error('[status-panel] pi_goal_state 读取失败', e))
  }, [])
  useEffect(() => {
    let cancelled = false
    const fetchGoal = () => {
      invoke<unknown>('pi_goal_state')
        .then((raw) => {
          if (!cancelled) setGoalRaw(raw)
        })
        .catch((e) => console.error('[status-panel] pi_goal_state 读取失败', e))
    }
    fetchGoal()
    const timer = window.setInterval(fetchGoal, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeId, isRunning, refreshGoal])

  // 智能体行：引擎名册（真值，可 Stop） + 工具调用派生（已结束目录）。
  const agentRows = useMemo(
    () => deriveAgentRows(threadMessages as readonly unknown[]),
    [threadMessages],
  )
  // 工作流行：本线程 plan / dispatch 工具调用派生（rpi-orchestrator 的 DAG
  // 是唯一真值面；活动 = pending/running，终态折进目录计数）。
  const workflowRuns = useMemo(
    () => deriveWorkflowRuns(threadMessages as readonly unknown[]),
    [threadMessages],
  )
  const engineRunningAgents = useMemo<StatusPanelAgentRow[]>(
    () =>
      childAgents
        .filter((agent) => agent.status === 'running')
        .map((agent) => ({
          id: agent.childId,
          title: agent.taskPreview !== '' ? agent.taskPreview : agent.role,
          startedAt: agent.startedMs,
          stoppable: true,
        })),
    [childAgents],
  )

  const model = useMemo(
    () =>
      buildStatusPanelModel({
        todoTasks: todo === null ? [] : flatTasks(todo),
        git: gitStat,
        goalRaw,
        planEntries,
        jobs: jobs
          .filter((job) => job.status === 'running')
          .map((job) => ({
            id: job.id,
            command: job.command ?? '后台作业',
            ...(job.label !== null ? { label: job.label } : {}),
            startedAtMs: job.startedAtMs,
            // 插件注册了 `/jobs kill <id>` 命令面（Job Object 在该进程内），
            // 宿主 pi_job_cancel 转发；新状态由插件快照如实回写。
            cancellable: true,
          })),
        runningAgents:
          engineRunningAgents.length > 0 ? engineRunningAgents : agentRows.running,
        endedAgentCount: agentRows.ended.length,
        runningWorkflows: workflowRuns.running,
        endedWorkflowCount: workflowRuns.ended.length,
      }),
    [todo, gitStat, goalRaw, planEntries, jobs, agentRows, engineRunningAgents, workflowRuns],
  )

  // 面板在场 → 写共享 store（对话内容列的让位判定；卸载即清除）。
  // **必须与渲染闸门同判**（`activeId !== null && hasContent`）：组件总会
  // 挂载，早先无条件 setMounted(true) 会让"面板渲染为 null 的会话"也把
  // 对话列左移收窄 10.5rem / 24rem，右侧留一片空白（用户 11-18 报障）。
  const panelVisible = variant !== 'hidden' && activeId !== null && model.hasContent
  useEffect(() => {
    statusPanelStore.getState().setMounted(panelVisible)
    return () => statusPanelStore.getState().setMounted(false)
  }, [panelVisible])

  // 分区开合 = 上游受控 state 语义（SessionPane 同款）：终端/智能体默认
  // 折起、归零折起、换会话复位；展开由用户点击分区头或 composer 徽标
  // （expandRequest，2026-11-20「全部对齐功能」轮接通——上游
  // handleOpenRunningBackgroundWorks 的宿主对偶）。
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  useEffect(() => {
    setTerminalOpen(false)
    setAgentOpen(false)
  }, [activeId])
  useEffect(() => {
    if (model.runningJobs.length === 0) setTerminalOpen(false)
  }, [model.runningJobs.length])
  useEffect(() => {
    if (model.runningAgents.length === 0) setAgentOpen(false)
  }, [model.runningAgents.length])
  // 工作流分区改受控，语义照上游 SessionPane 的 hasLiveWorkflowRun 翻转写入：
  // 在跑数 0→≥1 打开、归零折起、换会话按该会话重判。只在这个布尔翻转（或换
  // 会话）时写入，所以用户手动折起后 run 还在跑就一直保持折起。此前非受控
  // （defaultOpen）也能工作；改受控是因为 composer 徽标需要驱动它——2026-11-18
  // 踩过的坑是"受控且没有翻转写入"，不是受控本身。
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const hasLiveWorkflowRun = model.runningWorkflows.length > 0
  useEffect(() => {
    setWorkflowOpen(hasLiveWorkflowRun)
  }, [hasLiveWorkflowRun, activeId])
  // 徽标展开请求：一次消费（nonce 变化才应用），三个分区独立置位。
  const expandRequest = useStore(statusPanelStore, (s) => s.expandRequest)
  useEffect(() => {
    if (expandRequest === null) return
    setTerminalOpen(expandRequest.terminal)
    setAgentOpen(expandRequest.agent)
    setWorkflowOpen(expandRequest.workflow)
    statusPanelStore.getState().consumeExpandRequest()
  }, [expandRequest])

  // 目标暂停/恢复（rpi-goal 扩展命令 /goal pause|resume）。
  const [goalActionPending, setGoalActionPending] = useState(false)
  const [goalActionError, setGoalActionError] = useState<string | null>(null)
  const runGoalCommand = useCallback(
    async (args: 'pause' | 'resume') => {
      if (goalActionPending) return
      setGoalActionPending(true)
      setGoalActionError(null)
      try {
        await invoke('pi_run_command', { command: '/goal', args })
        refreshGoal()
      } catch (e) {
        // 错误可见（不静默假装切换成功）
        console.error('[status-panel] 目标命令失败', args, e)
        setGoalActionError(String(e))
      } finally {
        setGoalActionPending(false)
      }
    },
    [goalActionPending, refreshGoal],
  )

  // 计划详情 / 智能体目录 = 面板栏标签页（上游 side tab 的宿主对偶；
  // status-pane-openers 投递，dockview-shell 注册落点）。
  const handleOpenPlan = useCallback((item: StatusPanelSessionPlanItem) => {
    openPlanDetail({
      entryId: item.entryId,
      ...(item.title ? { title: item.title } : {}),
      markdown: item.markdown,
    })
  }, [])
  const openAgentDetail = useCallback((row: EndedAgentRow | StatusPanelAgentRow) => {
    if ('payload' in row) {
      openSubagentDetail(row.payload)
      return
    }
    // 运行中行没有结果/报告，只带任务信息（详情页会显示"运行中，尚无输出"）。
    openSubagentDetail({ name: '子代理', task: row.title, running: true, status: 'running' })
  }, [])

  const isVariantAutomatic = override === null
  const panelModeValue = isVariantAutomatic ? 'auto' : variant

  const handlePanelModeChange = useCallback((value: string) => {
    if (value === 'auto' || value === 'panel' || value === 'mini') {
      statusPanelStore.getState().setOverride(value === 'auto' ? null : value)
    }
  }, [])
  const handleCollapseToMini = useCallback(() => {
    statusPanelStore.getState().setOverride('mini')
  }, [])

  const onOpenGitReview = useCallback(() => {
    const a = statusPanelApi()
    if (!a) {
      console.error('[status-panel] 布局 api 不在场——无法打开审查面板')
      return
    }
    try {
      // 面板栏「审查」入口（open-page-actions 单源动作）
      openPagePanel(a, 'review')
    } catch (e) {
      console.error('[status-panel] 打开审查面板失败', e)
    }
  }, [])

  const onCancelJob = useCallback((jobId: string) => {
    invoke('pi_job_cancel', { jobId })
      .then(() => jobsBridge.getState().refresh())
      .catch((e) => console.error('[status-panel] 后台任务取消失败', jobId, e))
  }, [])

  // 工作流 Stop：rpi 的 dispatch 是轮内工具调用，引擎 per-call 取消链
  // （run abort → 插件 ABI cancel → Control）经由 pi_interrupt 可达——
  // 停的是持有 dispatch 的这一轮；无活动 run 时为诚实的 no-op。
  // thread = 面板所属的**活动会话**（多会话并存：不误停后台会话的 run）。
  const onCancelWorkflowRun = useCallback(() => {
    invoke('pi_interrupt', { thread: sessionThreadKey(activeId) }).catch((e) =>
      console.error('[status-panel] 工作流停止失败', e),
    )
  }, [activeId])

  // 停止子代理：引擎 host 按 childId 真取消（ChildAgents.stop）；名册随后刷新，
  // 行状态由 failed 行如实反映（错误可见，不假装成功）。
  const onStopAgent = useCallback((childId: string) => {
    invoke('pi_child_agent_stop', { childId })
      .then(() => childAgentsBridge.getState().refresh())
      .catch((e) => console.error('[status-panel] 子代理取消失败', childId, e))
  }, [])

  // 工作流实例详情 / 目录 = 面板栏标签页（status-pane-openers 投递）。
  const onOpenWorkflowRun = useCallback((run: StatusPanelWorkflowRun) => {
    const name = workflowRunDisplayName(run)
    openWorkflowRun({ runId: run.runId, ...(name !== null ? { title: name } : {}) })
  }, [])
  const onOpenWorkflowDirectory = useCallback(() => {
    openWorkflowRun({})
  }, [])

  const canRenderGit = Boolean(model.git)
  const canRenderGoal = model.goal !== null
  const canRenderSessionPlans = model.sessionPlans !== null
  const canRenderPlan = Boolean(model.plan)
  const canRenderTerminals = model.runningJobs.length > 0
  const canRenderWorkflows =
    model.runningWorkflows.length > 0 || model.endedWorkflowCount > 0
  const canRenderAgents = model.runningAgents.length > 0 || model.endedAgentCount > 0

  // draft（无会话）不挂（上游同款）。
  if (activeId === null) return null
  // 列头开关的「整个隐藏」= 连 mini 胶囊都不画；overlay 与让位都归零
  //（panelVisible 已排除 hidden，内容列不会留空白）。
  if (variant === 'hidden') return null
  // 上游卸载闸门：没有任何活内容就整块不渲染（2026-11-17 用户"全部对齐"
  // 轮推翻了 2026-11-15 的"常驻空态"宿主选择）。
  if (!model.hasContent) return null

  return (
    // 会话容器内 `top-0 right-4 pt-4`（上游 ConversationStatusPanelImpl 同款）。
    // 列头在 assistant-conversation-area 之外（与上游 ConversationHeader
    // 在 conversation 容器之外同构），因此不再需要 --logo-strip-h 特例。
    <div className="pointer-events-none absolute top-0 right-4 z-20 pt-4">
      <aside
        aria-label={L.panelTitle}
        data-state={variant === 'mini' ? 'collapsed' : 'expanded'}
        data-display-mode={variant}
        data-goal-status={
          model.goal === null ? undefined : model.goal.verifying !== null ? 'verifying' : model.goal.status
        }
        data-goal-title={model.goal?.title}
        data-running-terminal-count={model.runningJobs.length}
        data-running-workflow-count={model.runningWorkflows.length}
        data-ended-workflow-count={model.endedWorkflowCount}
        data-running-agent-count={model.runningAgents.length}
        data-ended-agent-count={model.endedAgentCount}
        data-session-plan-count={model.sessionPlans?.items.length ?? 0}
        className={cn(
          paper,
          'pointer-events-auto relative overflow-hidden rounded-2xl text-foreground shadow-md transition-[border-radius,padding,background-color,box-shadow] duration-300 ease-in-out',
          // 胶囊宽度只由 CSS 决定：w-max 跟随摘要内容（上游同判——ResizeObserver
          // 量宽会晚一帧，文字会落到胶囊外面）
          variant === 'mini'
            ? 'inline-flex max-h-8.5 w-max max-w-[min(320px,calc(100cqw-2rem))] flex-col'
            : variant === 'panel'
              ? 'flex max-h-[min(64dvh,32rem)] w-[320px] max-w-[calc(100cqw-2rem)] flex-col'
              : 'inline-flex max-h-8.5 w-max max-w-[min(320px,calc(100cqw-2rem))] flex-col @min-[1280px]/thread:max-h-[min(64dvh,32rem)] @min-[1280px]/thread:w-[320px]',
        )}
      >
        {variant !== 'mini' ? (
          <div
            className={cn(
              'absolute top-3 right-3 z-10 items-center gap-1',
              variant === 'auto' ? 'hidden @min-[1280px]/thread:flex' : 'flex',
            )}
          >
            <ContextMenu align="end" anchor="trigger" side="bottom" sideOffset={6}>
              <ContextMenuAnchor>
                <button
                  type="button"
                  aria-label={L.displayMode}
                  className={cn(ghostButton, 'size-6')}
                >
                  <EllipsisIcon className="size-[var(--size-icon-sm)]" />
                </button>
              </ContextMenuAnchor>
              <ContextMenuContent ariaLabel={L.displayMode} className="w-44">
                <ContextMenuRadioGroup value={panelModeValue} onValueChange={handlePanelModeChange}>
                  <ContextMenuRadioItem value="auto">{L.displayModeAuto}</ContextMenuRadioItem>
                  {/* 上游菜单缺 panel/mini 两项（键与 handler 都在）——补全 */}
                  <ContextMenuRadioItem value="panel">{L.displayModeExpanded}</ContextMenuRadioItem>
                  <ContextMenuRadioItem value="mini">{L.displayModeCollapsed}</ContextMenuRadioItem>
                </ContextMenuRadioGroup>
              </ContextMenuContent>
            </ContextMenu>
            <button
              type="button"
              aria-label={L.showMini}
              title={L.showMini}
              onClick={handleCollapseToMini}
              className={cn(ghostButton, 'size-6')}
            >
              <Minimize2Icon className="size-[var(--size-icon-sm)]" />
            </button>
          </div>
        ) : null}
        {variant !== 'mini' ? (
          // 单区块限高之外的第二层兜底滚动：多区块同时展开仍可能超过 shell（上游同注）
          <div
            className={cn(
              'min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2',
              variant === 'auto' ? 'hidden @min-[1280px]/thread:flex' : 'flex',
            )}
          >
            {canRenderGit ? (
              <GitStatusSection
                model={model}
                cwd={cwd ?? ''}
                onOpenGitReview={onOpenGitReview}
                separated={false}
              />
            ) : null}
            {canRenderGoal && model.goal !== null ? (
              <GoalStatusSection
                goal={model.goal}
                separated={canRenderGit}
                onPauseGoal={() => void runGoalCommand('pause')}
                onResumeGoal={() => void runGoalCommand('resume')}
                actionPending={goalActionPending}
                actionError={goalActionError}
              />
            ) : null}
            {canRenderSessionPlans ? (
              <SessionPlansStatusSection
                model={model}
                separated={canRenderGit || canRenderGoal}
                onOpenPlan={handleOpenPlan}
              />
            ) : null}
            {canRenderPlan ? (
              <PlanStatusSection
                model={model}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans}
              />
            ) : null}
            {canRenderTerminals ? (
              <TerminalStatusSection
                model={model}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans || canRenderPlan}
                open={terminalOpen}
                onOpenChange={setTerminalOpen}
                onCancelJob={onCancelJob}
              />
            ) : null}
            {canRenderWorkflows ? (
              <WorkflowStatusSection
                model={model}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals
                }
                key={activeId}
                open={workflowOpen}
                onOpenChange={setWorkflowOpen}
                onOpenRun={onOpenWorkflowRun}
                onOpenDirectory={onOpenWorkflowDirectory}
                onCancelRun={onCancelWorkflowRun}
              />
            ) : null}
            {canRenderAgents ? (
              <AgentStatusSection
                model={model}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals ||
                  canRenderWorkflows
                }
                open={agentOpen}
                onOpenChange={setAgentOpen}
                onOpenAgent={openAgentDetail}
                onOpenDirectory={() => openAgentDirectory()}
                onStopAgent={onStopAgent}
              />
            ) : null}
          </div>
        ) : null}
        <div
          aria-hidden={variant === 'panel'}
          className={cn(
            'w-max max-w-full transition-opacity duration-150',
            variant === 'mini'
              ? 'pointer-events-auto relative visible opacity-100'
              : variant === 'panel'
                ? 'pointer-events-none invisible absolute top-0 left-0 opacity-0'
                : 'pointer-events-auto relative visible opacity-100 @min-[1280px]/thread:hidden',
          )}
        >
          <StatusSummaryRow model={model} onVariantChange={handlePanelModeChange} />
        </div>
      </aside>
    </div>
  )
}

export const ConversationStatusPanel = memo(ConversationStatusPanelImpl)
