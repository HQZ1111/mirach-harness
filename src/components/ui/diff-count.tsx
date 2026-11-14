/**
 * hermes 桌面端 `components/ui/diff-count.tsx` 的逐字移植。
 *
 * `+A −B` 行数，绿色/红色走 `--ui-green` / `--ui-red` 令牌。每个数字用
 * motion 的 spring 渲染（不逐帧 re-render React）——首次挂载直接落在目标值
 * （导航切换同数字不动画），只有真实变化（实时编辑）才弹。
 */

import { motion, useSpring, useTransform } from 'motion/react'
import { useEffect } from 'react'

import { cn } from '@/lib/utils'

// Snappy spring — fast transitions per the design.
const SPRING = { stiffness: 320, damping: 30, mass: 0.5 } as const

export function AnimatedInt({ value }: { value: number }) {
  const spring = useSpring(value, SPRING)
  const text = useTransform(spring, (latest) => Math.round(latest).toString())

  useEffect(() => {
    spring.set(value)
  }, [value, spring])

  return <motion.span>{text}</motion.span>
}

interface DiffCountProps {
  added: number
  removed: number
  className?: string
}

/** Animated `+A −B` line-count, green/red via the top-level theme vars. */
export function DiffCount({ added, removed, className }: DiffCountProps) {
  if (!added && !removed) {
    return null
  }

  return (
    <span className={cn('flex shrink-0 items-center gap-1 tabular-nums', className)}>
      {added > 0 && (
        <span className='text-(--ui-green)'>
          +<AnimatedInt value={added} />
        </span>
      )}
      {removed > 0 && (
        <span className='text-(--ui-red)'>
          −<AnimatedInt value={removed} />
        </span>
      )}
    </span>
  )
}
