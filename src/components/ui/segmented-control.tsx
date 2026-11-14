/**
 * hermes 桌面端 `components/ui/segmented-control.tsx` 的逐字移植。
 *
 * 一行互斥小选择（审查面板的 scope 切换 = uncommitted/branch/lastTurn）。
 * 扁平设计：无逐项描边，一条染色轨道 + 浮起的选中 pill。
 *
 * 上游的 `icon?: IconComponent`（tabler 形状）在本工程没有消费面——审查
 * 面板的三个 scope 只有文字；保留该 prop 以免将来移植其它面时改签名。
 */

import type { ComponentType } from 'react'

import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  id: T
  label: string
  icon?: ComponentType<{ className?: string }>
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
  /** Dims the whole track and blocks selection. */
  disabled?: boolean
  /** `equal` (default) gives every option the widest option's width; `content`
   *  sizes each option to its own label. */
  sizing?: 'equal' | 'content'
}

export function SegmentedControl<T extends string>({
  className,
  disabled = false,
  onChange,
  options,
  sizing = 'equal',
  value,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        'inline-grid w-fit grid-flow-col gap-0.5 rounded-[5px] bg-(--ui-bg-tertiary) p-0.5',
        sizing === 'equal' ? 'auto-cols-fr' : 'auto-cols-max',
        disabled && 'opacity-50',
        className,
      )}
    >
      {options.map(({ id, label, icon: Icon }) => {
        const active = value === id

        return (
          <button
            aria-pressed={active}
            className={cn(
              'flex items-center justify-center gap-1 rounded-[3px] px-2.5 py-0.5 text-[0.6875rem] font-medium transition-colors hover:transition-none disabled:cursor-default',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            disabled={disabled}
            key={id}
            onClick={() => onChange(id)}
            type='button'
          >
            {Icon && <Icon className='size-3' />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
