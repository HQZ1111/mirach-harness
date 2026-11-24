"use client";

/**
 * Composer 模式芯片（dsh 计划模式 / 完全访问的宿主移植，2026-11-23）。
 *
 * 只有两个模式，且**会话级**：
 * - **计划模式**：rpi-plan-mode 计划态（会话条目 + 每个 harness 一份插件
 *   实例）；`/plan start|exit`。计划期间只放行 read / bash / docs /
 *   plan_mode_complete。插件收窄工具目录是下一次 run 才换的快照，
 *   `ApprovalMode::Planning` 会话 pin 让**进行中的 run** 也立即拦截
 *   write/edit（read/bash 照常）。
 * - **完全访问**：引擎 `ApprovalMode::Yolo` 的**会话 pin**（approval_gate
 *   `set_session_mode`；宿主持久化到 `~/.rpi/agent/approval-modes.json`）。
 *   打开时二次确认；关闭回 `always-ask`。
 *
 * 两者互斥：进入计划会先把该会话的审批退回 always-ask；开启完全访问会先
 * 退出计划态。默认（都未开）= always-ask。
 *
 * 会话 id：composer 的 `threadId` = pi 会话 id（runtime.tsx 注释同源）。
 * 已存在的会话（ULID）直接按 id 读写 pin；New Chat 的本地线程 id 不传，
 * 宿主把选择暂存为 pending，等第一份主会话创建时消费。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  ShieldAlertIcon,
  ShieldIcon,
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { cn } from '@/lib/utils'

interface ModeState {
  /** 'planning' | 'off' */
  planMode?: string
  /** 会话级审批模式：always-ask / write / yolo / planning（计划态内部 pin） */
  approvalMode?: string
  /** rpi-permission-gate 是否在启动期启用（env RPI_PERMISSION_GATE） */
  permissionGate?: boolean
}

type ApprovalId = 'always-ask' | 'write' | 'yolo'

/** pi 会话 id：UUID（v7 带连字符，如 01a2047a-00cd-…）或历史 ULID。 */
const PI_SESSION_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i

export function PermissionModeChip({
  className,
  threadId,
  running,
}: {
  className?: string
  /** 会话切换时重读（审批 pin / 计划态都是会话级） */
  threadId?: string | undefined
  /** run 结束后重读（plan_mode_complete 会自己退出计划态） */
  running?: boolean | undefined
}) {
  const [state, setState] = useState<ModeState | null>(null)
  const [open, setOpen] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const sessionId =
    threadId !== undefined && PI_SESSION_ID.test(threadId) ? threadId : null

  const refresh = useCallback(() => {
    invoke<ModeState>('pi_mode_state', { sessionId })
      .then(setState)
      .catch((e) => console.error('[mode] pi_mode_state 读取失败', e))
  }, [sessionId])

  useEffect(() => {
    refresh()
  }, [refresh, threadId])

  useEffect(() => {
    if (!running) refresh()
  }, [refresh, running])

  // 轻轮询：计划模式可能在 `plan_mode_complete` 后自行退出，浏览器侧
  // 没有事件面；2s 一次与旧 mode-store 同节奏（也兜住外部会话切换）。
  useEffect(() => {
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const currentApproval: ApprovalId =
    state?.approvalMode === 'yolo'
      ? 'yolo'
      : state?.approvalMode === 'write'
        ? 'write'
        : 'always-ask'
  const currentPlan = state?.planMode === 'planning'
  // 计划态下宿主 pin 是 planning（引擎确定性拦截变更工具），UI 两个模式
  // 互斥——计划显示为计划，不把"完全访问"也打勾。
  const fullAccess = !currentPlan && currentApproval === 'yolo'
  const label = currentPlan ? '计划模式' : fullAccess ? '完全访问' : '默认'

  /** 写该会话的审批 pin（Yolo 即完全访问；always-ask 为默认）。 */
  const applyApproval = useCallback(
    async (mode: ApprovalId) => {
      await invoke('pi_set_approval_mode', { mode, sessionId })
      refresh()
    },
    [refresh, sessionId],
  )

  const runPlan = useCallback(
    async (action: 'start' | 'exit') => {
      await invoke('pi_set_plan_mode', { enabled: action === 'start', sessionId })
      refresh()
    },
    [refresh, sessionId],
  )

  /** 计划模式开关（互斥：进入前把 full access 退回默认审批）。 */
  const togglePlan = async () => {
    if (planBusy) return
    setPlanBusy(true)
    setError(null)
    try {
      if (currentPlan) {
        await runPlan('exit')
      } else {
        // 互斥由宿主落：主会话进计划会把该会话审批退回 always-ask；
        // 并列窗格保持 yolo（窗格没有审批卡渲染面）。
        await runPlan('start')
      }
      setOpen(false)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      console.error('[mode] 计划模式切换失败', e)
    } finally {
      setPlanBusy(false)
    }
  }

  /** 完全访问开关（互斥：开启前先退出计划态；关闭即回 always-ask）。 */
  const toggleFullAccess = async () => {
    if (approvalBusy) return
    if (fullAccess) {
      setApprovalBusy(true)
      setError(null)
      try {
        await applyApproval('always-ask')
        setOpen(false)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        console.error('[mode] 关闭完全访问失败', e)
      } finally {
        setApprovalBusy(false)
      }
      return
    }
    setOpen(false)
    setAcknowledged(false)
    setConfirmOpen(true)
  }

  const confirmFullAccess = async () => {
    setApprovalBusy(true)
    try {
      if (currentPlan) await runPlan('exit')
      await applyApproval('yolo')
    } finally {
      setApprovalBusy(false)
    }
  }

  const TriggerIcon = currentPlan
    ? ClipboardListIcon
    : fullAccess
      ? ShieldAlertIcon
      : ShieldIcon

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) {
            setError(null)
            refresh()
          }
        }}
        align="start"
        side="top"
        sideOffset={8}
      >
        <PopoverTrigger>
          <button
            type="button"
            aria-label="切换模式"
            aria-haspopup="menu"
            title={label}
            className={cn(
              // ZCode 实测（9444）：28 高、圆角 8、14px 字、px-2、图标 16。
              'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex h-[28px] shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[14px] transition-colors',
              // 窄卡片：文字与箭头一起收掉，只留图标。
              '@max-xl/composer:size-[28px] @max-xl/composer:justify-center @max-xl/composer:gap-0 @max-xl/composer:px-0',
              currentPlan && 'text-(--ui-accent)',
              className,
            )}
          >
            <TriggerIcon className="size-[16px] shrink-0" />
            <span className="whitespace-nowrap @max-xl/composer:hidden">{label}</span>
            <ChevronDownIcon className="size-[12px] shrink-0 opacity-50 @max-xl/composer:hidden" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          role="menu"
          aria-label="切换模式"
          className="bg-popover text-popover-foreground w-80 rounded-xl p-1.5 shadow-(--shadow-pop)"
        >
          <button
            key="plan"
            type="button"
            role="menuitemcheckbox"
            aria-checked={currentPlan}
            disabled={planBusy || approvalBusy}
            onClick={() => void togglePlan()}
            className={cn(
              'hover:bg-foreground/[0.06] flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors disabled:opacity-60',
              currentPlan && 'bg-foreground/[0.06]',
            )}
          >
            <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
              {currentPlan ? <CheckIcon className="size-[14px]" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-[19px] font-medium">
                计划模式
                {planBusy ? <span className="text-muted-foreground"> · 切换中…</span> : null}
              </span>
              <span className="text-muted-foreground block text-[12px] leading-[17px]">
                编辑前先出计划；只放行 read / bash / docs。
              </span>
            </span>
          </button>

          <button
            key="full"
            type="button"
            role="menuitemcheckbox"
            aria-checked={fullAccess}
            disabled={planBusy || approvalBusy}
            onClick={() => void toggleFullAccess()}
            className={cn(
              'hover:bg-foreground/[0.06] flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors disabled:opacity-60',
              fullAccess && 'bg-foreground/[0.06]',
            )}
          >
            <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
              {fullAccess ? <CheckIcon className="size-[14px]" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-[19px] font-medium">
                完全访问
                {approvalBusy ? <span className="text-muted-foreground"> · 切换中…</span> : null}
              </span>
              <span className="text-muted-foreground block text-[12px] leading-[17px]">
                不逐次询问（硬策略闸仍生效）。
              </span>
            </span>
          </button>

          {error !== null ? (
            <p className="mt-1 border-t px-2 pt-2 text-[11px] leading-[15px] text-red-500">
              {error}
            </p>
          ) : null}
          <p className="text-muted-foreground/60 mt-1 border-t px-2 pt-2 text-[11px] leading-[15px]">
            两个模式都是会话级：切到别的会话不受影响。计划态下 write/edit 会被引擎拦截
            （进行中的轮次也生效）；两个都关闭 = 默认逐次确认。
            {state?.permissionGate
              ? '当前启动带 RPI_PERMISSION_GATE=1：bash/write/edit 仍逐次确认。'
              : ''}
          </p>
        </PopoverContent>
      </Popover>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false)
          setAcknowledged(false)
        }}
        onConfirm={confirmFullAccess}
        title="确认启用完全访问？"
        description="启用后该会话的智能体将减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。"
        confirmLabel="启用完全访问"
        cancelLabel="取消"
        destructive
        dismissOnConfirm
        confirmDisabled={!acknowledged}
      >
        <label className="flex cursor-pointer items-start gap-2 text-[13px] leading-[19px]">
          <input
            checked={acknowledged}
            className="mt-[2px] size-4 shrink-0 accent-current"
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          <span>我已了解风险，并愿意继续</span>
        </label>
      </ConfirmDialog>
    </>
  )
}
