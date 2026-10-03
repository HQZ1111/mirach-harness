import { useCallback, useEffect, useRef, useState } from 'react'
import { Layout, Model, Actions, TabNode, TabSetNode, TabGroupNode, RowNode, BorderNode, DockLocation, showPopupMenu, type Action, type Node, type PopupMenuEntry, type ILayoutApi } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'

import { Titlebar } from '@/app/shell/titlebar'
import { StatusBar } from '@/app/shell/statusbar'
import { ESCAPE_PRIORITY, isTopEscapeLayer } from '@/lib/escape-layers'
import { ChatLabelOverlay, MainTint, StripHiddenTitleOverlay } from './chrome-overlays'
import { ChevronDownIcon, CloseIcon } from '@/components/ui/codicons'
import { ChevronsDownIcon } from 'lucide-react'
import { useStore } from 'zustand'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'
import { DropOverlay } from './drop-overlay'
// flexlayout 0.11.1 行节点 max 聚合缺陷的运行时修正（须先于布局执行，见文件头）
import './flexlayout-rowfix'

import { RailLogoLeading } from './rail-logo-leading'
import { ResizeHandles } from './resize-handles'
import { clampRowWeights, regionCfgOfNode, rootNeededMin, rootAvailPx, widthBounds } from './constraints'
import { absorbSurplus, applyRootWeights, fitWindowWidth, mergeZonesPerColumn, measureRootPx, rootPxMem, setWindowMaximized, updateNarrowViewport } from './rebalance'
import { syncTabsetConstraints } from './constraints-sync'
import { startPaneDrag } from './drag-session'
import { EditPalette } from './edit-palette'
import { EditVeils } from './edit-veils'
import { useLayoutStore, bumpLayoutRev, bumpDragRev, closeEditMode, closeZoneEditor, openZoneEditor, removeUserPreset, setActivePreset, setAppliedTree, setSideCollapsed, storeUserPreset, toggleEditMode } from '@/store/layout-store'
import { appWindow, inTauri } from '@/lib/tauri-window'
import { LAYOUT_PRESETS, mirrorLayoutJson, presetToModelJson, SPLITTER_PX } from './layout-presets'
import { PANE_TYPES, PRIMARY_PANE, REGION_DEFAULT_W, REGION_LIMITS, TRACK_W, findRailTabset, paneTypeOf, paneTabJson, nextInstanceId, sendPaneHome, zoneConfigOf, closePane, type PaneType, type Region } from './pane-registry'
import { PaneAddButton, RailNav, openableTypesForRegion } from './region-rails'
import { useTabSelection, clearTabSelection, isToggleSelectClick, selectTabRange, selectionFor, toggleTabSelected } from './tab-selection'
import { TabOverviewMenu } from './tab-overview-menu'
import { ZoneEditor } from './zone-editor'

import { BotsPane } from '@/components/panes/bots-pane'
import { FilesPane } from '@/components/panes/files-pane'
import { FileTreePane } from '@/components/panes/file-tree-pane'
import { ReviewPane } from '@/components/panes/review-pane'
import { SessionsPane } from '@/components/panes/sessions-pane'
import { TerminalPane } from '@/components/panes/terminal-pane'
import { WorkspacePane } from '@/components/panes/workspace-pane'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { AssistantSessionsPane } from '@/components/panes/assistant-sessions-pane'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { HermesPreviewPane } from '@/components/panes/hermes-sidebar/hermes-preview-pane'
import { setPreviewOpener } from '@/components/panes/hermes-sidebar/preview-opener'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'


// ── 窗格组件注册表（按**类型**分发；多实例共用同一组件） ─────────────────────

const COMPONENTS: Record<string, React.ComponentType<{ tabName?: string }>> = {
  sessions: AssistantSessionsPane, // 左栏会话列表 = assistant-ui ThreadList 原语（hermes 皮）
  bots: BotsPane,
  workspace: AssistantThreadPane, // 主对话栏 = assistant-ui Thread
  session: AssistantThreadPane, // 多开会话同用 Thread
  files: HermesFileTreePane, // 文件树 = hermes 视觉 + 本 harness fs_list
  review: ReviewPane,
  terminal: TerminalPane,
}

/** 一级窗格类型（不可关闭；非家乡位置的关闭 = 回家） */
const PRIMARY_TYPES = new Set(
  Object.entries(PANE_TYPES)
    .filter(([, d]) => d.primary)
    .map(([t]) => t),
)

// 动作数据里的节点 id 键（flexlayout 工厂签名逐个对照——AGENTS 审计教训②：
// 数据键不统一，DELETE_TAB/UPDATE_NODE_ATTRIBUTES/MAXIMIZE_TOGGLE=node、
// SELECT_TAB/SET_ACTIVE_TABSET=tabNode、MOVE_NODE/ADD_TAB=fromNode/toNode、
// ADJUST_WEIGHTS/ADJUST_BORDER_SPLIT=nodeId）
const ACTION_ID_KEYS = ['node', 'nodeId', 'tabNode', 'fromNode', 'toNode'] as const

/** 动作是否作用于非主布局（浮动/弹出窗）子树——这些动作放行原生
 *  （docs/layout-design.md §8/§12：浮动窗格隔离，主布局的回家/关闭拦截、
 *  rail 不变量、配重钳制都不适用于浮窗） */
const actionInFloatLayout = (m: Model, action: Action): boolean => {
  const d = action.data as Record<string, unknown> | undefined
  if (!d) return false
  for (const k of ACTION_ID_KEYS) {
    const v = d[k]
    if (typeof v !== 'string') continue
    const n = m.getNodeById(v)
    if (n && n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return true
  }
  return false
}

// 布局预设与各栏约束在 layout-presets.ts（docs/layout-design.md §2 数值）。

const makeDefaultLayout = () => presetToModelJson(LAYOUT_PRESETS[0])

// v6：v3 架构（region/track 走 tabset.config；v5 及更早的存档带着三轮
// 废弃竖轨实验的残骸——停车轨/吸收区/合并式轨——整体作废，直接默认布局）
const STORAGE_KEY = 'mirach.harness.layout.v6'

// ── 整侧隐藏（2026-10-01 定稿：**全隐藏**，不走边框轨——隐藏后不出现
// 竖轨标签条；border 轨只保留给终端折叠与窄屏抽屉特性）────────────────────
// 参照（照抄不发明）：
// - hermes tree/store.ts $collapsedTreeSides：side collapse 是**纯可见性**
//   ——树与声明式固定轨 px 原封不动，展开即原样回来；store.ts 2095：
//   reset 重开收起侧，否则"隐藏在 reset 后悄悄存活，下一次 ⌘B 变成
//   显示"（= 持久化标志脱同步的出处）；
// - ZCode useAnimatedResizablePanel：panel.collapse() 期间
//   rememberExpandedSize 保留展开尺寸，expand 时 panel.resize 钉回。
// flexlayout 没有"隐藏"原语：页签只能删或折。折进 border 留 24px 竖排
// 标签轨（用户否掉）；删则该侧列被 tidy 拆掉、剩余列权重按 weight/Σ
// 比例膨胀（flexlayout 删节点**从不归一化**剩余兄弟权重——用户实测：
// 隐藏右栏后左栏 350 → 420）。修法：隐藏前把该侧根行列子树 JSON
// （含轨）+ 页签 id 清单快照落盘（= hermes"树不动"的等价物：结构在
// 快照里原样保活），显示时整树拼回（+孤儿页签 addNode 回填），配重由
// pinAfterLayout 按记忆 px（rebalance.rootPxMem = 声明轨/ZCode
// expandedSize 的等价物）重钉，主栏吃剩余。
const SIDE_HIDE_KEY = 'mirach.harness.layout.sideHide.v1'

interface SideHideRecord {
  /** 该侧根行列子树 JSON（含轨；隐藏前的结构原样） */
  cols?: unknown[]
  /** 该侧全部页签 id（含被拖去别栏/轨里的孤儿——恢复时回填） */
  panes?: string[]
}

const readSideHide = (): { left?: SideHideRecord; right?: SideHideRecord } => {
  try {
    const raw = localStorage.getItem(SIDE_HIDE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const r = parsed as Record<string, unknown>
    const one = (v: unknown): SideHideRecord | undefined => {
      if (!v || typeof v !== 'object') return undefined
      const o = v as Record<string, unknown>
      return {
        cols: Array.isArray(o.cols) ? (o.cols as unknown[]) : undefined,
        panes: Array.isArray(o.panes) ? (o.panes as string[]) : undefined,
      }
    }
    return { left: one(r.left), right: one(r.right) }
  } catch {
    return {}
  }
}

const writeSideHide = (v: { left?: SideHideRecord; right?: SideHideRecord }) => {
  try {
    localStorage.setItem(SIDE_HIDE_KEY, JSON.stringify(v))
  } catch (e) {
    console.error('[flex-layout] persist side hide record failed', e)
  }
}

const sideHideRecord: { left?: SideHideRecord; right?: SideHideRecord } = readSideHide()

/** JSON 级 zone 读取（与 constraints.regionCfgOfNode 同构：行不带 config，
 *  下钻第一个带 config 的 tabset）。 */
const jsonZoneOf = (n: unknown): { region: Region; track: boolean } | undefined => {
  if (!n || typeof n !== 'object') return undefined
  const node = n as { type?: string; config?: { region?: string; track?: boolean }; children?: unknown[] }
  if (node.type === 'tabset') {
    const cfg = node.config
    if (cfg && (cfg.region === 'left' || cfg.region === 'main' || cfg.region === 'right')) {
      return { region: cfg.region, track: cfg.track === true }
    }
    return undefined
  }
  if (node.type === 'row') {
    for (const c of node.children ?? []) {
      const deep = jsonZoneOf(c)
      if (deep) return deep
    }
  }
  return undefined
}

/** 折叠期间被关闭的页签不复活：快照里只保留仍存活的页签（= 边框轨里
 *  还在的），剪空的分栏/行整枝删除（单子行按 RowNode.tidy 语义解包）。
 *  **轨列例外**：20px 竖轨本来就是空的（RailNav 渲染在占位层），剪空
 *  逻辑不得吞掉它——否则竖轨形态的侧栏隐藏后恢复丢轨。 */
const pruneSideCols = (cols: unknown[], alive: Set<string>): unknown[] => {
  const walk = (n: unknown): unknown => {
    if (!n || typeof n !== 'object') return null
    const node = n as { type?: string; id?: string; children?: unknown[] }
    if (node.type === 'tab') return node.id && alive.has(node.id) ? node : null
    if (node.type === 'tabset' && jsonZoneOf(node)?.track) return node
    const kids = Array.isArray(node.children) ? node.children.map(walk).filter(Boolean) : []
    if (kids.length === 0) return null
    if (node.type === 'row' && kids.length === 1) return kids[0]
    return { ...node, children: kids }
  }
  return cols.map(walk).filter(Boolean) as unknown[]
}

const collectTabIds = (cols: unknown[]): Set<string> => {
  const out = new Set<string>()
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: string; id?: string; children?: unknown[] }
    if (node.type === 'tab' && node.id) out.add(node.id)
    for (const c of node.children ?? []) walk(c)
  }
  for (const c of cols) walk(c)
  return out
}

/** 快照里多出的边框页签（边角：折叠期间从别处拖进轨的页签）并入快照
 *  最后一个 tabset，保证不丢。 */
const lastTabsetOf = (n: unknown): { children?: unknown[] } | undefined => {
  if (!n || typeof n !== 'object') return undefined
  const node = n as { type?: string; children?: unknown[] }
  if (node.type === 'tabset') return node
  const kids = (node.children ?? []).filter((c) => (c as { type?: string })?.type !== 'tab')
  for (let i = kids.length - 1; i >= 0; i--) {
    const found = lastTabsetOf(kids[i])
    if (found) return found
  }
  return undefined
}

/** 该侧在主布局网格里是否还有分栏——展开态判定 = **实际模型状态**
 *  （hermes resetLayoutTree 注释同款问题：持久化标志与实际脱同步后，
 *  一次点击被空轨 expand 的 no-op 吃掉，第二次才生效）。 */
const sideHasGridZone = (m: Model, side: Region): boolean => {
  let found = false
  m.visitNodes((n) => {
    if (found || !(n instanceof TabSetNode) || n.getChildren().length === 0) return
    if (n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
    if (zoneConfigOf(n)?.region === side) found = true
  })
  return found
}

// ── zone 的 region / 形态 / 约束（docs/layout-design.md §2/§5/§12） ─────────
// region 约束数值（REGION_LIMITS）与窗格类型表都在 pane-registry.ts。

export function FlexLayoutShell() {
  // 模型配置：全局属性压回（旧存档防御）+ 竖轨投放保护
  const configure = (m: Model) => {
    m.doAction(Actions.updateModelAttributes({ enableEdgeDock: false, borderEnableAutoHide: true }))
    // 竖轨是导航（空轨）——页签投进轨里会被"吞掉"，一律拒绝；
    // 贴着轨的分裂/插入也拒（新栏会挤在轨和分栏之间 = 用户实测的
    // "拖进竖轨还能把竖轨分栏"——轨贴大栏外缘，旁边不开新栏）
    m.setOnAllowDrop((dragNode, dropInfo) => {
      const isTrack = (n: unknown) => n instanceof TabSetNode && zoneConfigOf(n)?.track
      if (isTrack(dropInfo.node)) return false
      if (dropInfo.node instanceof RowNode) {
        // 行空隙投放：插入位与轨相邻 → 拒
        const sibs = dropInfo.node.getChildren()
        const i = typeof dropInfo.index === 'number' ? dropInfo.index : -1
        if (i >= 0 && (isTrack(sibs[i - 1]) || isTrack(sibs[i]))) return false
      }
      if (dropInfo.node instanceof TabSetNode && dropInfo.location != null && dropInfo.location !== DockLocation.CENTER) {
        // 分栏边缘分裂：新栏落点一侧紧贴轨 → 拒
        const p = dropInfo.node.getParent()
        if (p instanceof RowNode) {
          const sibs = p.getChildren()
          const i = sibs.indexOf(dropInfo.node)
          if (i >= 0) {
            const side =
              dropInfo.location === DockLocation.LEFT || dropInfo.location === DockLocation.TOP ? sibs[i - 1] : sibs[i + 1]
            if (isTrack(side)) return false
          }
        }
      }
      return true
    })
    return m
  }

  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) return configure(Model.fromJson(JSON.parse(saved)))
    } catch (e) {
      // 不可信输入 → 默认布局；失败必须可见（铁律 12：错误就是错误）
      console.error('[flex-layout] saved layout invalid, falling back to default', e)
    }    return configure(Model.fromJson(makeDefaultLayout()))
  })

  // 原生溢出菜单面板（ZCode SidePaneTabOverview 照抄）：tabs 超宽被裁后
  // flexlayout 原生溢出按钮出现，点击经 onShowOverflowMenu 打开本面板。
  const [overflowMenu, setOverflowMenu] = useState<{
    node: import('flexlayout-react').TabSetNode | import('flexlayout-react').BorderNode
    anchor: { x: number; y: number }
  } | null>(null)

  // 启动自愈：region 继承/约束按 v2.1 规则修正（持久化布局可能来自旧版本）
  // + 过承诺 min 缩让 + 富余兜底（旧存档的权重残骸在第一帧就被修正）。
  // absorb 必须等 flexlayout 首次布局（calcMinMaxSize/DOM 量测）之后——
  // 同步跑会拿到 0 量测，把主栏权重写成"吃满全部可用宽"（2026-09-26
  // 实测踩过，右侧空白的根因），双 rAF 保证在首次布局之后。
  useEffect(() => {
    syncTabsetConstraints(model)
    const sides = useLayoutStore.getState().sideCollapsed
    // 存量脱同步（flag 收起、页签在网格）在 boot 折叠——折叠确实发生时
    // 必须接配重重钉：否则 90ms 重排的量测会把再归一中间态（剩余列被
    // 顶到 max 的钳制值）写进记忆，漂移从此定格
    const foldedL = sides.left ? hideSide('left') : false
    const foldedR = sides.right ? hideSide('right') : false
    if (foldedL || foldedR) pinAfterLayout()
    measureRootPx(model)
    // 窄屏判定单写者（P1-3：640 matchMedia 写者已删）——动态判据
    // updateNarrowViewport 在 boot 先写一次初值（窄窗首启两侧栏立即撤成
    // overlay 抽屉，不等首次 resize/结构动作）
    updateNarrowViewport(model)
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (modelRef.current === model) {
          absorbSurplus(model)
          // 首帧布局后**补跑 sync**：boot 直调的 sync 被未就绪守卫放弃
          // （widthBounds 全 0），enableTabStrip=false 的竖轨残留（切竖轨
          // 恢复路径漏恢复）自此无人修——条塌、内容上移 100px（2026-10-03
          // 用户实锤"标签隐藏后内容上移"）。首帧后量测就绪，补跑即自愈。
          syncTabsetConstraints(model)
        }
      })
    })
    // 只在挂载时跑一次（模型替换走 applyJson 自己的 re-apply）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      // 90ms 串行通道的挂起定时器随卸载清理——卸载后开火会在死模型上
      // 跑全套配重/吸收，且 updateNarrowViewport 会写全局 store
      // （StrictMode 双挂载/HMR 下可达）
      window.clearTimeout(rebalanceTimerRef.current)
    }
  }, [])

  // 布局状态在 layout-store（Zustand）；flexlayout Model 只是渲染器持有的活动树。
  const editMode = useLayoutStore(s => s.editMode)
  const activePresetId = useLayoutStore(s => s.activePresetId)
  const userPresets = useLayoutStore(s => s.userPresets)
  const sideCollapsed = useLayoutStore(s => s.sideCollapsed)
  const zoneEditorOpen = useLayoutStore(s => s.zoneEditorOpen)

  // 调试句柄（CDP 探针用）：window.__flModel = 活动布局模型；
  // __rootPxMem = 根行记忆 px（rebalance 模块态的活引用）；__pinLog =
  // 钉回轨迹（[px 左,主,右…], avail, 是否落笔）
  useEffect(() => {
    const w = window as { __flModel?: Model; __rootPxMem?: typeof rootPxMem; __pinLog?: unknown[] }
    w.__flModel = model
    w.__rootPxMem = rootPxMem
    if (!w.__pinLog) w.__pinLog = []
    return () => { if (w.__flModel === model) w.__flModel = undefined }
  }, [model])

  const persist = useCallback((m: Model) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(m.toJson()))
    } catch (e) {
      console.error('[flex-layout] persist layout failed', e)
    }
  }, [])

  // 拖拽/迁移的再入护栏：迁移本身触发 onModelChange，别递归
  const migratingRef = useRef(false)
  // 拖拽标志的逃逸阀数据：最后一次指针活动时刻（document 捕获段刷新）。
  // pointerup 整体缺失时（CDP 合成 button:none 释放只出 mouseup、捕获
  // 丢失等），deferred 分支按超时强制放行重排通道。
  const lastPointerActivityRef = useRef(0)

  // 根行 px 记忆的时效守卫（延迟量测——onModelChange 时 DOM 还是旧渲染）
  const modelRef = useRef(model)
  modelRef.current = model

  // 模型替换的同步句柄：setModel 要到下一次 render 才反映进 modelRef，
  // 同一拍内的连续调用（窄屏恢复连展两侧、toggleSide 收尾 persist）必须
  // 立即读到新模型——否则会拿旧模型 toJson/doAction（整侧快照还原引入）
  const adoptModel = useCallback((next: Model) => {
    modelRef.current = next
    setModel(next)
  }, [])

  // workspace 页签名跟随当前会话（hermes：页签名即会话名）——**订阅
  // sessionCatalog**（会话名单一真相源，廿一轮：CustomEvent 旁路桥退役）；
  // 无名/无会话回「主会话」。
  const activeTitle = useStore(sessionCatalog, (s) =>
    s.activeId ? sessionDisplayName(s.entries[s.activeId]) : null,
  )
  useEffect(() => {
    const m = modelRef.current
    const node = m?.getNodeById('workspace')
    if (!(node instanceof TabNode)) return
    const name = (typeof activeTitle === 'string' && activeTitle.length > 0 ? activeTitle : '主会话')
    if (node.getName() !== name) {
      m!.doAction(Actions.updateNodeAttributes('workspace', { name }))
    }
  }, [activeTitle])

  // 最大化同步标志（rebalance.fitWindowWidth 顶部判定用）：boot 查一次 +
  // onResized 持续维护（isMaximized 异步——标志化让 fitWindowWidth 保持同步）。
  useEffect(() => {
    if (!inTauri || !appWindow) return
    const win = appWindow
    let unlisten: (() => void) | undefined
    const refresh = () => {
      void win.isMaximized().then((v) => setWindowMaximized(v))
    }
    refresh()
    void win.onResized(() => refresh()).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }, [])

  // 折叠/隐藏后的配重重钉（hermes 声明式固定轨 / ZCode expandedSize 的
  // 等价物）：非主栏列按记忆 px（rootPxMem）显式钉回、主栏吃剩余——
  // 禁止 flexlayout 的默认兄弟权重再归一结果裸露到渲染。**同步施加**：
  // bounds 就绪靠强制 calcMinMaxSize（纯属性计算，flexlayout 布局期跑的
  // 就是它——fromJson 后未布局的模型也能同步算）；不追加 absorbSurplus
  // ——钉回后 Σ=可用宽、富余为零，而 absorb 读到的是写入前的旧 rect，
  // 反而会把钉回砸回钳制值（rAF 版实测：350 → 420 复现；且 rAF 在被
  // 遮挡的 WebView2 里被节流，钉回整个不落地）。pinPending 挂起到下一
  // 帧：hideSide/showSide 触发的 90ms 串行重排不得读中间态写记忆。
  const pinPendingRef = useRef(false)
  const pinRafsRef = useRef<number[]>([])
  const pinNow = useCallback((m: Model): boolean => {
    ;(m.getRootRow() as unknown as { calcMinMaxSize?: () => void } | null)?.calcMinMaxSize?.()
    const ok = applyRootWeights(m)
    try {
      const w = window as { __pinLog?: unknown[]; __rootPxMem?: Record<string, number> }
      if (w.__pinLog) {
        w.__pinLog.push({
          t: Math.round(performance.now()),
          mem: w.__rootPxMem ? { ...w.__rootPxMem } : null,
          applied: ok,
        })
        if (w.__pinLog.length > 40) w.__pinLog.shift()
      }
    } catch { /* 调试句柄不干扰主流程 */ }
    return ok
  }, [])
  const pinAfterLayout = useCallback(() => {
    const m = modelRef.current
    if (!m) return
    pinPendingRef.current = true
    pinNow(m)
    updateNarrowViewport(m)
    for (const id of pinRafsRef.current) cancelAnimationFrame(id)
    pinRafsRef.current = [
      requestAnimationFrame(() => {
        pinPendingRef.current = false
      }),
    ]
  }, [pinNow])

  // 布局变化 → 持久化；手动拖动后清除激活预设标记 + bump 版本（徽标刷新）。
  // 用回调传入的 m（applyJson 在 setModel 前做程序化动作，闭包 model 是旧的）。
  // 结构性动作后同步约束（region 继承/宽度限制/堆叠高度）——diff 门控。
  const rebalanceTimerRef = useRef(0)
  const rebalanceStructuralRef = useRef(false)
  const splitterDraggingRef = useRef(false)
  // 串行重排通道（评审 #3/#11：多路 setTimeout 互相覆盖 → 单一防抖任务，
  // 固定顺序 量测 → sync → absorb，后到取消先到；卸载时随清理作废）。
  // **分隔条拖拽进行中必须推迟**：sync 的重渲会把拖拽中的 DOM 权重重置，
  // 下一帧的 calculateSplit 以重置后尺寸为新基线，逐帧复利放大（实测
  // 拖 40px 缝跑到边界）。拖拽结束后再排一次。
  const scheduleRebalance = useCallback((structural: boolean) => {
    window.clearTimeout(rebalanceTimerRef.current)
    rebalanceStructuralRef.current = rebalanceStructuralRef.current || structural
    rebalanceTimerRef.current = window.setTimeout(() => {
      const wLog = window as { __rebalanceLog?: unknown[] }
      const log = (v: unknown) => {
        if (wLog.__rebalanceLog) {
          wLog.__rebalanceLog.push(v)
          if (wLog.__rebalanceLog.length > 60) wLog.__rebalanceLog.shift()
        }
      }
      if (splitterDraggingRef.current) {
        // 逃逸阀：拖拽结束的 pointerup 整体缺失（pointer 事件层异常）时
        // 拖拽标志永真，这里会自续饿死串行通道——指针活动超时即视为
        // 拖拽已结束，强制放行
        if (lastPointerActivityRef.current > 0 && performance.now() - lastPointerActivityRef.current > 1500) {
          splitterDraggingRef.current = false
        }
      }
      if (splitterDraggingRef.current) {
        log({ t: Math.round(performance.now()), ran: 'deferred-dragging' })
        scheduleRebalance(rebalanceStructuralRef.current)
        return
      }
      const m = modelRef.current
      if (!m) return
      const allowRevert = rebalanceStructuralRef.current
      rebalanceStructuralRef.current = false
      log({ t: Math.round(performance.now()), ran: pinPendingRef.current ? 'pending-skip' : 'full', structural: allowRevert })
      // 自适应窗宽（用户 2026-09-26 定稿）：Σ(各列聚合 min) + 轨 + 缝装不
      // 下当前窗口 → 窗宽自动长到 need；关闭/合并腾出空间（结构动作触发
      // 且 need ≤ 1800）→ 回 1800 设计宽。先于 sync（长窗后缩让不误触发）
      fitWindowWidth(m, allowRevert)
      // 挤压级联①：装不下各列 min → 每大栏合并分栏进一级栏（单向，用户
      // 定稿："机器人在会话栏右边单独开一栏，这一栏属于左栏的一部分"）
      if (window.innerWidth + 2 < rootNeededMin(m)) mergeZonesPerColumn(m)
      if (pinPendingRef.current) {
        // 配重重钉挂起中：渲染中间态（权重再归一的钳制值）不可信——
        // 不得写记忆（measureRootPx）也不得写权重（absorbSurplus 与钉回
        // 打架）；只做约束修复与窄屏判定，配重由钉回落地承担
        syncTabsetConstraints(m)
        updateNarrowViewport(m)
        return
      }
      if (allowRevert) {
        // 结构动作（DELETE_TAB / MOVE_NODE / AddNode）：**不**跑 measureRootPx
        // ——记忆中的 rootPxMem 已由 onModelChange 在动作**同步时刻**记录
        // （彼时 getRect 还是动作前布局 = 用户想要的状态）；此处再量测读到
        // 的已是 stale 权重的渲染（左栏被顶大的那一帧），会污染记忆使
        // 下一次钉回错值。此处显式把在场非主栏按记忆 px 钉回、再把差额
        // 交给主栏——和 hide/show 同款 pinAfterLayout 语义。
        syncTabsetConstraints(m)
        applyRootWeights(m)
      } else {
        measureRootPx(m)
      }
      syncTabsetConstraints(m)
      absorbSurplus(m)
      // 挤压级联②：合并后仍装不下 → 隐藏左右栏（撤成 overlay 抽屉）
      updateNarrowViewport(m)
    }, 90)
  }, [])
  const onModelChange = useCallback(
    (m: Model, action?: Action) => {
      // adjusting 帧（分隔条拖拽的每个 pointermove）早退：flexlayout 对
      // adjusting 走直写 DOM 快路径，这里若 persist×2+bump 会让拖拽全程
      // 每帧 2 次同步磁盘写 + 整壳重渲，击穿快路径。提交帧（非 adjusting）
      // 必然到达，持久化不丢；pointercancel 丢提交帧的窗口由下一次任意
      // 动作必 persist 兜住。
      // 帧内 bump dragRev（轻量计数，仅量测叠片订阅）：容器 rect 每帧在
      // 变，MainTint/双行块/条隐藏标题不跟就是"松手才跳"（用户实测）。
      if (action?.isAdjusting?.()) {
        bumpDragRev()
        return
      }
      persist(m)
      setActivePreset(null)
      bumpLayoutRev()
      if (
        action?.type === Actions.ADJUST_WEIGHTS ||
        action?.type === Actions.MOVE_NODE ||
        action?.type === Actions.DELETE_TAB ||
        action?.type === 'FlexLayout_AddNode'
      ) {
        // 关闭分栏（DELETE_TAB）：同步时刻 getRect 仍是**动作前**布局
        //（flexlayout 重排在 React commit，AGENTS 记载的"onModelChange
        // 时 DOM 是旧渲染"在此恰是正确值）——此刻量测写入的正是用户
        // 关闭前看到的各列宽（想要的状态），90ms 定时器 applyRootWeights
        // 据此钉回 → 关闭不漂移；且覆盖任何历史污染（stale 权重写进
        // rootPxMem/localStorage 的 413），关闭一次即自愈为"保持不变"。
        if (action?.type === Actions.DELETE_TAB) measureRootPx(m)
        scheduleRebalance(action?.type !== Actions.ADJUST_WEIGHTS)
      }
      if (migratingRef.current) return
      if (
        action?.type === Actions.MOVE_NODE ||
        action?.type === Actions.DELETE_TAB ||
        action?.type === 'FlexLayout_AddNode'
      ) {
        syncTabsetConstraints(m)
      }
    },
    [persist, scheduleRebalance],
  )

  const applyJson = useCallback(
    (json: unknown, presetId: string | null) => {
      try {
        const next = configure(Model.fromJson(json as import('flexlayout-react').IJsonModel))
        // 约束先修（其间 onModelChange 会 setActivePreset(null)/persist(next)——
        // 无妨），再记预设标记，避免被程序化动作的 onModelChange 清掉
        syncTabsetConstraints(next)
        adoptModel(next)
        // 侧栏收起标志以新模型实际状态重导（hermes resetLayoutTree：
        // "Restore everything includes collapsed SIDES ... so hiding never
        // appears to persist"——预设/镜像/重置后的新模型页签全在网格或
        // 全按 JSON 摆好，残留的旧标志会把下一次隐藏点击变成空轨 expand
        // 的 no-op，第二次点击才生效）。隐藏记录同步清理：标志翻 false
        // 的侧，快照作废（预设把页签带回网格了）
        const leftNow = !sideHasGridZone(next, 'left')
        const rightNow = !sideHasGridZone(next, 'right')
        setSideCollapsed('left', leftNow)
        setSideCollapsed('right', rightNow)
        if (!leftNow || !rightNow) {
          if (!leftNow) delete sideHideRecord.left
          if (!rightNow) delete sideHideRecord.right
          writeSideHide(sideHideRecord)
        }
        setActivePreset(presetId)
        setAppliedTree(json)
        persist(next)
        bumpLayoutRev()
      } catch (e) {
        // 不可信预设 JSON → 忽略；失败必须可见（铁律 12：错误就是错误）
        console.error('[flex-layout] apply preset json failed', e)
      }
      // 换预设 = 布局回到模板声明宽：清掉旧会话攒下的记忆宽（评审 #1：
      // rootPxMem 是模块级记忆，切预设/fullReset 必须显式回落）
      Object.assign(rootPxMem, REGION_DEFAULT_W)
    },
    [persist, adoptModel],
  )

  const applyTemplate = useCallback(
    (id: string) => {
      const preset = LAYOUT_PRESETS.find((p) => p.id === id)
      if (!preset) return
      applyJson(presetToModelJson(preset), id)
      closeEditMode()
    },
    [applyJson],
  )

  // 全重置（hermes resetLayoutTree："Reset restores EVERYTHING"）。
  const fullReset = useCallback(() => {
    applyJson(presetToModelJson(LAYOUT_PRESETS[0]), 'default')
  }, [applyJson])

  const applyUser = useCallback(
    (id: string) => {
      const preset = userPresets.find((p) => p.id === id)
      if (!preset) return
      applyJson(preset.json, id)
      closeEditMode()
    },
    [applyJson, userPresets],
  )

  const saveCurrent = useCallback(
    (title: string) => {
      if (!title) return
      storeUserPreset(title, model.toJson())
    },
    [model],
  )

  const removeUser = useCallback((id: string) => {
    removeUserPreset(id)
  }, [])

  // 关闭窗格（docs/layout-design.md §7）：一级窗格非家乡位置 → 回家；其余
  // 真关闭（子分栏最后一签关闭 = 分栏消失，tidy 语义）。
  const closePaneById = useCallback(
    (paneId: string) => {
      const out = closePane(model, paneId)
      if (out !== 'refused') {
        persist(model)
        bumpLayoutRev()
      }
    },
    [model, persist],
  )

  // UI ✕/Ctrl+Delete 的真删除拦截（docs/layout-design.md §7）：一级窗格
  // 离家点 ✕ = 回家（sendPaneHome），已在家 = 拒绝。返回 undefined 拦掉
  // 原动作。程序化 doAction 不经过这里（closePaneById 已按同语义路由）。
  // 拖拽提交帧修复：记录最后一帧实时权重（所见即所得），松手提交时采用
  const lastAdjustRef = useRef<{ nodeId: string; weights: number[] } | null>(null)
  const onAction = useCallback(
    (action: Action): Action | undefined => {
      // 浮动窗格隔离（§8/§12 待核查项落地，P2-5）：非主布局（浮动/弹出窗）
      // 来源的动作一律放行原生——FloatWindow 自己的控制器也走本 onAction，
      // 必须在此分派。浮窗内页签的 ✕ = flexlayout 原生行为（不触发回家）；
      // 浮窗内的拖动/配重不受主布局的 rail 不变量与钳制管。
      if (actionInFloatLayout(model, action)) return action
      if (action.type === Actions.ADJUST_WEIGHTS) {
        // 拖拽实时钳制（含 adjusting 中间帧）：把权重钳进各子项的
        // [minAlong, maxAlong]，手柄到 max 就推不动，不再和限制打架闪烁。
        // **提交帧采用最后一帧实时权重**（所见即所得）：实测 flexlayout 的
        // 非 adjusting 提交帧会以不同状态重算，把拖好的列砸回 min（2026-
        // 09-26 逐帧日志实锤：实时帧 [15.4,37.8,46.8] → 提交帧 [13.4,…]）。
        const data = action.data as { nodeId?: string; weights?: number[] }
        const adjusting = (action as unknown as { isAdjusting?: () => boolean }).isAdjusting?.() ?? false
        const row = model.getNodeById(data.nodeId ?? '')
        // 负/非有限权重防线（隔离测试实锤：拖拽与 fresh reset 渲染竞争时
        // flexlayout 的 adjusting 数学算出 [-565] 级负权重并写进模型——
        // 渲染异常 + React 树停摆）。权重是非负比例，负值/NaN 只能来自
        // 库内部的坏 rect 计算：直接拒收（错误可见），提交帧退回最后
        // 一帧好权重。
        const weights = Array.isArray(data.weights) ? data.weights : []
        const insane = weights.some((w) => !Number.isFinite(w) || w < 0)
        if (insane) {
          console.error('[flex-layout] reject insane ADJUST_WEIGHTS', data.nodeId, weights)
          const w2 = window as { __adjustLog?: unknown[] }
          if (w2.__adjustLog) w2.__adjustLog.push({ t: Math.round(performance.now()), insane: true, weights, adjusting })
          if (adjusting) {
            const last = lastAdjustRef.current
            if (last && last.nodeId === data.nodeId && last.weights.length > 0 && last.weights.every((w) => Number.isFinite(w) && w >= 0)) {
              return Actions.adjustWeights(last.nodeId, last.weights).setAdjusting(true)
            }
            return undefined // 无好权重可退：拒收本帧（拖拽停摆优于写坏模型）
          }
          if (row instanceof RowNode) {
            const sane = row.getChildren().map((c) => (c as unknown as { getWeight?: () => number }).getWeight?.() ?? 100)
            return Actions.adjustWeights(row.getId(), sane)
          }
          return undefined
        }
        const wAdj = window as { __adjustLog?: unknown[] }
        if (wAdj.__adjustLog && wAdj.__adjustLog.length < 200) {
          wAdj.__adjustLog.push({ t: Math.round(performance.now()), weights, adjusting })
        }
        if (adjusting) {
          if (row instanceof RowNode && Array.isArray(data.weights) && (window as { __noClamp?: boolean }).__noClamp !== true) {
            const corrected = clampRowWeights(row, data.weights)
            // 先 clamp 后记录——提交帧采纳的是**实际渲染态**（存原始值会把
            // 拖过界的非规范权重写进持久化 JSON）
            lastAdjustRef.current = { nodeId: data.nodeId ?? '', weights: corrected ?? (data.weights ?? []) }
            if (corrected) return Actions.adjustWeights(row.getId(), corrected).setAdjusting(true)
          }
          lastAdjustRef.current = { nodeId: data.nodeId ?? '', weights: data.weights ?? [] }
          return action
        }
        // 非 adjusting = 松手提交帧
        const last = lastAdjustRef.current
        lastAdjustRef.current = null
        if (last && last.nodeId === data.nodeId && last.weights.length > 0) {
          return Actions.adjustWeights(last.nodeId, last.weights)
        }
        if (row instanceof RowNode && Array.isArray(data.weights) && (window as { __noClamp?: boolean }).__noClamp !== true) {
          const corrected = clampRowWeights(row, data.weights)
          if (corrected) return Actions.adjustWeights(row.getId(), corrected)
        }
        return action
      }
      if (action.type !== Actions.DELETE_TAB) return action
      const id = (action.data as { node?: string }).node ?? ''
      const ptype = paneTypeOf(id)
      if (!ptype || !PANE_TYPES[ptype].primary) return action
      const tab = model.getNodeById(id)
      if (!(tab instanceof TabNode)) return undefined
      const cfg = zoneConfigOf(tab.getParent())
      if (cfg && cfg.region !== PANE_TYPES[ptype].region) {
        migratingRef.current = true
        try {
          sendPaneHome(model, id)
          syncTabsetConstraints(model)
          applyRootWeights(model)
        } finally {
          migratingRef.current = false
        }
        persist(model)
        bumpLayoutRev()
      }
      return undefined
    },
    [model, persist],
  )

  // ── 整侧收起（**窄屏抽屉专用**的 border 折叠）——该侧大栏分栏里的页签
  // 折进对应 border 轨道（VS 式 overlay 抽屉）；标题栏「隐藏」不走这条
  // 路径（hideSide 全隐藏）。不触碰 hideSide 的记录（两个特性独立）。
  const foldSide = useCallback(
    (side: 'left' | 'right'): boolean => {
      const m = modelRef.current
      const borderId = side === 'left' ? 'border_left' : 'border_right'
      let idx = 0
      const ids: string[] = []
      m.visitNodes((n) => {
        if (!(n instanceof TabNode)) return
        if (n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return // 浮动窗格不折叠（§8）
        const ptype = paneTypeOf(n.getId())
        if (!ptype || PANE_TYPES[ptype].region !== side) return
        const set = n.getParent()
        if (set instanceof BorderNode) return
        const cfg = zoneConfigOf(set)
        if (cfg?.track) return // 已折进竖轨（停车轨就是收起态）
        if (cfg?.region !== side) return
        ids.push(n.getId())
      })
      if (ids.length === 0) return false
      for (const id of ids) {
        m.doAction(Actions.moveNode(id, borderId, DockLocation.CENTER, idx++))
      }
      return true
    },
    [],
  )

  // ── 整侧隐藏（标题栏「隐藏左/右栏」）：全隐藏——页签从模型删除（不走
  // border，不出现竖轨），该侧列结构在快照里原样保活，主栏吃满。孤儿
  // 页签（被拖去别栏/轨里的该侧页签）一并记录。浮窗页签不动（§8）。
  const hideSide = useCallback(
    (side: 'left' | 'right'): boolean => {
      const m = modelRef.current
      const ids: string[] = []
      m.visitNodes((n) => {
        if (!(n instanceof TabNode)) return
        if (n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return // 浮动窗格不隐藏（§8）
        const ptype = paneTypeOf(n.getId())
        if (!ptype || PANE_TYPES[ptype].region !== side) return
        ids.push(n.getId())
      })
      if (ids.length === 0) return false
      // 删除前快照该侧根行列子树（含轨）——展开按原结构拼回
      const json = m.toJson() as { layout?: { children?: unknown[] } }
      const rootKids = Array.isArray(json.layout?.children) ? json.layout.children! : []
      sideHideRecord[side] = {
        cols: rootKids.filter((k) => jsonZoneOf(k)?.region === side),
        panes: ids,
      }
      writeSideHide(sideHideRecord)
      // 程序化 deleteTab 不经过 onAction（回家/关闭拦截不适用——隐藏是
      // chrome 语义，一级窗格也照藏）；DELETE_TAB 触发串行通道，钉回
      // 挂起期由调用方调度
      for (const id of ids) {
        m.doAction(Actions.deleteTab(id))
      }
      return true
    },
    [],
  )

  // ── 整侧显示：首选整树拼回快照（hermes 语义——隐藏不改树，展开按原
  // 结构回来，宽度由 pinAfterLayout 按记忆 px 钉回）；快照缺失/不可信
  // （如升级前隐藏的存量布局）→ 按记录的页签 id 在大栏边缘重建一个
  // 分栏堆叠回填；连记录都没有 → 重建一级窗格兜底 + console.error。
  const showSide = useCallback(
    (side: 'left' | 'right'): boolean => {
      const m = modelRef.current
      if (sideHasGridZone(m, side)) return false // 已在场（flag 脱同步防御）
      const rec = sideHideRecord[side]
      // ① 结构快照拼回
      if (rec && Array.isArray(rec.cols) && rec.cols.length > 0) {
        try {
          const modelTabIds = new Set<string>()
          m.visitNodes((n) => {
            if (n instanceof TabNode) modelTabIds.add(n.getId())
          })
          const cols = rec.cols
          const snapIds = collectTabIds(cols)
          // 快照页签与现模型的撞 id 防御（正常隐藏期不可能重建同 id——
          // 无分栏可投放；防外部篡改）
          for (const id of modelTabIds) snapIds.delete(id)
          const pruned = pruneSideCols(cols, snapIds)
          if (pruned.length > 0) {
            const json = m.toJson() as { layout: { children?: unknown[] } }
            const rootKids = Array.isArray(json.layout.children) ? json.layout.children : []
            // 拼回外缘：左=最左（轨贴外缘时插在轨后）、右=最右（轨前）
            if (side === 'left') {
              let at = 0
              while (at < rootKids.length && jsonZoneOf(rootKids[at])?.track) at++
              rootKids.splice(at, 0, ...pruned)
            } else {
              let end = rootKids.length
              while (end > 0 && jsonZoneOf(rootKids[end - 1])?.track) end--
              rootKids.splice(end, 0, ...pruned)
            }
            // 孤儿页签回填（隐藏时不在该侧列里的：拖去别栏/轨里的）
            const restoredIds = collectTabIds(pruned)
            const orphans = (rec.panes ?? []).filter((id) => !restoredIds.has(id) && !modelTabIds.has(id))
            if (orphans.length > 0) {
              const host = lastTabsetOf(pruned[pruned.length - 1])
              for (const id of orphans) {
                if (host) host.children = [...(host.children ?? []), paneTabJson(id)]
              }
            }
            const next = configure(Model.fromJson(json as import('flexlayout-react').IJsonModel))
            syncTabsetConstraints(next)
            adoptModel(next)
            delete sideHideRecord[side]
            writeSideHide(sideHideRecord)
            pinAfterLayout()
            return true
          }
        } catch (e) {
          // 快照 JSON 不可信 → 清掉走重建回退（铁律 12：错误可见）
          console.error('[flex-layout] side show from snapshot failed, falling back to rebuild', e)
          sideHideRecord[side] = undefined
          writeSideHide(sideHideRecord)
        }
      }
      // ② 回退：按记录 id（缺则一级窗格）在大栏边缘重建分栏堆叠回填
      // 记录 id 含已拖去别栏仍活着的孤儿——与在场的撞 id 会让 addNode 造出
      // 同 id 双节点（getNodeById 语义损坏），统一过滤；过滤后为空=错误可见
      const alive = (() => {
        const present = new Set<string>()
        m.visitNodes((n) => {
          if (n instanceof TabNode) present.add(n.getId())
        })
        return present
      })()
      const ids = (rec?.panes && rec.panes.length > 0 ? rec.panes : [PRIMARY_PANE[side]]).filter(
        (id) => !alive.has(id),
      )
      if (ids.length === 0) {
        console.error('[flex-layout] showSide 回退：记录页签全部在场——快照与模型脱同步', side)
        return false
      }
      const root = m.getRootRow()
      const kids = (root?.getChildren() ?? []).filter(
        (k) => !(k instanceof TabSetNode && zoneConfigOf(k)?.track),
      )
      if (kids.length === 0) return false
      const anchor = (side === 'left' ? kids[0] : kids[kids.length - 1]) as TabSetNode | RowNode
      const leadId = ids[0]
      m.doAction(
        Actions.addNode(paneTabJson(leadId), anchor.getId(), side === 'left' ? DockLocation.LEFT : DockLocation.RIGHT, 0),
      )
      const newSet = m.getNodeById(leadId)?.getParent()
      if (newSet instanceof TabSetNode) {
        // 重建分栏直接按记忆宽写权重（不依赖延迟计算——否则 flexbox 默认
        // 权重会被 max 钳住、measureRootPx 又把钳制值记回记忆）
        const lim = REGION_LIMITS[side]
        const memW = Math.min(Math.max(rootPxMem[side], lim.minW), lim.maxW ?? 99999)
        const availNow = Math.max(rootAvailPx() - SPLITTER_PX * kids.length, 1)
        m.doAction(
          Actions.updateNodeAttributes(newSet.getId(), {
            config: { region: side, rail: false },
            weight: (memW / availNow) * 100,
          }),
        )
        for (const id of ids.slice(1)) {
          if (!m.getNodeById(id)) {
            m.doAction(Actions.addNode(paneTabJson(id), newSet.getId(), DockLocation.CENTER, newSet.getChildren().length))
          }
        }
      }
      delete sideHideRecord[side]
      writeSideHide(sideHideRecord)
      pinAfterLayout()
      return true
    },
    [adoptModel, pinAfterLayout],
  )

  // 窄屏抽屉的 border 展开（foldSide 的逆操作）：页签从 border 收编回
  // 同 region 分栏；无分栏 → 大栏边缘重建 + pinAfterLayout 收尾。
  const expandSide = useCallback(
    (side: 'left' | 'right'): boolean => {
      const m = modelRef.current
      const borderId = side === 'left' ? 'border_left' : 'border_right'
      const border = m.getNodeById(borderId)
      if (!(border instanceof BorderNode)) return false
      const tabs = border.getChildren().filter((c): c is TabNode => c instanceof TabNode)
      if (tabs.length === 0) return false
      // 目标分栏：同 region 的现有分栏；无 → 大栏边缘重建（region 显式补上）
      let target: TabSetNode | undefined
      m.visitNodes((n) => {
        if (target || !(n instanceof TabSetNode) || n.getChildren().length === 0) return
        if (zoneConfigOf(n)?.region === side) target = n
      })
      let rebuilt = false
      const lead = tabs[0]
      if (target) {
        m.doAction(Actions.moveNode(lead.getId(), target.getId(), DockLocation.CENTER, target.getChildren().length))
      } else {
        rebuilt = true
        const root = m.getRootRow()
        // 重建锚点候选排除竖轨（轨贴大栏外缘，不参与锚点）
        const kids = (root?.getChildren() ?? []).filter(
          (k) => !(k instanceof TabSetNode && zoneConfigOf(k)?.track),
        )
        if (kids.length === 0) return false
        // 重建锚点：左栏贴最左、右栏贴最右（两侧同收再展开时右栏被插到
        // 左栏旁边 = "栏的位置自己变"，2026-09-26 窄视口往返实测抓到）
        const anchor = (side === 'left' ? kids[0] : kids[kids.length - 1]) as TabSetNode | RowNode
        m.doAction(
          Actions.moveNode(
            lead.getId(),
            anchor.getId(),
            side === 'left' ? DockLocation.LEFT : DockLocation.RIGHT,
            0,
          ),
        )
        const newSet = lead.getParent()
        if (newSet instanceof TabSetNode) {
          // 重建分栏直接按记忆宽写权重（不依赖延迟计算——否则 flexbox
          // 默认权重会被 max 钳住、measureRootPx 又把钳制值记回记忆）
          const lim = REGION_LIMITS[side]
          const memW = Math.min(Math.max(rootPxMem[side], lim.minW), lim.maxW ?? 99999)
          const availNow = Math.max(rootAvailPx() - SPLITTER_PX * kids.length, 1)
          m.doAction(
            Actions.updateNodeAttributes(newSet.getId(), {
              config: { region: side, rail: false },
              weight: (memW / availNow) * 100,
            }),
          )
        }
      }
      for (const t of tabs.slice(1)) {
        const host = lead.getParent()
        if (host instanceof TabSetNode) {
          m.doAction(Actions.moveNode(t.getId(), host.getId(), DockLocation.CENTER, host.getChildren().length))
        }
      }
      if (rebuilt) pinAfterLayout()
      return rebuilt
    },
    [pinAfterLayout],
  )

  const toggleSide = useCallback(
    (side: 'left' | 'right') => {
      const st = useLayoutStore.getState()
      if (st.narrowViewport) {
        // 窄屏抽屉模式：页签已在 border 轨（模型不动），只记录展开/收起
        // 意图——hermes 语义：collapsible 窗格窄屏留在 overlay 轨道，宽屏
        // 才收编
        setSideCollapsed(side, !st.sideCollapsed[side])
        return
      }
      // 展开/隐藏判定以**实际模型状态**为准（该侧在网格里还有没有分栏），
      // 不信持久化标志——全重置/应用预设后标志与实际脱同步时，第一次
      // 点击会被空轨 expand 的 no-op 吃掉（hermes resetLayoutTree 注释的
      // "flipping the next ⌘B into a SHOW"同款问题）
      const hidden = !sideHasGridZone(modelRef.current, side)
      migratingRef.current = true
      try {
        if (hidden) {
          showSide(side)
          setSideCollapsed(side, false)
        } else {
          hideSide(side)
          setSideCollapsed(side, true)
          // 隐藏后剩余列按记忆 px 重钉（等首帧布局后量测就绪）——主栏
          // 吸收腾出的宽度，剩余侧栏不动（hermes 声明轨语义）
          pinAfterLayout()
        }
      } finally {
        migratingRef.current = false
      }
      persist(modelRef.current)
      bumpLayoutRev()
    },
    [hideSide, showSide, pinAfterLayout, persist],
  )

  // 竖轨 ⇄ 横向 双形态切换（v3 定稿）：竖轨 = 该栏外缘一条 **20px 空轨**
  // （原生 tabset，真占位、零重叠），工厂对它渲染整栏页签导航（RailNav）；
  // 该栏各分栏保持原样（不合并、不挪页签），横向条由 sync 统一隐藏、
  // 内容向上充满。
  // 横向→竖轨：建轨。竖轨→横向：**拆轨**——不用快照（快照会把折叠期间
  // 关掉的页签原样带回来=「关闭的标签又加回来了」，且残骸布局下还原前后
  // 看不出变化=「没反应」）；拆轨 = 翻 enableDeleteWhenEmpty 后加假页签
  // 再删，tidy 收走空轨，分栏横向条由 sync 自动恢复。
  const toggleRegionForm = useCallback(
    (region: Region) => {
      const track = findRailTabset(model, region)
      if (track) {
        model.doAction(
          Actions.updateNodeAttributes(track.getId(), { enableDeleteWhenEmpty: true, enableClose: true }),
        )
        const spacerId = `${region}-unfold-spacer`
        model.doAction(
          Actions.addNode(
            { type: 'tab' as const, id: spacerId, component: 'external', name: '', enableClose: true },
            track.getId(),
            DockLocation.CENTER,
            0,
          ),
        )
        model.doAction(Actions.deleteTab(spacerId))
      } else {
        // 轨锚点：左栏=根行最左（LEFT）、右栏=根行最右（RIGHT）、
        // 主栏=主栏第一个分栏左缘（"主栏在左栏的左边"）
        let anchor: TabSetNode | RowNode | undefined
        if (region === 'main') {
          model.visitNodes((n) => {
            if (anchor || !(n instanceof TabSetNode) || n.getChildren().length === 0) return
            if (zoneConfigOf(n)?.region === 'main') anchor = n
          })
        } else {
          const root = model.getRootRow()
          const kids = root?.getChildren() ?? []
          if (kids.length === 0) return
          anchor = (region === 'left' ? kids[0] : kids[kids.length - 1]) as TabSetNode | RowNode
        }
        if (!anchor) return
        // flexlayout 没有建空 tabset 的动作——假页签建轨即删
        // （enableDeleteWhenEmpty:false 保轨不 tidy）
        const spacerId = `${region}-track-spacer`
        model.doAction(
          Actions.addNode(
            { type: 'tab' as const, id: spacerId, component: 'external', name: '', enableClose: true },
            anchor.getId(),
            region === 'right' ? DockLocation.RIGHT : DockLocation.LEFT,
            0,
          ),
        )
        const set = model.getNodeById(spacerId)?.getParent()
        if (!(set instanceof TabSetNode)) return
        model.doAction(
          Actions.updateNodeAttributes(set.getId(), {
            config: { region, rail: true, track: true },
            enableTabStrip: false,
            minWidth: TRACK_W,
            maxWidth: TRACK_W,
            enableDeleteWhenEmpty: false,
          }),
        )
        model.doAction(Actions.deleteTab(spacerId))
      }
      syncTabsetConstraints(model)
      applyRootWeights(model)
      persist(model)
      bumpLayoutRev()
    },
    [model, persist],
  )

  // 「+」新建窗格（docs/layout-design.md §6）：横向形态 → 堆叠页签进
  // 该分栏；竖轨形态 → **并列新分栏**（"竖标签下，点击加的是直接多加
  // 一栏"）——左/主栏向右分、右栏向左分（竖轨贴外缘不动）。region 继承
  // 由 sync 兜底（新分栏落进竖轨栏自动同样无横向条）。
  const createPane = useCallback(
    (tabset: TabSetNode, type: PaneType) => {
      const id = nextInstanceId(model, type)
      model.doAction(Actions.addNode(paneTabJson(id), tabset.getId(), DockLocation.CENTER, tabset.getChildren().length))
      model.doAction(Actions.selectTab(id))
      syncTabsetConstraints(model)
      persist(model)
      bumpLayoutRev()
    },
    [model, persist],
  )

  const createPaneInRegion = useCallback(
    (region: Region, type: PaneType) => {
      // 竖轨态「+」= 与横向同语义：**堆叠进该栏的分栏**（用户 2026-09-26
      // 二次定稿，覆盖早前"直接多加一栏"——"多个会话应该收进主栏的标签
      // 组中，可以拖出"）：轨内出现多行同类型标签，点行切换内容；要并列
      // 分栏就把它拖出去。宿主分栏 = 一级窗格所在栏，无则第一个分栏。
      const zones: TabSetNode[] = []
      model.visitNodes((n) => {
        if (!(n instanceof TabSetNode) || n.getChildren().length === 0) return
        const cfg = zoneConfigOf(n)
        if (cfg?.region === region && !cfg.track) zones.push(n)
      })
      if (zones.length === 0) return
      const primaryType = PRIMARY_PANE[region]
      const host =
        zones.find((z) => z.getChildren().some((c) => c instanceof TabNode && paneTypeOf(c.getId()) === primaryType)) ??
        zones[0]
      const id = nextInstanceId(model, type)
      model.doAction(Actions.addNode(paneTabJson(id), host.getId(), DockLocation.CENTER, host.getChildren().length))
      model.doAction(Actions.selectTab(id))
      syncTabsetConstraints(model)
      persist(model)
      bumpLayoutRev()
    },
    [model, persist],
  )

  // zone 头部按钮（onRenderTabSet）：+ 只渲染在**一级栏**（宿含本大栏的
  // 一级窗格——"分出的其他栏没有 + 号"），且本大栏有可开类型；每个 zone
  // 都有 [切竖轨] 钮（切换整栏形态）。
  // 会话分栏额外注入 **leading（logo+MIRACH 文字）**（用户定稿：logo 50、
  // 文字 30/black/#006fff/字距 2，位于条顶；页签行沉底）——替代宿主层
  // RailLogo 浮层（logo 成为 flexlayout 渲染树的真实子节点）。
  const onRenderTabSet = useCallback(
    (node: TabSetNode | BorderNode, renderValues: import('flexlayout-react').ITabSetRenderValues) => {
      if (!(node instanceof TabSetNode)) return
      const cfg = zoneConfigOf(node)
      if (!cfg) return
      // 会话分栏（左栏一级栏）：logo/文字注入 leading
      if (node.getChildren().some((c) => c.getId() === 'sessions')) {
        renderValues.leading = <RailLogoLeading />
      }
      const isPrimaryZone = node.getChildren().some(
        (c) => c instanceof TabNode && paneTypeOf(c.getId()) === PRIMARY_PANE[cfg.region],
      )
      const openable = openableTypesForRegion(model, cfg.region)
      // 主对话栏标记（用户 2026-10-03：**只有主对话栏**的页签从中线往右排
      // ——双行块占左半；左/右栏靠左）。flexlayout 无 classNameTabset 属性
      // （updateNodeAttributes 非法属性被忽略）——渲染层 leading 塞标记，
      // CSS :has 从 tabset 上探命中 stretch。
      if (cfg.region === 'main') {
        renderValues.leading = (
          <>
            {renderValues.leading}
            <span data-chat-lead aria-hidden className="hidden" />
          </>
        )
      }
      renderValues.buttons.push(
        <PaneAddButton key="add" items={isPrimaryZone ? openable : []} onCreate={(t) => createPane(node, t)} />,
      )
      renderValues.buttons.push(
        <button
          key="form"
          className="fl-min-btn"
          title="切换为竖轨"
          onClick={(e) => {
            e.stopPropagation()
            toggleRegionForm(cfg.region)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          type="button"
        >
          <ChevronDownIcon />
        </button>,
      )
    },
    [model, toggleRegionForm, createPane],
  )

  // 镜像翻转（hermes ⌘\ mirrorLayoutTree → mirrorTreeHorizontal）：
  // 水平行 children 反转，垂直行不动
  const mirror = useCallback(() => {
    applyJson(mirrorLayoutJson(model.toJson()), null)
  }, [applyJson, model])

  // 窄屏（hermes $narrowViewport）：两侧栏撤出网格 → 左右边框 overlay 抽屉；
  // 恢复宽屏 → 收编回同 region 分栏。整侧收起状态优先（窄屏不自动展开）。
  const narrow = useLayoutStore(s => s.narrowViewport)
  // 两个门控（2026-09-26 复审补）：①borderType 写前先比对——无差别 doAction
  // 会让 onModelChange 把刚应用的预设标记立刻清掉（applyJson → setModel →
  // 本 effect 重跑 → setActivePreset(null)）；②applyRootWeights 只在确实
  // **重建**了分栏时跑——否则会用旧记忆覆盖刚应用的预设权重。
  useEffect(() => {
    const borderOf = (m: Model, side: 'left' | 'right') =>
      m.getNodeById(side === 'left' ? 'border_left' : 'border_right')
    if (narrow) {
      migratingRef.current = true
      try {
        foldSide('left')
        foldSide('right')
        // expandSide 可能 adoptModel（快照拼回）——边框形态翻转必须落在
        // **当前**模型上，旧闭包 model 已失效
        const m = modelRef.current
        for (const side of ['left', 'right'] as const) {
          const b = borderOf(m, side)
          if (b instanceof BorderNode && !b.isOverlay()) {
            m.doAction(Actions.updateNodeAttributes(b.getId(), { borderType: 'overlay' }))
          }
        }
      } finally {
        migratingRef.current = false
      }
    } else {
      const sides = useLayoutStore.getState().sideCollapsed
      migratingRef.current = true
      try {
        if (!sides.left) expandSide('left')
        if (!sides.right) expandSide('right')
        // 同上：expandSide（快照拼回 adoptModel / moveNode）之后以
        // modelRef.current 为准；重建分栏的配重收尾由 expandSide 的
        // pinAfterLayout 自带（首帧布局后按记忆宽重排 + 富余兜底）
        const m = modelRef.current
        for (const side of ['left', 'right'] as const) {
          const b = borderOf(m, side)
          if (b instanceof BorderNode && b.isOverlay()) {
            m.doAction(Actions.updateNodeAttributes(b.getId(), { borderType: 'split' }))
          }
        }
      } finally {
        migratingRef.current = false
      }
    }
    persist(modelRef.current)
    bumpLayoutRev()
  }, [narrow, model, persist])

  // 窗口 resize 自愈：min 缩让（sync，防 Σmin > 可用宽把末栏挤出窗口）
  // + 富余兜底（absorb，防钳制态留白）。flexlayout 权重是相对值、resize
  // 按比例放大，但 min 钳制态（全最小）下比例失效，必须重跑这两步——
  // 统一走串行重排通道（防抖由其 clearTimeout 链承担）
  useEffect(() => {
    const onResize = () => scheduleRebalance(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 双击分隔条 → 所属 split 回默认权重（hermes resetBoundary）。**不能用
  // onDoubleClick**：flexlayout 的 splitter 在 pointerdown 里 preventDefault，
  // 浏览器不合成后续 click/dblclick（2026-09-26 复审实测：dblclick 从未到
  // 达宿主）——改在 host 捕获段检测指针双击，第二击 stopPropagation 拦掉
  // flexlayout 起拖并执行重置。
  const resetSplitToDefault = useCallback(
    (splitter: HTMLElement) => {
      const r = splitter.getBoundingClientRect()
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      // 拥有这条缝的 split = 恰好 ≥2 个子节点、矩形含缝心、且没有任何子
      // 矩形含缝心的最深 row
      let best: RowNode | undefined
      model.visitNodes((node) => {
        if (!(node instanceof RowNode) || node.getChildren().length < 2) return
        const rect = node.getRect()
        if (cx < rect.x || cx > rect.x + rect.width || cy < rect.y || cy > rect.y + rect.height) return
        // 子矩形判定要**向内缩 3px**：flexlayout 的相邻子项矩形互相重叠
        // 1-2px（子项矩形把分隔条空间包在里面），缝心永远同时严格落在
        // 相邻两个子矩形内部 → insideChild 恒 true → best 永远找不到
        // （2026-09-26 复审实测，此功能此前从未生效）
        const INS = 3
        const insideChild = node.getChildren().some((c) => {
          const cr = c.getRect()
          return (
            cx > cr.x + INS && cx < cr.x + cr.width - INS && cy > cr.y + INS && cy < cr.y + cr.height - INS
          )
        })
        if (!insideChild && (!best || rect.width * rect.height < best.getRect().width * best.getRect().height)) {
          best = node
        }
      })
      if (!best) return
      const applied = useLayoutStore.getState().appliedTree as { layout?: { children?: unknown[] } } | null
      // 在已应用预设树里按 split id 找该行的**子项权重数组**（hermes
      // resetBoundary：恢复原始权重；用户新开的分叉没有 id → 均分）。
      const findSplit = (node: { id?: string; children?: { id?: string; weight?: number; children?: unknown[] }[] }): number[] | null => {
        if (node.id === best!.getId()) {
          const kids = (node.children ?? []) as { weight?: number }[]
          return kids.map((c) => c.weight ?? 0)
        }
        for (const c of node.children ?? []) {
          if (typeof c === 'object' && c !== null && 'children' in (c as object)) {
            const r2 = findSplit(c as { id?: string; children?: { id?: string; weight?: number; children?: unknown[] }[] })
            if (r2 !== null) return r2
          }
        }
        return null
      }
      const presetWeights = applied ? findSplit((applied.layout ?? {}) as never) : null
      const kids = best.getChildren()
      const restore = (fn: (i: number) => number) => {
        kids.forEach((k, i) => {
          const w = fn(i)
          if (Number.isFinite(w) && w > 0) {
            model.doAction(Actions.updateNodeAttributes(k.getId(), { weight: w }))
          }
        })
      }
      if (presetWeights && presetWeights.length === kids.length) {
        const sum = presetWeights.reduce((s, w) => s + w, 0)
        if (sum > 0) {
          restore((i) => (presetWeights[i] / sum) * 100)
          return
        }
      }
      restore(() => 100 / kids.length)
    },
    [model],
  )

  // 双击检测挂 **document 原生捕获**：flexlayout 起拖会把指针捕获到 host
  // 之外的元素，第二次 pointerdown 被捕获重定向、不经过宿主 React 捕获段
  // （2026-09-26 实测：宿主只能收到一击）——只有 document 级捕获必然在
  // 派发路径上。检测到双击 → stopPropagation 拦掉 flexlayout 起拖 → 重置。
  // **必须是"两次点击"状态机而非"两次按下"**：按下→拖动→松手是拖拽，其
  // 后的再次按下是新拖拽的起点——否则快速连续拖动全被误判成双击吞掉
  // （2026-09-26 用户实测："所有宽度拉动全部失效"）。
  useEffect(() => {
    let lastClick: { t: number; x: number; y: number } | null = null
    let down: { t: number; x: number; y: number } | null = null
    let moved = false
    const splitterOf = (e: { target: EventTarget | null }) =>
      (e.target as HTMLElement)?.closest?.('.flexlayout__splitter') as HTMLElement | null
    const onDocPointerDown = (e: PointerEvent) => {
      markPointerActivity()
      if (e.button !== 0) return
      const splitterHit = splitterOf(e)
      if (!splitterHit) {
        lastClick = null
        down = null
        return
      }
      splitterDraggingRef.current = true
      const now = performance.now()
      if (lastClick && now - lastClick.t < 450 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 10) {
        // 真双击：上一击是"未拖动的点击"，且本次按下紧随其后
        lastClick = null
        down = null
        e.stopPropagation()
        resetSplitToDefault(splitterHit)
        return
      }
      down = { t: now, x: e.clientX, y: e.clientY }
      moved = false
    }
    const onDocPointerMove = (e: PointerEvent) => {
      markPointerActivity()
      if (!down) return
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) moved = true
    }
    const onDocPointerUp = (e: PointerEvent) => {
      if (down || splitterDraggingRef.current) {
        // 拖拽结束（无论是否组成双击）：清"待双击"状态，允许挂起的重排执行
        splitterDraggingRef.current = false
        if (!down) return
        const now = performance.now()
        if (!moved && now - down.t < 400) {
          // 一次"点击"（未拖动的按下）→ 记录，可能与下一次按下组成双击
          lastClick = { t: now, x: e.clientX, y: e.clientY }
        } else {
          // 拖拽结束：不算点击，下一次按下是全新拖拽
          lastClick = null
        }
        down = null
      }
    }
  // 系统打断（触摸取消/手势接管/窗口切换等，P2-4）：只监听 down/move/up
  // 时 pointercancel 后 splitterDraggingRef 永真，串行重排通道被自续
  // 定时器饿死（scheduleRebalance 的 while 拖拽守卫死循环）——参照
  // drag-session.ts 的 onCancel 模式：全部丢弃、不提交，放行挂起的重排。
  // 另外 pointerup 可能因捕获/驱动异常整体缺失（CDP 合成 button:none 的
  // 释放只出 mouseup 不出 pointerup，实测）——deferred 分支带指针活动
  // 超时逃逸阀（见 scheduleRebalance），拖拽标志绝不永久卡死通道。
  const onDocPointerCancel = () => {
    if (down || lastClick || splitterDraggingRef.current) {
      lastClick = null
      down = null
      moved = false
      splitterDraggingRef.current = false
      scheduleRebalance(false)
    }
  }
  const markPointerActivity = () => {
    lastPointerActivityRef.current = performance.now()
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('pointermove', onDocPointerMove, true)
  document.addEventListener('pointerup', onDocPointerUp, true)
  document.addEventListener('pointercancel', onDocPointerCancel, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('pointermove', onDocPointerMove, true)
      document.removeEventListener('pointerup', onDocPointerUp, true)
      document.removeEventListener('pointercancel', onDocPointerCancel, true)
    }
  }, [model, resetSplitToDefault, scheduleRebalance])

  // 离家一级窗格的"回家"钮（onRenderTab 注入）：拉伸头栏（单页签分栏）
  // **不渲染**原生 trailing 关闭钮（实测 hasTrailing=false）
  // 对它无效——只对拉伸头栏注入自定义钮；多页签条走原生 trailing
  // 点击 = 回家（非关闭）。
  const sendHomeFromUi = useCallback(
    (paneId: string) => {
      const tab = model.getNodeById(paneId)
      if (!(tab instanceof TabNode)) return
      const ptype = paneTypeOf(paneId)
      const pdef = ptype ? PANE_TYPES[ptype] : undefined
      if (!pdef?.primary) return
      const cfg = zoneConfigOf(tab.getParent())
      if (cfg && cfg.region === pdef.region) return // 已在家
      migratingRef.current = true
      try {
        sendPaneHome(model, paneId)
        syncTabsetConstraints(model)
        applyRootWeights(model)
      } finally {
        migratingRef.current = false
      }
      persist(model)
      bumpLayoutRev()
    },
    [model, persist],
  )

  const onRenderTab = useCallback(
    (node: TabNode, renderValues: import('flexlayout-react').ITabRenderValues) => {
      const set = node.getParent()
      if (!(set instanceof TabSetNode)) return
      // 横向多页签条：非首个页签的前缘加 5px 圆点分隔（用户 2026-09-27，
      // 骑在两签交界、垂直对文字中线）；折叠轨道（BorderNode）不在此列
      const tabs = set.getChildren().filter((c): c is TabNode => c instanceof TabNode)
      if (tabs.length > 1 && tabs.indexOf(node) > 0) {
        renderValues.leading = <span aria-hidden className="fl-tab-sep" />
      }
      // 对话标签双行块：**宿主层叠片 ChatLabelOverlay**（二十轮定稿——
      // stretch 头栏上方有 tabset_header 25px，leading 内够不到与左栏
      // MIRACH 顶对齐的位置；见 chrome-overlays.tsx 注释）。原 tab 名
      // content 保持显示。
      const ptype0 = paneTypeOf(node.getId())
      const pdef0 = ptype0 ? PANE_TYPES[ptype0] : undefined
      const stretched0 = set.getChildren().length === 1 && set.isEnableSingleTabStretch()
      // 拉伸头栏（单页签分栏）**不渲染原生 trailing 关闭钮**（flexlayout 缺
      // 口，实测 hasTrailing=false）——可关页签在这里注入 ✕（真关闭）；
      // 多页签条走原生 trailing（显隐统一 hover）
      const stretched = stretched0
      if (!stretched) return
      const ptype = ptype0
      const pdef = pdef0
      const cfg = zoneConfigOf(set)
      if (pdef?.primary) {
        // 一级窗格：离家 → 回家钮（点击回到家乡大栏）；在家 → 不渲染（不可关）
        if (!cfg || cfg.region === pdef.region) return
        const regionName: Record<Region, string> = { left: '左栏', main: '主栏', right: '右栏' }
        renderValues.buttons.push(
          <button
            key="home"
            className="fl-close-btn fl-home-btn"
            title={`回到${regionName[pdef.region]}`}
            onClick={(e) => {
              e.stopPropagation()
              sendHomeFromUi(node.getId())
            }}
            onPointerDown={(e) => e.stopPropagation()}
            type="button"
          >
            <CloseIcon />
          </button>,
        )
        return
      }
      if (node.isEnableClose()) {
        renderValues.buttons.push(
          <button
            key="close"
            className="fl-close-btn fl-stretch-close"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation()
              closePaneById(node.getId())
            }}
            onPointerDown={(e) => e.stopPropagation()}
            type="button"
          >
            <CloseIcon />
          </button>,
        )
      }
    },
    [model, sendHomeFromUi, closePaneById],
  )

  // ── ② Chrome 页签多选语法 + ③ pointer-capture 拖拽接管 ─────────────────────
  // flexlayout 页签按钮 id = flexlayout-tabbutton-<tabId>（tabset 与 border
  // 按钮同前缀）。捕获段跑在 flexlayout 的 onClick（selectTab）之前：
  //   Shift 点 = 范围选；⌥/Ctrl 点 = 进出选区；普通点 = 进拖拽会话
  //   （4px 阈值内松开是普通点击：原生 click 照常激活，onTap 收拢选区）。
  // pointerdown preventDefault 压掉 flexlayout 的原生 HTML5 页签拖拽
  // （Chromium：pointerdown 默认被取消 → 不派发 mousedown → 不起拖拽），
  // 修饰键编辑后吞掉合成 click，激活不会误发。
  const TAB_BUTTON_ID = 'flexlayout-tabbutton-'

  const onHostPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      // 双击分隔条的检测不在本 handler（见上方 document 捕获段的说明：
      // 第二击被指针捕获重定向，宿主 React 捕获段收不到）。
      // 关闭按钮/回家钮/改名输入框/工具栏：原生行为优先。fl-close-btn 是
      // 统一族（fl-home-btn 回家钮 / fl-stretch-close 拉伸头栏注入 ✕ 都是
      // 它的子集）——拉伸头栏的关闭钮此前不在白名单，被拖拽接管
      // preventDefault 吞掉 click 成了死钮（2026-10-01 审查 P1-1）。
      if (target.closest('.flexlayout__tab_button_trailing, .flexlayout__border_button_trailing, .fl-close-btn, .tab-overflow-btn, input, textarea')) return
      const btn = target.closest(`[id^="${TAB_BUTTON_ID}"]`) as HTMLElement | null
      if (!btn) return
      const tabId = btn.id.slice(TAB_BUTTON_ID.length)
      const tab = model.getNodeById(tabId)
      if (!(tab instanceof TabNode)) return

      // groupId/条带序：住在 tabset → {groupId, 条带序}；折叠在 border →
      // groupId 用 border id（无 reorder 上下文，起手就是 zone 模式）
      const parent = tab.getParent()
      const inTabset = parent instanceof TabSetNode
      const groupId = parent?.getId()
      if (!groupId) return
      const ordered = (parent?.getChildren() ?? [])
        .filter((c): c is TabNode => c instanceof TabNode)
        .map((c) => c.getId())
      const activeId = parent instanceof TabSetNode ? parent.getSelectedNode()?.getId() : parent instanceof BorderNode ? parent.getSelectedNode()?.getId() : undefined

      // Chrome 的语法在 activate/drag 之前：这两类按"点即选区编辑"，既不
      // 激活也不起拖（hermes tree-group onPointerDown 同序）
      const grammarEdit = (edit: () => void) => {
        e.preventDefault()
        e.stopPropagation()
        edit()
        // 吞掉松手后的合成 click——flexlayout 的按钮 onClick 会 selectTab。
        // click 在 pointerup 之后的任务里才来，不能立刻拆除（一次即可，
        // 宽限定时器兜底"永远没松手"的泄漏）。
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault()
          ev.stopPropagation()
        }
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 1500)
      }

      if (e.shiftKey) {
        grammarEdit(() => selectTabRange(groupId, ordered, tabId, activeId ?? tabId))
        return
      }
      if (isToggleSelectClick(e)) {
        grammarEdit(() => toggleTabSelected(groupId, tabId, activeId ?? tabId))
        return
      }

      // 拖着已选中的页签 = 整组一起走（拖未选中的 = 单页签拖）
      const dragSelection = selectionFor(groupId, ordered, tabId)
      startPaneDrag(model, tabId, e, {
        onTap: () => clearTabSelection(),
        reorder: inTabset ? { groupId } : undefined,
        ghostLabel: dragSelection ? `${dragSelection.length} 个页签` : tab.getName(),
        selection: dragSelection ?? undefined,
      })
    },
    [model],
  )

  // 选区高亮：给选中页签的按钮元素挂 class（hermes PaneTab 的 selected 视觉）。
  // 依赖 $layoutRev——flexlayout 重渲按钮会重建 class，模型每次变更后再刷。
const selection = useTabSelection()
const layoutRev = useLayoutStore(s => s.layoutRev)
  useEffect(() => {
    const ids = selection?.ids
    for (const el of document.querySelectorAll('.flexlayout__tab_button, .flexlayout__border_button')) {
      const id = el.id.startsWith(TAB_BUTTON_ID) ? el.id.slice(TAB_BUTTON_ID.length) : ''
      el.classList.toggle('fl-tab-selected', ids?.has(id) ?? false)
    }
  }, [selection, layoutRev, model])

  // 页签条本体的原生拖拽关闭（用户：条拖出来和标题栏打架，只要里面的
  // 标签能拖）：tabstrip 容器 draggable=true，空白处按住拖 = 整栏拖出/
  // 浮动。捕获段拦 dragstart——目标不在页签按钮内（含拉伸头栏）一律
  // 取消；页签按钮的拖拽由 pointer 引擎接管（pointerdown preventDefault
  // 后原生 dragstart 本就不会发起），不受影响。
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest('.flexlayout-host')) return
      if (t.closest('.flexlayout__tab_button, .flexlayout__border_button, .flexlayout__tab_button_stretch')) return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('dragstart', onDragStart, true)
    return () => document.removeEventListener('dragstart', onDragStart, true)
  }, [])

  // 工厂：component name → React 组件（tabName 注入占位标题——多实例
  // 窗格内容相同，靠名字区分"切没切"）；external = OS 拖入的文件占位。
  // 竖轨形态的分栏（横向条已隐藏）同样直接渲染内容——竖轨本身是栏外缘
  // 的空轨 tabset，其导航由 onTabSetPlaceHolder 渲染（RailNav）。
  // **竖轨形态的 logo**：logo 是 sessions 窗格的附属物（§6），平时住在
  // 会话分栏横向条的 leading 里；竖轨形态横向条被 sync 隐藏 → 工厂在
  // 内容顶部补同一条 logo 带（横向形态条内 leading 仍在，不会双 logo）。
  // Layout API 引用（双击内联改名等 ILayoutApi 通道；ref 对象跨渲染稳定）。
  const layoutRef = useRef<ILayoutApi>(null)

  const factory = useCallback(
    (node: TabNode) => {
      const componentName = node.getComponent() ?? ''
      const Comp = COMPONENTS[componentName]
      let content: React.ReactNode
      if (Comp) content = <Comp tabName={node.getName()} />
      else if (componentName === 'preview') {
        content = <HermesPreviewPane node={node} />
      }
      else if (componentName === 'external') {
        const cfg = node.getConfig() as { fileName?: string } | undefined
        content = (
          <div className="pane-placeholder">
            <h2>{cfg?.fileName ?? node.getName()}</h2>
            <p>外部内容占位（OS 拖入）——预览渲染待接。</p>
          </div>
        )
      } else {
        content = <div className="pane-placeholder"><p>未知窗格: {componentName}</p></div>
      }
      const parent = node.getParent()
      const surface =
        parent instanceof TabSetNode &&
        !parent.isEnableTabStrip() &&
        parent.getChildren().some((c) => c.getId() === 'sessions')
          ? (
              <div className="rail-pane-railform">
                <RailLogoLeading />
                <div className="rail-pane-railform-body">{content}</div>
              </div>
            )
          : content
      // 普通模式 body 右键 = app 菜单（hermes 实锤：ZoneMenu 只包页签条/
      // 竖轨/编辑遮罩三处，body 在常态不包——tree-group.tsx 816 的包裹在
      // `editMode &&` 分支里）。页签条/竖轨 chrome 由 main.tsx 裁定层路由
      // （closest('.flexlayout__tabset') → openZoneContextMenuAt）。
      return surface
    },
    [],
  )

  // 空栏占位：竖轨（空轨 tabset）→ RailNav（整栏页签导航）；其余空栏
  // 走普通提示
  const onTabSetPlaceHolder = useCallback(
    (node?: TabSetNode) => {
      const cfg = node ? zoneConfigOf(node) : undefined
      if (cfg?.track) {
        return (
          <RailNav
            model={model}
            region={cfg.region}
            addItems={openableTypesForRegion(model, cfg.region)}
            onToggle={() => toggleRegionForm(cfg.region)}
            onSelect={(id) => {
              model.doAction(Actions.selectTab(id))
              persist(model)
              bumpLayoutRev()
            }}
            onClose={closePaneById}
            onCreate={(t) => createPaneInRegion(cfg.region, t)}
            onReorder={(tabId, zoneId, index) => {
              model.doAction(Actions.moveNode(tabId, zoneId, DockLocation.CENTER, index))
              persist(model)
              bumpLayoutRev()
            }}
            onDragOut={(e, id, name) => {
              startPaneDrag(model, id, e, { ghostLabel: name })
            }}
          />
        )
      }
      return (
        <div className="pane-placeholder">
          <p>空栏 — 从「+」打开窗格，或把页签拖进来。</p>
        </div>
      )
    },
    [model, toggleRegionForm, closePaneById, createPaneInRegion, persist],
  )

  // 右键菜单（hermes closeOtherTreeTabs/closeTreeTabsToRight/closeAllTreeTabs
  // 的矩阵），用 flexlayout 的 showPopupMenu 实现。
  // 菜单项按可关性过滤：一级窗格不给关闭类动作。
  const isCloseableTab = useCallback((c: Node): c is TabNode => {
    if (!(c instanceof TabNode)) return false
    const t = paneTypeOf(c.getId())
    return t ? !PANE_TYPES[t].primary : true
  }, [])

  const onTabContextMenu = useCallback(
    (node: TabNode | TabSetNode | BorderNode | TabGroupNode, event: React.MouseEvent) => {
      event.preventDefault()
      if (!(node instanceof TabNode)) return
      // 拉伸头栏（单页签 zone 的 header，flexlayout 给它 tab_button_stretch
      // 元素 + TabNode 派发）右键 = 分栏级 ZoneMenu（裁定层 store 路由）——
      // 这里只压 WebView2 菜单不弹页签弹层，两菜单不叠开（hermes strip 面
      // 同归 ZoneMenu；页签弹层留给多页签条的真实页签按钮）。
      if (event.target instanceof Element && event.target.closest('.flexlayout__tab_button_stretch')) return
      const ptype = paneTypeOf(node.getId())
      const pdef = ptype ? PANE_TYPES[ptype] : undefined
      const closeable = pdef ? !pdef.primary : true
      const tabsetId = (node.getParent() as TabSetNode)?.getId()
      const items: PopupMenuEntry[] = []
      if (closeable) items.push({ key: 'close', label: '关闭' })
      items.push({ key: 'rename', label: '重命名' })
      items.push({ key: 'pin', label: '钉住' })
      if (closeable && tabsetId) {
        const siblings = (model.getNodeById(tabsetId) as TabSetNode).getChildren().filter(isCloseableTab)
        if (siblings.length > 1) {
          items.push({ type: 'divider', key: 'd1' })
          items.push({ key: 'closeOthers', label: '关闭其他' })
          items.push({ key: 'closeRight', label: '关闭右侧' })
          items.push({ key: 'closeAll', label: '全部关闭' })
        }
      }
      showPopupMenu({
        anchor: { x: event.clientX, y: event.clientY },
        items,
        onClose: () => {},
        onSelect: (item) => {
          const id = node.getId()
          if (item.key === 'close') {
            closePaneById(id)
          } else if (item.key === 'rename') {
            layoutRef.current?.editTabName(id)
          } else if (item.key === 'pin') {
            model.doAction(Actions.setTabPinned(id, !node.isPinned()))
          } else if (tabsetId) {
            const tabset = model.getNodeById(tabsetId) as TabSetNode
            const siblings = tabset.getChildren().filter(isCloseableTab)
            const idx = siblings.findIndex((c) => c.getId() === id)
            const targets =
              item.key === 'closeOthers'
                ? siblings.filter((c) => c.getId() !== id)
                : item.key === 'closeRight'
                  ? siblings.slice(idx + 1)
                  : siblings
            for (const t of targets) closePaneById(t.getId())
          }
        },
      })
    },
    [model, closePaneById, isCloseableTab],
  )

  // 中键关闭页签（hermes 页签行为的标配；一级窗格不受影响）
  const onAuxMouseClick = useCallback(
    (node: TabNode | TabSetNode | BorderNode | TabGroupNode, event: React.MouseEvent) => {
      if (event.button !== 1 || !(node instanceof TabNode)) return
      const ptype = paneTypeOf(node.getId())
      if (ptype && PANE_TYPES[ptype].primary) return
      closePaneById(node.getId())
    },
    [closePaneById],
  )

  // OS 文件拖入布局 → 建外部内容页签（flexlayout 原生 onExternalDrag）
  const onExternalDrag = useCallback(
    (event: React.DragEvent) => {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return undefined
      return {
        json: {
          type: 'tab' as const,
          component: 'external',
          name: files[0].name,
          enableClose: true,
          config: { fileName: files[0].name, size: files[0].size },
        },
        onDrop: () => {
          persist(model)
          bumpLayoutRev()
        },
      }
    },
    [model, persist],
  )

  // 键位（hermes：⌘\ 镜像翻转；⌘⇧\ 布局编辑模式；mod = ctrl|meta）。
  // Escape 退出编辑模式/编辑器——hermes edit-mode.tsx "owns Escape-to-exit"。
  // escape-layers 分层：拖拽会话注册更高优先级（drag=50），拖拽中的 Esc
  // 只中止拖拽，不会连带退编辑模式/关编辑器（hermes escape-layers 契约）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        if (useLayoutStore.getState().zoneEditorOpen) {
          if (!isTopEscapeLayer(ESCAPE_PRIORITY.zoneEditor)) return
          closeZoneEditor()
          e.preventDefault()
          return
        }
        if (useLayoutStore.getState().editMode) {
          if (!isTopEscapeLayer(ESCAPE_PRIORITY.layoutEdit)) return
          closeEditMode()
          e.preventDefault()
          return
        }
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.key !== '\\') return
      e.preventDefault()
      if (e.shiftKey) {
        toggleEditMode()
      } else {
        mirror()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mirror])

  // 窗口拖动：window 捕获段按命中面分派（取代旧 .titlebar-drag-band 盖层）。
  // 根因：盖层截胡顶带内 pointerdown——拉伸头栏（单页签 zone）整条 100px
  // 都是页签（id 同 flexlayout-tabbutton- 前缀），带上部 60px 被盖后按下
  // 变拖窗口、拖拽会话与 zone 落点预览全不启动。语义定稿：**有页签的地方
  // 拖页签，没页签的空白拖窗口**——多页签条整钮归页签、上部空白（logo 区）
  // 归窗口；拉伸头栏只有**文字标签区**归页签，标签左右空白归窗口
  // （用户 2026-09-29：单页签时标签右边的空白不该拖页签）。
  useEffect(() => {
    if (!inTauri || !appWindow) return
    const win = appWindow
    const onWinPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as Element | null
      if (!t) return
      // 交互面/专用面归原主：按钮/输入、分隔条、溢出钮、resize 手柄、
      // 头栏工具钮、编辑面板
      if (
        t.closest(
          'button, input, textarea, select, a, .flexlayout__splitter, ' +
            '.flexlayout__tab_button_overflow, .win-resize-handle, .fl-min-btn, ' +
            '.fl-close-btn, .fl-home-btn, [class*="ep-"], [class*="ze-"]',
        )
      )
        return
      // 页签归属：多页签整钮归页签；拉伸头栏按**文字标签区**判定（±8px
      // 手感余量）——区外空白：顶带=拖窗口（双击最大化），低条=吞掉
      // （不拖页签也不拖窗；用户 2026-09-29：低条右侧空白仍拖页签=旧
      // clientY>100 早退把低条整段放行给了宿主接管）。
      const btn = t.closest('[id^="flexlayout-tabbutton-"]')
      if (btn) {
        if (!btn.className.includes('tab_button_stretch')) return
        const content = btn.querySelector('.flexlayout__tab_button_content')
        if (!content) return // 兜底：无文字盒照旧整钮归页签
        const cr = content.getBoundingClientRect()
        if (e.clientX >= cr.left - 8 && e.clientX <= cr.right + 8) return
        e.preventDefault()
        e.stopPropagation()
        if (e.clientY <= 100) {
          if (e.detail === 2) {
            void win.toggleMaximize().catch(() => {})
          } else {
            void win.startDragging().catch(() => {})
          }
        }
        return
      }
      // 非按钮面：仅顶带空白拖窗口（logo 区/条带容器/壳层）
      if (e.clientY > 100) return
      if (!t.closest('.flexlayout__tabset_tabbar_outer, .app-shell')) return
      e.preventDefault()
      e.stopPropagation()
      if (e.detail === 2) {
        void win.toggleMaximize().catch(() => {})
        return
      }
      void win.startDragging().catch(() => {})
    }
    window.addEventListener('pointerdown', onWinPointerDown, true)
    return () => window.removeEventListener('pointerdown', onWinPointerDown, true)
  }, [])

  const openPreviewTab = useCallback(
    (filePath: string, fileName: string) => {
      let existing: string | null = null
      model.visitNodes((n) => {
        if (!(n instanceof TabNode)) return
        const tn = n as TabNode
        if (tn.getComponent() === 'preview' && (tn.getConfig() as { filePath?: string } | undefined)?.filePath === filePath)
          existing = n.getId()
      })
      if (existing) {
        model.doAction(Actions.selectTab(existing))
        return
      }
      const filesNode = model.getNodeById('files')
      const tabset = filesNode?.getParent()
      if (!(tabset instanceof TabSetNode)) return
      const id = 'preview-' + Date.now()
      model.doAction(Actions.addNode({ id, component: 'preview', name: fileName, config: { filePath } }, tabset.getId(), DockLocation.CENTER, tabset.getChildren().length, true))
      model.doAction(Actions.selectTab(id))
    },
    [model],
  )
  useEffect(() => {
    setPreviewOpener((filePath, fileName) => openPreviewTab(filePath, fileName))
  }, [openPreviewTab])

  return (
    <AssistantRuntime>
      <div className="app-shell">
        <ResizeHandles />
      {/* 窗口拖动：不再用盖层拖拽带（旧 .titlebar-drag-band 截胡顶带内
          页签头 pointerdown——拉伸头栏整条 100px 都是页签，带上部被盖=
          按下变拖窗口、拖拽会话与 zone 落点预览全不启动）。改为 window
          捕获段判定（effect 见上）：有页签的地方拖页签，没页签的空白
          拖窗口。 */}
      {/* 自绘标题栏（app/shell/titlebar.tsx）：布局处理器以 props 注入 */}
      <Titlebar
        sideCollapsed={sideCollapsed}
        onToggleSide={toggleSide}
        onMirror={mirror}
        onFullReset={fullReset}
      />
      <div className="app-main flexlayout-host" onPointerDownCapture={onHostPointerDown}>
        <Layout ref={layoutRef} model={model} factory={factory} onAction={onAction} onModelChange={onModelChange} onRenderTab={onRenderTab} onRenderTabSet={onRenderTabSet} onContextMenu={onTabContextMenu} onAuxMouseClick={onAuxMouseClick} onExternalDrag={onExternalDrag} onTabSetPlaceHolder={onTabSetPlaceHolder} tabDragSpeed={0.08} icons={{ close: <CloseIcon />, more: () => <ChevronsDownIcon size={14} /> }} onShowOverflowMenu={(node, mouseEvent) => {
          // 原生溢出按钮点击（tabs 超宽被裁后出现）→ 接 ZCode SidePaneTabOverview
          // 面板（搜索 + 相对时间 + ✕）；锚点 = 点击位置。面板显示**全部**
          // 打开的标签（ZCode「打开的标签页」=全量，不只 hiddenTabs）。
          const target = mouseEvent.currentTarget as HTMLElement | undefined
          const rect = target?.getBoundingClientRect()
          setOverflowMenu({
            node,
            anchor: rect ? { x: rect.right, y: rect.bottom } : { x: mouseEvent.clientX, y: mouseEvent.clientY },
          })
        }} />
        {overflowMenu && (
          <TabOverviewMenu
            anchor={overflowMenu.anchor}
            tabset={overflowMenu.node}
            onClose={() => setOverflowMenu(null)}
          />
        )}        {/* ③ FancyZones 投放预览：拖拽中亮 zone sheet + 页签条插入符 */}
        <DropOverlay />
        {/* 装饰叠片：主区调色层（E9EEEF@40%）+ 左栏 logo 带（上 logo 下标签） */}
        <MainTint model={model} />
        <ChatLabelOverlay model={model} />
        <StripHiddenTitleOverlay model={model} />
        {/* 离家一级标签 回家钮（onRenderTab）+ logo/文字由
            onRenderTabSet 的 leading 注入会话页签条（RailLogo 浮层已退役） */}
        {/* hermes 编辑模式画布面：zone body 变拖拽把手（veil） */}
        <EditVeils
          model={model}
          onVeilPointerDown={(e, activeId, title) => {
            startPaneDrag(model, activeId, e, { ghostLabel: title })
          }}
        />
        {editMode && (
          <EditPalette
            activePresetId={activePresetId}
            userPresets={userPresets}
            currentJson={() => model.toJson()}
            onApplyTemplate={applyTemplate}
            onApplyUser={applyUser}
            onSaveCurrent={saveCurrent}
            onDeleteUser={removeUser}
            onOpenZoneEditor={openZoneEditor}
            onClose={closeEditMode}
          />
        )}
        {zoneEditorOpen && (
          <ZoneEditor
            onApply={(json) => applyJson(json, null)}
            onClose={closeZoneEditor}
          />
        )}
        </div>
        <StatusBar />
      </div>
    </AssistantRuntime>
  )
}
