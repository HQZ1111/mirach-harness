/**
 * 面板栏标签条滚动箭头（beUI tabs·TabsList 溢出样式语义移植，2026-10-15）。
 *
 * 用户定稿："面板栏的标签页样式不是 tabs 里的 overflow 样式吗，之前的下拉
 * 选标签页的组件也保留"——溢出行为 = 原生横向滚动 + 左右箭头钮 + 两端
 * 渐隐（beUI TabsList 三件套）；原生 dockview 溢出下拉已关
 * （disableTabsOverflowList），标签总览下拉（TabOverviewButton，cmdk 检索
 * + 关闭）保留为键盘/检索通道。
 *
 * 挂载面：左箭头挂 prefixHeaderActionsComponent（条最左）、右箭头与总览
 * 钮同挂 rightHeaderActionsComponent（条最右，箭头在总览钮左侧）。两组件
 * 各自侦测同一个 .dv-tabs-container（dockview 原生滚动容器，实测滚动
 * scrollLeft 可编程驱动——overflow: hidden 的盒子仍是程序化可滚动盒），
 * 显示纪律：组有条才渲染；overflow 时箭头槽恒定占位（边缘禁用 = opacity-0
 * 不拆 DOM，避免滚动过程布局抖动）；渐隐属性 data-strip-edges 由左组件
 * 写入（l/r/lr），flexlayout.css 按属性画两级 mask。
 */
import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'

import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/motion/tooltip'
import { TabOverviewButton } from './tab-overview-menu'
import { TabStripNewButton } from './tab-strip-new'

interface StripEdges {
  overflow: boolean
  left: boolean
  right: boolean
}

const NO_EDGES: StripEdges = { overflow: false, left: false, right: false }

/** 溢出侦测（beUI TabsList measure 语义）：overflow 判定 + 两边缘可达性。 */
function measureStrip(vp: HTMLElement): StripEdges {
  const max = Math.max(0, vp.scrollWidth - vp.clientWidth)
  const fromLeft = Math.max(0, Math.min(max, vp.scrollLeft))
  return {
    overflow: vp.scrollWidth > vp.clientWidth + 1,
    left: fromLeft > 1,
    right: fromLeft < max - 1,
  }
}

const TabStripArrow: FC<{ side: 'left' | 'right' } & IDockviewHeaderActionsProps> = ({
  side,
  ...props
}) => {
  const [edges, setEdges] = useState<StripEdges>(NO_EDGES)
  const vpRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const groupEl = props.group.element as unknown as HTMLElement | undefined
    const tac = groupEl?.querySelector<HTMLElement>('.dv-tabs-and-actions-container')
    const vp = tac?.querySelector<HTMLElement>('.dv-tabs-container') ?? null
    vpRef.current = vp
    if (!tac || !vp) return
    const apply = () => {
      const next = measureStrip(vp)
      setEdges((prev) =>
        prev.overflow === next.overflow && prev.left === next.left && prev.right === next.right
          ? prev
          : next,
      )
      // 渐隐属性一次写两边缘（两组件同值幂等；左组件是唯一写者纪律不必要，
      // 双写省一套跨组件状态同步）。flexlayout.css 按属性画两级 mask。
      tac.dataset.stripLeft = next.overflow && next.left ? '1' : ''
      tac.dataset.stripRight = next.overflow && next.right ? '1' : ''
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(vp)
    const list = vp.firstElementChild
    if (list) ro.observe(list)
    vp.addEventListener('scroll', apply, { passive: true })
    return () => {
      ro.disconnect()
      vp.removeEventListener('scroll', apply)
      delete tac.dataset.stripLeft
      delete tac.dataset.stripRight
    }
    // 面板增删/激活变化会强制重渲本组件（dockview-react 桥语义）——
    // panels 长度入依赖，增删后重测（ResizeObserver 不覆盖 scrollWidth 变化）
  }, [props.group, props.panels.length])

  const scroll = useCallback(() => {
    const vp = vpRef.current
    if (!vp) return
    vp.scrollBy({ left: (side === 'left' ? -1 : 1) * vp.clientWidth * 0.8, behavior: 'smooth' })
  }, [side])

  // 显示面：有条（hideHeader 组条 display:none，渲染即无意义）+ 横向条
  // （竖条本应用不存在，防签名漂移照总览钮守卫）+ 溢出才出现。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  if (!edges.overflow) return null

  const canScroll = side === 'left' ? edges.left : edges.right
  return (
    <Tooltip content={side === 'left' ? '向左滚动标签' : '向右滚动标签'} side="bottom">
      <button
        aria-label={side === 'left' ? '向左滚动标签' : '向右滚动标签'}
        className={cn(
          'pressable-sm text-(--tab-text) inline-flex w-9 shrink-0 items-center justify-center self-stretch',
          'transition-opacity hover:opacity-70 focus-visible:outline-2',
          'disabled:pointer-events-none disabled:opacity-0',
        )}
        disabled={!canScroll}
        onClick={scroll}
        type="button"
      >
        {side === 'left' ? (
          <ChevronLeftIcon aria-hidden className="size-[var(--size-icon-lg)]" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-[var(--size-icon-lg)]" />
        )}
      </button>
    </Tooltip>
  )
}

export const TabStripLeftArrow: FC<IDockviewHeaderActionsProps> = (props) => (
  <TabStripArrow side="left" {...props} />
)

/**
 * 条**左端**组合：**标签总览**（点开选标签）+ 左箭头（溢出时才出现）。
 *
 * 2026-11-01 用户纠正（我此前理解反了）：
 * "标签的前面应该有个按钮，点击能打开，选择标签，这个组件不是已经做过了吗？
 *  加号应该在标签的右面啊"
 *
 * 所以左右分工是：
 * ```
 * [标签总览 ▾] [标签1 标签2 …] [+] [右箭头]
 *   ↑ 左（选标签）              ↑ 右（新建）
 * ```
 * - **左** = 标签总览下拉（`TabOverviewButton`，cmdk 检索 + ✕ 关闭）。
 *   这是"点开能选标签"的那个组件——早就做过（`tab-overview-menu.tsx`），
 *   只是此前被 `panels<=2` 门槛藏了，且挂在右侧。
 * - **右** = 加号（`TabStripNewButton`，新建面板）。
 *
 * dockview 的槽位语义（`headerActionsService.ts` 的 SLOT_OPTION_KEY）：
 * `prefix` → `dv-pre-actions-container`（tabs **之前**）；
 * `left` → `dv-left-actions-container`（tabs **之后**、void 之前）；
 * `right` → `dv-right-actions-container`（条最右）。
 * 所以"加号在标签右边"要挂 `leftHeaderActionsComponent`。
 */
export const TabStripLeading: FC<IDockviewHeaderActionsProps> = (props) => (
  <>
    <TabOverviewButton {...props} />
    <TabStripArrow side="left" {...props} />
  </>
)

/**
 * 条**标签之后**的组合：加号（新建面板）。
 *
 * 挂 `leftHeaderActionsComponent` → `dv-left-actions-container`，DOM 序在
 * tabs 之后、void 之前，所以视觉上就是"最后一个标签的右边"。
 */
export const TabStripTrailing: FC<IDockviewHeaderActionsProps> = (props) => (
  <TabStripNewButton {...props} />
)

/** 右动作位组合：右滚动箭头（溢出时出现）。 */
export const TabStripRightSide: FC<IDockviewHeaderActionsProps> = (props) => (
  <TabStripArrow side="right" {...props} />
)
