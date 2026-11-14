/**
 * Master-detail 页面脚手架 —— hermes `apps/desktop/src/app/master-detail.tsx`
 * 的逐字移植（2026-10-27 用户："不是有源码吗，让你完全复制，为什么又自己做？"）。
 *
 * hermes 的 Capabilities 和 Messaging 页共用这套脚手架：左边密集列表行、
 * 右边居中详情。页面自带行/详情内容（Capabilities 用 CapRow 开关行，
 * Messaging 用自己的头像行）。
 *
 * **所有 tailwind 类照抄上游**（含 hermes 的 `--ui-*` 令牌——宿主的
 * tokens.css 补齐这些别名即可，不再自造 `.set-cap-*` CSS）。
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/** Monospace 能力芯片（工具名、传输方式……）。Skills 和 MCP tab 共用。 */
export function ToolChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      className='rounded-md bg-(--ui-bg-quinary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)'
      title={title}
    >
      {children}
    </span>
  )
}

/** `split="wide"` 给列表多的页一个宽轨（skills/tools/mcp）；默认 14rem 轨
 *  适合详情更重的页（messaging）。`--md-split` 是拖拽覆盖槽。 */
export const MASTER_DETAIL_WIDE_COLS =
  'sm:grid-cols-[minmax(0,var(--md-split,0.75fr))_minmax(0,1fr)]'

export function MasterDetail({
  children,
  split = 'rail',
}: {
  children: React.ReactNode
  split?: 'rail' | 'wide'
}) {
  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          split === 'wide' ? MASTER_DETAIL_WIDE_COLS : 'sm:grid-cols-[14rem_minmax(0,1fr)]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function ListColumn({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  return (
    <aside className='flex min-h-0 flex-col p-2'>
      {header}
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]'>{children}</div>
    </aside>
  )
}

/** `footer` 在滚动下方钉一条安静说明（"changes apply to new sessions"）。 */
export function DetailColumn({
  children,
  footer,
}: {
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className='flex min-h-0 flex-col overflow-hidden'>
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]'>
        <div className='mx-auto max-w-2xl space-y-5 px-5 py-4'>{children}</div>
      </div>
      {footer && (
        <div className='mx-auto w-full max-w-2xl shrink-0 px-5 pb-3 pt-1.5 text-right text-[0.65rem] text-muted-foreground/50'>
          {footer}
        </div>
      )}
    </main>
  )
}

/** 一行控制条钉在列表上方：左排序/主动作，右溢出 kebab。 */
export function ListStrip({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className='mb-1 flex h-6 shrink-0 items-center justify-between gap-2 pl-2 pr-1'>
      <div className='flex min-w-0 items-center gap-1.5'>{left}</div>
      <div className='flex shrink-0 items-center gap-1.5'>{right}</div>
    </div>
  )
}

export function ListStripButton({
  active,
  children,
  disabled,
  onClick,
}: {
  active?: boolean
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        'cursor-pointer text-[0.68rem] font-medium transition-colors disabled:opacity-40',
        active ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground',
      )}
      disabled={disabled}
      onClick={onClick}
      type='button'
    >
      {children}
    </button>
  )
}

export interface ListStripMenuToggle {
  checked: boolean
  disabled?: boolean
  label: string
  onToggle: (checked: boolean) => void
}

export interface ListStripMenuItem {
  disabled?: boolean
  label: string
  onSelect: () => void
}

/**
 * 列表级动作的溢出 kebab —— hermes `master-detail.tsx` 的 `ListStripMenu`
 * 移植。`toggle` 作为第一行（一个标签 + 开关，覆盖全开/全关）。
 *
 * 上游用 Radix DropdownMenu；宿主统一到 beui ContextMenu（`anchor='trigger'`
 * 从按钮长出，与全应用弹层同一套 goo 动效——AGENTS.md 定稿）。
 */
export function ListStripMenu({
  items = [],
  label,
  toggle,
}: {
  items?: ListStripMenuItem[]
  label: string
  toggle?: ListStripMenuToggle
}) {
  return (
    <ContextMenu anchor='trigger' align='end' side='bottom'>
      <ContextMenuTrigger>
        <button
          aria-label={label}
          className='inline-flex size-6 items-center justify-center rounded-md text-(--ui-text-tertiary) hover:bg-(--ui-row-hover-background) hover:text-foreground'
          type='button'
        >
          <Codicon name='kebab-vertical' size='0.8125rem' />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent ariaLabel={label} className='w-44'>
        {toggle && (
          <ContextMenuItem
            disabled={toggle.disabled}
            onSelect={() => toggle.onToggle(!toggle.checked)}
            closeOnSelect={false}
          >
            <span className='min-w-0 flex-1 truncate'>{toggle.label}</span>
            {/* 开关只是投影：菜单保持打开，让用户看见它翻过去（上游同款）。 */}
            <span
              aria-hidden
              className={cn(
                'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
                toggle.checked ? 'bg-(--fl-accent)' : 'bg-(--ui-bg-quinary)',
                !toggle.checked && 'opacity-60',
              )}
            >
              <span
                className={cn('block h-3 w-3 rounded-full bg-white transition-transform', toggle.checked && 'translate-x-3')}
              />
            </span>
          </ContextMenuItem>
        )}
        {items.map((item) => (
          <ContextMenuItem disabled={item.disabled} key={item.label} onSelect={item.onSelect}>
            <span className='min-w-0 flex-1 truncate'>{item.label}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * 详情列底部的可折叠编辑面板 —— hermes `DetailPane` 的**语义裁剪版**。
 *
 * 上游带拖拽调高 + 高度持久化（pane-store）。宿主没有那套 store，且唯一
 * 消费方是技能编辑器 → 只保留「标题 + 动作 + 关闭 + 正文」的固定高度面板
 * （`defaultHeight` 作为最大高度用）。拖动调高不是本页需求，故不做。
 */
export function DetailPane({
  actions,
  children,
  id,
  onClose,
  title,
}: {
  actions?: React.ReactNode
  children: React.ReactNode
  /** 面板标识（上游用于持久化高度；宿主保留以免改调用点）。 */
  id: string
  onClose?: () => void
  title: React.ReactNode
}) {
  return (
    <section className='mt-3 flex flex-col rounded-lg border border-(--ui-stroke-secondary)' data-pane-id={id}>
      <header className='flex h-8 shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2'>
        <div className='min-w-0 flex-1 truncate'>{title}</div>
        {actions}
        {onClose && (
          <button
            aria-label='关闭'
            className='inline-flex size-6 items-center justify-center rounded text-(--ui-text-tertiary) hover:bg-(--ui-row-hover-background) hover:text-foreground'
            onClick={onClose}
            type='button'
          >
            <Codicon name='close' size='0.8125rem' />
          </button>
        )}
      </header>
      <div className='min-h-0 flex-1 overflow-auto p-2'>{children}</div>
    </section>
  )
}

interface CapRowProps {
  /** Switch 槽里渲染别的（如未安装行的 Install 钮）。 */
  action?: React.ReactNode
  active: boolean
  busy?: boolean
  enabled: boolean
  meta?: React.ReactNode
  onSelect: () => void
  onToggle?: (checked: boolean) => void
  rowId?: string
  /** 名字下的第二行（分类、描述、状态）。行高变 h-11。 */
  subtitle?: React.ReactNode
  title: string
  toggleLabel?: string
}

/** 三个列表共用的一行。固定高度、开关常显——状态从开关 + 变暗标题读，
 *  切换不需要先选中。关闭行变暗；开关本身在关闭时也变暗。 */
export function CapRow({
  action,
  active,
  busy,
  enabled,
  meta,
  onSelect,
  onToggle,
  rowId,
  subtitle,
  title,
  toggleLabel,
}: CapRowProps) {
  return (
    <div
      className={cn(
        'group/row row-hover flex w-full shrink-0 items-center rounded-md [content-visibility:auto] hover:text-foreground',
        subtitle ? 'h-11' : 'h-8',
        active ? 'bg-(--ui-row-active-background) text-foreground' : 'text-(--ui-text-secondary)',
      )}
      id={rowId}
    >
      <button
        className='flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2 pr-1.5 text-left'
        onClick={onSelect}
        type='button'
      >
        <span className='min-w-0 flex-1'>
          <span
            className={cn(
              'block truncate text-[0.78rem]',
              enabled ? 'font-medium text-foreground/85' : 'font-normal text-muted-foreground/60',
            )}
          >
            {title}
          </span>
          {subtitle != null && (
            <span className='flex min-w-0 items-center gap-1 text-[0.62rem] text-muted-foreground/50'>
              {typeof subtitle === 'string' ? <span className='truncate'>{subtitle}</span> : subtitle}
            </span>
          )}
        </span>
        {meta != null && (
          <span className='shrink-0 rounded bg-(--ui-bg-quinary) px-1 py-px text-[0.6rem] tabular-nums leading-3.5 text-(--ui-text-tertiary)'>
            {meta}
          </span>
        )}
      </button>
      {action != null ? (
        <span className='mr-1.5 flex shrink-0 items-center'>{action}</span>
      ) : (
        <button
          aria-label={toggleLabel ?? title}
          className={cn(
            'mr-1.5 shrink-0 cursor-pointer',
            !enabled && 'opacity-60',
          )}
          disabled={busy}
          onClick={() => onToggle?.(!enabled)}
          role='switch'
          aria-checked={enabled}
          title={toggleLabel ?? title}
          type='button'
        >
          <span
            className={cn(
              'flex h-4 w-7 items-center rounded-full p-0.5 transition-colors',
              enabled ? 'bg-(--fl-accent)' : 'bg-(--ui-bg-quinary)',
            )}
          >
            <span
              className={cn(
                'block h-3 w-3 rounded-full bg-white transition-transform',
                enabled && 'translate-x-3',
              )}
            />
          </span>
        </button>
      )}
    </div>
  )
}
