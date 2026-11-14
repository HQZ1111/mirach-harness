/**
 * 面板栏标签条「+」号（用户 2026-10-15："面板栏的标签页没有+号能打开其他
 * 标签"）——hermes tree-group.tsx:706 的 "Plain + after the last tab" 语义
 * （条尾 + 号，点开 = 又一类面板）。
 *
 * 挂载面 = **leftHeaderActionsComponent**（dockview 条的 left-actions 容器
 * 紧跟在 .dv-tabs-container 之后——CDP 实测 DOM 序：pre-actions | tabs |
 * left-actions | void | right-actions，即"最后一个标签之后"位）。仅
 * **panel 域组**渲染（regionOfGroup==='panels'；会话列/左栏没有"打开其他
 * 标签"的数据面）；hideHeader 组天然无条不渲染。
 *
 * 菜单 = 打开页三件（文件树/终端/预览，open-page-actions.ts 单源动作——
 * 与打开页按钮/标签总览同源）。Radix DropdownMenu 形制对齐侧栏 ⋯ 菜单
 * （MENU_CONTENT_CLASS 同款观感：圆角/阴影/无描边）。
 */
import type { FC } from 'react'
import { EyeIcon, FolderTreeIcon, PlusIcon, SquareTerminalIcon } from 'lucide-react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'

import { regionOfGroup } from './dockview-column-ops'
import { openPagePanel } from './open-page-actions'
import { Tooltip } from '@/components/motion/tooltip'
import {
  ContextMenu,
  ContextMenuAnchor,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/motion/context-menu'
import type { OpenPageKind } from '@/components/panes/open-page'

const NEW_TAB_OPTIONS: readonly { kind: OpenPageKind; label: string; icon: typeof FolderTreeIcon }[] = [
  { kind: 'files', label: '文件树', icon: FolderTreeIcon },
  { kind: 'terminal', label: '终端', icon: SquareTerminalIcon },
  { kind: 'preview', label: '预览', icon: EyeIcon },
]

// 菜单观感由 beui ContextMenu 的 goo 表面提供（2026-10-26 归拢），这里只留宽度。
const MENU_CONTENT_CLASS = 'min-w-36'

export const TabStripNewButton: FC<IDockviewHeaderActionsProps> = (props) => {
  // 条可见性守卫（与箭头/总览钮同款：hideHeader 组 + 竖条不渲染）。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  // 仅面板域（"打开其他标签"的数据面 = 文件树/终端/预览）。
  if (regionOfGroup(props.group) !== 'panels') return null

  return (
    // **液滴粘性合并（goo）由令牌统一控制**（2026-11-01 用户："调用点没传，
    // 直接在令牌中统一开关不行吗"）。默认关（tokens.css 的
    // `--beui-popover-goo: 0`）：28×28 图标钮 + 大面板的组合不做粘性合并
    // （否则有脖子、按钮也被投影）。调用点不再传 `goo`。
    <ContextMenu align="start" anchor="trigger" side="bottom" sideOffset={6}>
      {/* 悬停提示 = beUI Tooltip（2026-10-16：原生 title= 无动画——用户点名
          "悬停显示的窗口动画"；与 win-dot 同款）。**嵌套序 = Tooltip 在外、
          菜单锚点在内**：两层各自 cloneElement，逐层落到 button。 */}
      <Tooltip content="打开标签" side="bottom">
        <ContextMenuAnchor>
          <button
            aria-label="打开标签"
            className="tab-new-trigger pressable-sm"
            data-slot="tab-strip-new"
            type="button"
          >
            <PlusIcon className="size-[var(--size-icon-md)]" />
          </button>
        </ContextMenuAnchor>
      </Tooltip>
      <ContextMenuContent ariaLabel="打开标签" className={MENU_CONTENT_CLASS}>
        {NEW_TAB_OPTIONS.map(({ kind, label, icon: Icon }) => (
          <ContextMenuItem
            className="gap-2"
            key={kind}
            onSelect={() => openPagePanel(props.containerApi, kind)}
          >
            <Icon className="text-(--text-3) size-[var(--size-icon-md)] shrink-0" />
            <span>{label}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
