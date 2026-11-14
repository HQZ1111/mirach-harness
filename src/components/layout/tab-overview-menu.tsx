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
  // 横向条（top/bottom；竖条 left/right 的右动作位在窄带里，不做）。
  //
  // **2026-10-31 去掉「面板数 > 2」的门槛**。用户："显示标签的组件也不见了"。
  // 原门槛的理由是"2 签同屏可见、点选直达"——但它让**面板栏只有 1 个标签时
  // 整个总览入口消失**，而那个场景恰恰最需要一个能看见"有哪些面板"的入口
  // （用户看到条上只有一个「打开」，不知道还能开什么）。ZCode 的同类入口
  // 是常驻的。所以：有条就给入口，不按数量隐藏。
  if (props.headerPosition !== 'top' && props.headerPosition !== 'bottom') return null
  if (props.group.model.header.hidden) return null
  const panels = props.panels

  const activeId = props.activePanel?.id

  return (
    // 2026-10-16 换 beUI goo 弹层（用户定稿"所有 panel 型浮层"）——原
    // Radix Popover 的 API 面对位：align/side/sideOffset 是 goo 根属性；
    // 进出场动画由 goo 的弹簧 morph 自带（不再需要 animate-in 类）。
    //
    // **`align="end"`**（2026-11-01 二次修正，用户："弹窗的位置怎么不在
    // 按钮上"）。
    //
    // 上一版改 `start` 是错的：总览钮在**面板栏**（窗口右侧那条窄栏），
    // 面板宽 288 —— 从按钮左缘（x≈1478）往右展开会到 1766，超出
    // `innerWidth - gutter`（1748），于是被 Popover 的防溢出钳位左移 18px
    // （实测 clampX = -18），看起来"没对齐按钮"。
    //
    // `end` = 面板**右缘**对齐按钮右缘、向左展开——按钮在屏幕右侧区域时
    // 这是唯一不越界的方向，且视觉上"从按钮长出来"的锚点感更强。
    //
    // **液滴粘性合并（goo）由令牌统一控制**（2026-11-01 用户："调用点没传，
    // 直接在令牌中统一开关不行吗"）。默认关（tokens.css 的
    // `--beui-popover-goo: 0`）：28×28 图标钮 + 288 宽大面板、间隔 6px 的
    // 组合下，粘性滤镜会把那 6px 拉成一条明显的脖子，且 `drop-shadow` 作用
    // 在「按钮 + 脖子 + 面板」的合并形状上，按钮也被投一层影。视觉上是噪声。
    //
    // 关掉后：面板 = 独立圆角矩形 + 投影，按钮保持原样（无副本、无阴影）。
    // 此前这里手写关掉 goo 的 prop，模型选择器/加号弹窗各写一遍——散在调用点
    // 的布尔参数正是"有的有脖子有的没有"的成因，已全部删除。
    <Popover
      align="end"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      sideOffset={6}
    >
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
            {/* 双下箭头（2026-11-01 用户："标签总览换成两个向下的符号图标，
                现在只有一个向下的符号"）——两个 chevron 竖叠，间距收紧，
                整体高度压到与单箭头相仿，避免把 28px 的钮撑高。
                用 `aria-hidden` 两个都藏：可访问名由外层 aria-label 提供。 */}
            <span aria-hidden className="tab-overview-chevrons">
              <ChevronDownIcon className="size-[var(--size-icon-sm)]" />
              <ChevronDownIcon className="size-[var(--size-icon-sm)]" />
            </span>
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
