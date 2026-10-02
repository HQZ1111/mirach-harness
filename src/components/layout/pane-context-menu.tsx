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
 * （Actions.addNode + DockLocation）。重新加载无占位内容可载、不装假
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
 */

import { Actions, DockLocation, TabNode, TabSetNode, type IJsonTabNode, type Model } from 'flexlayout-react'
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
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

import { resolveContextMenuScope } from '../panes/session-manage/context-menu-scope'
import { PANE_TYPES, closePane, nextInstanceId, paneTabJson, paneTypeOf, zoneConfigOf } from './pane-registry'

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

/** hermes 项序 + 任务要求的分栏组在前；文案对照 hermes zh catalog。 */
export const buildPaneMenuItems = (f: ZoneMenuFlags): PaneMenuItem[] => [
  { kind: 'item', id: 'split-left', label: '左分栏' },
  { kind: 'item', id: 'split-right', label: '右分栏' },
  { kind: 'item', id: 'split-top', label: '上分栏' },
  { kind: 'item', id: 'split-bottom', label: '下分栏' },
  { kind: 'sep', id: 'sep-split' },
  f.maximized
    ? { kind: 'item', id: 'restore', label: '还原' }
    : { kind: 'item', id: 'maximize', label: '最大化', disabled: !f.canMaximize },
  { kind: 'sep', id: 'sep-view' },
  { kind: 'item', id: 'rename', label: '重命名' },
  // hermes 对不可关目标**隐藏** Close；用户裁定一级窗格关闭=回家、项保留，
  // 故此处保持可见、仅"已在家"禁用（§7）。
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

export interface PaneMenuHost {
  /** 页签内联改名（Layout ILayoutApi.editTabName）；无实现即报错（规矩 12）。 */
  editTabName?: (tabId: string) => void
}

/** 分栏 = 在本分栏按方向裂出新分栏，放入**同窗格的实例副本**
 *  （hermes 语义："the zone menu's Split actions carry the pane into the
 *  new zone"）；多实例类型走注册表 id 分配，未注册组件克隆 JSON 加新 id。 */
export const splitTabInto = (model: Model, tab: TabNode, loc: DockLocation): boolean => {
  const tabId = tab.getId()
  const set = tab.getParent()
  if (!(set instanceof TabSetNode)) return false
  const type = paneTypeOf(tabId)
  let json: IJsonTabNode
  if (type) {
    json = paneTabJson(nextInstanceId(model, type))
  } else {
    const base = `${tab.getComponent() ?? 'pane'}-split`
    let n = 2
    let newId = `${base}-${n}`
    while (model.getNodeById(newId)) {
      n += 1
      newId = `${base}-${n}`
    }
    json = { type: 'tab', id: newId, component: tab.getComponent(), name: tab.getName(), enableClose: true }
  }
  model.doAction(Actions.addNode(json, set.getId(), loc, 0, true))
  return true
}

export const runPaneMenuAction = (itemId: string, model: Model, tabId: string, host?: PaneMenuHost): void => {
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
    case 'split-left':
      splitTabInto(model, tab, DockLocation.LEFT)
      return
    case 'split-right':
      splitTabInto(model, tab, DockLocation.RIGHT)
      return
    case 'split-top':
      splitTabInto(model, tab, DockLocation.TOP)
      return
    case 'split-bottom':
      splitTabInto(model, tab, DockLocation.BOTTOM)
      return
    case 'maximize':
    case 'restore':
      model.doAction(Actions.maximizeToggle(set.getId()))
      return
    case 'rename': {
      if (!host?.editTabName) {
        console.error('[pane-context-menu] rename host unavailable', tabId)
        return
      }
      host.editTabName(tabId)
      return
    }
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

/** 打开时刻现读 flags 的菜单体（Content 只在开启时挂载 = "resolved when the
 *  menu OPENS"，闭包里的 model 由 flexlayout 在模型变更后重渲工厂时换新）。 */
const ZoneMenuBody: FC<{ model: Model; tabId: string; host?: PaneMenuHost }> = ({ model, tabId, host }) => {
  const flags = zoneMenuFlags(model, tabId)
  if (!flags) return null // 目标页签已消失（下一次 doAction 重渲即卸载）
  const items = buildPaneMenuItems(flags)
  return (
    <>
      {items.map((it) =>
        it.kind === 'sep' ? (
          <ContextMenuPrimitive.Separator className="bg-(--stroke-soft)" key={it.id} />
        ) : (
          <ContextMenuPrimitive.Item
            className={MENU_ITEM_BASE}
            disabled={it.disabled}
            key={it.id}
            onSelect={() => runPaneMenuAction(it.id, model, tabId, host)}
          >
            {(() => {
              const Icon = ITEM_ICONS[it.id]
              return Icon ? <Icon className="size-3.5 shrink-0" /> : null
            })()}
            <span>{it.label}</span>
          </ContextMenuPrimitive.Item>
        ),
      )}
    </>
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
export const PaneZoneMenu: FC<{ node: TabNode; host?: PaneMenuHost; children: ReactNode }> = ({ node, host, children }) => {
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
          <ZoneMenuBody host={host} model={model} tabId={tabId} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
