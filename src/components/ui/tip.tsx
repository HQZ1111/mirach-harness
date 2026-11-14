/**
 * hermes 桌面端 `components/ui/tooltip.tsx` 的 `Tip` 薄封装。
 *
 * 上游 `Tip` 是无箭头小气泡（自定义 tooltip 组件，422 行带定位/rail 边缘
 * 修正）。宿主的工具提示面统一在 `components/ui/tooltip.tsx`（Radix，带箭头），
 * 这里给出**同名同签名**的 `Tip`，内部转调宿主那套——这样照抄上游 JSX 时
 * `<Tip label=…>` 不用改。样式取宿主既有 tooltip-content（深底浅字小字）。
 *
 * 与上游的差异：宿主 tooltip 带一个 45° 小箭头（tailwind.css 的 Arrow 段）；
 * 上游无箭头。为保持"照抄不改 JSX"，接受这点观感差（不影响布局/命中）。
 */

import type { ReactNode } from 'react'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export function Tip({
  children,
  label,
  side,
}: {
  children: ReactNode
  label: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  if (!label) return <>{children}</>
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
