import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Layout,
  Model,
  Actions,
  TabNode,
  TabSetNode,
  RowNode,
  DockLocation,
  Orientation,
  type Action,
  type ILayoutApi,
  type IJsonModel,
} from 'flexlayout-react'
import 'flexlayout-react/style/light.css'

import { Titlebar } from '@/app/shell/titlebar'
import { StatusBar } from '@/app/shell/statusbar'
import { ChatLabelOverlay, MainTint, StripHiddenTitleOverlay } from './chrome-overlays'
import { CloseIcon } from '@/components/ui/codicons'
import { ChevronsDownIcon } from 'lucide-react'
import { useStore } from 'zustand'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'
import { DropOverlay } from './drop-overlay'

import { appWindow, inTauri } from '@/lib/tauri-window'
import { ResizeHandles } from './resize-handles'
import { applyRootWeights, absorbSurplus, measureRootPx, rootPxMem } from './rebalance'
import {
  syncTabsetConstraints,
  syncSemanticStamps,
  panelsKidTopSetId,
} from './constraints-sync'
import {
  closePanelsColumnIfEmptied,
  normalizeColumns,
  setColumnOpsAdopter,
  syncOpenAnchor,
  withdrawOpenOnPanelTabArrival,
} from './column-ops'
import { startPaneDrag } from './drag-session'
import { bumpLayoutRev, bumpDragRev, useLayoutStore } from '@/store/layout-store'
import {
  PANE_TYPES,
  paneTypeOf,
  nextInstanceId,
  zoneConfigOf,
  closePane,
  type PaneType,
} from './pane-registry'
import { defaultLayout } from './layout-presets'
import { TabOverviewMenu } from './tab-overview-menu'
import {
  setSessionTabOpener,
  switchSessionThreadBridge,
} from '@/components/panes/session-manage/session-tab-bridge'
import { setPreviewOpener } from '@/components/panes/hermes-sidebar/preview-opener'

import { TerminalPane } from '@/components/panes/terminal-pane'
import { ReviewPane } from '@/components/panes/review-pane'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { SessionThreadPane } from '@/components/panes/session-thread-pane'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { HermesPreviewPane } from '@/components/panes/hermes-sidebar/hermes-preview-pane'
import { OpenPage, type OpenPageKind } from '@/components/panes/open-page'
import { LeftRailPane } from '@/components/panes/left-rail-pane'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'

// ── 窗格组件注册表（按**类型**分发；多实例共用同一组件） ─────────────────────

const COMPONENTS: Record<string, React.ComponentType<{ tabName?: string }>> = {
  leftrail: LeftRailPane,
  workspace: AssistantThreadPane,
  open: OpenPage as unknown as React.ComponentType<{ tabName?: string }>,
  files: HermesFileTreePane,
  review: ReviewPane,
  terminal: TerminalPane,
}

const ACTION_ID_KEYS = ['node', 'nodeId', 'tabNode', 'fromNode', 'toNode'] as const

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

const STORAGE_KEY = 'mirach.harness.layout.v8'

export function FlexLayoutShell() {
  // 模型配置：全局属性压回（旧存档防御）。无 SingleTabStretch——页签条恒显
  // （docs/layout-design.md v6.0 §1：主页签按钮必须可见、可被会话行拖入）。
  const configure = (m: Model) => {
    m.doAction(Actions.updateModelAttributes({ enableEdgeDock: false, borderEnableAutoHide: true }))
    return m
  }

  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) return configure(Model.fromJson(JSON.parse(saved) as IJsonModel))
    } catch (e) {
      // 不可信输入 → 默认布局；失败必须可见（规矩 12：错误就是错误）
      console.error('[flex-layout] saved layout invalid, falling back to default', e)
    }
    return configure(Model.fromJson(defaultLayout() as unknown as IJsonModel))
  })

  // 原生溢出菜单面板（ZCode SidePaneTabOverview 照抄）：tabs 超宽被裁后
  // flexlayout 原生溢出按钮出现，点击经 onShowOverflowMenu 打开本面板。
  const [overflowMenu, setOverflowMenu] = useState<{
    node: TabSetNode | import('flexlayout-react').BorderNode
    anchor: { x: number; y: number }
  } | null>(null)

  const modelRef = useRef(model)
  modelRef.current = model

  // Layout API 引用（redraw 等 ILayoutApi 通道；ref 对象跨渲染稳定）
  const layoutRef = useRef<ILayoutApi>(null)

  const persist = useCallback((m: Model) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(m.toJson()))
    } catch (e) {
      console.error('[flex-layout] persist layout failed', e)
    }
  }, [])

  const rebalanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRebalance = useCallback(() => {
    if (rebalanceTimerRef.current) clearTimeout(rebalanceTimerRef.current)
    rebalanceTimerRef.current = setTimeout(() => {
      const m = modelRef.current
      if (!m) return
      syncTabsetConstraints(m)
      applyRootWeights(m)
      absorbSurplus(m)
    }, 90)
  }, [])

  // 会话页签激活 → runtime 切线程（§8）。**挂在 onModelChange**：flexlayout
  // 的页签点击与程序化 selectTab 都会经过模型变更通知（onAction 拦不住
  // 程序化路径），且 flexlayout 对"点已选中页签"不再派发，天然免重入。
  const onModelChange = useCallback(
    (m: Model, action?: Action) => {
      if (action?.isAdjusting?.()) {
        bumpDragRev()
        return
      }
      persist(m)
      bumpLayoutRev()
      if (action?.type === Actions.SELECT_TAB) {
        // 会话页签自持静态投影（v7.3 双对话分栏）：激活页签不再切运行时
        // 线程——"切主会话"只走侧栏行点击（switchSessionThreadBridge）
        return
      }
      if (
        action?.type === Actions.DELETE_TAB ||
        action?.type === 'FlexLayout_DeleteTabset' ||
        action?.type === Actions.MOVE_NODE ||
        action?.type === 'FlexLayout_AddTab'
      ) {
        if (action?.type === Actions.DELETE_TAB || action?.type === 'FlexLayout_DeleteTabset') measureRootPx(m)
        // 关空收列（ZCode 原义：末签关闭/拖走 → 面板收起）——先于锚同步
        closePanelsColumnIfEmptied(m, action)
        // 语义戳同步（v7.0：tabset 约束跟内容走——页签进出即重算，先于
        // 配重/锚，防止旧戳喂给吸收者判定）
        syncSemanticStamps(m)
        // 实签抵达面板栏 → 撤打开页（ZCode：任一实签开出 launcher 即被
        // 页签 UI 替换；覆盖终端纵向新行等横带外落点）
        withdrawOpenOnPanelTabArrival(m, action)
        // 打开页空态锚即时生效（不等 90ms——否则"打开+文件树"会短暂并列）
        syncOpenAnchor(m)
        applyRootWeights(m)
        scheduleRebalance()
      }
    },
    [persist, scheduleRebalance],
  )

  // 模型注册（**必须最先声明**——boot 的 normalizeColumns/栏动词经
  // __flModel 通道取模型，effect 按声明序执行，晚了取不到）：
  // window.__flModel = 活动布局模型；__rootPxMem = 根行记忆 px 的活引用。
  useEffect(() => {
    const w = window as { __flModel?: Model; __rootPxMem?: typeof rootPxMem }
    w.__flModel = model
    w.__rootPxMem = rootPxMem
    return () => {
      if (w.__flModel === model) w.__flModel = undefined
    }
  }, [model])

  // column-ops 重采纳通道（hide/show 的整树恢复用——hermes applyJson 家族
  // 语义；**注册先于 boot**：boot 的旗标收敛可能触发重采纳；未注册 = 错误
  // 可见）。返回 false = 采纳失败（动词放弃旗标/快照提交，状态不脱同步）。
  useEffect(() => {
    setColumnOpsAdopter((json) => {
      try {
        const next = configure(Model.fromJson(json as unknown as IJsonModel))
        syncTabsetConstraints(next)
        // 同步配重（rootPxMem 记忆值）：首帧即最终几何——否则恢复列的权重按
        // flexlayout 归一化缩放、90ms 后才纠正 = 可见的"从上往下弹"
        applyRootWeights(next)
        modelRef.current = next
        setModel(next)
        // **同步刷 __flModel**：setModel 的 effect 要等重渲染——adopter 的
        // 调用方（隐藏/打开后的对齐等）在同一个同步栈里取模型，拿到旧引用
        // 就是对着死模型对齐（U2 实锤）
        ;(window as { __flModel?: Model }).__flModel = next
        persist(next)
        bumpLayoutRev()
        scheduleRebalance()
        return true
      } catch (e) {
        console.error('[flex-layout] column ops re-adopt failed', e)
        return false
      }
    })
    return () => setColumnOpsAdopter(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, scheduleRebalance])

  // 对话栏贴软件边缘留白（用户 2026-10-06：对话栏直接到软件边缘时该侧
  // 留 20px 空白）：贴边的对话语义分栏打标记类。**标记打在 tab 元素上**
  // ——flexlayout 0.11 的 .flexlayout__tab 平铺在 layout 根层绝对定位
  // （不在 tabset 子树里，tabset 上打类管不到内容）；tab 路径 =
  // tabset 路径 + '/序号'，按前缀映射。依赖 layoutRev——普通动作原地改
  // 模型不触发重渲染，只有 rev bump 能带动本 effect 重跑。
  const layoutRev = useLayoutStore((s) => s.layoutRev)
  useEffect(() => {
    // 双 rAF：flexlayout 对模型动作的重渲染（tab 元素重建）在同一轮提交
    // 之后——立刻查 DOM 会拿到旧元素，类打上去就丢
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const m = modelRef.current
        if (!m) return
        const first = (n: import('flexlayout-react').Node): TabSetNode | undefined =>
          n instanceof TabSetNode ? n : (n.getChildren().map((c) => first(c)).find(Boolean) as TabSetNode | undefined)
        const kids = m.getRootRow()?.getChildren() ?? []
        const lastIdx = kids.length - 1
        const tabs = [...document.querySelectorAll<HTMLElement>('.flexlayout__tab')]
        const setEdge = (tabset: TabSetNode, cls: string, on: boolean) => {
          const prefix = `${tabset.getPath()}/`
          for (const t of tabs) {
            const p = t.getAttribute('data-layout-path') ?? ''
            if (p.startsWith(prefix)) t.classList.toggle(cls, on)
          }
        }
        kids.forEach((kid, i) => {
          const ts = first(kid)
          if (!ts) return
          const isChat = zoneConfigOf(ts)?.region === 'chat'
          setEdge(ts, 'fl-edge-start', isChat && i === 0)
          setEdge(ts, 'fl-edge-end', isChat && i === lastIdx)
        })
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [model, layoutRev])

  // ── 启动自愈（boot）：栏旗标收敛（隐藏/位置脱同步）→ 约束按 region 修正
  // （旧档防御）→ 富余兜底。absorb 必须等 flexlayout 首次布局（calcMinMaxSize/
  // DOM 量测）之后——同步跑会拿到 0 量测（2026-09-26 实测踩过，右侧空白的
  // 根因），双 rAF 保证在首次布局之后。
  useEffect(() => {
    normalizeColumns()
    const m = modelRef.current
    syncTabsetConstraints(m)
    measureRootPx(m)
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (modelRef.current !== m) return
        absorbSurplus(m)
        // 首帧布局后补跑 sync：boot 直调的 sync 在量测未就绪时部分放弃
        syncTabsetConstraints(m)
      })
    })
    // 90ms 串行通道的挂起定时器随卸载清理——卸载后开火会在死模型上跑
    // 全套配重/吸收（StrictMode 双挂载/HMR 下可达）
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      clearTimeout(rebalanceTimerRef.current ?? undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // workspace 页签名跟随当前会话
  const activeTitle = useStore(sessionCatalog, (s) =>
    s.activeId ? sessionDisplayName(s.entries[s.activeId]) : null,
  )
  useEffect(() => {
    const m = modelRef.current
    const node = m?.getNodeById('workspace')
    if (!(node instanceof TabNode)) return
    const name = typeof activeTitle === 'string' && activeTitle.length > 0 ? activeTitle : '主会话'
    if (node.getName() !== name) {
      m!.doAction(Actions.updateNodeAttributes('workspace', { name }))
    }
  }, [activeTitle])

  // 会话页签标题跟随会话目录（docs/layout-design.md v6.0 §8：页签名 =
  // 会话显示名）。目录条目缺失（未 ingest）时跳过，不写占位。
  const sessionEntries = useStore(sessionCatalog, (s) => s.entries)
  useEffect(() => {
    const m = modelRef.current
    if (!m) return
    m.visitNodes((n) => {
      if (!(n instanceof TabNode)) return
      if (paneTypeOf(n.getId()) !== 'session') return
      const threadId = (n.getConfig() as { threadId?: string } | undefined)?.threadId
      if (!threadId) return
      const entry = sessionEntries[threadId]
      if (!entry) return
      const title = sessionDisplayName(entry)
      if (n.getName() !== title) {
        m.doAction(Actions.updateNodeAttributes(n.getId(), { name: title }))
      }
    })
  }, [sessionEntries])

  // ── 会话页签（多标签，§5/§8） ──────────────────────────────────────────────
  /** 开出/激活某会话的页签：同会话已有页签 → 置前（同会话不重复开签）；
   *  否则落到目标分栏（须 region=chat，缺省 = 主会话所在分栏）激活。
   *  beforeTabId = 悬停页签的槽位（hermes slotBefore——插到它前面，null =
   *  追加条尾）。thread-list 的会话行拖拽经 bridge 调这里。 */
  const openSessionTab = useCallback(
    (threadId: string, targetTabsetId?: string, beforeTabId?: string | null) => {
      const m = modelRef.current
      let existing: string | null = null
      m.visitNodes((n) => {
        if (existing || !(n instanceof TabNode)) return
        if (paneTypeOf(n.getId()) !== 'session') return
        if ((n.getConfig() as { threadId?: string } | undefined)?.threadId === threadId) {
          existing = n.getId()
        }
      })
      if (existing) {
        m.doAction(Actions.selectTab(existing))
        persist(m)
        bumpLayoutRev()
        return
      }
      let host: TabSetNode | null = null
      if (targetTabsetId) {
        const t = m.getNodeById(targetTabsetId)
        if (t instanceof TabSetNode && zoneConfigOf(t)?.region === 'chat' && t.getChildren().length > 0) {
          host = t
        }
      }
      if (!host) {
        const ws = m.getNodeById('workspace')
        if (ws instanceof TabNode && ws.getParent() instanceof TabSetNode) {
          host = ws.getParent() as TabSetNode
        }
      }
      if (!host) {
        console.error('[flex-layout] 对话栏分栏不存在——开签放弃', threadId)
        return
      }
      const id = nextInstanceId(m, 'session')
      const entry = sessionCatalog.getState().entries[threadId]
      const name = entry ? sessionDisplayName(entry) : '会话'
      // 槽位精度（hermes slotBefore）：插到悬停页签前；目标签不在场 = 条尾
      const index = beforeTabId ? host.getChildren().findIndex((t) => t.getId() === beforeTabId) : -1
      m.doAction(
        Actions.addNode(
          { type: 'tab', id, component: 'session', name, enableClose: true, config: { threadId } },
          host.getId(),
          DockLocation.CENTER,
          index >= 0 ? index : host.getChildren().length,
          true,
        ),
      )
      m.doAction(Actions.selectTab(id))
      persist(m)
      bumpLayoutRev()
    },
    [persist],
  )

  useEffect(() => {
    setSessionTabOpener(openSessionTab)
    return () => setSessionTabOpener(null)
  }, [openSessionTab])

  // ── 打开页动作（docs/layout-design.md v6.0 §7） ────────────────────────────
  /** 面板栏「页签组」锚 = 面板栏列顶组（open 空态锚住那里；open 被撤下时
   *  顶组仍在，靠模型定位）。 */
  const panelsTabsetOf = (m: Model): TabSetNode | null => {
    const topId = panelsKidTopSetId(m)
    if (!topId) return null
    const top = m.getNodeById(topId)
    return top instanceof TabSetNode ? top : null
  }

  const selectExistingOfType = (m: Model, type: PaneType): boolean => {
    let found: string | null = null
    m.visitNodes((n) => {
      if (found || !(n instanceof TabNode)) return
      if (paneTypeOf(n.getId()) === type) found = n.getId()
    })
    if (!found) return false
    m.doAction(Actions.selectTab(found))
    return true
  }

  const openPanelsAction = useCallback(
    (kind: OpenPageKind) => {
      const m = modelRef.current
      // 终端 = 面板栏页签组成员（v7.0 用户定稿：不再有底行，与文件树/预览
      // 同栈）。已存在 → 激活；否则入页签组。
      if (selectExistingOfType(m, kind)) {
        persist(m)
        bumpLayoutRev()
        return
      }
      const tabsSet = panelsTabsetOf(m)
      if (!tabsSet) {
        console.error('[flex-layout] 面板栏页签组不存在——开签放弃', kind)
        return
      }
      // files/terminal 单例 id=类型名；preview 多实例 id=preview-N
      const id = PANE_TYPES[kind].multi ? nextInstanceId(m, kind) : kind
      m.doAction(
        Actions.addNode(
          {
            type: 'tab',
            id,
            component: kind,
            name: kind === 'files' ? '文件树' : kind === 'terminal' ? '终端' : '预览',
            enableClose: true,
            ...(kind === 'preview' ? { config: { filePath: '' } } : {}),
          },
          tabsSet.getId(),
          DockLocation.CENTER,
          tabsSet.getChildren().length,
          true,
        ),
      )
      m.doAction(Actions.selectTab(id))
      persist(m)
      bumpLayoutRev()
    },
    [persist],
  )

  // 文件树点文件 → 预览页签（preview-opener 链）
  const openPreviewTab = useCallback(
    (filePath: string, fileName: string) => {
      const m = modelRef.current
      let existing: string | null = null
      m.visitNodes((n) => {
        if (existing || !(n instanceof TabNode)) return
        if (
          n.getComponent() === 'preview' &&
          (n.getConfig() as { filePath?: string } | undefined)?.filePath === filePath
        ) {
          existing = n.getId()
        }
      })
      if (existing) {
        m.doAction(Actions.selectTab(existing))
        return
      }
      const tabsSet = panelsTabsetOf(m)
      if (!tabsSet) {
        console.error('[flex-layout] 面板栏页签组不存在——预览开签放弃', filePath)
        return
      }
      const id = nextInstanceId(m, 'preview')
      m.doAction(
        Actions.addNode(
          { type: 'tab', id, component: 'preview', name: fileName, config: { filePath } },
          tabsSet.getId(),
          DockLocation.CENTER,
          tabsSet.getChildren().length,
          true,
        ),
      )
      m.doAction(Actions.selectTab(id))
      persist(m)
      bumpLayoutRev()
    },
    [persist],
  )

  useEffect(() => {
    setPreviewOpener((filePath, fileName) => openPreviewTab(filePath, fileName))
  }, [openPreviewTab])

  // ── 动作拦截 ────────────────────────────────────────────────────────────────
  const lastAdjustRef = useRef<{ nodeId: string; weights: number[] } | null>(null)
  const onAction = useCallback(
    (action: Action): Action | undefined => {
      if (actionInFloatLayout(model, action)) return action
      if (action.type === Actions.ADJUST_WEIGHTS) {
        const data = action.data as { nodeId?: string; weights?: number[] }
        const adjusting = (action as unknown as { isAdjusting?: () => boolean }).isAdjusting?.() ?? false
        const row = model.getNodeById(data.nodeId ?? '')
        const weights = Array.isArray(data.weights) ? data.weights : []
        const insane = weights.some((w) => !Number.isFinite(w) || w < 0)
        if (insane) {
          console.error('[flex-layout] reject insane ADJUST_WEIGHTS', data.nodeId, weights)
          if (adjusting) {
            const last = lastAdjustRef.current
            if (
              last &&
              last.nodeId === data.nodeId &&
              last.weights.length > 0 &&
              last.weights.every((w) => Number.isFinite(w) && w >= 0)
            ) {
              return Actions.adjustWeights(last.nodeId, last.weights).setAdjusting(true)
            }
            return undefined
          }
          if (row instanceof RowNode) {
            const sane = row.getChildren().map((c) => (c as unknown as { getWeight?: () => number }).getWeight?.() ?? 100)
            return Actions.adjustWeights(row.getId(), sane)
          }
          return undefined
        }
        if (adjusting) {
          lastAdjustRef.current = { nodeId: data.nodeId ?? '', weights: data.weights ?? [] }
          return action
        }
        const last = lastAdjustRef.current
        lastAdjustRef.current = null
        if (last && last.nodeId === data.nodeId && last.weights.length > 0) {
          return Actions.adjustWeights(last.nodeId, last.weights)
        }
        return action
      }
      if (action.type !== Actions.DELETE_TAB) return action
      const id = (action.data as { node?: string }).node ?? ''
      const ptype = paneTypeOf(id)
      if (!ptype || !PANE_TYPES[ptype].primary) return action
      // primary 不可关（主会话/打开页/左侧栏）
      return undefined
    },
    [model],
  )

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

  // ── 工厂 ────────────────────────────────────────────────────────────────────
  const factory = useCallback(
    (node: TabNode) => {
      const componentName = node.getComponent() ?? ''
      let content: React.ReactNode
      if (componentName === 'preview') {
        content = <HermesPreviewPane node={node} />
      } else if (componentName === 'external') {
        const cfg = node.getConfig() as { fileName?: string } | undefined
        content = (
          <div className="pane-placeholder">
            <h2>{cfg?.fileName ?? node.getName()}</h2>
            <p>外部内容占位（OS 拖入）——预览渲染待接。</p>
          </div>
        )
      } else if (componentName === 'open') {
        content = <OpenPage onOpen={openPanelsAction} />
      } else if (componentName === 'session') {
        // 会话窗格 = 自持投影（v7.3 双对话分栏各显各的会话）：threadId 从
        // 页签 config 取，threadId === 活动会话时翻 live
        const cfg = node.getConfig() as { threadId?: string } | undefined
        content = <SessionThreadPane threadId={cfg?.threadId ?? ''} tabName={node.getName()} />
      } else {
        const Comp = COMPONENTS[componentName]
        content = Comp ? (
          <Comp tabName={node.getName()} />
        ) : (
          <div className="pane-placeholder">
            <p>未知窗格: {componentName}</p>
          </div>
        )
      }
      // 页签 body 右键 = 应用菜单（v6.0：唯一右键菜单，main.tsx 裁定层
      // 把 .flexlayout__tab 落点也归 app——ZoneMenu 体系已裁）
      return content
    },
    [model, openPanelsAction],
  )

  // 横向多页签条：非首个页签的前缘加分隔圆点（用户 2026-09-27 定稿视觉）
  const onRenderTab = useCallback((node: TabNode, renderValues: import('flexlayout-react').ITabRenderValues) => {
    const set = node.getParent()
    if (!(set instanceof TabSetNode)) return
    const tabs = set.getChildren().filter((c): c is TabNode => c instanceof TabNode)
    if (tabs.length > 1 && tabs.indexOf(node) > 0) {
      renderValues.leading = <span aria-hidden className="fl-tab-sep" />
    }
  }, [])

  const onTabSetPlaceHolder = useCallback(() => {
    return (
      <div className="pane-placeholder">
        <p>空栏 — 把页签拖进来。</p>
      </div>
    )
  }, [])

  const onAuxMouseClick = useCallback(
    (node: TabNode | TabSetNode | import('flexlayout-react').BorderNode | import('flexlayout-react').TabGroupNode, event: React.MouseEvent<HTMLElement>) => {
      if (event.button === 1 && node instanceof TabNode) {
        const t = paneTypeOf(node.getId())
        if (t ? !PANE_TYPES[t].primary : true) closePaneById(node.getId())
      }
    },
    [closePaneById],
  )

  // 页签右键 = 应用菜单（v6.0：唯一右键菜单——main.tsx 裁定层不再豁免
  // tab_button，本组件的原生 showPopupMenu 页签菜单随之删除）

  // ── 页签拖拽接管（pointerdown 捕获段；docs/layout-design.md v6.0 §4） ───────
  const onHostPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.flexlayout__tab_button_trailing, .flexlayout__border_button_trailing, .fl-close-btn, .tab-overflow-btn, input, textarea')) return
      const btn = target.closest(`[id^="flexlayout-tabbutton-"]`) as HTMLElement | null
      if (!btn) return
      const tabId = btn.id.slice('flexlayout-tabbutton-'.length)
      // 打开页锚不参与拖拽（列级语义钉死——拖拽准入已拒，指针会话不起）
      if (paneTypeOf(tabId) === 'open') return
      const tab = model.getNodeById(tabId)
      if (!(tab instanceof TabNode)) return
      const parent = tab.getParent()
      const groupId = parent instanceof TabSetNode ? parent.getId() : undefined
      if (!groupId) return
      startPaneDrag(model, tabId, e, {
        reorder: { groupId },
      })
    },
    [model],
  )

  const onExternalDrag = useCallback((e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return undefined
    e.preventDefault()
    // 占位页签（预览渲染待接）；首个文件名做标题
    return {
      json: {
        type: 'tab',
        component: 'external',
        name: files[0].name,
        config: { fileName: files[0].name },
      },
    }
  }, [])

  const onShowOverflowMenu = useCallback(
    (node: TabSetNode | import('flexlayout-react').BorderNode, mouseEvent: React.MouseEvent<HTMLElement>) => {
      const target = mouseEvent.currentTarget as HTMLElement | undefined
      const rect = target?.getBoundingClientRect()
      setOverflowMenu({
        node,
        anchor: rect ? { x: rect.right, y: rect.bottom } : { x: mouseEvent.clientX, y: mouseEvent.clientY },
      })
    },
    [],
  )

  // ── 窗口拖动（v4 恢复，window 捕获段按命中面分派）──
  // 有页签的地方归页签，顶带空白（条带容器/logo 带/双行块锚层/壳层）拖
  // 窗口、双击最大化。绝不改用绝对定位盖层——盖层会截胡顶带内页签的
  // pointerdown（2026-09-29 定稿；v6.0 重建时误删致标题栏/顶带空白不可
  // 拖，2026-10-05 恢复）。
  useEffect(() => {
    if (!inTauri || !appWindow) return
    const win = appWindow
    const onWinPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as Element | null
      if (!t) return
      // 交互面/专用面归原主：按钮/输入、分隔条、溢出钮、resize 手柄、关闭钮
      if (
        t.closest(
          'button, input, textarea, select, a, .flexlayout__splitter, ' +
            '.flexlayout__tab_button_overflow, .win-resize-handle, .fl-close-btn, .fl-min-btn',
        )
      )
        return
      // 页签整钮归页签（v6 无拉伸头栏，无需文字区细分）
      if (t.closest('[id^="flexlayout-tabbutton-"]')) return
      // 顶带（窗口顶部 100px）的面空白：条带容器 / 条隐藏分栏的 padding 带
      // （target 恰为 tabset/content 本体，非窗格内容）/ 壳层 / logo 带 /
      // 双行块锚层 → 拖窗口
      if (e.clientY > 100) return
      const onBandSurface =
        t.closest('.flexlayout__tabset_tabbar_outer, .app-shell, .rail-logo-leading, .left-rail-logo-row, .chat-tab-label-anchor') !== null ||
        t.classList.contains('flexlayout__tabset') ||
        t.classList.contains('flexlayout__tabset_content')
      if (!onBandSurface) return
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

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  return (
    <AssistantRuntime>
      <div className="app-shell">
        <ResizeHandles />
        {/* Titlebar 自渲染 .app-titlebar（pointer-events:none 浮片、按钮子元
            素 auto）——**外面不得再包一层 .app-titlebar**：内层会被
            `.app-titlebar > * { pointer-events: auto }` 规则点亮成盖住整个
            85px 顶带的透明板，吃掉全部栏的页签点击/拖拽（v6.0 首版踩坑） */}
        <Titlebar />
        <div className="app-main flexlayout-host" onPointerDownCapture={onHostPointerDown}>
          <Layout
            ref={layoutRef}
            model={model}
            factory={factory}
            onAction={onAction}
            onModelChange={onModelChange}
            onRenderTab={onRenderTab}
            onTabSetPlaceHolder={onTabSetPlaceHolder}
            onAuxMouseClick={onAuxMouseClick}
            onExternalDrag={onExternalDrag}
            tabDragSpeed={0.08}
            icons={{ close: <CloseIcon />, more: () => <ChevronsDownIcon size={14} /> }}
            onShowOverflowMenu={onShowOverflowMenu}
          />
          {overflowMenu && (
            <TabOverviewMenu
              anchor={overflowMenu.anchor}
              tabset={overflowMenu.node}
              onClose={() => setOverflowMenu(null)}
            />
          )}
          {/* FancyZones 投放预览：拖拽中亮 zone sheet + 页签条插入符 */}
          <DropOverlay />
          {/* 装饰叠片：主区调色层 + 对话双行块（跟随激活对话页签） */}
          <MainTint model={model} />
          <ChatLabelOverlay model={model} />
          <StripHiddenTitleOverlay model={model} />
        </div>
        <StatusBar />
      </div>
    </AssistantRuntime>
  )
}

/** tabset 所在列的根行直接子项（列身份节点）。 */
function columnRootKidOf(m: Model, tabsetId: string): TabSetNode | RowNode | undefined {
  const rootRow = m.getRootRow()
  let cur: import('flexlayout-react').Node | undefined = m.getNodeById(tabsetId)
  while (cur) {
    const p: import('flexlayout-react').Node | undefined = cur.getParent()
    if (!p || p === rootRow) break
    cur = p
  }
  return cur instanceof TabSetNode || cur instanceof RowNode ? cur : undefined
}
