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
 *   deadlineMs}, archived}` + rpi-goal-iterations 插件的 `goal-iterations`
 *   逐轮快照（宿主 `pi_goal_state` 已按 goalTitle+goalStartedAt 并进 active，
 *   2026-11-18）；插件原生 status active/paused/complete 映射为 ZCode 六态
 *   （complete → verified），未知 status 一律 console.error + 整行丢弃
 *   （不猜成 active——规矩 12）；迭代行构建 `buildConversationGoalIterationSummaries`
 *   逐条照抄上游 `conversationGoalSummaryModel.ts`；
 * - 运行项：jobs（终端，数据面 = rpi-background-tasks 插件的 `background-tasks`
 *   会话快照，宿主 `pi_job_list` 只读投影）与智能体（宿主从工具调用派生，
 *   见面板组件）。
 *
 * 上游字段缺席用"字段不存在"而不是 0/空串的纪律同样保留：渲染层据此决定
 * 一行有没有时长、能不能停。
 */
import type { PlanEntryRow } from './plan-entries-store'
import type { StatusPanelWorkflowRun } from './status-workflow-runs'

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
  /** 运行中的工作流实例（宿主从 plan / dispatch 工具调用派生）。 */
  runningWorkflows: readonly StatusPanelWorkflowRun[]
  /** 已结束工作流实例计数（目录入口的行数）。 */
  endedWorkflowCount: number
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

/** rpi-goal 的 Goal（`goal-state` 条目 data.active）+ 迭代/校验数组
 *  （ZCode `GoalState` 的宿主对偶）。
 *
 *  status 词表 = ZCode 六态（active/paused/verifying/verified/notSatisfied/
 *  failed）加上 rpi-goal v2 的停止词（blocked / waiting / usage_limited /
 *  budget_limited）。插件 v2 用 `complete` 表示完成（映射为 verified），
 *  `verifying` 就是状态本身；每个词都由插件真发，解析层不认识才丢弃。 */
export type StatusPanelGoalStatus =
  | 'active'
  | 'paused'
  | 'verifying'
  | 'verified'
  | 'notSatisfied'
  | 'failed'
  | 'blocked'
  | 'waiting'
  | 'usageLimited'
  | 'budgetLimited'

export interface StatusPanelGoalItem {
  id: string
  content: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface StatusPanelGoalIteration {
  iteration: number
  items: StatusPanelGoalItem[]
  updatedAt: number | null
}

export type StatusPanelGoalVerificationOutcome = 'pass' | 'notSatisfied' | 'failed' | 'cancelled'

export interface StatusPanelGoalVerification {
  iteration: number
  outcome: StatusPanelGoalVerificationOutcome
  at: number | null
  reason?: string
  nextAction?: string
}

export interface StatusPanelGoalModel {
  title: string
  status: StatusPanelGoalStatus
  notes: string
  startedAt: number | null
  updatedAt: number | null
  turnsUsed: number
  maxTurns: number | null
  deadlineMs: number | null
  /** 迭代行构建源（ZCode `GoalState.iterations`）：每轮一次快照。 */
  iterations: StatusPanelGoalIteration[]
  /** 校验结论（ZCode `GoalState.verifications`；宿主校验器逐轮累积）。 */
  verifications: StatusPanelGoalVerification[]
  /** 在途校验（宿主 `pi_goal_verify` 的真实进程内事实；无 = null）。 */
  verifying: StatusPanelGoalVerifying | null
}

export interface StatusPanelGoalVerifying {
  iteration: number
  startedAt: number | null
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
  runningWorkflows: StatusPanelWorkflowRun[]
  endedWorkflowCount: number
  hasContent: boolean
}

// ── goal ────────────────────────────────────────────────────────────

/** 插件原生词 → ZCode 词（complete = 上游 verified 的宿主对偶；v2 的
 *  blocked/waiting/usage_limited/budget_limited 各自保留，不硬折成 paused）。 */
const GOAL_STATUS_MAP: Record<string, StatusPanelGoalStatus> = {
  active: 'active',
  paused: 'paused',
  complete: 'verified',
  verifying: 'verifying',
  verified: 'verified',
  notSatisfied: 'notSatisfied',
  failed: 'failed',
  blocked: 'blocked',
  waiting: 'waiting',
  usage_limited: 'usageLimited',
  budget_limited: 'budgetLimited',
}

/** 结论词归一：宿主发 camelCase，插件持久化 snake_case。 */
const GOAL_VERIFICATION_OUTCOME_MAP: Record<string, StatusPanelGoalVerificationOutcome> = {
  pass: 'pass',
  notSatisfied: 'notSatisfied',
  not_satisfied: 'notSatisfied',
  failed: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

const GOAL_ITEM_STATUSES = new Set(['pending', 'inProgress', 'completed'])

function parseGoalIterations(value: unknown): StatusPanelGoalIteration[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    console.error('[status-panel] goal iterations 非数组——丢弃', value)
    return []
  }
  const rows: StatusPanelGoalIteration[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      console.error('[status-panel] goal iteration 非对象——丢弃该行', raw)
      continue
    }
    const row = raw as Record<string, unknown>
    const iteration =
      typeof row.iteration === 'number' && Number.isInteger(row.iteration) && row.iteration >= 1
        ? row.iteration
        : null
    if (iteration === null) {
      console.error('[status-panel] goal iteration 缺合法序号——丢弃该行', row)
      continue
    }
    const rawItems = row.items
    if (!Array.isArray(rawItems)) {
      console.error('[status-panel] goal iteration 缺 items 数组——丢弃该行', row)
      continue
    }
    const items: StatusPanelGoalItem[] = []
    for (const rawItem of rawItems) {
      if (typeof rawItem !== 'object' || rawItem === null) continue
      const item = rawItem as Record<string, unknown>
      const content = typeof item.content === 'string' ? item.content.trim() : ''
      const status = typeof item.status === 'string' ? item.status : ''
      if (content === '' || !GOAL_ITEM_STATUSES.has(status)) {
        console.error('[status-panel] goal iteration 条目损坏——丢弃该条', item)
        continue
      }
      items.push({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : `item-${items.length + 1}`,
        content,
        status: status as StatusPanelGoalItem['status'],
      })
    }
    rows.push({
      iteration,
      items,
      updatedAt:
        typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : null,
    })
  }
  return rows.sort((left, right) => left.iteration - right.iteration)
}

function parseGoalVerifications(value: unknown): StatusPanelGoalVerification[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    console.error('[status-panel] goal verifications 非数组——丢弃', value)
    return []
  }
  const rows: StatusPanelGoalVerification[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const iteration =
      typeof row.iteration === 'number' && Number.isInteger(row.iteration) && row.iteration >= 1
        ? row.iteration
        : null
    const outcome = GOAL_VERIFICATION_OUTCOME_MAP[
      typeof row.outcome === 'string' ? row.outcome : ''
    ]
    if (iteration === null || outcome === undefined) {
      console.error('[status-panel] goal verification 条目损坏——丢弃该条', row)
      continue
    }
    rows.push({
      iteration,
      outcome,
      at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null,
      ...(typeof row.reason === 'string' && row.reason !== '' ? { reason: row.reason } : {}),
      ...(typeof row.nextAction === 'string' && row.nextAction !== ''
        ? { nextAction: row.nextAction }
        : {}),
    })
  }
  return rows.sort((left, right) => left.iteration - right.iteration)
}

/**
 * 严格解析 rpi-goal `goal-state` 条目（`{active, archived}`，active 上可能已
 * 并入 `goal-iterations` 的 `iterations`）：
 * 无 active / 标题空 = null（诚实空态）；字段损坏 = console.error + null
 * （条目不渲染，不造假行——与插件自身恢复失败 Blocked 同语义）。
 * 迭代/校验数组内**单行**损坏只丢该行（可见的 console.error），不牵连整目标。
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
  const rawStatus = typeof goal.status === 'string' ? goal.status : ''
  const status = GOAL_STATUS_MAP[rawStatus]
  if (status === undefined) {
    console.error(`[status-panel] goal-state 未知 status（${rawStatus}）——丢弃`, goal)
    return null
  }
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const notes = typeof goal.notes === 'string' ? goal.notes : ''
  return {
    title,
    status,
    notes,
    startedAt: numOrNull(goal.startedAt),
    updatedAt: numOrNull(goal.updatedAt),
    turnsUsed: numOrNull(goal.turnsUsed) ?? 0,
    maxTurns: numOrNull(goal.maxTurns),
    deadlineMs: numOrNull(goal.deadlineMs),
    iterations: parseGoalIterations(goal.iterations),
    verifications: parseGoalVerifications(goal.verifications),
    // v1 宿主写 `verifying` 对象；rpi-goal v2 把边界写进 status/verifyIteration。
    // 两条来源归一，UI 的"在途行 spinner"共用一份读取。
    verifying: (() => {
      const legacy = parseGoalVerifying(goal.verifying)
      if (legacy !== null) return legacy
      if (status !== 'verifying') return null
      const iteration = numOrNull(goal.verifyIteration)
      if (iteration === null || !Number.isInteger(iteration) || iteration < 1) return null
      return { iteration, startedAt: numOrNull(goal.verifyStartedAt) }
    })(),
  }
}

/** 在途校验：`{iteration, startedAt}`；形状不对 → null + console.error
 *  （不知道状态就不说"校验中"，不猜）。 */
function parseGoalVerifying(value: unknown): StatusPanelGoalVerifying | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    console.error('[status-panel] goal verifying 非对象——忽略', value)
    return null
  }
  const row = value as Record<string, unknown>
  const iteration =
    typeof row.iteration === 'number' && Number.isInteger(row.iteration) && row.iteration >= 1
      ? row.iteration
      : null
  if (iteration === null) {
    console.error('[status-panel] goal verifying 缺合法 iteration——忽略', row)
    return null
  }
  return {
    iteration,
    startedAt:
      typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : null,
  }
}

/**
 * 目标用时（秒）：
 * - active / verifying / notSatisfied → now - startedAt（秒针照走）；
 * - paused / verified / failed → updatedAt - startedAt（停在最后一次状态
 *   写入，没有 updatedAt/startedAt 就不报时长——不拿 now 假装还在跑）。
 */
export function goalElapsedSeconds(
  goal: StatusPanelGoalModel,
  now: number,
): number | null {
  if (goal.startedAt === null) return null
  const running =
    goal.status === 'active' || goal.status === 'verifying' || goal.status === 'notSatisfied'
  const end = running ? now : (goal.updatedAt ?? goal.startedAt)
  return Math.max(0, Math.floor((end - goal.startedAt) / 1000))
}

// ── goal 迭代行（ZCode conversationGoalSummaryModel.ts 逐条照抄）────────

const INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION =
  'Continue verifying and completing the goal.'

export interface StatusPanelGoalIterationSummary {
  iteration: number
  title: string | null
  items: StatusPanelGoalItem[]
  completedCount: number
  totalCount: number
  completed: boolean
  verificationOutcome: StatusPanelGoalVerificationOutcome | null
  /** 结论的 reason（宿主行渲染 title 提示用；上游只有 data 属性）。 */
  verificationReason: string | null
}

function visibleNextAction(value: string | undefined): string | null {
  const nextAction = value?.trim()
  if (!nextAction || nextAction === INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION) {
    return null
  }
  return nextAction
}

/**
 * 需要的行数（上游 requiredIterationCount 的宿主对偶）。
 *
 * 上游用 `goal.iteration`（校验器边界计数）再对"续跑中"加一行；宿主的迭代
 * 计数就来自 rpi-goal-iterations 的逐轮快照（最后一轮 = 当前打开的迭代），
 * 所以直接取两侧最大值、**不再 +1** —— 否则活跃目标永远多出一行空迭代
 * （按上游字面照抄会产生这个假行）。
 */
function requiredIterationCount(goal: StatusPanelGoalModel): number {
  const maxTodoIteration = goal.iterations.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  )
  const maxVerificationIteration = goal.verifications.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  )
  return Math.max(1, maxTodoIteration, maxVerificationIteration)
}

/** 从 goal 模型构造右上角逐轮摘要；不从 renderer timeline 反推轮次。 */
export function buildConversationGoalIterationSummaries(
  goal: StatusPanelGoalModel,
): StatusPanelGoalIterationSummary[] {
  const todoByIteration = new Map(goal.iterations.map((entry) => [entry.iteration, entry.items]))
  const verificationByIteration = new Map(
    goal.verifications.map((entry) => [entry.iteration, entry] as const),
  )
  const rows: StatusPanelGoalIterationSummary[] = []

  for (let iteration = 1; iteration <= requiredIterationCount(goal); iteration += 1) {
    const items = todoByIteration.get(iteration) ?? []
    const completedCount = items.filter((item) => item.status === 'completed').length
    const previousVerification = verificationByIteration.get(iteration - 1)
    const verification = verificationByIteration.get(iteration)
    rows.push({
      iteration,
      title:
        iteration === 1 ? goal.title.trim() || null : visibleNextAction(previousVerification?.nextAction),
      items,
      completedCount,
      totalCount: items.length,
      completed: items.length > 0 && completedCount >= items.length,
      verificationOutcome: verification?.outcome ?? null,
      verificationReason: verification?.reason ?? null,
    })
  }

  return rows.sort((left, right) => {
    if (left.completed !== right.completed) return left.completed ? -1 : 1
    return left.iteration - right.iteration
  })
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
  const runningWorkflows = [...input.runningWorkflows]
  const endedWorkflowCount = Math.max(0, input.endedWorkflowCount)

  return {
    git,
    goal,
    sessionPlans,
    plan,
    runningJobs,
    runningAgents,
    endedAgentCount,
    runningWorkflows,
    endedWorkflowCount,
    // 上游 hasContent 只认活内容；已结束目录行不单独开门（只有已结束
    // 智能体的会话整块不渲染——上游同判，2026-11-17 对齐轮照抄）。
    hasContent: Boolean(
      git ||
        goal ||
        sessionPlans ||
        plan ||
        runningJobs.length > 0 ||
        runningAgents.length > 0 ||
        // 上游同判：已结束目录计数不单独开门（只有历史实例的会话整块不渲染）。
        runningWorkflows.length > 0,
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
