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
import { FolderTreeIcon, PlusIcon, RadioIcon, SquareTerminalIcon } from 'lucide-react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'

import { regionOfGroup } from './dockview-column-ops'
import { openPagePanel } from './open-page-actions'
import { Tooltip } from '@/components/motion/tooltip'
import { useRadioFeatureEnabled } from '@/plugins/radio-gate'
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
  // 电台（2026-11-15）：hermes radio 插件改落窗格（宿主无底栏）。
  { kind: 'radio', label: '电台', icon: RadioIcon },
]

// 菜单观感由 beui ContextMenu 的 goo 表面提供（2026-10-26 归拢），这里只留宽度。
const MENU_CONTENT_CLASS = 'min-w-36'

export const TabStripNewButton: FC<IDockviewHeaderActionsProps> = (props) => {
  const radioEnabled = useRadioFeatureEnabled()
  // 条可见性守卫（与箭头/总览钮同款：hideHeader 组 + 竖条不渲染）。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  // 仅面板域（"打开其他标签"的数据面 = 文件树/终端/预览）。
  if (regionOfGroup(props.group) !== 'panels') return null
  const options = radioEnabled ? NEW_TAB_OPTIONS : NEW_TAB_OPTIONS.filter((option) => option.kind !== 'radio')

  return (
    // goo 已退役（2026-11-22）：面板 = 默认 fade+zoom 的独立圆角矩形 +
    // 投影，触发钮不再有副本/脖子/阴影。
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
        {options.map(({ kind, label, icon: Icon }) => (
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
