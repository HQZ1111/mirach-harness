/**
 * 小组件外壳（hermes `components/chat/widget-shell.tsx` 的宿主对偶）。
 *
 * 上游是 chat 里内嵌卡片的外框（标题 + 内容 + 可选页脚）。同形最小实现。
 */
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface WidgetShellProps {
  /** 卡片标题（可省略）。 */
  title?: ReactNode
  /** 右上角动作。 */
  actions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}

export const WidgetShell: FC<WidgetShellProps> = ({ title, actions, children, footer, className }) => (
  <div
    className={cn(
      'flex flex-col overflow-hidden rounded-lg bg-[var(--ui-bg-card)] shadow-sm',
      className,
    )}
    data-slot="widget-shell"
  >
    {title || actions ? (
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        {title ? <span className="truncate text-[13px] font-medium">{title}</span> : <span />}
        {actions ? <span className="shrink-0">{actions}</span> : null}
      </div>
    ) : null}
    <div className="min-h-0 flex-1 px-3 pb-2">{children}</div>
    {footer ? <div className="border-t px-3 py-2">{footer}</div> : null}
  </div>
)

/** 上游 `WIDGET_SHELL_CLASS`：卡片外壳样式类。 */
export const WIDGET_SHELL_CLASS = 'rounded-lg bg-[var(--ui-bg-card)] shadow-sm'
