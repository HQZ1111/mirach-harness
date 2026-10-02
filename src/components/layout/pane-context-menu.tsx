/**
 * 窗格空白区（zone body）右键 → 分栏操作菜单。
 *
 * hermes 实锤（tree/renderer/tree-group.tsx 的 ZoneMenu，94-224 行；
 * paneTabCloseItems 在 components/ui/pane-tab.tsx 329-383 行）：strip / rail /
 * edit veil / body 四处同一份菜单；项序 =（域前缀）· 重新加载(refresh) · 关闭
 * (close，非可关**隐藏**——本工程按用户裁定改为**保留可见仅禁用**，一级窗格
 * 关闭=回家) · 关闭其他(close-all) · 关闭右侧(arrow-right) · 全部关闭(clear-all)
 * 计数为 0 禁用 ·（隐藏/显示轨道页签）· 隐藏/显示标签(eye/eye-closed) ·
 * 最小化/还原(chevron-down/chevron-up，图标指向区将 GO 的方向)。中文文案逐字
 * zh catalog（zones 段：重新加载/关闭其他/关闭右侧/全部关闭/隐藏标签/显示标签/
 * 还原 + common.close 关闭）。
 * **实证差异**：现役 hermes zone 菜单里没有 左/右/上/下分栏 与 最大化
 * （tree-group.tsx 246 行 "the zone menu's Split actions" 是旧版残留注释）；
 * 分栏是本轮任务新增的动作面，映射 flexlayout 原生 tabset 分裂
 * （Actions.updateNodeAttributes + closePane 注册表路由）。重新加载无占位
 *  内容可载、不装假（规矩 12）。
 * （规矩 12）；最小化对应既有 zone 头部竖轨切换钮，不在菜单重复。
 *
 * 三面裁定协调（context-menu-scope.ts 'pane' 分支）：main.tsx 全局 capture
 * 监听对 pane **早退不 preventDefault**（与行/树同款 Radix 自管模式），本组件
 * Trigger 的 handler 自己 preventDefault + 开菜单（Radix composeEventHandlers
 * 内建：子元素 onContextMenu 先跑，defaultPrevented 则跳过开启分支——所以
 * owned 面（行自己的 Trigger）先 preventDefault 后，pane 菜单自动不弹）。
 * 右键落在 editable（composer 输入框等）→ 本组件在**捕获段** stopPropagation：
 * 不 preventDefault（原生编辑菜单保留），同时拦住本元素冒泡段的 Radix 开启。
 *
 * 菜单项在**打开时刻**从 model 现读（hermes "Resolved when the menu OPENS"
 * 契约——Content 只在开启时挂载，无订阅、无过期快照）。
 *
 * 触发面全景（hermes ZoneMenu 包裹 strip/rail/edit-veil/body 四面——
 * tree-group.tsx 486/550/816）：本组件的 Radix Trigger 表面 div 盖
 * **页签 body**（.flexlayout__tab 全域，工厂包裹）；tabset 的其余区域
 * （页签条/拉伸头栏/logo 带/条上空白）由**裁定层 store 路由**同弹本菜单：
 * main.tsx app 分支查落点所在 .flexlayout__tabset → openZoneContextMenuAt
 * → ZoneContextMenuHost 在点击点渲染**同一份项清单**（buildPaneMenuItems
 * 单一来源，hermes MenuKit 同构——两套 Radix 原语、一份菜单）。目标页签 =
 * 该分栏当前选中页签（hermes "the right-clicked chip, else the active
 * pane"；页签按钮右键仍归 flexlayout 自管页签菜单，不经此路）。
 */

import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import {
  ArrowRightIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  ListXIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PanelTopIcon,
  PencilIcon,
  XIcon,
} from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { createStore, useStore } from 'zustand'

import { resolveContextMenuScope } from '../panes/session-manage/context-menu-scope'
import { PANE_TYPES, closePane, paneTypeOf, zoneConfigOf } from './pane-registry'

// ── 状态推导（纯函数，node 可测） ─────────────────────────────────────────────

/** 页签可关性：注册表一级窗格（primary）不可真关（关闭走回家语义）。 */
export const isCloseableTabNode = (t: TabNode): boolean => {
  const pt = paneTypeOf(t.getId())
  return pt ? !PANE_TYPES[pt].primary : true
}

export interface ZoneMenuFlags {
  /** 一级窗格且已在家 → 关闭禁用（回家无处可回）。 */
  closeDisabled: boolean
  /** 同栏可关页签中除本签的个数（关闭其他计数，hermes treeTabCloseTargets）。 */
  othersCloseable: number
  /** 本签右侧可关页签个数（关闭右侧计数）。 */
  rightCloseable: number
  /** 同栏可关页签总数（全部关闭计数）。 */
  allCloseable: number
  maximized: boolean
  /** 非轨分栏 ≥2 才可最大化（"最大化仅多窗格时可用"）。 */
  canMaximize: boolean
  stripVisible: boolean
  /** 竖轨形态大栏（rail）：标签条由区域形态管，菜单不开放单栏开关。 */
  stripLocked: boolean
}

export const zoneMenuFlags = (model: Model, tabId: string): ZoneMenuFlags | undefined => {
  const tab = model.getNodeById(tabId)
  if (!(tab instanceof TabNode)) return undefined
  const set = tab.getParent()
  if (!(set instanceof TabSetNode)) return undefined
  const kids = set.getChildren().filter((c): c is TabNode => c instanceof TabNode)
  const closeables = kids.filter(isCloseableTabNode)
  const idxInKids = kids.findIndex((t) => t.getId() === tabId)
  const ptype = paneTypeOf(tabId)
  const def = ptype ? PANE_TYPES[ptype] : undefined
  const cfg = zoneConfigOf(set)
  let setCount = 0
  model.visitNodes((n) => {
    if (!(n instanceof TabSetNode) || n.getChildren().length === 0) return
    const c = zoneConfigOf(n)
    if (!c?.track) setCount += 1
  })
  return {
    // 一级窗格且所在分栏就是它的家乡大栏 → 关闭不可用（已在家，§7）
    closeDisabled: !!(def?.primary && cfg && cfg.region === def.region),
    othersCloseable: closeables.filter((t) => t.getId() !== tabId).length,
    rightCloseable: idxInKids >= 0 ? closeables.filter((t) => kids.indexOf(t) > idxInKids).length : 0,
    allCloseable: closeables.length,
    maximized: set.isMaximized(),
    canMaximize: setCount >= 2,
    stripVisible: set.isEnableTabStrip(),
    stripLocked: !!cfg?.rail,
  }
}

// ── 菜单项清单（纯函数：flags → 项序/文案/禁用，hermes ZoneMenu 同构） ────────

export type PaneMenuItem =
  | { kind: 'sep'; id: string }
  | { kind: 'item'; id: string; label: string; disabled?: boolean }

/** hermes ZoneMenu 项序（tree-group.tsx ZoneMenu 实锤：refresh[宿主无重载
 *  面，规矩 12 不装假] → 关闭组 → 隐藏/显示标签 → 最小化/还原[还原=折回
 *  轨道的区头钮语义，菜单项待 fold 逻辑导出后接——区头钮已在位]）。
 *  **四向分栏/最大化/重命名不在 hermes ZoneMenu**（i18n zones 段无 split
 *  键全库零命中）——此前按旧口径自创，2026-10-02 用户纠错后删除。 */
export const buildPaneMenuItems = (f: ZoneMenuFlags): PaneMenuItem[] => [
  { kind: 'item', id: 'close', label: '关闭', disabled: f.closeDisabled },
  { kind: 'item', id: 'close-others', label: '关闭其他', disabled: !f.othersCloseable },
  { kind: 'item', id: 'close-right', label: '关闭右侧', disabled: !f.rightCloseable },
  { kind: 'item', id: 'close-all', label: '全部关闭', disabled: !f.allCloseable },
  { kind: 'sep', id: 'sep-strip' },
  {
    kind: 'item',
    id: f.stripVisible ? 'hide-strip' : 'show-strip',
    label: f.stripVisible ? '隐藏标签' : '显示标签',
    disabled: f.stripLocked,
  },
]

// ── 动作映射（flexlayout Actions；doAction 经壳 onModelChange 自动
//    persist + 结构动作 rebalance，无需手动记账） ─────────────────────────────

export const runPaneMenuAction = (itemId: string, model: Model, tabId: string): void => {
  const tab = model.getNodeById(tabId)
  if (!(tab instanceof TabNode)) {
    // 菜单打开到点击之间页签已消失（拖拽/别处关闭）——目标没了，动作作废可见报
    console.error('[pane-context-menu] tab is gone', tabId)
    return
  }
  const set = tab.getParent()
  if (!(set instanceof TabSetNode)) {
    console.error('[pane-context-menu] tab has no tabset', tabId)
    return
  }
  const kids = set.getChildren().filter((c): c is TabNode => c instanceof TabNode)
  const idxInKids = kids.findIndex((t) => t.getId() === tabId)
  const closeables = kids.filter(isCloseableTabNode)
  switch (itemId) {
    case 'close': {
      const res = closePane(model, tabId)
      if (res === 'refused') console.error('[pane-context-menu] close refused (primary at home)', tabId)
      return
    }
    case 'close-others':
    case 'close-right':
    case 'close-all': {
      const targets =
        itemId === 'close-others'
          ? closeables.filter((t) => t.getId() !== tabId)
          : itemId === 'close-right'
            ? closeables.filter((t) => kids.indexOf(t) > idxInKids)
            : closeables
      for (const t of targets) {
        const res = closePane(model, t.getId())
        if (res === 'refused') console.error('[pane-context-menu] close refused', t.getId())
      }
      return
    }
    case 'hide-strip':
    case 'show-strip':
      model.doAction(Actions.updateNodeAttributes(set.getId(), { enableTabStrip: !set.isEnableTabStrip() }))
      return
    default:
      console.error('[pane-context-menu] unknown menu item', itemId)
  }
}

// ── Radix ContextMenu 挂载（形制照 thread-list.aui.tsx SessionContextMenu） ──

const MENU_CONTENT_CLASS =
  'bg-popover text-popover-foreground z-50 w-44 overflow-hidden rounded-xl border p-1.5 shadow-(--shadow-pop)'

const MENU_ITEM_BASE =
  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

const ITEM_ICONS: Record<string, FC<{ className?: string }>> = {
  'split-left': PanelLeftIcon,
  'split-right': PanelRightIcon,
  'split-top': PanelTopIcon,
  'split-bottom': PanelBottomIcon,
  rename: PencilIcon,
  close: XIcon,
  'close-others': ListXIcon,
  'close-right': ArrowRightIcon,
  'close-all': EraserIcon,
  maximize: Maximize2Icon,
  restore: Minimize2Icon,
  'hide-strip': EyeOffIcon,
  'show-strip': EyeIcon,
}

const ZoneMenuIcon: FC<{ itemId: string }> = ({ itemId }) => {
  const Icon = ITEM_ICONS[itemId]
  return Icon ? <Icon className="size-3.5 shrink-0" /> : null
}

/** 菜单原语套件（hermes MenuKit 同构）：一份项清单喂两套 Radix 原语——
 *  ContextMenu（页签 body 的表面 Trigger）与 DropdownMenu（裁定层 store
 *  路由的受控菜单，AppContextMenu 零尺寸锚形制）。项数据 buildPaneMenuItems
 *  是唯一来源，两渲染面不得分叉。 */
interface ZoneMenuKit {
  Separator: FC
  Item: FC<{ itemId: string; label: string; disabled?: boolean; onRun: (itemId: string) => void }>
}

const contextMenuKit: ZoneMenuKit = {
  Separator: () => <ContextMenuPrimitive.Separator className="bg-(--stroke-soft)" />,
  Item: ({ disabled, itemId, label, onRun }) => (
    <ContextMenuPrimitive.Item className={MENU_ITEM_BASE} disabled={disabled} onSelect={() => onRun(itemId)}>
      <ZoneMenuIcon itemId={itemId} />
      <span>{label}</span>
    </ContextMenuPrimitive.Item>
  ),
}

const dropdownMenuKit: ZoneMenuKit = {
  Separator: () => <DropdownMenuPrimitive.Separator className="bg-(--stroke-soft)" />,
  Item: ({ disabled, itemId, label, onRun }) => (
    <DropdownMenuPrimitive.Item
      className={MENU_ITEM_BASE + ' data-[highlighted]:bg-(--hover-wash)'}
      disabled={disabled}
      onSelect={() => onRun(itemId)}
    >
      <ZoneMenuIcon itemId={itemId} />
      <span>{label}</span>
    </DropdownMenuPrimitive.Item>
  ),
}

/** 菜单体渲染（flags → 项序/文案/禁用，纯投影）：ContextMenu 与 DropdownMenu
 *  两面共用；flags 缺失 = 目标页签已消失（下一次 doAction 重渲即卸载）。 */
const ZoneMenuList: FC<{ flags: ZoneMenuFlags; kit: ZoneMenuKit; onRun: (itemId: string) => void }> = ({
  flags,
  kit,
  onRun,
}) => (
  <>
    {buildPaneMenuItems(flags).map((it) =>
      it.kind === 'sep' ? (
        <kit.Separator key={it.id} />
      ) : (
        <kit.Item disabled={it.disabled} itemId={it.id} key={it.id} label={it.label} onRun={onRun} />
      ),
    )}
  </>
)

/** 打开时刻现读 flags 的菜单体（Content 只在开启时挂载 = "resolved when the
 *  menu OPENS"，闭包里的 model 由 flexlayout 在模型变更后重渲工厂时换新）。 */
const ZoneMenuBody: FC<{ model: Model; tabId: string }> = ({ model, tabId }) => {
  const flags = zoneMenuFlags(model, tabId)
  if (!flags) return null // 目标页签已消失（下一次 doAction 重渲即卸载）
  return (
    <ZoneMenuList
      flags={flags}
      kit={contextMenuKit}
      onRun={(itemId) => runPaneMenuAction(itemId, model, tabId)}
    />
  )
}

/**
 * 窗格 body 右键面。flex-layout 工厂用它包住每个页签内容：
 * Trigger asChild 的表面 div **铺满整个 body**（.flexlayout__tab 是
 * position:absolute 定尺寸盒，surface 以 100%×100% 吃满——窗格内容矮于
 * body 时下缘留白照样命中 surface，display:contents 不行：无盒元素收不到
 * 命中测试，WebView2 菜单会从缝里漏出）。Radix Trigger 自带：开启时
 * preventDefault（压 WebView2 菜单）+ 虚拟锚定到点击坐标。
 */
export const PaneZoneMenu: FC<{ node: TabNode; children: ReactNode }> = ({ node, children }) => {
  const tabId = node.getId()
  const model = node.getModel()
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        <div
          className="pane-zone-menu-surface"
          onContextMenuCapture={(e) => {
            // 原生右键落在 pane 内编辑面（composer textarea 等）→ 放行原生
            // 编辑菜单：捕获段 stopPropagation（**不 preventDefault**——那
            // 会连原生菜单一起压掉）拦住本元素冒泡段的 Radix 开启。
            // owned 面无需处理（行 Trigger 先 preventDefault，
            // composeEventHandlers 的 defaultPrevented 检查自动跳过本菜单）。
            if (!(e.target instanceof Element)) return
            if (resolveContextMenuScope(e.target) === 'editable') e.stopPropagation()
          }}
          style={{ display: 'block', height: '100%', width: '100%' }}
        >
          {children}
        </div>
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label="分栏操作"
          className={MENU_CONTENT_CLASS}
          data-slot="fl-pane-zone-context"
        >
          <ZoneMenuBody model={model} tabId={tabId} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}

// ── 裁定层 store 路由（tabset chrome 落点 → 同一份 ZoneMenu） ────────────────
// 页签条/拉伸头栏/logo 带/条上空白不在页签 body 表面（Radix Trigger 够不到，
// hermes 里这些面同归 ZoneMenu——tree-group 486 的 strip 包裹）。main.tsx 的
// app 分支查落点所在 .flexlayout__tabset 后调 openZoneContextMenuAt，本模块
// 持 store 并在树外渲染受控菜单（AppContextMenu 零尺寸锚形制——hermes app
// 菜单同款：菜单由 store 打开而非 Trigger，两菜单永不同开由裁定层保证）。

interface ZoneContextMenuState {
  /** 打开中的菜单（viewport 坐标 + 目标页签），null = 无菜单。 */
  open: { x: number; y: number; tabId: string } | null
  openAt(x: number, y: number, tabId: string): void
  close(): void
}

export const zoneContextMenuStore = createStore<ZoneContextMenuState>((set) => ({
  open: null,
  openAt: (x, y, tabId) => set({ open: { x, y, tabId } }),
  close: () => set({ open: null }),
}))

/** DOM tabset 落点 → 模型 TabSetNode（data-layout-path 对模型 getPath 回查）。
 *  模型/路径缺失 = 错误可见（__flModel 通道与 app-context-menu 同源）。 */
export const zoneTabsetFromDom = (setEl: Element): TabSetNode | undefined => {
  const model = (window as { __flModel?: Model }).__flModel
  if (!model) {
    console.error('[pane-context-menu] 活动布局模型不在场（__flModel 未挂载）')
    return undefined
  }
  const path = setEl.getAttribute('data-layout-path')
  if (!path) {
    console.error('[pane-context-menu] tabset 落点无 data-layout-path')
    return undefined
  }
  let found: TabSetNode | undefined
  model.visitNodes((n) => {
    if (!found && n instanceof TabSetNode && n.getPath() === path) found = n
  })
  if (!found) console.error('[pane-context-menu] 落点分栏不在当前模型', path)
  return found
}

/** main.tsx app 分支入口：右键点在某 tabset 内（页签 body 之外）→ 弹该分栏
 *  的 ZoneMenu。目标页签 = 分栏当前选中页签（hermes "the right-clicked chip,
 *  else the active pane"；页签按钮右键归 flexlayout 自管页签菜单，裁定层
 *  已先行放行）。停车轨（RailNav 自有交互面）与空栏占位（hermes 空 zone 不
 *  存续、tidy 即收——无目标页签可作用）不弹，维持无菜单现状。 */
export function openZoneContextMenuAt(x: number, y: number, setEl: Element): void {
  const set = zoneTabsetFromDom(setEl)
  if (!set) return
  if (zoneConfigOf(set)?.track) return
  const tab = set.getSelectedNode()
  if (!tab) return
  zoneContextMenuStore.getState().openAt(x, y, tab.getId())
}

/** 受控 ZoneMenu（store 路由面）：与页签 body 的 Radix 表面共用一份项清单
 *  与动作；模型在渲染时刻现读（Content 挂载即打开时刻——同 "resolved when
 *  the menu OPENS" 契约）。目标页签在打开到点击之间消失 → 项清单为空、
 *  菜单空壳即关（动作面 runPaneMenuAction 对消失页签另有错误可见兜底）。 */
export const ZoneContextMenuHost: FC = () => {
  const open = useStore(zoneContextMenuStore, (s) => s.open)
  if (!open) return null
  const model = (window as { __flModel?: Model }).__flModel
  if (!model) {
    console.error('[pane-context-menu] 活动布局模型不在场（__flModel 未挂载）')
    return null
  }
  const flags = zoneMenuFlags(model, open.tabId)
  if (!flags) return null
  return (
    <DropdownMenuPrimitive.Root
      onOpenChange={(openState) => {
        if (!openState) zoneContextMenuStore.getState().close()
      }}
      open
    >
      <DropdownMenuPrimitive.Trigger asChild>
        <span aria-hidden style={{ left: open.x, position: 'fixed', top: open.y }} />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          aria-label="分栏操作"
          className={MENU_CONTENT_CLASS}
          data-slot="fl-pane-zone-context"
          onCloseAutoFocus={(event) => event.preventDefault()}
          side="bottom"
        >
          <ZoneMenuList
            flags={flags}
            kit={dropdownMenuKit}
            onRun={(itemId) => runPaneMenuAction(itemId, model, open.tabId)}
          />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
