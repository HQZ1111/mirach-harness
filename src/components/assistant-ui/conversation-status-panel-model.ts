/**
 * 活动状态面板模型 —— ZCode `v4/conversationStatusPanelModel.ts` 的 mirach
 * 适配（2026-11-01 用户："对话区的右上角的活动状态面板直接用zcode的"）。
 *
 * 与上游的差异只有**数据来源**（上游吃 v4 会话投影，这里吃宿主三个 bridge
 * + git store），推导规则逐条照抄：
 * - git 模型：`added + removed <= 0 → null`（clean repo 不挂卡，上游
 *   buildGitModel 同判）；
 * - plan 模型：保留 snapshot 原序（`displayItems = items`，重排会让 Todo
 *   完成时跳位——上游注释同文）；
 * - 后台任务：**只收 running**（上游 `work.status !== "running" → skip`）；
 *   workflow 类没有（pi 无 workflow run 概念，docs/engine-gaps.md G3），
 *   goal / sessionPlans 同理（G4）——上游对应分区在无数据时本就返回 null，
 *   这里直接不建模型，分区跟着不渲染。
 *
 * 上游字段缺席用"字段不存在"而不是 0/空串的纪律同样保留：渲染层据此决定
 * 一行有没有时长、能不能停。
 */

/** 宿主侧输入（全部来自宿主 store，形状见各 store 文件头注释）。 */
export interface StatusPanelInput {
  /** 待办任务（todo-store flatTasks 的投影）。 */
  todoTasks: readonly { content: string; status: 'open' | 'in_progress' | 'done' | 'dropped' | 'blocked' }[]
  /** 子代理（agent-hub-store children）。 */
  children: readonly {
    id: string
    task: string
    kind: 'subagent' | 'tan'
    status: 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'killed'
    startedMs: number
    finishedMs: number | null
  }[]
  /** 后台命令（jobs-store jobs）。 */
  jobs: readonly {
    id: string
    command: string
    status: 'running' | 'exited' | 'killed' | 'timedOut' | 'failed'
    startedAtMs: number
    exitCode: number | null
  }[]
  /** 工作区 git 变更统计（git-store stat）。 */
  git: {
    isRepository: boolean
    branch: string | null
    added: number
    removed: number
    changedFiles: number
  } | null
}

// ── 上游同形模型 ────────────────────────────────────────────────────

export interface StatusPanelPlanItem {
  id: string
  content: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface StatusPanelPlanModel {
  items: StatusPanelPlanItem[]
  /** 与 items 同引用（上游：完整保留原数组，重排 = Todo 完成时跳位）。 */
  displayItems: StatusPanelPlanItem[]
  completedCount: number
  waitingCount: number
  totalCount: number
}

/** 上游 BackgroundWorkSummary 的宿主子集（terminal/subagent 两行用）。 */
export interface StatusPanelWork {
  workId: string
  kind: 'bash' | 'subagent'
  title: string
  status: 'running'
  startedAt: number
  cancellable: boolean
  /** subagent 控制句柄联接键（上游 work.childSessionId）。 */
  childSessionId?: string
}

/**
 * 已退出的行（终端 / 智能体分区的历史尾巴）。
 *
 * **与上游的偏差（2026-11-01 用户定稿"完整，全链路复制"）**：上游分区只收
 * running（已结束的折进「已结束」目录页），宿主没有目录页——已结束的行
 * 就地留在分区里（运行中的在前），否则一回合一结束整个分区消失，用户看到
 * 的是"没有终端/智能体"。
 */
export interface StatusPanelEndedWork {
  workId: string
  kind: 'bash' | 'subagent'
  title: string
  status: 'exited' | 'killed' | 'timedOut' | 'failed' | 'done' | 'cancelled'
  startedAt: number
  finishedAt: number | null
  /** bash：退出码（null = 被杀/超时，无码）。 */
  exitCode: number | null
}

export interface StatusPanelRunningSubagent {
  agentId: string
  childSessionId: string
  subagentType: string
  title: string
  status: 'running'
  startedAt: number
}

export interface StatusPanelGitModel {
  branchName: string | null
  dirtyFileCount: number
  added: number
  removed: number
}

export interface StatusPanelModel {
  hasContent: boolean
  git: StatusPanelGitModel | null
  plan: StatusPanelPlanModel | null
  runningBashWorks: StatusPanelWork[]
  runningSubagentWorks: StatusPanelRunningSubagent[]
  endedBashWorks: StatusPanelEndedWork[]
  endedSubagentWorks: StatusPanelEndedWork[]
}

function buildGitModel(input: StatusPanelInput): StatusPanelGitModel | null {
  const git = input.git
  // 非 git 仓库 → 无卡（上游 buildGitModel 的 isRepository 同判）
  if (!git || !git.isRepository) return null
  if (git.added + git.removed <= 0) return null
  return {
    branchName: git.branch,
    dirtyFileCount: git.changedFiles,
    added: git.added,
    removed: git.removed,
  }
}

function buildPlanModel(tasks: StatusPanelInput['todoTasks']): StatusPanelPlanModel | null {
  if (tasks.length === 0) return null
  const items: StatusPanelPlanItem[] = tasks.map((task, index) => ({
    id: `todo-${index}`,
    content: task.content,
    // done→completed；in_progress→inProgress；其余（open/blocked/dropped）→
    // pending（dropped 在待办列表里已按"非完成"参与计数，与 harness 旧
    // TodoSection 的 done 统计口径一致）。
    status:
      task.status === 'done' ? 'completed' : task.status === 'in_progress' ? 'inProgress' : 'pending',
  }))
  const completed = items.filter((item) => item.status === 'completed')
  return {
    items,
    displayItems: items,
    completedCount: completed.length,
    waitingCount: items.length - completed.length,
    totalCount: items.length,
  }
}

export function buildStatusPanelModel(input: StatusPanelInput): StatusPanelModel {
  const git = buildGitModel(input)
  const plan = buildPlanModel(input.todoTasks)
  // 终端行：running 的 bash 作业（上游同判：只收 running），按启动序排
  const runningBashWorks: StatusPanelWork[] = input.jobs
    .filter((job) => job.status === 'running')
    .map((job) => ({
      workId: job.id,
      kind: 'bash' as const,
      title: job.command,
      status: 'running' as const,
      startedAt: job.startedAtMs,
      cancellable: true,
    }))
  // 智能体行：未 settled 的子代理（starting/running 都算活动——上游 blocked
  // 也算活动态）
  const runningSubagentWorks: StatusPanelRunningSubagent[] = input.children
    .filter((c) => c.status === 'starting' || c.status === 'running')
    .map((c) => ({
      agentId: c.id,
      childSessionId: c.id,
      subagentType: c.kind,
      title: c.task,
      status: 'running' as const,
      startedAt: c.startedMs,
    }))
  // 已结束的行（宿主无「已结束」目录页 → 就地留在分区，见 StatusPanelEndedWork）
  const endedBashWorks: StatusPanelEndedWork[] = input.jobs
    .filter((job): job is StatusPanelInput['jobs'][number] & { status: 'exited' | 'killed' | 'timedOut' | 'failed' } => job.status !== 'running')
    .map((job) => ({
      workId: job.id,
      kind: 'bash' as const,
      title: job.command,
      status: job.status,
      startedAt: job.startedAtMs,
      finishedAt: null,
      exitCode: job.exitCode,
    }))
    .sort((left, right) => right.startedAt - left.startedAt)
  const endedSubagentWorks: StatusPanelEndedWork[] = input.children
    .filter((c) => c.status !== 'starting' && c.status !== 'running')
    .map((c) => ({
      workId: c.id,
      kind: 'subagent' as const,
      title: c.task,
      status:
        c.status === 'done'
          ? ('done' as const)
          : c.status === 'failed'
            ? ('failed' as const)
            : c.status === 'cancelled'
              ? ('cancelled' as const)
              : ('killed' as const),
      startedAt: c.startedMs,
      finishedAt: c.finishedMs,
      exitCode: null,
    }))
    .sort((left, right) => right.startedAt - left.startedAt)

  return {
    git,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    endedBashWorks,
    endedSubagentWorks,
    hasContent: Boolean(
      git ||
        plan ||
        runningBashWorks.length > 0 ||
        runningSubagentWorks.length > 0 ||
        endedBashWorks.length > 0 ||
        endedSubagentWorks.length > 0,
    ),
  }
}

// ── Todo 紧凑窗口（上游 getStatusPanelTodoFocusWindow 逐条照抄）────────

const COMPACT_TODO_THRESHOLD = 6
const TODO_FOCUS_WINDOW_SIZE = 3

export interface StatusPanelTodoFocusWindow {
  compact: boolean
  precedingItems: StatusPanelPlanItem[]
  focusItems: StatusPanelPlanItem[]
  followingItems: StatusPanelPlanItem[]
}

export function getStatusPanelTodoFocusWindow(
  items: StatusPanelPlanItem[],
): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, precedingItems: [], focusItems: items, followingItems: [] }
  }

  const runningIndex = items.findIndex((item) => item.status === 'inProgress')
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== 'completed')
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE)
  // 从前面回补，让精简窗口在项目数足够时始终保持三条（上游注释同文）。
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE))
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE)

  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  }
}
