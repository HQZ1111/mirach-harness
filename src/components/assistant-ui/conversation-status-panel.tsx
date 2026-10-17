/**
 * 活动状态面板（对话栏右上角浮层）——ZCode `ConversationStatusPanel`
 * （packages/ui/src/v4/ConversationStatusPanel.tsx）的 mirach 移植版。
 *
 * 形态（与 ZCode 同款）：
 * - **panel**：右上角 `absolute top-0 right-*` 的 `w-80` 卡片，分区纵向
 *   排列、各自可折叠；头部每区 = 标题 + 折叠箭头 + 尾部摘要（展开显计数，
 *   收起显「最长时长 · N」）。
 * - **mini**：收起成一条胶囊，显示当前优先级最高的一件事（待办当前项 >
 *   运行计数 > 已结束后兜底），点开回到 panel。
 *
 * 数据面（真数据）：待办（todo-store）/ 子代理（agent-hub-store）/ 终端
 * （jobs-store）——全部经 runtime.tsx 的 tool-sidecar 分派 + IPC 拉取。
 *
 * 引擎侧缺数据的分区（workflow run / goal / git 变更统计）：**UI 保留**，
 * 渲染「引擎侧缺数据」占位行——pi 内核无这些概念（详见 docs/engine-gaps.md）。
 * 不编造数字、不隐藏分区（用户 2026-10-16 口径：能做的做、没有的做 UI 并
 * 标注缺数据，别砍）。
 */
import { useEffect, useState, type FC, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  FileDiffIcon,
  ListChecksIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  Workflow,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { field, ghostButton, mono, paper } from '@/components/assistant-ui/elements/surfaces'
import {
  agentHubBridge,
  isSettled,
  useAgentHubBridge,
  type ChildEntry,
  type ChildStatus,
} from '@/components/assistant-ui/agent-hub-store'
import {
  jobsBridge,
  useJobsBridge,
  type JobSnapshot,
} from '@/components/assistant-ui/jobs-store'
import { gitBridge, useGitBridge } from '@/components/assistant-ui/git-store'
import { useStore } from 'zustand'
import {
  sessionCatalog,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog'
import {
  flatTasks,
  todoBridge,
  useTodoBridge,
  type TodoTask,
} from '@/components/assistant-ui/todo-store'

// ── 时长格式化（ZCode formatDurationUnits 同款语义）──────────────────
const formatDuration = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分`)
  if (rest > 0 || parts.length === 0) parts.push(`${rest}秒`)
  return parts.join('')
}

/** 相对时长（给 startedMs → now 的毫秒差）。 */
const elapsedLabel = (startedMs: number, now: number): string =>
  formatDuration((Math.max(0, now - startedMs)) / 1000)

// ── 可折叠分区（ZCode StatusSection 同款）────────────────────────────
const StatusSection: FC<{
  title: string
  trailing?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}> = ({ title, trailing, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-foreground/20"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-foreground/45" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-foreground/45" />
        )}
        <span className="shrink-0 text-[13px] text-foreground/70">{title}</span>
        {trailing !== undefined && (
          <span className={cn(mono, 'ml-auto min-w-0 shrink truncate text-foreground/40 tabular-nums')}>
            {trailing}
          </span>
        )}
      </button>
      {open && <div className="min-w-0 pb-1">{children}</div>}
    </section>
  )
}

// ── 通用行（图标 + 两行文本 + 尾控件，ZCode 行样式）─────────────────
const StatusRow: FC<{
  icon: ReactNode
  title: string
  meta?: ReactNode
  onOpen?: () => void
  trailing?: ReactNode
}> = ({ icon, title, meta, onOpen, trailing }) => (
  <li className="group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-foreground/[0.04]">
    {onOpen && (
      <button
        type="button"
        aria-label={title}
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-lg focus-visible:ring-2 focus-visible:ring-foreground/20"
      />
    )}
    <span className="pointer-events-none relative z-1 mt-0.5 shrink-0 text-foreground/45">
      {icon}
    </span>
    <div className="pointer-events-none relative z-1 flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="line-clamp-2 text-[13px] leading-5 text-foreground/90">{title}</span>
      {meta !== undefined && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          {meta}
        </span>
      )}
    </div>
    {trailing !== undefined && (
      <span className="pointer-events-auto relative z-2 shrink-0 self-center">{trailing}</span>
    )}
  </li>
)

/** 停止按钮（后台任务 / 子代理共用）：调 host IPC 取消，成功后拉取刷新投影。
 * 失败 console.error 可见（不乐观假装成功——兜底禁令）；进行中禁用防重复。 */
const StopButton: FC<{ onStop: () => Promise<void> }> = ({ onStop }) => {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      aria-label="停止"
      onClick={() => {
        if (busy) return
        setBusy(true)
        void onStop().finally(() => setBusy(false))
      }}
      className={cn(ghostButton, 'size-6', busy && 'opacity-40')}
    >
      {busy ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : (
        <SquareIcon className="size-3 fill-current" />
      )}
    </button>
  )
}

// ── 分区：待办（plan，真数据）────────────────────────────────────────
const PLAN_ICON: Record<TodoTask['status'], ReactNode> = {
  done: <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />,
  dropped: <CircleIcon className="size-3.5 shrink-0 text-foreground/25" />,
  in_progress: <PlayIcon className="size-3.5 shrink-0 text-foreground" />,
  open: <CircleIcon className="size-3.5 shrink-0 text-foreground/35" />,
  blocked: <CircleIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />,
}

const TodoSection: FC = () => {
  const { todo } = useTodoBridge()
  if (todo === null) return null
  const tasks = flatTasks(todo)
  if (tasks.length === 0) return null
  const done = tasks.filter((t) => t.status === 'done').length
  return (
    <StatusSection
      title="待办"
      trailing={
        <span className={done >= tasks.length && tasks.length > 0 ? 'text-emerald-600 dark:text-emerald-400' : undefined}>
          {done}/{tasks.length}
        </span>
      }
    >
      <ul className="space-y-0">
        {tasks.map((t, i) => (
          <li
            key={`${t.content}-${i}`}
            className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]"
          >
            <span className="mt-0.5 shrink-0">{PLAN_ICON[t.status]}</span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'line-clamp-2 text-[13px] leading-5 break-words',
                  t.status === 'done' || t.status === 'dropped'
                    ? 'text-foreground/35 line-through'
                    : 'text-foreground/90',
                )}
              >
                {t.content}
              </span>
              {t.status === 'blocked' && t.reason !== undefined && (
                <span className="mt-0.5 block text-[12px] leading-4 text-amber-700/80 break-words dark:text-amber-400/80">
                  {t.reason}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 分区：子代理（agent，真数据）────────────────────────────────────
const CHILD_STATUS_TEXT: Record<ChildStatus, string> = {
  starting: '启动中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  killed: '已终止',
}

const childMeta = (c: ChildEntry, now: number): ReactNode => (
  <>
    <span className="shrink-0 text-foreground/45 tabular-nums">
      {isSettled(c.status) && c.finishedMs !== null
        ? elapsedLabel(c.startedMs, c.finishedMs)
        : elapsedLabel(c.startedMs, now)}
    </span>
    <span className="shrink-0 text-foreground/35">{CHILD_STATUS_TEXT[c.status]}</span>
    <span className={cn(mono, 'shrink-0 text-foreground/30')}>
      {c.kind === 'tan' ? '/tan' : c.name}
    </span>
  </>
)

const AgentSection: FC = () => {
  const { children } = useAgentHubBridge()
  const [now, setNow] = useState(() => Date.now())
  const running = children.filter((c) => !isSettled(c.status))
  const ended = children.filter((c) => isSettled(c.status))
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])
  if (children.length === 0) return null
  const longest = running.reduce(
    (max, c) => Math.max(max, now - c.startedMs),
    0,
  )
  return (
    <StatusSection
      title="子代理"
      defaultOpen={running.length > 0}
      trailing={
        running.length > 0
          ? `${formatDuration(longest / 1000)} · ${running.length} 个运行中`
          : `${ended.length} 个已结束`
      }
    >
      <ul className="space-y-0">
        {[...running, ...ended].map((c) => (
          <StatusRow
            key={c.id}
            icon={
              isSettled(c.status) ? (
                <CheckCircle2Icon className="size-4" />
              ) : (
                <BotIcon className="size-4" />
              )
            }
            title={c.task}
            meta={childMeta(c, now)}
            trailing={
              !isSettled(c.status) ? (
                <StopButton
                  onStop={async () => {
                    try {
                      await invoke('pi_hub_kill', { agentId: c.id })
                    } catch (e) {
                      console.error('[hub] 子代理终止失败', e)
                    }
                    await agentHubBridge.getState().refresh()
                  }}
                />
              ) : undefined
            }
          />
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 分区：终端（terminal，真数据）───────────────────────────────────
const JOB_STATUS_TEXT: Record<JobSnapshot['status'], string> = {
  running: '运行中',
  exited: '已退出',
  killed: '已终止',
  timedOut: '超时',
  failed: '失败',
}

const TerminalSection: FC = () => {
  const { jobs } = useJobsBridge()
  const [now, setNow] = useState(() => Date.now())
  const running = jobs.filter((j) => j.status === 'running')
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running.length])
  if (jobs.length === 0) return null
  const longest = running.reduce((max, j) => Math.max(max, now - j.startedAtMs), 0)
  return (
    <StatusSection
      title="终端"
      defaultOpen={false}
      trailing={
        running.length > 0
          ? `${formatDuration(longest / 1000)} · ${running.length} 个运行中`
          : `${jobs.length} 个`
      }
    >
      <ul className="space-y-0">
        {[...running, ...jobs.filter((j) => j.status !== 'running')].map((j) => (
          <StatusRow
            key={j.id}
            icon={<SquareTerminalIcon className="size-4" />}
            title={j.command}
            meta={
              <>
                <span className="shrink-0 text-foreground/45 tabular-nums">
                  {j.status === 'running' ? elapsedLabel(j.startedAtMs, now) : JOB_STATUS_TEXT[j.status]}
                </span>
                {j.exitCode !== null && (
                  <span className={cn(mono, 'shrink-0 text-foreground/30')}>
                    exit {j.exitCode}
                  </span>
                )}
              </>
            }
            trailing={
              j.status === 'running' ? (
                <StopButton
                  onStop={async () => {
                    try {
                      await invoke('pi_job_cancel', { jobId: j.id })
                    } catch (e) {
                      console.error('[jobs] 后台任务取消失败', e)
                    }
                    await jobsBridge.getState().refresh()
                  }}
                />
              ) : undefined
            }
          />
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 引擎侧缺数据分区（UI 保留 + 标注）──────────────────────────────
const EngineGapRow: FC<{ what: string; why: string }> = ({ what, why }) => (
  <li className="flex items-start gap-2 rounded-lg px-2 py-2">
    <span className="mt-0.5 shrink-0 text-foreground/25">
      <CircleIcon className="size-3.5" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] leading-5 text-foreground/45">{what}</span>
      <span className="mt-0.5 block text-[12px] leading-4 text-foreground/30">{why}</span>
    </span>
  </li>
)

const WorkflowSection: FC = () => (
  <StatusSection title="工作流" defaultOpen={false}>
    <ul className="space-y-0">
      <EngineGapRow
        what="工作流运行（阶段/车道/因果图）"
        why="引擎侧缺数据：pi 无 workflow run 概念（docs/engine-gaps.md G3）"
      />
    </ul>
  </StatusSection>
)

const GoalSection: FC = () => (
  <StatusSection title="目标" defaultOpen={false}>
    <ul className="space-y-0">
      <EngineGapRow
        what="目标迭代与验证状态"
        why="引擎侧缺数据：pi 无 GoalState（仅 handoff 文本级目标，docs/engine-gaps.md G4）"
      />
    </ul>
  </StatusSection>
)

const GitSection: FC = () => {
  const { stat } = useGitBridge()
  // 非仓库 / 无变更 → 隐藏分区（与 ZCode buildGitModel 的 added+removed<=0 同款）
  if (stat === null || !stat.isRepository) return null
  const hasChanges = stat.added + stat.removed > 0 || stat.changedFiles > 0
  if (!hasChanges) return null
  return (
    <StatusSection
      title="环境"
      defaultOpen
      trailing={
        <span className="flex items-center gap-1.5">
          <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>
          <span className="text-red-600 dark:text-red-400">-{stat.removed}</span>
        </span>
      }
    >
      <ul className="space-y-0">
        <li className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <FileDiffIcon className="size-4 shrink-0 text-foreground/45" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
            {stat.changedFiles} 个文件变更
          </span>
          <span className={cn(mono, 'shrink-0 tabular-nums')}>
            <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>{' '}
            <span className="text-red-600 dark:text-red-400">-{stat.removed}</span>
          </span>
        </li>
        {stat.branch !== null && (
          <li className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <CircleIcon className="size-3.5 shrink-0 text-foreground/30" />
            <span className={cn(mono, 'min-w-0 flex-1 truncate text-foreground/55')}>
              {stat.branch}
            </span>
          </li>
        )}
      </ul>
      <p className="px-2 pb-1 text-[11px] leading-4 text-foreground/30">
        工作区当前状态（相对 HEAD 的未提交变更，非本会话改动）
      </p>
    </StatusSection>
  )
}

// ── mini 胶囊（收起态：优先级最高的一件事）─────────────────────────
const SummaryPill: FC<{ onExpand: () => void }> = ({ onExpand }) => {
  const { todo } = useTodoBridge()
  const { children } = useAgentHubBridge()
  const { jobs } = useJobsBridge()
  const runningAgents = children.filter((c) => !isSettled(c.status)).length
  const runningJobs = jobs.filter((j) => j.status === 'running').length
  const runningTotal = runningAgents + runningJobs

  const tasks = todo === null ? [] : flatTasks(todo)
  const currentTask =
    tasks.find((t) => t.status === 'in_progress') ??
    tasks.find((t) => t.status === 'open' || t.status === 'blocked') ??
    null

  const kindCount = [runningAgents > 0, runningJobs > 0].filter(Boolean).length
  const RunningIcon = kindCount > 1 ? ActivityIcon : runningAgents > 0 ? BotIcon : SquareTerminalIcon

  const metric =
    currentTask !== null ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <PlayIcon className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0 truncate">{currentTask.content}</span>
      </span>
    ) : runningTotal > 0 ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <RunningIcon className="size-4 shrink-0 text-foreground" />
        <span className="shrink-0">{runningTotal} 个运行中</span>
      </span>
    ) : null

  if (metric === null) return null

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="展开活动面板"
      className={cn(
        paper,
        'group inline-flex h-8.5 max-w-80 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-foreground/20',
      )}
    >
      <span className="relative size-4 shrink-0">
        <span className="absolute inset-0 transition-opacity group-hover:opacity-0">{metric}</span>
        <Maximize2Icon className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="min-w-0 truncate">{metric}</span>
    </button>
  )
}

// ── 面板主体 ───────────────────────────────────────────────────────
export const ConversationStatusPanel: FC = () => {
  const [collapsed, setCollapsed] = useState(false)
  // 活动会话工作区（git 变更统计的目标目录）；数据源与对话栏列头同源
  const cwd = useStore(sessionCatalog, (s) =>
    sessionProjectCwd(s.activeId ? s.entries[s.activeId] : undefined, s.pendingCwd),
  )

  // 挂载/聚焦拉取：registry 与会话解耦，模型没调 hub/jobs 工具时也要能看到
  // 已注册的子代理与后台任务（真相在 pi 进程级 registry）；待办同理——重放
  // 会话 Custom 条目（重启后模型未再调 todo 工具前也能显示历史待办，G2）；
  // git 变更统计（G6，工作区当前状态）。
  useEffect(() => {
    void agentHubBridge.getState().refresh()
    void jobsBridge.getState().refresh()
    void todoBridge.getState().refresh()
    void gitBridge.getState().refresh(cwd ?? null)
  }, [cwd])

  const hasRealContent =
    useTodoBridge().todo !== null ||
    useAgentHubBridge().children.length > 0 ||
    useJobsBridge().jobs.length > 0

  if (collapsed) {
    return (
      <div className="pointer-events-none absolute top-0 right-4 z-20 flex justify-end pt-4">
        <div className="pointer-events-auto">
          <SummaryPill onExpand={() => setCollapsed(false)} />
        </div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute top-0 right-4 z-20 flex justify-end pt-4">
      <aside
        aria-label="活动面板"
        className={cn(
          paper,
          'pointer-events-auto flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl shadow-md',
        )}
      >
        <div className="flex h-8 shrink-0 items-center justify-end gap-1 px-2 pt-1">
          <button
            type="button"
            aria-label="收起活动面板"
            onClick={() => setCollapsed(true)}
            className={cn(ghostButton, 'size-6')}
          >
            <Minimize2Icon className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
          {!hasRealContent && (
            <p className="px-2 pb-1 text-[12px] text-foreground/35">
              暂无活动。待办 / 子代理 / 终端任务出现时自动显示。
            </p>
          )}
          <TodoSection />
          <AgentSection />
          <TerminalSection />
          <WorkflowSection />
          <GoalSection />
          <GitSection />
        </div>
      </aside>
    </div>
  )
}
