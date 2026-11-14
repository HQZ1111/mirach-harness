/**
 * hermes 桌面端 `components/ui/split-button.tsx` 的移植。
 *
 * 主按钮 + 尾巴菜单（VS Code 的 Commit / Commit & Push）。主按钮跑 `value`；
 * 菜单项跑它并把它变成新默认——用户怎么用，控件就怎么记，不需要额外设置项。
 *
 * 上游用 Radix DropdownMenu；宿主统一到 beui 的 ContextMenu（`anchor='trigger'`
 * 从触发钮长出，与全应用弹层同一套 goo 动效——AGENTS.md「弹层动效：只有一个
 * 来源」）。行为等价：点主钮跑当前值、点尾巴开菜单、选项写入默认。
 */

import { ChevronDown, Check } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  ContextMenu,
  ContextMenuAnchor,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface SplitButtonAction {
  id: string
  label: string
  icon?: ReactNode
}

interface SplitButtonProps {
  actions: SplitButtonAction[]
  /** The id of the action the primary button runs (the user's current default). */
  value: string
  /** Picking from the menu changes the default (so the next primary click repeats it). */
  onValueChange: (id: string) => void
  /** Run an action by id (primary click or menu pick both call it). */
  onTrigger: (id: string) => void
  disabled?: boolean
  className?: string
  /** Icon shown on the primary button only (e.g. a ✓ for Commit). */
  primaryIcon?: ReactNode
  variant?: 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive'
  size?: 'sm' | 'default' | 'xs'
}

export function SplitButton({
  actions,
  value,
  onValueChange,
  onTrigger,
  disabled,
  className,
  primaryIcon,
  variant = 'secondary',
  size = 'sm',
}: SplitButtonProps) {
  const active = actions.find((action) => action.id === value) ?? actions[0]

  if (!active) {
    return null
  }

  return (
    <div className={cn('inline-flex min-w-0', className)}>
      <Button
        className='min-w-0 flex-1 rounded-r-none'
        disabled={disabled}
        onClick={() => onTrigger(active.id)}
        size={size}
        variant={variant}
      >
        {primaryIcon ?? active.icon}
        <span className='truncate'>{active.label}</span>
      </Button>
      <ContextMenu anchor='trigger' align='end' side='bottom'>
        <ContextMenuTrigger>
          <Button
            aria-label='更多操作'
            className='rounded-l-none border-l border-current/25 px-2'
            disabled={disabled}
            size={size}
            variant={variant}
          >
            <ChevronDown aria-hidden className='size-3.5' />
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent ariaLabel='提交方式' className='min-w-44'>
          {actions.map((action) => (
            <ContextMenuItem
              key={action.id}
              onSelect={() => {
                onValueChange(action.id)
                onTrigger(action.id)
              }}
            >
              {action.icon}
              <span className='flex-1 truncate'>{action.label}</span>
              {action.id === value && (
                <Check aria-hidden className='size-3.5 text-(--ui-text-tertiary)' />
              )}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

/** 触发钮登记器（ContextMenuTrigger 已覆盖 asChild 语义；此处仅导出以便
 *  调用方在 Tooltip 包裹链里显式登记锚点）。 */
export { ContextMenuAnchor }
