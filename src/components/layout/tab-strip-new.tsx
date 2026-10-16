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
import { DropdownMenu } from 'radix-ui'
import { EyeIcon, FolderTreeIcon, PlusIcon, SquareTerminalIcon } from 'lucide-react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'

import { regionOfGroup } from './dockview-column-ops'
import { openPagePanel } from './open-page-actions'
import { Tooltip } from '@/components/motion/tooltip'
import type { OpenPageKind } from '@/components/panes/open-page'

const NEW_TAB_OPTIONS: readonly { kind: OpenPageKind; label: string; icon: typeof FolderTreeIcon }[] = [
  { kind: 'files', label: '文件树', icon: FolderTreeIcon },
  { kind: 'terminal', label: '终端', icon: SquareTerminalIcon },
  { kind: 'preview', label: '预览', icon: EyeIcon },
]

// 进出场动画（2026-10-16 用户："悬停显示的窗口动画怎么没有"）：补 animate-in/out
// （曲线/时长走 tw-animate-css 的 beUI 令牌覆盖，tailwind.css 在案）。
const MENU_CONTENT_CLASS =
  'bg-popover text-popover-foreground z-50 min-w-36 overflow-hidden rounded-xl p-1.5 shadow-(--shadow-pop) origin-(--radix-dropdown-menu-content-transform-origin) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'

const MENU_ITEM_BASE =
  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-(--hover-wash)'

export const TabStripNewButton: FC<IDockviewHeaderActionsProps> = (props) => {
  // 条可见性守卫（与箭头/总览钮同款：hideHeader 组 + 竖条不渲染）。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  // 仅面板域（"打开其他标签"的数据面 = 文件树/终端/预览）。
  if (regionOfGroup(props.group) !== 'panels') return null

  return (
    <DropdownMenu.Root>
      {/* 悬停提示 = beUI Tooltip（2026-10-16：原生 title= 无动画——用户点名
          "悬停显示的窗口动画"；与 win-dot 同款）。**嵌套序 = Tooltip 在外、
          菜单 Trigger 在内**：两层 asChild 链 Tooltip→Trigger→button 逐层
          克隆；反序会把 Tooltip 组件当 DOM 节点克隆、菜单事件全丢。 */}
      <Tooltip content="打开标签" side="bottom">
        <DropdownMenu.Trigger asChild>
          <button
            aria-label="打开标签"
            className="tab-new-trigger"
            data-slot="tab-strip-new"
            type="button"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className={MENU_CONTENT_CLASS}
          data-slot="tab-strip-new-content"
          sideOffset={6}
        >
          {NEW_TAB_OPTIONS.map(({ kind, label, icon: Icon }) => (
            <DropdownMenu.Item
              className={MENU_ITEM_BASE}
              key={kind}
              onSelect={() => openPagePanel(props.containerApi, kind)}
            >
              <Icon className="text-(--text-3) size-3.5 shrink-0" />
              <span>{label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
