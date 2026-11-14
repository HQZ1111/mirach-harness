/**
 * hermes 桌面端 `components/ui/generate-button.tsx` 的移植。
 *
 * 星火「用 AI 生成」按钮：图标 + 提示，提交信息框与新项目想法框共用同一
 * 模式。星火 → 点击生成；带 `onCancel` 时运行中显示停止方块；不带则转圈。
 *
 * 上游的 `Tip`（悬停说明）在宿主用 Radix Tooltip 的薄封装（下条），
 * 视觉沿用 hermes 的 `Tip` 语义（无箭头小气泡）。
 */

import { Square, Sparkles } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tip'
import { cn } from '@/lib/utils'

interface GenerateButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'children' | 'onClick'> {
  /** True while a generation is in flight. */
  generating: boolean
  /** Start a generation. */
  onGenerate: () => void
  /** Cancel an in-flight generation. When omitted, the button just spins. */
  onCancel?: () => void
  /** Tooltip + aria label at rest (and while generating if no `generatingLabel`). */
  label: string
  /** Tooltip while generating. */
  generatingLabel?: string
  iconSize?: number | string
}

export function GenerateButton({
  generating,
  onGenerate,
  onCancel,
  label,
  generatingLabel,
  disabled,
  iconSize = 12,
  className,
  ...rest
}: GenerateButtonProps) {
  const tip = generating ? (generatingLabel ?? label) : label
  const cancellable = generating && !!onCancel
  const px = typeof iconSize === 'number' ? `${iconSize}px` : iconSize

  return (
    <Tip label={tip}>
      <Button
        aria-label={tip}
        className={cn('text-muted-foreground/80 hover:text-foreground', className)}
        disabled={generating ? !onCancel : disabled}
        onClick={cancellable ? onCancel : onGenerate}
        size='icon-xs'
        type='button'
        variant='ghost'
        {...rest}
      >
        {cancellable ? (
          <Square className='fill-current' size={11} />
        ) : (
          <Sparkles
            aria-hidden
            className={cn(generating && 'animate-pulse')}
            size={typeof iconSize === 'number' ? iconSize : 14}
            style={{ width: px, height: px }}
          />
        )}
      </Button>
    </Tip>
  )
}
