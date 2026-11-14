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
 * 数据面：待办（todo-store）/ git 变更（git-store）→ conversation-status-panel-model.ts
 * （上游 buildConversationStatusPanelModel 的宿主适配）。**面板常驻**：
 * 有活动会话即渲染（无数据时显示"暂无活动"空态），上游的"无内容整块卸载"
 * 不再照抄（2026-11-15 用户定稿）。
 *
 * **已移除的分区（2026-11-15，实证不可做）**：终端（rpi jobs 插件不可装）、
 * 智能体（子代理状态在引擎进程内无读取面）、工作流 / 目标（rpi 引擎无概念）
 * ——UI、模型字段与 hub/jobs 拉取一并删除，不留永远空的假分区。
 *
 * **与上游其余两处偏差**（都因宿主没有对应原语/页面）：
 * 1. Todo 折叠预览：上游 HoverCard（悬停出浮层），宿主无 HoverCard →
 *    用 motion Popover trigger="hover"（同一交互语义）；预览 side 只有
 *    top/bottom（上游 left），用 bottom + 视口钳位。
 * 2. git 区：上游有分支切换器 / git 动作菜单（宿主引擎无此能力面）→
 *    只保留「更改」行（点击开审查面板，走 __dvApi 全局 + openPagePanel，
 *    与 session-drag 同款全局取 api）与分支名只读行。
 * 3. 子代理行分区已随"实证不可做"整段删除（2026-11-15）：子代理在对话区
 *    走工具卡（delegation-card），状态面板不再有智能体分区。
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from 'zustand'
import {
  ActivityIcon,
  ArrowRightIcon,
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
  openReview: '打开审查面板',
  /** 常驻面板的空态（无待办 / 无 git 变更）。 */
  empty: '暂无活动',
  emptyHint: '本次会话还没有待办或文件更改',
} as const

// ── 显示策略（variant）──────────────────────────────────────────────
// override/持久化住在 status-panel-store（对话内容列的让位类要消费同一
// 份策略；本组件还负责把"此刻以面板形态在场"写回 store）。

// ── 可折叠分区（上游 StatusSection 逐条照抄）────────────────────────
type StatusSectionKind = 'environment' | 'plan'

const STATUS_SECTION_SCROLL_POLICY = {
  environment: null,
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: 'max-h-80',
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
  ) : (
    // 面板常驻（2026-11-15 用户："我的活动面板也没有了"）：无待办/无 git
    // 变更时给一行诚实空态——不是 0/0 也不是假状态，就是"没有活动"。
    <StatusSummaryMetric icon={<ActivityIcon className="text-foreground/45 size-4" />}>
      <span className="min-w-0 truncate">{L.empty}</span>
    </StatusSummaryMetric>
  )

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
  // New Chat / 启动无会话时没有工作区可查，面包屑也还不存在。
  // **有会话即常驻**（2026-11-15 用户："我的活动面板也没有了"）：上游的
  // `!hasContent → null` 不再照抄——没有数据时面板显示诚实空态（"暂无活动"），
  // 而不是整块消失。activeId === null 即 New Chat（catalog 与 runtime
  // currentThreadId 同源）。
  const activeId = useStore(sessionCatalog, (s) => s.activeId)
  const { todo } = useTodoBridge()
  const { stat: gitStat } = useGitBridge()
  // 活动会话工作区（git 变更统计的目标目录）；数据源与对话栏列头同源
  const cwd = useStore(sessionCatalog, (s) =>
    sessionProjectCwd(s.activeId ? s.entries[s.activeId] : undefined, s.pendingCwd),
  )

  const override = useStore(statusPanelStore, (s) => s.override)

  // 面板在场 → 写共享 store（对话内容列的顶部余隙判定；卸载即清除）。
  // mini 胶囊也算在场（胶囊同样挂在列右上角，需要余隙）。
  const variant: StatusPanelVariant = override ?? 'auto'
  useEffect(() => {
    statusPanelStore.getState().setMounted(true)
    return () => statusPanelStore.getState().setMounted(false)
  }, [])

  // 挂载/聚焦拉取：待办重放 + git 变更统计。
  // **hub / jobs 拉取已移除**（2026-11-15）：rpi 的 jobs 插件不可装、子代理
  // 状态在引擎进程内无读取面——`pi_hub_roster` / `pi_job_list` 没有真实数据，
  // 拉它只是往空 registry 上做无意义 IPC。
  useEffect(() => {
    void todoBridge.getState().refresh()
    void gitBridge.getState().refresh(cwd ?? null)
  }, [cwd])

  const model = useMemo(
    () =>
      buildStatusPanelModel({
        todoTasks: todo === null ? [] : flatTasks(todo),
        git: gitStat,
      }),
    [todo, gitStat],
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

  const canRenderGit = Boolean(model.git)
  const canRenderPlan = Boolean(model.plan)

  // draft（无会话）不挂；有会话常驻（空态见 StatusSummaryRow / 正文空态）
  if (activeId === null) return null

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
        data-empty={canRenderGit || canRenderPlan ? undefined : 'true'}
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
            {/* 常驻面板的空态：没有待办也没有 git 变更时，正文给一行说明
                （不造假数据、不渲染空分区）。 */}
            {!canRenderGit && !canRenderPlan ? (
              <div
                data-slot="aui_status-empty"
                className="text-foreground/40 flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px]"
              >
                <ActivityIcon className="size-[var(--size-icon-md)] shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{L.emptyHint}</span>
              </div>
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
