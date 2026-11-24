/**
 * hermes `app/settings/primitives.tsx` 的宿主复制（2026-11-23）。
 *
 * 只带设置页真正用到的两个行原语：ListRow（标签 / 描述 / 控件三件套）与
 * ToggleRow（Switch 行）。列宽用上游同一套 `@container` 查询：宽面板标签与
 * 控件左右分列，窄面板自动堆叠。宿主设置页其余样式继续走既有类名，新外观
 * 页完全按 hermes 的行距渲染。
 */
import type { ReactNode } from 'react'

import { Switch } from '@/components/ui/switch'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

export const LIST_ROW_COLUMNS = '@2xl:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]'

export function ListRow({
  title,
  description,
  action,
  below,
  id,
  wide = false,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  below?: ReactNode
  'data-tour'?: string
  id?: string
  wide?: boolean
  className?: string
}) {
  return (
    <div className={cn('@container', className)} id={id}>
      <div className={cn('grid gap-3 px-4 py-[var(--settings-row-pad-y)]', !wide && [LIST_ROW_COLUMNS, '@2xl:items-center'])}>
        <div className="min-w-0">
          <div className="text-foreground flex items-center justify-between gap-3 text-[length:var(--settings-label-size)] font-medium">
            <span className="min-w-0">{title}</span>
            {wide && action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
          </div>
          {description && (
            <div className="mt-1 text-[length:var(--settings-desc-size)] leading-[1.5] text-(--ui-text-tertiary)">
              {description}
            </div>
          )}
          {below}
        </div>
        {!wide && action && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 @2xl:justify-end @2xl:justify-self-end">
            {action}
          </div>
        )}
      </div>
    </div>
  )
}

export function ToggleRow({
  checked,
  below,
  description,
  disabled,
  id,
  label,
  onChange,
  wide,
}: {
  checked: boolean
  below?: ReactNode
  'data-tour'?: string
  description?: ReactNode
  disabled?: boolean
  hint?: ReactNode
  id?: string
  label: string
  onChange: (on: boolean) => void
  wide?: boolean
}) {
  return (
    <ListRow
      action={
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(on) => {
            triggerHaptic('selection')
            onChange(on)
          }}
        />
      }
      below={below}
      description={description}
      id={id}
      title={label}
      wide={wide}
    />
  )
}
