/**
 * 品牌字标（上游 `components/chat/wordmark.tsx`）。
 *
 * 上游是 hermes 的字标；宿主换成 Mirach 的文字标识，形状（字号/字重/颜色
 * 走令牌）保持一致。
 */
import type { FC } from 'react'

import { cn } from '@/lib/utils'

export interface WordmarkProps {
  className?: string
  /** 字号档位（上游有 sm/md/lg）。 */
  size?: 'sm' | 'md' | 'lg'
}

const SIZE: Record<NonNullable<WordmarkProps['size']>, string> = {
  sm: 'text-[13px]',
  md: 'text-[15px]',
  lg: 'text-[18px]',
}

export const Wordmark: FC<WordmarkProps> = ({ className, size = 'md' }) => (
  <span
    className={cn('select-none font-semibold tracking-tight text-[var(--text)]', SIZE[size], className)}
    data-slot="wordmark"
  >
    Mirach
  </span>
)
