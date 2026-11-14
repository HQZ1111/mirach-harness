/**
 * 活动状态面板（对话栏右上角浮层）—— **ZCode 原版结构与行为移植**
 * （2026-11-01 用户："对话区的右上角的活动状态面板直接用zcode的"）。
 *
 * 上游 = packages/ui/src/v4/ConversationStatusPanel.tsx（2229 行）+
 * conversationStatusPanelModel.ts。本文件按上游结构逐段移植：
 *
 * - **三态**（auto / panel / mini）：auto = 容器查询裁决——对话列
 *   （`.assistant-thread-pane` 是 named container `thread`）≥1280px 出
 *   panel、窄了收 mini 胶囊；panel/mini 为用户钉死态（Ellipsis 菜单选，
 *   localStorage `mirach:status-panel-variant` 持久化）。
 * - **控制行**：右上角 Ellipsis（显示策略菜单）+ Minimize2（收起为胶囊）。
 *   上游菜单只挂了 auto 一项（panel/mini 的 i18n 键与 handler 都在但条目
 *   缺失——上游缺陷），这里补全三项。
 * - **分区**：Collapsible + 每类限高滚动视口（STATUS_SECTION_SCROLL_POLICY）
 *   + separated 上边线 + trailing 随开合切换；分区标题行 = 标题 + 悬停
 *   出现的箭头（`opacity-0 group-hover:opacity-100`）+ 内联 trailing。
 * - **mini 胶囊**：优先级链（当前待办 → git 变更 → 最近完成项 → 计数
 *   → 运行计数），点开回 panel。
 *
 * 数据面：待办（todo-store）/ 子代理（agent-hub-store）/ 后台命令
 * （jobs-store）/ git 变更（git-store）→ conversation-status-panel-model.ts
 * （上游 buildConversationStatusPanelModel 的宿主适配）。
 *
 * **引擎侧没有的数据 = 没有分区**（工作流 / 目标 / 会话计划，pi 无这些
 * 概念——docs/engine-gaps.md G3/G4）：上游本就是"无数据返回 null"，分区
 * 自然不渲染。2026-10-16 旧口径的「保留占位分区 + 标注缺数据」按本次
 * "直接用zcode的"撤销——占位分区是常驻噪声，不是 ZCode 的形态。
 *
 * **与上游其余两处偏差**（都因宿主没有对应原语/页面）：
 * 1. Todo 折叠预览：上游 HoverCard（悬停出浮层），宿主无 HoverCard →
 *    用 motion Popover trigger="hover"（同一交互语义）；预览 side 只有
 *    top/bottom（上游 left），用 bottom + 视口钳位。
 * 2. git 区：上游有分支切换器 / git 动作菜单（宿主引擎无此能力面）→
 *    只保留「更改」行（点击开审查面板，走 __dvApi 全局 + openPagePanel，
 *    与 session-drag 同款全局取 api）与分支名只读行。
 * 3. 子代理行是平的（上游同款）：旧移植版的 TaskCard 展开 / transcript
 *    / steer 随本版移除——ZCode 的行没有这层。
 */
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from 'zustand'
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  EllipsisIcon,
  FileDiffIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  SquareIcon,
  SquareTerminalIcon,
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
import { openPagePanel } from '@/components/layout/open-page-actions'
import {
  agentHubBridge,
  useAgentHubBridge,
} from '@/components/assistant-ui/agent-hub-store'
import { jobsBridge, useJobsBridge } from '@/components/assistant-ui/jobs-store'
import { gitBridge, useGitBridge } from '@/components/assistant-ui/git-store'
import { flatTasks, todoBridge, useTodoBridge } from '@/components/assistant-ui/todo-store'
import {
  sessionCatalog,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog'
import {
  buildStatusPanelModel,
  getStatusPanelTodoFocusWindow,
  type StatusPanelModel,
  type StatusPanelPlanItem,
} from '@/components/assistant-ui/conversation-status-panel-model'
import { statusPanelStore, type StatusPanelVariant } from '@/components/assistant-ui/status-panel-store'

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
  terminals: '终端',
  agents: '智能体',
  openReview: '打开审查面板',
} as const

/** ZCode formatDurationUnits：空格连接（"1小时 2分"）。 */
const formatDurationUnits = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}小时`)
  if (minutes > 0) parts.push(`${minutes}分`)
  if (rest > 0 || parts.length === 0) parts.push(`${rest}秒`)
  return parts.join(' ')
}

/** ZCode formatBackgroundTaskElapsedLabel："已运行 {s} 秒 / {m} 分 {s} 秒"。 */
const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `已运行 ${minutes} 分 ${seconds} 秒` : `已运行 ${totalSeconds} 秒`
}

const formatRunningCount = (count: number) => `${count} 后台`
const formatRunningSubagentCount = (count: number) => `${count} 运行`

/** 每秒心跳（仅在有活动行时开——上游 useNowTicker / setInterval 同纪律）。 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

// ── 显示策略（variant）──────────────────────────────────────────────
// override/持久化住在 status-panel-store（对话内容列的让位类要消费同一
// 份策略；本组件还负责把"此刻以面板形态在场"写回 store）。

// ── 可折叠分区（上游 StatusSection 逐条照抄）────────────────────────
type StatusSectionKind = 'environment' | 'plan' | 'terminal' | 'agent'

const STATUS_SECTION_SCROLL_POLICY = {
  environment: null,
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: 'max-h-80',
  terminal: 'max-h-48',
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
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode
  defaultOpen?: boolean
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
        </CollapsibleContent>
      </section>
    </Collapsible>
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
      </div>
    </StatusSection>
  )
}

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

function PlanStatusItems({ plan }: { plan: NonNullable<StatusPanelModel['plan']> }) {
  const window = getStatusPanelTodoFocusWindow(plan.displayItems)
  const foldLabel = (items: StatusPanelPlanItem[], kind: 'preceding' | 'following'): string => {
    if (kind === 'preceding') {
      return items.every((item) => item.status === 'completed')
        ? `已完成 ${items.length} 项`
        : `前面 ${items.length} 项`
    }
    return items.every((item) => item.status === 'pending')
      ? `待处理 ${items.length} 项`
      : `后面 ${items.length} 项`
  }

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

// ── 分区：终端（上游 BackgroundWorkStatusSection，section=terminal）──
const BASH_STATUS_TEXT: Record<string, string> = {
  exited: '已退出',
  killed: '已终止',
  timedOut: '超时',
  failed: '失败',
}

const AGENT_STATUS_TEXT: Record<string, string> = {
  done: '已完成',
  killed: '已终止',
  timedOut: '超时',
  failed: '失败',
  cancelled: '已取消',
}

function RunningWorkCancelButton({
  workId,
  onCancel,
}: {
  workId: string
  onCancel?: (workId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (busy) return
    setBusy(true)
    void Promise.resolve(onCancel?.(workId)).finally(() => setBusy(false))
  }

  if (!onCancel) return null

  return (
    <button
      type="button"
      aria-label="停止运行中的后台任务"
      onClick={handleClick}
      disabled={busy}
      className={cn(
        ghostButton,
        'text-foreground pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 gap-1 px-1.5 text-[12px]',
        busy && 'opacity-40',
      )}
    >
      <SquareIcon aria-hidden className="size-[var(--size-icon-xs)] fill-current" />
      停止
    </button>
  )
}

function RunningStatusItem({
  now,
  onCancelBackgroundWork,
  work,
}: {
  now: number
  onCancelBackgroundWork?: (workId: string) => void
  work: StatusPanelModel['runningBashWorks'][number]
}) {
  return (
    <li
      data-work-id={work.workId}
      data-work-status={work.status}
      className="hover:bg-foreground/[0.04] group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2"
    >
      <SquareTerminalIcon className="text-foreground/45 pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-foreground line-clamp-2 text-[13px] leading-5">{work.title}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="text-foreground/45 shrink-0 tabular-nums">
            {formatElapsed(Math.max(0, now - work.startedAt))}
          </span>
          {work.cancellable !== false ? (
            <RunningWorkCancelButton workId={work.workId} onCancel={onCancelBackgroundWork} />
          ) : null}
        </div>
      </div>
    </li>
  )
}

/** 已退出行（宿主无「已结束」目录页 → 历史就地留在分区，运行中的在前）。 */
function EndedStatusItem({
  work,
  icon,
  statusText,
}: {
  work: StatusPanelModel['endedBashWorks'][number]
  icon: ReactNode
  statusText: string
}) {
  return (
    <li
      data-work-id={work.workId}
      data-work-status={work.status}
      className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-2"
    >
      <span className="text-foreground/25 pointer-events-none relative z-[1] mt-0.5 shrink-0">{icon}</span>
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-foreground/45 line-clamp-2 text-[13px] leading-5">{work.title}</p>
        <span className="text-foreground/30 text-[13px] tabular-nums">
          {work.status === 'exited' && work.exitCode !== null ? `${statusText}（exit ${work.exitCode}）` : statusText}
        </span>
      </div>
    </li>
  )
}

function BackgroundWorkStatusSection({
  model,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  section,
  title,
}: {
  model: StatusPanelModel
  onCancelBackgroundWork?: (workId: string) => void
  onOpenChange?: (open: boolean) => void
  open?: boolean
  separated: boolean
  section: 'terminal'
  title: string
}) {
  const running = model.runningBashWorks
  const ended = model.endedBashWorks
  const now = useNowTicker(running.length > 0)
  const orderedRunningWorks = useMemo(
    () => [...running].sort((left, right) => left.startedAt - right.startedAt),
    [running],
  )

  if (running.length === 0 && ended.length === 0) return null

  const collapsedElapsedLabel = formatDurationUnits(
    Math.max(
      1,
      Math.floor(
        orderedRunningWorks.reduce(
          (longest, work) => Math.max(longest, Math.max(0, now - work.startedAt)),
          0,
        ) / 1000,
      ),
    ),
  )

  return (
    <StatusSection
      section={section}
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {running.length > 0
              ? `${running.length} 个后台运行`
              : `${running.length + ended.length} 个`}
          </span>
        ) : running.length > 0 ? (
          <>
            <span className="min-w-0 truncate">{collapsedElapsedLabel}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningCount(running.length)}</span>
          </>
        ) : (
          <span className="shrink-0">{`${running.length + ended.length} 个`}</span>
        )
      }
    >
      <ul className="space-y-0">
        {orderedRunningWorks.map((work) => (
          <RunningStatusItem key={work.workId} work={work} now={now} onCancelBackgroundWork={onCancelBackgroundWork} />
        ))}
        {ended.map((work) => (
          <EndedStatusItem
            key={work.workId}
            work={work}
            icon={<SquareTerminalIcon className="size-4" />}
            statusText={BASH_STATUS_TEXT[work.status] ?? work.status}
          />
        ))}
      </ul>
    </StatusSection>
  )
}

// ── 分区：智能体（上游 SubagentStatusSection + 历史尾巴）────────────
function SubagentStatusSection({
  model,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  title,
}: {
  model: StatusPanelModel
  onCancelBackgroundWork?: (workId: string) => void
  onOpenChange?: (open: boolean) => void
  open?: boolean
  separated: boolean
  title: string
}) {
  const subagents = model.runningSubagentWorks
  const ended = model.endedSubagentWorks
  const now = useNowTicker(subagents.length > 0)
  const ordered = useMemo(
    () => [...subagents].sort((left, right) => left.startedAt - right.startedAt),
    [subagents],
  )
  if (subagents.length === 0 && ended.length === 0) return null
  const longestElapsedMs = subagents.reduce(
    (longest, item) => Math.max(longest, Math.max(0, now - item.startedAt)),
    0,
  )

  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {subagents.length > 0
              ? formatRunningSubagentCount(subagents.length)
              : `${subagents.length + ended.length} 个`}
          </span>
        ) : subagents.length > 0 ? (
          <>
            <span className="min-w-0 truncate">{formatDurationUnits(Math.max(1, Math.floor(longestElapsedMs / 1000)))}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningSubagentCount(subagents.length)}</span>
          </>
        ) : (
          <span className="shrink-0">{`${subagents.length + ended.length} 个`}</span>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((subagent) => (
          <li
            key={subagent.childSessionId}
            data-child-session-id={subagent.childSessionId}
            data-work-status="running"
            className="hover:bg-foreground/[0.04] group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2"
          >
            <BotIcon className="text-foreground/45 pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0" />
            <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-foreground line-clamp-2 text-[13px] leading-5">{subagent.title}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className="text-foreground/45 text-[13px] tabular-nums">
                  {formatElapsed(Math.max(0, now - subagent.startedAt))}
                </span>
                <RunningWorkCancelButton workId={subagent.agentId} onCancel={onCancelBackgroundWork} />
              </span>
            </div>
          </li>
        ))}
        {ended.map((work) => (
          <EndedStatusItem
            key={work.workId}
            work={work}
            icon={<BotIcon className="size-4" />}
            statusText={AGENT_STATUS_TEXT[work.status] ?? work.status}
          />
        ))}
      </ul>
    </StatusSection>
  )
}

// ── mini 胶囊（上游 StatusSummaryRow，缺数据分支按同序剔除）─────────
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
  const added = model.git?.added ?? 0
  const removed = model.git?.removed ?? 0
  const hasGitMiniSummary = Boolean(model.git && added + removed > 0)

  // 恰好一类沿用该类图标，混合才是 Activity（上游同规则）
  const hasRunningBash = model.runningBashWorks.length > 0
  const hasRunningSubagent = model.runningSubagentWorks.length > 0
  const runningCount = model.runningBashWorks.length + model.runningSubagentWorks.length
  const RunningSummaryIcon =
    hasRunningBash && hasRunningSubagent ? ActivityIcon : hasRunningBash ? SquareTerminalIcon : BotIcon

  const summaryMetric = currentPlanItem ? (
    <StatusSummaryMetric icon={<ArrowRightIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{currentPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : hasGitMiniSummary ? (
    <StatusSummaryMetric icon={<FileDiffIcon className="text-foreground size-4" />}>
      <span className="min-w-0 truncate">{L.changes}</span>
      <span className="text-emerald-600 dark:text-emerald-400 shrink-0">+{added}</span>
      <span className="text-red-600 dark:text-red-400 shrink-0">-{removed}</span>
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
  ) : runningCount > 0 ? (
    <StatusSummaryMetric icon={<RunningSummaryIcon className="text-foreground size-4" />}>
      {/* 终端 / 智能体的实时计数只能在没有 Todo/Git 等主状态时兜底（上游同注） */}
      <span className="shrink-0">
        {hasRunningSubagent
          ? formatRunningSubagentCount(runningCount)
          : formatRunningCount(runningCount)}
      </span>
    </StatusSummaryMetric>
  ) : null

  if (!summaryMetric) return null

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

// ── 面板主体（上游 ConversationStatusPanelImpl 结构）────────────────
const statusPanelApi = (): DockviewApi | null => {
  const a = (globalThis as { __dvApi?: DockviewApi }).__dvApi
  return a ?? null
}

function ConversationStatusPanelImpl() {
  // **draft 态不挂**（上游同款：SessionPane 只在有会话时渲染本面板）——
  // New Chat / 启动无会话时没有工作区可查（git/todo/jobs 全部诚实空），
  // 挂着只会渲染 null。activeId === null 即 New Chat（catalog 与 runtime
  // currentThreadId 同源）。
  const activeId = useStore(sessionCatalog, (s) => s.activeId)
  const { todo } = useTodoBridge()
  const { children } = useAgentHubBridge()
  const { jobs } = useJobsBridge()
  const { stat: gitStat } = useGitBridge()
  // 活动会话工作区（git 变更统计的目标目录）；数据源与对话栏列头同源
  const cwd = useStore(sessionCatalog, (s) =>
    sessionProjectCwd(s.activeId ? s.entries[s.activeId] : undefined, s.pendingCwd),
  )

  const override = useStore(statusPanelStore, (s) => s.override)
  const [terminalSectionOpen, setTerminalSectionOpen] = useState<boolean | undefined>(undefined)
  const [agentSectionOpen, setAgentSectionOpen] = useState<boolean | undefined>(undefined)

  // 面板在场 → 写共享 store（对话内容列的顶部余隙判定；卸载即清除）。
  // mini 胶囊也算在场（胶囊同样挂在列右上角，需要余隙）。
  const variant: StatusPanelVariant = override ?? 'auto'
  useEffect(() => {
    statusPanelStore.getState().setMounted(true)
    return () => statusPanelStore.getState().setMounted(false)
  }, [])

  // 挂载/聚焦拉取：registry 与会话解耦（旧版同款）——模型没调 hub/jobs 工具
  // 时也要能看到已注册的子代理与后台任务；待办重放；git 变更统计。
  useEffect(() => {
    void agentHubBridge.getState().refresh()
    void jobsBridge.getState().refresh()
    void todoBridge.getState().refresh()
    void gitBridge.getState().refresh(cwd ?? null)
  }, [cwd])

  const model = useMemo(
    () =>
      buildStatusPanelModel({
        todoTasks: todo === null ? [] : flatTasks(todo),
        children,
        jobs,
        git: gitStat,
      }),
    [todo, children, jobs, gitStat],
  )

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

  const onCancelBackgroundWork = useCallback(async (workId: string) => {
    // workId 既是 job id 也是子代理 id（两个 registry 的主键不重叠）。
    // 先试 jobs，失败再试 hub——都不行错误可见（兜底禁令）。
    try {
      await invoke('pi_job_cancel', { jobId: workId })
      await jobsBridge.getState().refresh()
      return
    } catch {
      // 不是 job——继续试子代理
    }
    try {
      await invoke('pi_hub_kill', { agentId: workId })
      await agentHubBridge.getState().refresh()
    } catch (e) {
      console.error('[status-panel] 停止后台任务失败', workId, e)
    }
  }, [])

  const canRenderGit = Boolean(model.git)
  const canRenderPlan = Boolean(model.plan)
  const canRenderTerminals =
    model.runningBashWorks.length > 0 || model.endedBashWorks.length > 0
  const canRenderAgents =
    model.runningSubagentWorks.length > 0 || model.endedSubagentWorks.length > 0

  // 无活内容整块卸载（上游 !hasContent → null 同判）；draft（无会话）不挂
  if (activeId === null || !model.hasContent) return null

  return (
    // **顶带下方**（2026-11-01 用户："活动状态面板的高度也应该避开顶栏"）：
    // 宿主把列头（ChatTabLabel，--logo-strip-h=75）做进了 thread pane，而
    // 上游的 conversation 容器不含头部——直接 top-0 会压在列头上。top =
    // 顶带高 + pt-4 的关系与上游"容器顶 + pt-4"一致。
    <div className="pointer-events-none absolute top-[var(--logo-strip-h)] right-4 z-20 pt-4">
      <aside
        aria-label={L.panelTitle}
        data-state={variant === 'mini' ? 'collapsed' : 'expanded'}
        data-display-mode={variant}
        data-running-background-count={model.runningBashWorks.length + model.runningSubagentWorks.length}
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagentWorks.length}
        className={cn(
          paper,
          'pointer-events-auto relative overflow-hidden rounded-2xl text-foreground shadow-md transition-[border-radius,padding,background-color,box-shadow] duration-300 ease-in-out',
          // 胶囊宽度只由 CSS 决定：w-max 跟随摘要内容（上游同判——ResizeObserver
          // 量宽会晚一帧，文字会落到胶囊外面）
          variant === 'mini'
            ? 'inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col'
            : variant === 'panel'
              ? 'flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100cqw-2rem)] flex-col'
              : 'inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col @min-[1280px]/thread:max-h-[min(64dvh,32rem)] @min-[1280px]/thread:w-80',
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
              <GitStatusSection model={model} cwd={cwd ?? ''} onOpenGitReview={onOpenGitReview} separated={false} />
            ) : null}
            {canRenderPlan ? (
              <PlanStatusSection model={model} separated={canRenderGit} />
            ) : null}
            {canRenderTerminals ? (
              <BackgroundWorkStatusSection
                model={model}
                onCancelBackgroundWork={onCancelBackgroundWork}
                onOpenChange={setTerminalSectionOpen}
                open={terminalSectionOpen}
                section="terminal"
                separated={canRenderGit || canRenderPlan}
                title={L.terminals}
              />
            ) : null}
            {canRenderAgents ? (
              <SubagentStatusSection
                model={model}
                onCancelBackgroundWork={onCancelBackgroundWork}
                onOpenChange={setAgentSectionOpen}
                open={agentSectionOpen}
                separated={canRenderGit || canRenderPlan || canRenderTerminals}
                title={L.agents}
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
