/**
 * 活动状态面板模型 —— ZCode `v4/conversationStatusPanelModel.ts` 的 mirach
 * 适配（2026-11-01 用户："对话区的右上角的活动状态面板直接用zcode的"）。
 *
 * 与上游的差异只有**数据来源**（上游吃 v4 会话投影，这里吃宿主 bridge +
 * git store），推导规则逐条照抄：
 * - git 模型：`added + removed <= 0 → null`（clean repo 不挂卡，上游
 *   buildGitModel 同判）；
 * - plan 模型：保留 snapshot 原序（`displayItems = items`，重排会让 Todo
 *   完成时跳位——上游注释同文）。
 *
 * **已移除的分区（2026-11-15，实证不可做）**：
 * - 终端（上游 BackgroundWorkStatusSection / jobs）：rpi 的 jobs 插件不可装，
 *   `pi_job_list` 无真实数据面；
 * - 智能体（上游 SubagentStatusSection / hub roster）：子代理状态完在 rpi
 *   进程内，宿主没有读取面（`pi_hub_roster` 只有空的宿主 registry）；
 * - workflow / goal / sessionPlans：rpi 引擎无这些概念（docs/engine-gaps.md
 *   G3/G4）。
 * 分区 UI 与模型字段一并删除——不留"永远空"的假分区。
 *
 * 上游字段缺席用"字段不存在"而不是 0/空串的纪律同样保留：渲染层据此决定
 * 一行有没有时长、能不能停。
 */

/** 宿主侧输入（全部来自宿主 store，形状见各 store 文件头注释）。 */
export interface StatusPanelInput {
  /** 待办任务（todo-store flatTasks 的投影）。 */
  todoTasks: readonly { content: string; status: 'open' | 'in_progress' | 'done' | 'dropped' | 'blocked' }[]
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

export interface StatusPanelGitModel {
  branchName: string | null
  dirtyFileCount: number
  added: number
  removed: number
}

export interface StatusPanelModel {
  git: StatusPanelGitModel | null
  plan: StatusPanelPlanModel | null
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
  return {
    git: buildGitModel(input),
    plan: buildPlanModel(input.todoTasks),
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
