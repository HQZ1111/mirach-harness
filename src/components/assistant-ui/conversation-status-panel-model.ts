/**
 * 活动状态面板模型 —— ZCode `v4/conversationStatusPanelModel.ts` 的 mirach
 * 适配（2026-11-01 首版；2026-11-17「完整移植」轮补齐 goal / sessionPlans /
 * 运行项 / hasContent）。
 *
 * 与上游的差异只有**数据来源**（上游吃 v4 会话投影，这里吃宿主 bridge +
 * rpi 插件条目），推导规则逐条照抄：
 * - git 模型：`added + removed <= 0 → null`（clean repo 不挂卡，上游
 *   buildGitModel 同判）；只有 model 有内容才进 hasContent；
 * - plan 模型：保留 snapshot 原序（`displayItems = items`，重排会让 Todo
 *   完成时跳位——上游注释同文）；
 * - sessionPlans 模型：只收**有 markdown** 的完成计划，按 seq 降序（最新
 *   在前，上游行序同判）；标题 = 首个 H1，否则首个非空文本行
 *   （`getPlanDirectoryTitle` 逐字照抄）；
 * - goal 模型：真源 = rpi-goal `goal-state` 条目
 *   `{active:{title,status,notes,startedAt,updatedAt,turnsUsed,maxTurns,
 *   deadlineMs}, archived}`；未知 status 一律 console.error + 整行丢弃
 *   （不猜成 active——规矩 12）；
 * - 运行项：jobs（终端，数据面 = rpi-background-tasks 插件的 `background-tasks`
 *   会话快照，宿主 `pi_job_list` 只读投影）与智能体（宿主从工具调用派生，
 *   见面板组件）。
 *
 * 上游字段缺席用"字段不存在"而不是 0/空串的纪律同样保留：渲染层据此决定
 * 一行有没有时长、能不能停。
 */
import type { PlanEntryRow } from './plan-entries-store'

/** 宿主侧输入（全部来自宿主 store / IPC 投影）。 */
export interface StatusPanelInput {
  /** 待办任务（todo-store flatTasks 的投影）。 */
  todoTasks: readonly {
    content: string
    status: 'open' | 'in_progress' | 'done' | 'dropped' | 'blocked'
  }[]
  /** 工作区 git 变更统计（git-store stat）。 */
  git: {
    isRepository: boolean
    branch: string | null
    added: number
    removed: number
    changedFiles: number
  } | null
  /** rpi-goal `goal-state` 条目原文（pi_goal_state；null = 无目标）。 */
  goalRaw: unknown
  /** 完成计划目录（plan-entries-store；已按 seq 降序）。 */
  planEntries: readonly PlanEntryRow[]
  /** 后台 bash 任务（jobs-store 投影；rpi 当前无数据面 → 空）。 */
  jobs: readonly StatusPanelJobInput[]
  /** 运行中的子代理行（面板从 delegate_task / subagent / dispatch 调用派生）。 */
  runningAgents: readonly StatusPanelAgentRow[]
  /** 已结束子代理计数（同派生面；目录入口的行数）。 */
  endedAgentCount: number
}

export interface StatusPanelJobInput {
  id: string
  /** 命令行原文（插件 `background-tasks` 行的 `command`）。 */
  command: string
  /** 作业标签（插件 `background-tasks` 行的 `label`）；行标题优先用它。 */
  label?: string
  startedAtMs: number
  /** 能否取消。rpi-background-tasks 的 kill 面在插件进程内（Job Object），
   *  宿主无按 id 终止面 → 面板传 false，按钮如实不渲染。 */
  cancellable?: boolean
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

export interface StatusPanelGitModel {
  branchName: string | null
  dirtyFileCount: number
  added: number
  removed: number
}

/** rpi-goal 的 Goal（`goal-state` 条目 data.active）。 */
export interface StatusPanelGoalModel {
  title: string
  status: 'active' | 'paused' | 'complete'
  notes: string
  startedAt: number | null
  updatedAt: number | null
  turnsUsed: number
  maxTurns: number | null
  deadlineMs: number | null
}

export interface StatusPanelSessionPlanItem {
  entryId: string
  seq: number
  timestamp: number
  markdown: string
  title?: string
}

export interface StatusPanelSessionPlansModel {
  items: StatusPanelSessionPlanItem[]
}

/** 运行中的子代理行（面板从工具调用派生后传入）。 */
export interface StatusPanelAgentRow {
  id: string
  title: string
  startedAt: number | null
  /** 引擎名册行（pi_child_agents）才可停；工具调用派生行没有停面。 */
  stoppable?: boolean
}

/** 终端分区一行（上游 BackgroundWorkSummary 的宿主最小投影）。 */
export interface StatusPanelJobRow {
  workId: string
  title: string
  startedAt: number
  cancellable: boolean
}

export interface StatusPanelModel {
  git: StatusPanelGitModel | null
  goal: StatusPanelGoalModel | null
  sessionPlans: StatusPanelSessionPlansModel | null
  plan: StatusPanelPlanModel | null
  runningJobs: StatusPanelJobRow[]
  runningAgents: StatusPanelAgentRow[]
  endedAgentCount: number
  hasContent: boolean
}

// ── goal ────────────────────────────────────────────────────────────

const GOAL_STATUSES = new Set(['active', 'paused', 'complete'])

/**
 * 严格解析 rpi-goal `goal-state` 条目（`{active, archived}`）：
 * 无 active / 标题空 = null（诚实空态）；字段损坏 = console.error + null
 * （条目不渲染，不造假行——与插件自身恢复失败 Blocked 同语义）。
 */
export function parseGoalState(raw: unknown): StatusPanelGoalModel | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[status-panel] goal-state 非对象——丢弃', raw)
    return null
  }
  const record = raw as Record<string, unknown>
  const active = record.active
  if (active === null || active === undefined) return null
  if (typeof active !== 'object' || Array.isArray(active)) {
    console.error('[status-panel] goal-state.active 非对象——丢弃', active)
    return null
  }
  const goal = active as Record<string, unknown>
  const title = typeof goal.title === 'string' ? goal.title.trim() : ''
  if (title === '') {
    console.error('[status-panel] goal-state.active.title 缺失/空——丢弃', goal)
    return null
  }
  const status = typeof goal.status === 'string' ? goal.status : ''
  if (!GOAL_STATUSES.has(status)) {
    console.error(`[status-panel] goal-state 未知 status（${status}）——丢弃`, goal)
    return null
  }
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const notes = typeof goal.notes === 'string' ? goal.notes : ''
  return {
    title,
    status: status as StatusPanelGoalModel['status'],
    notes,
    startedAt: numOrNull(goal.startedAt),
    updatedAt: numOrNull(goal.updatedAt),
    turnsUsed: numOrNull(goal.turnsUsed) ?? 0,
    maxTurns: numOrNull(goal.maxTurns),
    deadlineMs: numOrNull(goal.deadlineMs),
  }
}

/**
 * 目标用时（秒）：
 * - active → now - startedAt（秒针照走）；
 * - paused / complete → updatedAt - startedAt（停在最后一次状态写入，
 *   没有 updatedAt/startedAt 就不报时长——不拿 now 假装还在跑）。
 */
export function goalElapsedSeconds(
  goal: StatusPanelGoalModel,
  now: number,
): number | null {
  if (goal.startedAt === null) return null
  const end =
    goal.status === 'active' ? now : (goal.updatedAt ?? goal.startedAt)
  return Math.max(0, Math.floor((end - goal.startedAt) / 1000))
}

// ── sessionPlans ────────────────────────────────────────────────────

const MARKDOWN_H1_PATTERN = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m
const MARKDOWN_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/

/** 计划目录标题取首个 H1，否则取首个非空文本行（上游 getPlanDirectoryTitle
 *  逐字照抄）。 */
export function getPlanDirectoryTitle(markdown: string): string | undefined {
  const h1 = MARKDOWN_H1_PATTERN.exec(markdown)?.[1]?.trim()
  if (h1) return h1
  for (const line of markdown.split(/\r?\n/u)) {
    const title = line.replace(MARKDOWN_LEADING_DECORATION, '').trim()
    if (title) return title
  }
  return undefined
}

function buildSessionPlansModel(
  entries: readonly PlanEntryRow[],
): StatusPanelSessionPlansModel | null {
  if (entries.length === 0) return null
  const items = [...entries]
    .sort((a, b) => b.seq - a.seq)
    .flatMap((entry) => {
      const title = getPlanDirectoryTitle(entry.plan)
      return [
        {
          entryId: entry.entryId,
          seq: entry.seq,
          timestamp: entry.timestamp,
          markdown: entry.plan,
          ...(title ? { title } : {}),
        },
      ]
    })
  return items.length > 0 ? { items } : null
}

// ── git / plan / jobs ───────────────────────────────────────────────

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

function buildJobRows(jobs: readonly StatusPanelJobInput[]): StatusPanelJobRow[] {
  return jobs.map((job) => ({
    workId: job.id,
    title: job.label ?? job.command,
    startedAt: job.startedAtMs,
    // rpi-background-tasks 的 kill 面在插件进程内：面板显式传 false，
    // Stop 按钮如实不渲染（缺省仍按上游 `!== false` 判可停）。
    cancellable: job.cancellable !== false,
  }))
}

export function buildStatusPanelModel(input: StatusPanelInput): StatusPanelModel {
  const git = buildGitModel(input)
  const goal = parseGoalState(input.goalRaw)
  const sessionPlans = buildSessionPlansModel(input.planEntries)
  const plan = buildPlanModel(input.todoTasks)
  const runningJobs = buildJobRows(input.jobs)
  const runningAgents = [...input.runningAgents]
  const endedAgentCount = Math.max(0, input.endedAgentCount)

  return {
    git,
    goal,
    sessionPlans,
    plan,
    runningJobs,
    runningAgents,
    endedAgentCount,
    // 上游 hasContent 只认活内容；已结束目录行不单独开门（只有已结束
    // 智能体的会话整块不渲染——上游同判，2026-11-17 对齐轮照抄）。
    hasContent: Boolean(
      git ||
        goal ||
        sessionPlans ||
        plan ||
        runningJobs.length > 0 ||
        runningAgents.length > 0,
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
