/**
 * 复选框（hermes `components/ui/checkbox.tsx` 的移植）。
 *
 * 上游是 Radix Checkbox 包一层。宿主没有装 `@radix-ui/react-checkbox`，
 * 用**原生 input[type=checkbox]** + 宿主令牌样式实现同形态：
 *
 * - 视觉：12px 方块、选中态用 accent 色、focus-visible 有 ring
 * - 语义：原生 input 自带键盘/无障碍，比自绘更可靠
 * - 形状对齐：`checked` / `onCheckedChange` / `disabled` 三个 props 与上游同签名
 */
import type { FC } from 'react'

import { cn } from '@/lib/utils'

export interface CheckboxProps {
  checked?: boolean
  /** 上游签名是 `(checked: boolean | 'indeterminate') => void`。 */
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
  id?: string
}

export const Checkbox: FC<CheckboxProps> = ({
  checked = false,
  onCheckedChange,
  disabled = false,
  className,
  id,
  'aria-label': ariaLabel,
}) => (
  <input
    aria-label={ariaLabel}
    checked={checked}
    className={cn(
      'size-3.5 shrink-0 cursor-pointer rounded-[3px] border border-[var(--stroke)] bg-transparent',
      'accent-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-50',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-accent)]/40',
      className,
    )}
    data-slot="checkbox"
    disabled={disabled}
    id={id}
    onChange={(event) => onCheckedChange?.(event.target.checked)}
    type="checkbox"
  />
)
