/**
 * 会话状态圆点（上游 `components/status-dot.tsx` 的 `StatusDot` / `SessionStatusDot`）。
 *
 * 同形语义：一个 tone → 一个颜色的小圆点，用于会话行/花名册行表示忙/闲/错误。
 * 颜色全部走宿主令牌，不写字面值。
 */
import type { FC } from 'react'

import { cn } from '@/lib/utils'

export type StatusTone = 'error' | 'idle' | 'live' | 'warn'

const TONE_CLASS: Record<StatusTone, string> = {
  idle: 'bg-[var(--text-4)]',
  live: 'bg-[var(--ui-accent)]',
  warn: 'bg-[var(--ui-warn,#f5a524)]',
  error: 'bg-[var(--state-error,#e5484d)]',
}

export interface SessionStatusDotProps {
  tone?: StatusTone
  className?: string
  /** 无障碍标签（上游用 aria-label 播报状态）。 */
  label?: string
}

export const SessionStatusDot: FC<SessionStatusDotProps> = ({ tone = 'idle', className, label }) => (
  <span
    aria-label={label}
    aria-hidden={label ? undefined : true}
    className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE_CLASS[tone], className)}
    data-tone={tone}
    role={label ? 'img' : undefined}
  />
)

export { SessionStatusDot as StatusDot }
