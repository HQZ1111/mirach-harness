"use client";

/**
 * Composer 模式芯片（ZCode `切换模式` 的宿主投影，两态版）。
 *
 * 只保留引擎真有的两个状态：
 * - **计划模式**：`rpi-plan-mode` 计划态。进入后插件只放行 `read` / `bash` /
 *   `docs` / `plan_mode_complete`，write/edit 的工具调用被 before_tool_call
 *   否决（注意：**bash 不是只读沙箱**，README 原话）。
 * - **完全访问**：不带计划态，工具按正常能力执行。
 *
 * 切换 = 执行扩展命令 `/plan start` / `/plan exit`（pi_run_command，与
 * rpi-cli RPC 的 execute_command 同一 handler 契约）。不需要改引擎。
 *
 * 若启动参数带 RPI_PERMISSION_GATE=1，bash/write/edit 仍会逐次确认——菜单
 * 底部如实标注，不把它伪装成"完全访问"。
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

type ModeId = 'plan' | 'full'

const MODES: { id: ModeId; label: string; description: string }[] = [
  {
    id: 'plan',
    label: '计划模式',
    description: '编辑前先出计划；只放行 read / bash / docs。',
  },
  {
    id: 'full',
    label: '完全访问',
    description: '正常执行任务（可写文件）。',
  },
]

export function PermissionModeChip({
  className,
  threadId,
  running,
}: {
  className?: string
  /** 会话切换时重读（计划态是会话级的；New Chat 后必须回到 off） */
  threadId?: string | undefined
  /** run 结束后重读（plan_mode_complete 会自己退出计划态） */
  running?: boolean | undefined
}) {
  const [state, setState] = useState<ModeState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ModeId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    invoke<ModeState>('pi_mode_state')
      .then(setState)
      .catch((e) => console.error('[mode] pi_mode_state 读取失败', e))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, threadId])

  useEffect(() => {
    if (!running) refresh()
  }, [refresh, running])

  const current: ModeId = state?.planMode === 'planning' ? 'plan' : 'full'
  const currentLabel = MODES.find((m) => m.id === current)?.label ?? '完全访问'

  const select = (id: ModeId) => {
    if (id === current) {
      setOpen(false)
      return
    }
    setBusy(id)
    setError(null)
    const args = id === 'plan' ? 'start' : 'exit'
    invoke<unknown>('pi_run_command', { command: '/plan', args })
      .then(() => {
        refresh()
        setOpen(false)
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        console.error(`[mode] /plan ${args} 失败`, e)
      })
      .finally(() => setBusy(null))
  }

  return (
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
          title={currentLabel}
          className={cn(
            // ZCode 实测（9444）：28 高、圆角 8、14px 字、px-2、图标 16。
            'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground flex h-[28px] shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[14px] transition-colors',
            // 窄卡片（ZCode ChatModeSwitchControl / V4ComposerModeSwitch 同款）：
            // 文字与下拉箭头一起收掉，触发器收成 28×28 正方形、只留盾牌图标。
            // 断点 = 卡片自身宽度 36rem（ZCode 的 @xl/composer），不是窗口宽度。
            '@max-xl/composer:size-[28px] @max-xl/composer:justify-center @max-xl/composer:gap-0 @max-xl/composer:px-0',
            className,
          )}
        >
          <ShieldAlertIcon className="size-[16px] shrink-0" />
          <span className="whitespace-nowrap @max-xl/composer:hidden">{currentLabel}</span>
          <ChevronDownIcon className="size-[12px] shrink-0 opacity-50 @max-xl/composer:hidden" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label="切换模式"
        className="bg-popover text-popover-foreground w-80 rounded-xl p-1.5 shadow-(--shadow-pop)"
      >
        {MODES.map((mode) => {
          const active = mode.id === current
          const running = busy === mode.id
          return (
            <button
              key={mode.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={busy !== null}
              onClick={() => select(mode.id)}
              className={cn(
                'hover:bg-foreground/[0.06] flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors disabled:opacity-60',
                active && 'bg-foreground/[0.06]',
              )}
            >
              <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
                {active ? <CheckIcon className="size-[14px]" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-[19px] font-medium">
                  {mode.label}
                  {running ? <span className="text-muted-foreground"> · 切换中…</span> : null}
                </span>
                <span className="text-muted-foreground block text-[12px] leading-[17px]">
                  {mode.description}
                </span>
              </span>
            </button>
          )
        })}
        {error !== null ? (
          <p className="mt-1 border-t px-2 pt-2 text-[11px] leading-[15px] text-red-500">
            {error}
          </p>
        ) : null}
        <p className="text-muted-foreground/60 mt-1 border-t px-2 pt-2 text-[11px] leading-[15px]">
          计划态下 write/edit 会被扩展拒绝；bash 不受只读沙箱限制。
          {state?.permissionGate
            ? '当前启动带 RPI_PERMISSION_GATE=1：bash/write/edit 仍逐次确认。'
            : ''}
        </p>
      </PopoverContent>
    </Popover>
  )
}
