/**
 * 标签总览下拉（v8.1 恢复，2026-10-14）——flexlayout 时代 tab-overview-menu
 * 的 dockview 版（旧版依赖 flexlayout TabNode/TabSetNode，已随 M1 删除；
 * git 9d3baa4~1 可考古）。语义保留：cmdk Command 面板——搜索框 + 「打开的
 * 标签页」分组 + 类型图标 + 标签名 + ✕ 关闭；触发钮由原生溢出按钮改为
 * rightHeaderActionsComponent 挂载（dockview-react 的组头部右侧动作位，
 * 组件随组 onDidAddPanel/onDidRemovePanel/onDidActivePanelChange 自动重渲
 * ——不需要 onDidLayoutChange 轮询）。
 *
 * 显示条件（用户定稿语义"溢出才出"的兼容版，协调实测情报：面板栏 350px）：
 * ①组有条（hideHeader 组无条不渲染——左/主栏不出现）；②顶置条（本应用无
 * 竖条）；③该组面板数 > 2（3 签起给总览入口；2 签同屏可见、点选直达）。
 * dockview 原生溢出下拉保持启用（真正溢出时的安全网，双保险不互斥）。
 *
 * 点击行 = panel.api.setActive()（原生会滚入视图）；✕ = panel.api.close()
 * （open 根面板不可关——同页签头无 ✕ 的语义，不发关闭钮）。
 */
import { useState, type FC } from 'react'
import { Command } from 'cmdk'
import {
  ChevronDownIcon,
  EyeIcon,
  FolderIcon,
  LayoutGridIcon,
  MessageSquareTextIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import type { IDockviewHeaderActionsProps, IDockviewPanel } from 'dockview-react'

import { Tooltip } from '@/components/motion/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/motion/popover'

/** 类型图标（旧版 TYPE_ICONS 的 dockview 面板映射——按 panel id）。 */
const PanelGlyph: FC<{ panel: IDockviewPanel }> = ({ panel }) => {
  const id = panel.id
  const Icon =
    id === 'files'
      ? FolderIcon
      : id === 'terminal'
        ? SquareTerminalIcon
        : id === 'preview' || id.startsWith('preview')
          ? EyeIcon
          : id === 'open'
            ? LayoutGridIcon
            : MessageSquareTextIcon
  return <Icon size={14} />
}

/** 面板不可关的面：open 是面板列的锚（v8.0 打开页生命周期）。 */
const closable = (panel: IDockviewPanel): boolean => panel.id !== 'open'

const TITLE_OF = (panel: IDockviewPanel): string => panel.title ?? panel.id

export const TabOverviewButton: FC<IDockviewHeaderActionsProps> = (props) => {
  const [open, setOpen] = useState(false)

  // 显示面：有条（hideHeader 组整个 header display:none，渲染即无意义）+
  // 横向条（top/bottom；竖条 left/right 的右动作位在窄带里，不做）+ 面板
  // 数 > 2。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  const panels = props.panels
  if (panels.length <= 2) return null

  const activeId = props.activePanel?.id

  return (
    // 2026-10-16 换 beUI goo 弹层（用户定稿"所有 panel 型浮层"）——原
    // Radix Popover 的 API 面对位：align/side/sideOffset 是 goo 根属性；
    // 进出场动画由 goo 的弹簧 morph 自带（不再需要 animate-in 类）。
    <Popover align="end" open={open} onOpenChange={setOpen} side="bottom" sideOffset={6}>
      {/* 悬停提示 = beUI Tooltip（2026-10-16：原生 title= 无动画——嵌套序
          Tooltip 在外、PopoverTrigger 在内，两层克隆逐层到 button） */}
      <Tooltip content="标签总览" side="bottom">
        <PopoverTrigger>
          <button
            aria-label="标签总览"
            className="tab-overview-trigger"
            data-slot="tab-overview-trigger"
            type="button"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        className="tab-overflow-menu w-72"
        onOpenAutoFocus={(el) => {
          // 对位原 Radix 行为（旧版 Command.Input autoFocus）：开面板后
          // 焦点进搜索框，cmdk 键盘导航（↑↓/Enter）才能用。
          el.querySelector('input')?.focus()
        }}
      >
        <Command className="tab-overview-cmd" loop>
          <Command.Input
            className="tab-overview-input"
            placeholder="搜索标签页..."
          />
          <Command.List className="tab-overview-list">
            <Command.Empty className="tab-overview-empty">没有匹配的标签页</Command.Empty>
            {/* 分组 heading 保留旧版文案；每次渲染现取 props.panels——
                dockview-react 桥在面板增删/激活变化时强制重渲。 */}
            <Command.Group className="tab-overview-group" heading="打开的标签页">
              {panels.map((panel) => {
                const title = TITLE_OF(panel)
                return (
                  <Command.Item
                    className={`tab-overview-item${panel.id === activeId ? ' active' : ''}`}
                    key={panel.id}
                    onSelect={() => {
                      panel.api.setActive()
                      setOpen(false)
                    }}
                    value={`${title} ${panel.id}`}
                  >
                    <span className="tab-overview-icon">
                      <PanelGlyph panel={panel} />
                    </span>
                    <span className="tab-overview-name">{title}</span>
                    {closable(panel) && (
                      <button
                        aria-label={`关闭 ${title}`}
                        className="tab-overview-close"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          panel.api.close()
                        }}
                        onPointerDown={(e) => {
                          // cmdk 的行选择在 pointerdown/up 链上——关闭钮
                          // 独立动作，不让事件冒到行选择（旧版同款）。
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                        type="button"
                      >
                        <XIcon size={12} />
                      </button>
                    )}
                  </Command.Item>
                )
              })}
            </Command.Group>
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
