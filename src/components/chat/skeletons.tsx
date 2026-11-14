/**
 * hermes 桌面端 `components/chat/skeletons.tsx` 的逐字移植。
 *
 * 文件树 / git 树 / diff 的加载骨架——比 spinner 安静，形状贴近即将落地的
 * 内容。审查面板用它（TreeSkeleton / DiffSkeleton）。
 */

import type { CSSProperties } from 'react'

import { Skeleton } from '@/components/ui/skeleton'

const TREE_ROWS: { indent: number; width: string }[] = [
  { indent: 0, width: '55%' },
  { indent: 1, width: '72%' },
  { indent: 1, width: '46%' },
  { indent: 0, width: '60%' },
  { indent: 1, width: '52%' },
  { indent: 2, width: '40%' },
  { indent: 0, width: '64%' },
]

/** Rows of icon + label bars, mimicking a file tree mid-load. */
export function TreeSkeleton() {
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-2 px-3 py-2.5' data-slot='tree-skeleton'>
      {TREE_ROWS.map((row, index) => (
        <div
          className='flex items-center gap-2'
          key={`${index}-${row.width}`}
          style={{ paddingLeft: `${row.indent * 12}px` }}
        >
          <Skeleton className='size-3.5 shrink-0 rounded-[3px]' />
          <Skeleton className='h-3' style={{ width: row.width }} />
        </div>
      ))}
    </div>
  )
}

const DIFF_ROWS: string[] = ['72%', '40%', '88%', '55%', '64%', '30%', '80%', '48%', '60%', '36%', '70%']

/** Stacked line bars, mimicking a unified diff mid-load. */
export function DiffSkeleton({ style }: { style?: CSSProperties }) {
  return (
    <div className='flex flex-col gap-1.5 px-3 py-2' data-slot='diff-skeleton' style={style}>
      {DIFF_ROWS.map((width, index) => (
        <Skeleton className='h-3' key={`${index}-${width}`} style={{ width }} />
      ))}
    </div>
  )
}
