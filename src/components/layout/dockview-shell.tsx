/**
 * dockview 壳（v8.0 M1）——出厂三栏 + 栏动词 + 持久化 + 打开页生命周期 +
 * 会话分栏桥。语义平移自 flex-layout.tsx（映射表 docs/architecture.md §6）。
 *
 * dockview 8.5.1 实测类型事实（对型依据，勿凭旧版文档写）：
 * - 序列化 leaf data 是**组视图状态** GroupPanelViewState：`{ id（组 id）,
 *   views: [panelId…] }` + CoreGroupOptions（hideHeader/constraints/
 *   initialWidth 随序列化 round-trip）；panel 内容（contentComponent/
 *   params/tabComponent）在顶层 panels 记录，组按 id 引用；
 * - grid.orientation 是 dockview-core 的 Orientation 枚举；grid height/
 *   width 必填（存档值，加载时按容器归一）；
 * - 拖拽拦截 = api.onWillDragPanel/onWillDragGroup（react 层无此 prop）；
 * - 无面板关闭拦截 API → open 页签用自定义 tabComponent（无 ✕ 头）实现
 *   "根面板不可关"；
 * - params 必须可序列化——回调经组件闭包注入，不进 params；
 * - 组移动 = groupApi.moveTo（零组件卸载）；整列摘除/拼回 = toJSON 手术
 *   + fromJSON（panel 重挂，hide/show 专属）。
 *
 * 持久化：布局 JSON `mirach.harness.layout.v9`（v8 及更早 flexlayout 存档
 * 作废不迁移）；栏旗标/快照沿用 colflags.v1/colstash.v1（语义不变）。
 */
import {
  DockviewReact,
  DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
  type DockviewApi,
  type SerializedDockview,
} from 'dockview-react'
import { Orientation } from 'dockview-core'
import { useCallback, useEffect, useRef } from 'react'

import { Titlebar } from '@/app/shell/titlebar'
import { StatusBar } from '@/app/shell/statusbar'
import { ResizeHandles } from './resize-handles'
import { inTauri, appWindow } from '@/lib/tauri-window'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { SessionThreadPane } from '@/components/panes/session-thread-pane'
import { LeftRailPane } from '@/components/panes/left-rail-pane'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { HermesPreviewPane } from '@/components/panes/hermes-sidebar/hermes-preview-pane'
import { setPreviewOpener } from '@/components/panes/hermes-sidebar/preview-opener'
import { ReviewPane } from '@/components/panes/review-pane'
import { TerminalPane } from '@/components/panes/terminal-pane'
import { OpenPage, type OpenPageKind } from '@/components/panes/open-page'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'
import {
  setSessionTabOpener,
} from '@/components/panes/session-manage/session-tab-bridge'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'
import {
  alignVisibleToOrder,
  columnFlagsOf,
  normalizeColumns,
  persistFlagsColOrder,
  rootPanelsGroup,
} from './dockview-column-ops'

// ── 出厂布局（三栏）：[左栏 350 | 主栏 | 面板栏 350] ────────────────────────
// 左/主组 hideHeader（无标签条）；组约束走**面板级** minimumWidth/
// maximumWidth（GroupviewPanelState 字段，随序列化 round-trip——组的生效
// 约束回落到活动 panel 的同名值；leaf data 的 constraints/initialWidth 在
// 反序列化里被丢弃，实测勿用）。wrapper.size = 出厂列宽（px 值，fromJSON
// 按比例归一——精确 px 由 boot 后 setSize 钉回）。面板栏出厂单签 open
// （打开页宿主，tabComponent openTab = 无 ✕ 头，根面板不可关）。
const RAIL_W = 350

const FACTORY_LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { id: 'g-left', views: ['leftrail'], hideHeader: true }, size: RAIL_W },
        { type: 'leaf', data: { id: 'g-chat', views: ['workspace'], hideHeader: true }, size: 1100 },
        { type: 'leaf', data: { id: 'g-panels', views: ['open'] }, size: RAIL_W },
      ],
    },
    height: 1000,
    width: 1800,
    orientation: Orientation.HORIZONTAL,
  },
  panels: {
    leftrail: {
      id: 'leftrail',
      contentComponent: 'leftrail',
      title: '',
      minimumWidth: 240,
      maximumWidth: 420,
      params: { region: 'left' },
    },
    workspace: {
      id: 'workspace',
      contentComponent: 'workspace',
      title: '',
      minimumWidth: 395,
      params: { region: 'chat' },
    },
    open: {
      id: 'open',
      contentComponent: 'open',
      title: '打开',
      tabComponent: 'openTab',
      minimumWidth: 240,
      params: { region: 'panels' },
    },
  },
}

const LAYOUT_KEY = 'mirach.harness.layout.v9'

const loadLayout = (): SerializedDockview | null => {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SerializedDockview
  } catch (e) {
    console.error('[dv-shell] 布局存档解析失败——出厂布局', e)
    return null
  }
}

const saveLayout = (json: SerializedDockview): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(json))
  } catch (e) {
    console.error('[dv-shell] 布局存档写入失败', e)
  }
}

// ── 打开页三按钮落点（预览 = HermesPreviewPane；检查占位 = review） ─────────
const OPEN_KIND_PANEL: Record<OpenPageKind, { id: string; component: string; title: string }> = {
  files: { id: 'files', component: 'files', title: '文件树' },
  terminal: { id: 'terminal', component: 'terminal', title: '终端' },
  preview: { id: 'preview', component: 'preview', title: '预览' },
}

/** open 页签头（根面板不可关：无 ✕ 的自定义 tab）。 */
const OpenTabHeader = (props: IDockviewPanelHeaderProps) => (
  <div className="dv-open-tab">
    <span className="dv-open-tab-title">{props.api.title ?? '打开'}</span>
  </div>
)

export function DockviewShell() {
  const apiRef = useRef<DockviewApi | null>(null)
  /** fromJSON 期间抑制持久化（boot/hide-show 动词都会触发布局事件）。 */
  const hydratingRef = useRef(false)
  /** 打开页生命周期重入护栏。 */
  const anchorBusyRef = useRef(false)

  // ── 打开页生命周期（ZCode 空态逻辑，v7.3.1 语义 dockview 版） ─────────────
  // 实签抵达面板组 → 撤 open；最后一个实签关闭 → open 回来（根面板列打开
  // 期间永不空——v8.0 docs："面板栏缺席仅『隐藏面板栏』一条路径"）。
  const restoreOpenAnchor = useCallback((a: DockviewApi) => {
    if (a.getPanel('open')) return
    const flags = columnFlagsOf()
    if (flags.panelsHidden) return
    const host = rootPanelsGroup(a)
    if (host) {
      a.addPanel({
        id: 'open',
        component: 'open',
        title: '打开',
        tabComponent: 'openTab',
        minimumWidth: 240,
        params: { region: 'panels' },
        position: { referenceGroup: host.id, index: 0 },
      })
    } else {
      // 组随末签关闭被 dockview 收走 → 重建（colOrder 语义位对齐）
      a.addPanel({
        id: 'open',
        component: 'open',
        title: '打开',
        tabComponent: 'openTab',
        minimumWidth: 240,
        params: { region: 'panels' },
        position: { referencePanel: 'workspace', direction: 'right' },
      })
      alignVisibleToOrder(a)
    }
  }, [])

  const handlePanelAdded = useCallback(
    (a: DockviewApi, panelId: string) => {
      if (anchorBusyRef.current) return
      const panel = a.getPanel(panelId)
      if (!panel || panel.id === 'open') return
      if (panel.params?.region !== 'panels') return
      const open = a.getPanel('open')
      if (open && open.group === panel.group) {
        anchorBusyRef.current = true
        try {
          a.removePanel(open)
        } finally {
          anchorBusyRef.current = false
        }
      }
    },
    [],
  )

  const handlePanelRemoved = useCallback(
    (a: DockviewApi, panelId: string) => {
      if (anchorBusyRef.current) return
      const removed = /* 移除前 region 已不可考——用 id 判面板栏域 */ panelId === 'open' || panelId === 'files' || panelId === 'terminal' || panelId.startsWith('preview')
      if (!removed) return
      if (panelId === 'open') return
      anchorBusyRef.current = true
      try {
        restoreOpenAnchor(a)
      } finally {
        anchorBusyRef.current = false
      }
    },
    [restoreOpenAnchor],
  )

  // ── 会话分栏（v7.4 完整聊天 dockview 版）：左栏动作开 session panel =
  //   主栏分栏（direction right = 并排对话列）。同会话不重复开 → 置前。 ────
  useEffect(() => {
    setSessionTabOpener((threadId) => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——会话分栏放弃')
        return
      }
      const id = `session-${threadId}`
      const existing = a.getPanel(id)
      if (existing) {
        existing.api.setActive()
        return
      }
      const tabName = sessionDisplayName(sessionCatalog.getState().entries[threadId])
      a.addPanel({
        id,
        component: 'session',
        title: tabName,
        minimumWidth: 395,
        params: { region: 'chat', threadId, tabName },
        position: { referencePanel: 'workspace', direction: 'right' },
      })
    })
    return () => setSessionTabOpener(null)
  }, [])

  // ── 文件预览链（preview-opener）：单实例 preview 面板，filePath 进 params ──
  useEffect(() => {
    setPreviewOpener((filePath, fileName) => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——预览放弃')
        return
      }
      const existing = a.getPanel('preview')
      if (existing) {
        // panel params 更新 = 运行时 setter（dockview 8.x 无 setParameters——
        // 用面板重建：同 id remove+add，无闪烁成本）
        a.removePanel(existing)
      }
      a.addPanel({
        id: 'preview',
        component: 'preview',
        title: fileName || '预览',
        minimumWidth: 240,
        params: { region: 'panels', filePath },
        position: { referencePanel: 'open', direction: 'within' },
      })
    })
    return () => setPreviewOpener(null)
  }, [])

  // ── 打开页动作 ─────────────────────────────────────────────────────────────
  const onOpen = useCallback((kind: OpenPageKind) => {
    const a = apiRef.current
    if (!a) return
    const target = OPEN_KIND_PANEL[kind]
    try {
      const existing = a.getPanel(target.id)
      if (existing) {
        existing.api.setActive()
        return
      }
      a.addPanel({
        ...target,
        minimumWidth: 240,
        params: { region: 'panels' },
        // 锚 open panel 所在组（组 id 由 fromJSON 归一，不依赖出厂命名）
        position: { referencePanel: 'open', direction: 'within' },
      })
    } catch (e) {
      console.error('[dv-shell] 打开页动作失败', kind, e)
    }
  }, [])

  const components = {
    leftrail: () => <LeftRailPane />,
    workspace: () => <AssistantThreadPane />,
    session: (props: IDockviewPanelProps) => (
      <SessionThreadPane threadId={props.params.threadId} tabName={props.params.tabName} />
    ),
    files: () => <HermesFileTreePane />,
    terminal: () => <TerminalPane />,
    review: () => <ReviewPane />,
    preview: (props: IDockviewPanelProps) => <HermesPreviewPane filePath={props.params.filePath ?? ''} />,
  }

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const a = event.api
      apiRef.current = a
      // 调试句柄（__flModel 同惯例）：E2E/CDP 从 api 驱动，不猜 DOM
      ;(globalThis as { __dvApi?: DockviewApi }).__dvApi = a
      // 语义归属准入（v8）：M1 全禁拖拽（左/主栏本就不可拖，面板栏页签的
      // 跨区准入在拖拽平移轮按 params.region 放行）
      a.onWillDragPanel((e) => e.nativeEvent.preventDefault())
      a.onWillDragGroup((e) => e.nativeEvent.preventDefault())
      // 打开页生命周期 + 持久化（先订阅再灌布局——boot 布局事件也要记账）
      a.onDidAddPanel((p) => handlePanelAdded(a, p.id))
      a.onDidRemovePanel((p) => handlePanelRemoved(a, p.id))
      let persistTimer: ReturnType<typeof setTimeout> | null = null
      a.onDidLayoutChange(() => {
        if (hydratingRef.current) return
        if (persistTimer) clearTimeout(persistTimer)
        persistTimer = setTimeout(() => {
          persistTimer = null
          try {
            saveLayout(a.toJSON() as SerializedDockview)
            persistFlagsColOrder(a)
          } catch (e) {
            console.error('[dv-shell] 布局持久化失败', e)
          }
        }, 250)
      })
      hydratingRef.current = true
      try {
        const saved = loadLayout()
        a.fromJSON(saved ?? FACTORY_LAYOUT)
        if (!saved) {
          // 出厂态钉双轨 350（fromJSON 的 size 按比例归一，不是 px；setSize
          // 逐个调用会把差额摊给先设的轨——两轮互挤后收敛；存档 boot 不钉，
          // 用户列宽记忆在 v9 size 里）
          const lg = a.groups.find((g) => g.panels.some((p) => p.params?.region === 'left'))
          const pg = a.groups.find((g) => g.panels.some((p) => p.params?.region === 'panels'))
          for (let i = 0; i < 3; i++) {
            pg?.api.setSize({ width: RAIL_W })
            lg?.api.setSize({ width: RAIL_W })
          }
        }
      } finally {
        hydratingRef.current = false
      }
      // boot 自愈（旗标 vs 实际树；列序对齐）
      normalizeColumns()
      // 面板列缺席但旗标未藏（normalizeColumns 收敛过旗标）→ 一致性兜底：
      // 打开页锚重建（隐藏语义交给菜单动词，boot 只保证锚在场）
      restoreOpenAnchor(a)
    },
    [handlePanelAdded, handlePanelRemoved, restoreOpenAnchor],
  )

  // ── 窗口拖动（M1 漏迁后从 flex-layout 原样回迁，2026-10-14）──────────────
  // window 捕获段按命中面分派：顶带（--logo-strip-h=85）内非交互面拖窗口、
  // 双击最大化；绝不改用绝对定位盖层——盖层会截胡顶带内页签 pointerdown
  //（2026-09-29 定稿）。
  useEffect(() => {
    if (!inTauri || !appWindow) return
    const win = appWindow
    const onWinPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as Element | null
      if (!t) return
      // 交互面/专用面归原主：按钮/输入、分隔条、resize 手柄
      if (t.closest('button, input, textarea, select, a, .dv-sash, .win-resize-handle')) return
      // 页签整钮归 dockview（拖页签不是拖窗）
      if (t.closest('.dv-tab')) return
      // 顶带（窗口顶部 85px）的面空白才拖窗
      if (e.clientY > 85) return
      const onBandSurface =
        t.closest('.app-shell, .rail-logo-leading, .left-rail-logo-row, .app-titlebar') !== null
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
  // 壳层结构（flex-layout 原版恢复——M1 换壳时漏迁了窗口框架，
  // .app-shell/Titlebar/StatusBar/ResizeHandles 全丢，2026-10-14 实锤补回）：
  // AssistantRuntime 包壳（左栏 useAui / AuiIf 依赖壳级 runtime provider）→
  // .app-shell（白底圆角窗）→ ResizeHandles + Titlebar（圆点浮层）+
  // .app-main（dockview 主区）+ StatusBar（底栏）。
  return (
    <AssistantRuntime>
      <div className="app-shell">
        <ResizeHandles />
        <Titlebar />
        <div className="app-main dockview-host" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <DockviewReact
            // open 必须在注册表内（FACTORY 引用 contentComponent 'open'——缺键 =
            // ReactPart 抛 "Only React.memo..." → fromJSON 整体回退空布局）
            components={{ ...components, open: () => <OpenPage onOpen={onOpen} /> }}
            tabComponents={{ openTab: OpenTabHeader }}
            onReady={onReady}
            className="dockview-theme-light"
          />
        </div>
        <StatusBar />
      </div>
    </AssistantRuntime>
  )
}
