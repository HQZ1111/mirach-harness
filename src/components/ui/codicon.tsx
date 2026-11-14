/**
 * hermes 桌面端 `components/ui/codicon.tsx` 的逐字移植。
 *
 * 字形来源 = **@vscode/codicons 字体**（与上游同一份包，`dist/codicon.css`
 * 在 main.tsx 里全局 import）——不再像 codicons.tsx 那样内联零星 SVG path。
 * 审查面板 / 技能与中心用的是整套 codicon 名字（diff-added / folder-opened /
 * sparkle / git-pull-request …），逐个内联不现实。
 *
 * 上游 `codiconIcon(name)` 把 codicon 包成 tabler 形状给导航行用——本工程
 * 没有该消费面（导航行用 lucide），不移植。
 */

import type * as React from 'react'

import { cn } from '@/lib/utils'

export interface CodiconProps extends React.HTMLAttributes<HTMLElement> {
  name: string
  size?: number | string
  spinning?: boolean
}

export function Codicon({ className, name, size, spinning, style, ...props }: CodiconProps) {
  return (
    <i
      aria-hidden='true'
      className={cn('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className)}
      style={{ ...(size != null && size !== '' ? { fontSize: size } : {}), ...style }}
      {...props}
    />
  )
}
