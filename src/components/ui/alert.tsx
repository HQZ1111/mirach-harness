/**
 * hermes 桌面端 `components/ui/alert.tsx` 的移植（53 行）。
 *
 * 轻提示条：`warning` / `default` 两个调性。catalog 的加载失败条用它
 * （`CatalogAlert`）。
 */

import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const alertVariants = cva(
  'relative flex w-full items-start gap-2.5 rounded-xl px-4 py-3 text-sm',
  {
    variants: {
      variant: {
        default: 'bg-(--ui-bg-quinary) text-foreground',
        warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        destructive: 'bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot='alert'
      role='alert'
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('min-w-0 flex-1 text-[0.8rem] font-medium leading-snug', className)}
      data-slot='alert-title'
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-[0.75rem] leading-relaxed opacity-90 [&_p]:leading-relaxed',
        className,
      )}
      data-slot='alert-description'
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle, alertVariants }
