/**
 * 连接类型字形（上游 `app/chat/sidebar/connection-glyph.tsx`）。
 *
 * 上游区分「本地 / SSH / 远程网关」三类连接的图标。宿主只有本地单引擎，
 * 但仍要把**形状**保留：上游代码按 `kind` 分支渲染，缺符号会编译不过。
 */
import type { FC } from 'react'
import { CloudIcon, HardDriveIcon, TerminalIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type ConnectionKind = 'local' | 'remote' | 'ssh'

export interface ConnectionGlyphProps {
  kind?: ConnectionKind
  className?: string
  /** 无障碍标签。 */
  label?: string
}

const ICON: Record<ConnectionKind, typeof HardDriveIcon> = {
  local: HardDriveIcon,
  ssh: TerminalIcon,
  remote: CloudIcon,
}

export const ConnectionGlyph: FC<ConnectionGlyphProps> = ({ kind = 'local', className, label }) => {
  const Icon = ICON[kind] ?? HardDriveIcon
  return (
    <Icon
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('size-3 shrink-0 text-[var(--text-3)]', className)}
      data-connection-kind={kind}
    />
  )
}
