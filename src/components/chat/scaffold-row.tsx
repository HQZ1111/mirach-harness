/**
 * 脚手架行（hermes `components/chat/scaffold-row.tsx` 的宿主对偶）。
 *
 * 上游是 chat 页的通用行布局（左图标 + 主文案 + 右动作）。宿主的
 * `connector-card` 依赖它，给一个同形的最小实现。
 */
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface ScaffoldRowProps {
  /** 左侧图标。 */
  icon?: ReactNode
  /** 主标题。 */
  title: ReactNode
  /** 副标题/描述。 */
  description?: ReactNode
  /** 右侧动作区。 */
  trailing?: ReactNode
  className?: string
  onClick?: () => void
}

export const ScaffoldRow: FC<ScaffoldRowProps> = ({
  icon,
  title,
  description,
  trailing,
  className,
  onClick,
}) => {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        onClick && 'hover:bg-[var(--hover-wash)]',
        className,
      )}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      {icon ? <span className="flex size-8 shrink-0 items-center justify-center">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-[var(--text)]">{title}</span>
        {description ? (
          <span className="block truncate text-[11px] text-[var(--text-4)]">{description}</span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </Tag>
  )
}

/** 上游 `SCAFFOLD_META_CLASS`：副标题样式类。 */
export const SCAFFOLD_META_CLASS = 'text-[11px] text-[var(--text-4)]'
