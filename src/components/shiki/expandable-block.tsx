import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ExpandableBlockProps {
  children: ReactNode
  className?: string
}

// 折叠态 7.5rem（=120px）与 overflow 判定线 121px（hermes ExpandableBlock
// 同值：120px 收纳大多数 5-6 行片段，+1 防亚像素抖动）；展开 40dvh。
const COLLAPSED_MAX_H = 121

/**
 * 长代码折叠（hermes ExpandableBlock 移植）：默认 max-h ~7.5rem，展开
 * 40dvh；溢出时底部渐隐 + 右下 chevron。量测只在 ResizeObserver 回调里做
 * （布局干净）——挂载时同步读 scrollHeight 会强迫每个实例一次 reflow，
 * 工具密集的转录一次切会话要挂几十个。
 */
export function ExpandableBlock({ children, className }: ExpandableBlockProps) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  const measure = useCallback(() => {
    const el = innerRef.current

    if (el) {
      setOverflowing(el.scrollHeight > COLLAPSED_MAX_H)
    }
  }, [])

  useEffect(() => {
    const el = innerRef.current

    if (!el || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(measure)

    observer.observe(el)
    measure()

    return () => observer.disconnect()
  }, [measure])

  return (
    <div className="relative">
      <div
        className={cn(
          'overflow-x-auto overflow-y-auto',
          expanded ? 'max-h-[40dvh]' : 'max-h-[7.5rem]',
          className,
        )}
        ref={innerRef}
      >
        {children}
      </div>
      {overflowing && (
        // 渐隐是纯溢出提示，不拦截指针：它横跨底缘（宽代码块的横向滚动条和
        // 最后一行都在下面），可点击会同时杀掉横向滚动与文本选择。保持
        // pointer-events-none，唯一可点目标——紧凑的展开/收起钮——钉在右缘，
        // 避开可拖的滚动条轨道。
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-7 justify-end bg-linear-to-t from-(--code-bg) to-transparent">
          <button
            aria-expanded={expanded}
            aria-label={expanded ? '收起' : '展开'}
            className="pointer-events-auto flex h-7 w-9 cursor-pointer items-end justify-center pb-1 text-(--text-3) transition-colors hover:text-(--text-2)"
            onClick={() => setExpanded(v => !v)}
            type="button"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      )}
    </div>
  )
}
