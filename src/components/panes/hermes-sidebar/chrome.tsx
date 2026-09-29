/**
 * hermes 侧栏 chrome 移植（视觉结构与类名照抄 hermes app/chat/sidebar/chrome.tsx，
 * 令牌换 harness 体系：--ui-* → --text/--stroke/--hover-wash；Codicon → lucide。
 * 数据不接 hermes store（nanostores/网关）——纯 UI，本地面板状态。
 */
import type { ComponentProps, ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'

/** 区块头"+"钮（hover 显形，hermes HEADER_ACTION_BTN）。 */
export const HEADER_ACTION_BTN =
  'text-(--text-3) opacity-0 transition-opacity hover:bg-(--hover-wash) hover:text-(--text) group-hover/section:opacity-100 focus-visible:opacity-100'

/** 区块头：图标 + 标题 + hover 显形的动作钮（hermes SidebarSectionHeader 简版）。 */
export function SidebarSectionHeader({
  label,
  action,
  className,
}: {
  label: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('group/section flex items-center gap-1 px-2 pt-2 pb-1', className)}>
      <span className="min-w-0 flex-1 truncate text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-(--text-3)">
        {label}
      </span>
      {action}
    </div>
  )
}

/** 日期分桶分隔条（hermes SidebarDateDivider）：小标题 + 发丝线，可折叠。 */
export function SidebarDateDivider({
  label,
  open = true,
  onToggle,
  action,
  className,
  ...props
}: ComponentProps<'div'> & { label: ReactNode; open?: boolean; onToggle?: () => void; action?: ReactNode }) {
  const caption = (
    <span className="shrink-0 text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-(--text-4)">
      {label}
    </span>
  )
  const rule = <span aria-hidden className="h-px min-w-4 flex-1 bg-(--stroke-soft)" />
  return (
    <div className={cn('group/workspace flex select-none items-center gap-2 px-2 pt-2 pb-0.5', className)} {...props}>
      {onToggle ? (
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left"
          onClick={onToggle}
          type="button"
        >
          {caption}
          <ChevronRight
            className={cn(
              'size-3 text-(--text-3) opacity-0 transition group-hover/workspace:opacity-100',
              !open && 'rotate-0',
              open && 'rotate-90',
            )}
          />
          {rule}
        </button>
      ) : (
        <>
          {caption}
          {rule}
        </>
      )}
      {action}
    </div>
  )
}

/** 行外壳：网格 [主体|动作列]，动作列 data-row-actions（hermes 同形）。 */
export function SidebarRowShell({
  actions,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { actions?: ReactNode }) {
  return (
    <div
      className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-stretch rounded-md pr-1', className)}
      {...props}
    >
      {children}
      {actions ? (
        <div className="flex shrink-0 items-center self-stretch" data-row-actions>
          {actions}
        </div>
      ) : null}
    </div>
  )
}

/** 行主体（hermes SidebarRowBody）：左内距 + 左对齐。 */
export function SidebarRowBody({ className, ...props }: ComponentProps<'button'>) {
  return <button className={cn('bg-transparent px-2 text-left', className)} {...props} />
}

/** 固定首列（状态点/图标）。 */
export function SidebarRowLead({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('flex w-4 shrink-0 justify-center', className)} {...props} />
}

/** 标准行文字。 */
export function SidebarRowLabel({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('truncate text-[0.8125rem] leading-5 text-(--text-2)', className)} {...props} />
}

/** 区块头"+"（hermes SidebarSectionAddButton 简版，点击即可）。 */
export function SidebarSectionAddButton({
  ariaLabel,
  onPlainClick,
}: {
  ariaLabel: string
  onPlainClick: () => void
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn('grid size-5 place-items-center rounded', HEADER_ACTION_BTN)}
      onClick={(e) => {
        e.stopPropagation()
        onPlainClick()
      }}
      title={ariaLabel}
      type="button"
    >
      <Plus className="size-3" />
    </button>
  )
}
