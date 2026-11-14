/**
 * 审查 scope 切换行 —— hermes 桌面端
 * `app/right-sidebar/review/scope-row.tsx`（51 行）的移植。
 *
 * 标签 + tabs + 图标挤不进 28px 头部（面板最窄 10rem），所以 tabs 独占一行；
 * 低于其自然宽度时收成下拉（上游 TabDropdown 的窄宽折叠），而不是把每个
 * 选项都省略号化。
 *
 * 与上游的差异：上游用 `@container` 查询 + `TabDropdown`（Radix 菜单）在
 * 13.5rem 处切换。宿主没有该 container query 的等价物（面板宽由 dockview
 * 控制），改用 ResizeObserver 量自身宽度——同一个阈值 13.5rem，观感一致。
 * 下拉用 beui ContextMenu（全应用唯一弹层来源，AGENTS.md 定稿）。
 */

import { useEffect, useRef, useState } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'
import { useReview, type ReviewScope } from '@/components/panes/review-store'
import { Codicon } from '@/components/ui/codicon'
import { SegmentedControl } from '@/components/ui/segmented-control'

/** 上游 `@[13.5rem]` 断点。 */
const NARROW_PX = 13.5 * 16

const SCOPE_LABELS: Record<ReviewScope, string> = {
  uncommitted: '未提交',
  branch: '分支',
  lastTurn: '上一轮',
}

export function ReviewScopeRow() {
  const scope = useReview((s) => s.scope)
  const setScope = useReview((s) => s.setScope)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)

  // 面板宽度变化 → 收/展（上游 container query 的等价实现）。
  useEffect(() => {
    const node = hostRef.current
    if (!node) return
    const sync = () => setNarrow(node.clientWidth < NARROW_PX)
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const options: { id: ReviewScope; label: string }[] = [
    { id: 'uncommitted', label: SCOPE_LABELS.uncommitted },
    { id: 'branch', label: SCOPE_LABELS.branch },
    { id: 'lastTurn', label: SCOPE_LABELS.lastTurn },
  ]

  return (
    <div className='shrink-0 px-2 pb-1.5' data-suppress-pane-reveal-side='' ref={hostRef}>
      {!narrow ? (
        <SegmentedControl<ReviewScope>
          className='grid w-full auto-cols-[minmax(0,auto)] [&>button]:px-2'
          onChange={setScope}
          options={options}
          value={scope}
        />
      ) : (
        <div className='flex h-[1.5625rem] items-center pl-1.5'>
          <ContextMenu align='start' anchor='trigger' side='bottom'>
            <ContextMenuTrigger>
              <button
                className='flex h-7 cursor-pointer items-center gap-1.5 px-1 text-xs font-medium text-foreground'
                type='button'
              >
                <span className='min-w-0 truncate'>{SCOPE_LABELS[scope]}</span>
                <Codicon className='text-muted-foreground' name='chevron-down' size='0.75rem' />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent ariaLabel='审查范围' className='w-44'>
              {options.map((option) => (
                <ContextMenuItem
                  className={option.id === scope ? 'text-foreground' : undefined}
                  key={option.id}
                  onSelect={() => setScope(option.id)}
                >
                  <span className='min-w-0 flex-1 truncate'>{option.label}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuContent>
          </ContextMenu>
        </div>
      )}
    </div>
  )
}
