import { useCallback, useEffect, useRef, useState } from 'react'
import { Layout, Model, Actions, TabNode, TabSetNode, RowNode, BorderNode, DockLocation, showPopupMenu, type Action, type Node, type PopupMenuEntry, type ILayoutApi } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'

import { Titlebar } from '@/app/shell/titlebar'
import { StatusBar } from '@/app/shell/statusbar'
import { ChatLabelOverlay, MainTint, StripHiddenTitleOverlay } from './chrome-overlays'
import { ChevronDownIcon, CloseIcon } from '@/components/ui/codicons'
import { ChevronsDownIcon } from 'lucide-react'
import { useStore } from 'zustand'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'
import { DropOverlay } from './drop-overlay'

import { RailLogoLeading } from './rail-logo-leading'
import { ResizeHandles } from './resize-handles'
import { rootNeededMin, rootAvailPx } from './constraints'
import { applyRootWeights, absorbSurplus, measureRootPx, rootPxMem } from './rebalance'
import { syncTabsetConstraints } from './constraints-sync'
import { startPaneDrag } from './drag-session'
import { bumpLayoutRev, bumpDragRev, useLayoutStore } from '@/store/layout-store'
import { PANE_TYPES, PRIMARY_PANE, paneTypeOf, paneTabJson, nextInstanceId, zoneConfigOf, closePane, type PaneType, type Region } from './pane-registry'
import { defaultLayout, SPLITTER_PX } from './layout-presets'
import { TabOverviewMenu } from './tab-overview-menu'

import { TerminalPane } from '@/components/panes/terminal-pane'
import { ReviewPane } from '@/components/panes/review-pane'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { HermesPreviewPane } from '@/components/panes/hermes-sidebar/hermes-preview-pane'
import { setPreviewOpener } from '@/components/panes/hermes-sidebar/preview-opener'
import { OpenPage } from '@/components/panes/open-page'
import { LeftRailPane } from '@/components/panes/left-rail-pane'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'

// ── 窗格组件注册表（按**类型**分发；多实例共用同一组件） ─────────────────────

const COMPONENTS: Record<string, React.ComponentType<{ tabName?: string }>> = {
  leftrail: LeftRailPane,
  workspace: AssistantThreadPane,
  session: AssistantThreadPane,
  open: OpenPage,
  files: HermesFileTreePane,
  review: ReviewPane,
  terminal: TerminalPane,
}

const PRIMARY_TYPES = new Set(
  Object.entries(PANE_TYPES)
    .filter(([, d]) => d.primary)
    .map(([t]) => t),
)

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

const makeDefaultLayout = () => defaultLayout()

const STORAGE_KEY = 'mirach.harness.layout.v7'

export function FlexLayoutShell() {
  const configure = (m: Model) => {
    m.doAction(Actions.updateModelAttributes({ enableEdgeDock: false, borderEnableAutoHide: true }))
    return m
  }

  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) return configure(Model.fromJson(JSON.parse(saved)))
    } catch (e) {
      console.error('[flex-layout] saved layout invalid, falling back to default', e)
    }
    return configure(Model.fromJson(makeDefaultLayout()))
  })

  const [overflowMenu, setOverflowMenu] = useState<{
    node: import('flexlayout-react').TabSetNode | import('flexlayout-react').BorderNode
    anchor: { x: number; y: number }
  } | null>(null)

  const modelRef = useRef(model)
  modelRef.current = model

  const adoptModel = useCallback((next: Model) => {
    modelRef.current = next
    setModel(next)
  }, [])

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

  const migratingRef = useRef(false)
  const rebalanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleRebalance = useCallback((allowRevert: boolean) => {
    if (rebalanceTimerRef.current) clearTimeout(rebalanceTimerRef.current)
    rebalanceTimerRef.current = setTimeout(() => {
      const m = modelRef.current
      if (!m) return
      syncTabsetConstraints(m)
      applyRootWeights(m)
      absorbSurplus(m)
    }, 90)
  }, [])

  const onModelChange = useCallback(
    (m: Model, action?: Action) => {
      if (action?.isAdjusting?.()) {
        bumpDragRev()
        return
      }
      persist(m)
      bumpLayoutRev()
      if (
        action?.type === Actions.DELETE_TAB ||
        action?.type === Actions.MOVE_NODE ||
        action?.type === 'FlexLayout_AddNode'
      ) {
        if (action?.type === Actions.DELETE_TAB) measureRootPx(m)
        if (!migratingRef.current) applyRootWeights(m)
        scheduleRebalance(true)
      }
    },
    [persist, scheduleRebalance],
  )

  // workspace 页签名跟随当前会话
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
            if (last && last.nodeId === data.nodeId && last.weights.length > 0 && last.weights.every((w) => Number.isFinite(w) && w >= 0)) {
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
      const tab = model.getNodeById(id)
      if (!(tab instanceof TabNode)) return undefined
      return undefined // primary 不可关
    },
    [model],
  )

  // ── 工厂 ────────────────────────────────────────────────────────────────────
  const factory = useCallback((node: TabNode) => {
    const componentName = node.getComponent()
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
    } else {
      const Comp = COMPONENTS[componentName]
      content = Comp ? <Comp tabName={node.getName()} /> : <div className="pane-placeholder"><p>未知窗格: {componentName}</p></div>
    }
    return content
  }, [])

  const onRenderTabSet = useCallback(
    (node: TabSetNode | BorderNode, renderValues: import('flexlayout-react').ITabSetRenderValues) => {
      if (!(node instanceof TabSetNode)) return
      const sel = node.getSelectedNode()
      const selIsChat = !!sel && (sel.getId() === 'workspace' || paneTypeOf(sel.getId()) === 'session')
      if (sel?.getId() === 'leftrail') {
        renderValues.leading = <RailLogoLeading />
      }
      if (selIsChat) {
        renderValues.leading = (
          <>
            {renderValues.leading}
            <span data-chat-lead aria-hidden className="hidden" />
          </>
        )
      }
    },
    [],
  )

  const onTabSetPlaceHolder = useCallback(() => {
    return (
      <div className="pane-placeholder">
        <p>空栏 — 从「+」打开窗格，或把页签拖进来。</p>
      </div>
    )
  }, [])

  const isCloseableTab = useCallback((c: Node): c is TabNode => {
    if (!(c instanceof TabNode)) return false
    const t = paneTypeOf(c.getId())
    return t ? !PANE_TYPES[t].primary : true
  }, [])

  const onTabContextMenu = useCallback(
    (node: TabNode | TabSetNode | BorderNode | import('flexlayout-react').TabGroupNode, event: React.MouseEvent) => {
      event.preventDefault()
      if (!(node instanceof TabNode)) return
      if (event.target instanceof Element && event.target.closest('.flexlayout__tab_button_stretch')) return
      const ptype = paneTypeOf(node.getId())
      const pdef = ptype ? PANE_TYPES[ptype] : undefined
      const closeable = pdef ? !pdef.primary : true
      const tabsetId = (node.getParent() as TabSetNode)?.getId()
      const items: PopupMenuEntry[] = []
      if (closeable) {
        items.push({ type: 'item', name: 'close', text: '关闭' })
      }
      if (items.length > 0) {
        showPopupMenu(event.nativeEvent as unknown as MouseEvent, nodes(node), onMenuItemClick.bind(null, model, node.getId()))
      }

      function nodes(tab: TabNode): PopupMenuEntry[] {
        return items
      }
    },
    [model],
  )

  const onMenuItemClick = useCallback(
    (m: Model, tabId: string, item: { name: string }) => {
      if (item.name === 'close') closePaneById(tabId)
    },
    [closePaneById],
  )

  const onAuxMouseClick = useCallback(
    (node: TabNode, event: Event) => {
      if ('button' in event && (event as MouseEvent).button === 1 && isCloseableTab(node)) {
        closePaneById(node.getId())
      }
    },
    [closePaneById],
  )

  const onHostPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.flexlayout__tab_button_trailing, .flexlayout__border_button_trailing, .fl-close-btn, .tab-overflow-btn, input, textarea')) return
      const btn = target.closest(`[id^="flexlayout-tabbutton-"]`) as HTMLElement | null
      if (!btn) return
      const tabId = btn.id.slice('flexlayout-tabbutton-'.length)
      const tab = model.getNodeById(tabId)
      if (!(tab instanceof TabNode)) return
      const parent = tab.getParent()
      const inTabset = parent instanceof TabSetNode
      const groupId = parent?.getId()
      if (!groupId) return
      startPaneDrag(model, tabId, e, {
        reorder: inTabset ? { groupId } : undefined,
      })
    },
    [model],
  )

  const onExternalDrag = useCallback((e: DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return undefined
    e.preventDefault()
    return {
      data: { files },
      dragText: files.map((f) => f.name).join(', '),
      json: { type: 'tab', component: 'external', name: files[0].name, config: { fileName: files[0].name } },
      onDrop: (model: Model, tabset: TabSetNode) => {
        for (const f of files) {
          model.doAction(Actions.addNode({ type: 'tab', component: 'preview', name: f.name, config: { filePath: '' } }, tabset.getId(), DockLocation.CENTER, tabset.getChildren().length, true))
        }
      },
    }
  }, [])

  const onShowOverflowMenu = useCallback((node: import('flexlayout-react').TabSetNode | import('flexlayout-react').BorderNode, mouseEvent: MouseEvent) => {
    const target = mouseEvent.currentTarget as HTMLElement | undefined
    const rect = target?.getBoundingClientRect()
    setOverflowMenu({
      node,
      anchor: rect ? { x: rect.right, y: rect.bottom } : { x: mouseEvent.clientX, y: mouseEvent.clientY },
    })
  }, [])

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  return (
    <AssistantRuntime>
      <div className="app-shell">
      <ResizeHandles />
      <div className="app-titlebar">
        <Titlebar />
      </div>
      <div className="app-main flexlayout-host" onPointerDownCapture={onHostPointerDown}>
        <Layout ref={layoutRef} model={model} factory={factory} onAction={onAction} onModelChange={onModelChange} onRenderTabSet={onRenderTabSet} onTabSetPlaceHolder={onTabSetPlaceHolder} tabDragSpeed={0.08} icons={{ close: <CloseIcon />, more: () => <ChevronsDownIcon size={14} /> }} onShowOverflowMenu={onShowOverflowMenu} />
        {overflowMenu && (
          <TabOverviewMenu
            anchor={overflowMenu.anchor}
            tabset={overflowMenu.node}
            onClose={() => setOverflowMenu(null)}
          />
        )}
        <DropOverlay />
        <MainTint model={model} />
        <ChatLabelOverlay model={model} />
        <StripHiddenTitleOverlay model={model} />
      </div>
      <StatusBar />
      </div>
    </AssistantRuntime>
  )
}

// ── 辅助（编译器需要的声明） ─────────────────────────────────────────────────
declare const layoutRef: React.MutableRefObject<import('flexlayout-react').Layout | null>
declare function Titlebar(): React.ReactElement | null
declare function StatusBar(): React.ReactElement
declare function ResizeHandles(): React.ReactElement | null
declare function TabOverviewMenu(props: { anchor: { x: number; y: number }; tabset: import('flexlayout-react').TabSetNode | import('flexlayout-react').BorderNode; onClose(): void }): React.ReactElement | null
declare function DropOverlay(): React.ReactElement | null
declare function MainTint(props: { model: Model }): React.ReactElement | null
declare function ChatLabelOverlay(props: { model: Model }): React.ReactElement | null
declare function StripHiddenTitleOverlay(props: { model: Model }): null
declare function AssistantRuntime(props: { children: React.ReactNode }): React.ReactElement
