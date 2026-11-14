/**
 * 模式切换钮（composer 工具行，"+" 右侧——ZCode `V4ComposerModeSwitch`
 * 同位，2026-11-01 用户点名三态：计划模式 / 文件内修改 / 完全访问）。
 *
 * 结构对齐上游：触发钮 = ghost（模式图标 + 当前模式名 + ChevronDown），
 * 菜单 side=top = **计划模式独立勾选**（Lightbulb，"编辑前先出计划"）+
 * 分隔线 + **权限单选组**（变更前确认 / 文件内修改 / 完全访问）。
 * 图标语义照上游 resolveModeOptionIcon：yolo=ShieldAlert（警示色）、
 * plan=Lightbulb、其余=ShieldCheck。
 *
 * 数据面 = mode-store（pi ApprovalMode + plan gate，全链路真数据）。
 * 完全访问上游还有一道确认对话框——pi 的 Yolo 有硬策略闸与双确认类兜底，
 * 这里照 ZCode 保留确认步（confirm-dialog）。
 *
 * 计划审批卡（模型 submit_plan 后）= 本文件的 `PlanReviewCard`，挂
 * thread 消息区顶部（与压缩横幅同位）——轮询 planPending，批准/驳回走
 * Rust `pi_decide_plan`。
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import {
  ChevronDownIcon,
  LightbulbIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { ghostButton } from '@/components/assistant-ui/elements/surfaces'
import {
  ContextMenu,
  ContextMenuAnchor,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from '@/components/motion/context-menu'
import {
  modeStore,
  type ApprovalMode,
} from '@/components/assistant-ui/mode-store'

/** 权限单选的三档（ZCode zh-CN 原文；文件内修改 = pi Write 语义）。 */
const APPROVAL_OPTIONS: readonly { value: ApprovalMode; label: string; description: string }[] = [
  { value: 'always-ask', label: '变更前确认', description: '改文件前先问我。' },
  { value: 'write', label: '文件内修改', description: '自动编辑文件。' },
  { value: 'yolo', label: '完全访问', description: '减少确认次数。' },
]

/** 触发钮的图标/文案（ZCode resolveModeOptionIcon 同语义）。 */
function currentModeLabel(approvalMode: ApprovalMode, planActive: boolean): {
  icon: typeof ShieldCheckIcon
  label: string
  warning: boolean
} {
  if (planActive) return { icon: LightbulbIcon, label: '计划模式', warning: false }
  if (approvalMode === 'yolo') return { icon: ShieldAlertIcon, label: '完全访问', warning: true }
  if (approvalMode === 'write')
    return { icon: ShieldCheckIcon, label: '文件内修改', warning: false }
  return { icon: ShieldCheckIcon, label: '变更前确认', warning: false }
}

export function ModeSwitch() {
  const approvalMode = useStore(modeStore, (s) => s.approvalMode)
  const planMode = useStore(modeStore, (s) => s.planMode)
  const error = useStore(modeStore, (s) => s.error)
  const loaded = useStore(modeStore, (s) => s.loaded)
  // 计划模式期间轮询（submit_plan 后 planPending 出现 → PlanReviewCard 显卡）
  const planActive = planMode === 'planning' || planMode === 'pending_approval'
  useEffect(() => {
    void modeStore.getState().refresh()
  }, [])
  useEffect(() => {
    if (!planActive) return
    const timer = window.setInterval(() => void modeStore.getState().refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [planActive])

  const planOn = planMode !== 'off'
  const { icon: Icon, label, warning } = currentModeLabel(approvalMode, planOn)

  return (
    <ContextMenu align="start" anchor="trigger" side="top" sideOffset={6}>
      <ContextMenuAnchor>
        <button
          type="button"
          aria-label="切换模式"
          aria-expanded={undefined}
          data-slot="mode-switch-trigger"
          className={cn(
            ghostButton,
            'h-8 gap-1.5 rounded-full px-2.5 text-[12.5px]',
            warning && 'text-amber-600 dark:text-amber-400',
          )}
        >
          <Icon className="size-[var(--size-icon-lg)]" aria-hidden="true" />
          {/* 未拉到状态前不显示文案（避免闪"变更前确认"假态） */}
          <span className="max-w-24 truncate">{loaded ? label : ''}</span>
          <ChevronDownIcon className="size-[var(--size-icon-sm)] opacity-60" aria-hidden="true" />
        </button>
      </ContextMenuAnchor>
      <ContextMenuContent ariaLabel="切换模式" className="w-64">
        <ContextMenuCheckboxItem
          checked={planOn}
          onCheckedChange={(checked) => void modeStore.getState().setPlanMode(checked)}
        >
          <LightbulbIcon className="mt-0.5 size-[var(--size-icon-lg)] shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>计划模式</span>
            <span className="text-foreground/45 text-[11px]">编辑前先出计划。</span>
          </span>
        </ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuRadioGroup
          value={approvalMode}
          onValueChange={(v) => {
            if (v === 'yolo' && approvalMode !== 'yolo') {
              // 完全访问保留确认步（ZCode useYoloModeConfirmation 同款——
              // 一次误点不该把所有工具闸门全开）
              if (window.confirm('要启用完全访问吗？\n\n所有工具调用将自动放行（危险命令仍需二次确认）。'))
                void modeStore.getState().setApprovalMode('yolo')
              return
            }
            void modeStore.getState().setApprovalMode(v as ApprovalMode)
          }}
        >
          {APPROVAL_OPTIONS.map((option) => {
            const Icon = option.value === 'yolo' ? ShieldAlertIcon : ShieldCheckIcon
            return (
              <ContextMenuRadioItem key={option.value} value={option.value}>
                <Icon
                  className={cn(
                    'mt-0.5 size-[var(--size-icon-lg)] shrink-0',
                    option.value === 'yolo' && 'text-amber-600 dark:text-amber-400',
                  )}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{option.label}</span>
                  <span className="text-foreground/45 text-[11px]">{option.description}</span>
                </span>
              </ContextMenuRadioItem>
            )
          })}
        </ContextMenuRadioGroup>
        {error !== null && (
          <div role="alert" className="text-destructive px-2.5 pb-1.5 pt-1 text-[11px]">
            {error}
          </div>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 计划审批卡（模型 submit_plan 后出现；批准 = 计划钉入上下文并放行）。 */
export function PlanReviewCard() {
  const planPending = useStore(modeStore, (s) => s.planPending)
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)

  const decide = async (approve: boolean) => {
    if (busy !== null) return
    setBusy(approve ? 'approve' : 'reject')
    try {
      await modeStore.getState().decidePlan(approve)
    } finally {
      setBusy(null)
    }
  }

  if (planPending === null) return null

  return (
    <div
      data-slot="aui_plan-review"
      className="border-foreground/[0.06] bg-background rounded-2xl border shadow-sm dark:bg-popover"
    >
      <div className="flex h-9 items-center gap-2 px-3">
        <LightbulbIcon className="text-foreground/45 size-[var(--size-icon-lg)] shrink-0" aria-hidden="true" />
        <span className="text-[13px] text-foreground/70">计划待审</span>
        <span className="text-foreground/35 text-[11px]">批准后模型按计划执行；驳回则按反馈修改</span>
      </div>
      <pre className="max-h-64 overflow-y-auto border-t border-foreground/[0.06] px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words">
        {planPending}
      </pre>
      <div className="flex items-center justify-end gap-1.5 border-t border-foreground/[0.06] px-2 py-1.5">
        {busy !== null && (
          <span className="text-foreground/35 mr-auto text-[11px]">处理中…</span>
        )}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void decide(false)}
          className="focus-visible:ring-foreground/20 flex h-7 items-center rounded-full px-2.5 text-[12px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/90 disabled:opacity-40"
        >
          驳回
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void decide(true)}
          className="bg-foreground text-background focus-visible:ring-foreground/20 flex h-7 items-center rounded-full px-3 text-[12px] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          批准执行
        </button>
      </div>
    </div>
  )
}
