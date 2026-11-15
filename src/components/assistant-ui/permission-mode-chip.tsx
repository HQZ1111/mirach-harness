"use client";

/**
 * Composer 模式芯片（ZCode `切换模式` 的宿主投影）。
 *
 * ZCode 的四态：计划模式 / 变更前确认 / 自主模式 / 完全访问。rpi 只有两件
 * 真实的东西：
 * - `rpi-plan-mode` 插件的会话条目（planMode: planning/off），进入退出由
 *   插件 `/plan` 自己完成——宿主没有切换面（`set_plan_mode` 恒 Err）；
 * - `rpi-permission-gate` 扩展的**启动期**开关（`--permission-gate` 或
 *   `RPI_PERMISSION_GATE=1`）：开启后 bash/write/edit 每次经扩展 UI 确认；
 *   宿主没有运行时切换面（`set_approval_mode` 恒 Err）。
 *
 * 所以这个芯片**只读展示当前真实模式**，菜单里把 ZCode 的四态都列出来：
 * 当前态打勾，其余置灰并标注为什么切不过去（能做的接真数据、缺数据的
 * 标注——用户口径"别砍"，但不造假开关）。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CheckIcon, ChevronDownIcon, ShieldAlertIcon } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover'
import { cn } from '@/lib/utils'

interface ModeState {
  /** 'planning' | 'off' */
  planMode?: string
  /** rpi-permission-gate 是否在启动期启用（env RPI_PERMISSION_GATE） */
  permissionGate?: boolean
}

type ModeId = 'plan' | 'confirm' | 'auto' | 'full'

const MODES: {
  id: ModeId
  label: string
  description: string
  /** 非当前态时显示的不可切换原因 */
  unavailable: string
}[] = [
  {
    id: 'plan',
    label: '计划模式',
    description: '编辑前先出计划。',
    unavailable: '由 rpi-plan-mode 的 /plan 命令进入/退出，宿主无切换面',
  },
  {
    id: 'confirm',
    label: '变更前确认',
    description: '改文件前先问我。',
    unavailable: '需以 RPI_PERMISSION_GATE=1 启动（扩展只在会话构建时读开关）',
  },
  {
    id: 'auto',
    label: '自主模式',
    description: '在有风险时询问。',
    unavailable: 'rpi 没有风险分级策略（permission gate 只按工具名门控）',
  },
  {
    id: 'full',
    label: '完全访问',
    description: '减少确认次数。',
    unavailable: '需重启并关闭 RPI_PERMISSION_GATE',
  },
]

function currentMode(state: ModeState | null): ModeId {
  if (state?.planMode === 'planning') return 'plan'
  return state?.permissionGate ? 'confirm' : 'full'
}

export function PermissionModeChip({ className }: { className?: string }) {
  const [state, setState] = useState<ModeState | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(() => {
    invoke<ModeState>('pi_mode_state')
      .then(setState)
      .catch((e) => console.error('[mode] pi_mode_state 读取失败', e))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const current = currentMode(state)
  const currentLabel = MODES.find((m) => m.id === current)?.label ?? '完全访问'

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) refresh()
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
          className={cn(
            // ZCode 实测（9444）：28 高、圆角 8、14px 字、px-2、图标 16。
            'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex h-[28px] items-center gap-1.5 rounded-[8px] px-2 text-[14px] transition-colors',
            className,
          )}
        >
          <ShieldAlertIcon className="size-[16px] shrink-0" />
          <span className="whitespace-nowrap">{currentLabel}</span>
          <ChevronDownIcon className="size-[12px] shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label="切换模式"
        className="bg-popover text-popover-foreground w-72 rounded-xl p-1.5 shadow-(--shadow-pop)"
      >
        {MODES.map((mode) => {
          const active = mode.id === current
          return (
            <button
              key={mode.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={!active}
              onClick={() => setOpen(false)}
              className={cn(
                'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                active
                  ? 'bg-foreground/[0.06]'
                  : 'cursor-default opacity-55',
              )}
            >
              <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
                {active ? <CheckIcon className="size-[14px]" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-[19px] font-medium">
                  {mode.label}
                </span>
                <span className="text-muted-foreground block text-[12px] leading-[17px]">
                  {mode.description}
                </span>
                {active ? null : (
                  <span className="text-muted-foreground/60 mt-0.5 block text-[11px] leading-[15px]">
                    {mode.unavailable}
                  </span>
                )}
              </span>
            </button>
          )
        })}
        <p className="text-muted-foreground/60 mt-1 border-t px-2 pt-2 text-[11px] leading-[15px]">
          模式由引擎启动参数/插件决定，此处只读展示当前状态。
        </p>
      </PopoverContent>
    </Popover>
  )
}
