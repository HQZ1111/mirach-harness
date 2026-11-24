import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

// hermes `components/ui/slider.tsx` 逐字复制：一条细轨道 + 原生滑块拇指。
// 设置行负责在旁边放读数，调用点不自己写 `<input type="range">`。
export function Slider({ className, style, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <input
      className={cn('h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)', className)}
      data-slot="slider"
      style={{ accentColor: 'var(--brand)', ...style }}
      type="range"
      {...props}
    />
  )
}
