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
 * 持久化：布局 JSON `mirach.harness.layout.v10`（v8 及更早 flexlayout 存档
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
import { useCallback, useEffect, useRef } from 'react'

import { Titlebar } from '@/app/shell/titlebar'
import { ResizeHandles } from './resize-handles'
import { GlobalKeybinds } from './global-keybinds'
import { inTauri, appWindow } from '@/lib/tauri-window'
import { SessionThreadPane } from '@/components/panes/session-thread-pane'
import { LeftRailPane } from '@/components/panes/left-rail-pane'
import { BotsPane } from '@/components/panes/bots-pane'
import { PluginPane } from '@/components/panes/plugin-pane'
import { PluginWorkspacePane } from '@/components/panes/plugin-workspace-pane'
import { pruneOrphanWorkspacePanels, workspacePanelClosed } from '@/components/layout/plugin-workspaces'
import { registry } from '@/hermes-shim/contrib/registry'
import { BOTS_PANEL_ID, botsPanelStore } from '@/components/panes/hub/bots-panel-actions'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { HermesPreviewPane } from '@/components/panes/hermes-sidebar/hermes-preview-pane'
import { setPreviewOpener } from '@/components/panes/hermes-sidebar/preview-opener'
import { ReviewPanelHost } from '@/components/panes/review-pane'
import { RadioPane } from '@/components/panes/radio-pane'
import { SubagentDetailPane } from '@/components/panes/subagent-detail-pane'
import { setSubagentDetailOpener } from '@/components/panes/subagent-detail-opener'
import { PlanDetailPane } from '@/components/panes/plan-detail-pane'
import { AgentDirectoryPane } from '@/components/panes/agent-directory-pane'
import { WorkflowRunDetailPane } from '@/components/panes/workflow-run-detail-pane'
import {
  setAgentDirectoryOpener,
  setPlanDetailOpener,
  setWorkflowRunOpener,
} from '@/components/panes/status-pane-openers'
import { MainWorkspacePane } from '@/components/panes/main-workspace-pane'
import { TerminalPane } from '@/components/panes/terminal-pane'
import { isTerminalPanelId } from '@/components/panes/terminal/terminal-tabs'
import { OpenPage, type OpenPageKind } from '@/components/panes/open-page'
import { sessionCatalog, sessionDisplayName } from '@/components/panes/session-manage/session-catalog'
import {
  setSessionTabOpener,
  type SessionTabDropPosition,
} from '@/components/panes/session-manage/session-tab-bridge'
import { TabStripLeading, TabStripRightSide, TabStripTrailing } from './tab-strip-arrows'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'
import {
  alignVisibleToOrder,
  columnFlagsOf,
  factoryLayout,
  LAYOUT_KEY,
  layoutResetInProgress,
  normalizeColumns,
  persistFlagsColOrder,
  repinRailWidths,
  rootPanelsGroup,
  setPanelsHidden,
  setRailTargetWidth,
  withoutColumnMorph,
} from './dockview-column-ops'
import {
  CHAT_MIN_WIDTH,
  leftRailDefaultWidth,
  panelsRailDefaultWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from './rail-metrics'
import { radialDropResolver } from './drop-geometry'
import { openPagePanel, panelsDropPosition, splitPanelOut } from './open-page-actions'

// ── 出厂布局（三栏）：[左栏 | 主栏 | 面板栏] ─────────────────────────────────
// factoryLayout / LAYOUT_KEY 在 dockview-column-ops.ts（2026-10-16：「默认
// 布局」复位动词 = 第二消费方，单源防漂移）——本文件只消费：boot 灌布局 +
// 出厂双轨钉宽 300 + 持久化读写。栏宽口径见 rail-metrics.ts。
const loadLayout = (): SerializedDockview | null => {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SerializedDockview
    // 坏档防御（2026-10-14 实锤）：曾出现 views:[] 的空 leaf 存档——
    // 分栏手术中途状态被持久化后，后续启动递归恶化（手术找不到左栏 leaf
    // → 报"不在场"→ 树越掏越空）。**凡根行有 leaf.views 为空数组的
    // 存档判废**，回出厂布局（错误可见，不静默吞）。
    const root = (parsed as unknown as { grid?: { root?: { data?: { data?: { views?: unknown } }[] } } })
      .grid?.root
    const kids = root?.data ?? []
    const badIdx = kids.findIndex((k) => Array.isArray(k?.data?.views) && k.data!.views!.length === 0)
    if (badIdx >= 0 || kids.length === 0) {
      console.error('[dv-shell] 布局存档含空 leaf（坏档）——判废回出厂布局', { badIdx, kids: kids.length })
      localStorage.removeItem(LAYOUT_KEY)
      return null
    }
    return parsed
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
// OPEN_KIND_PANEL / panelsDropPosition 已抽至 open-page-actions.ts（面板栏
// 标签条 + 号同源消费，2026-10-15）。

/**
 * 「打开页」面板的标签名（单一定义源）。
 *
 * 用户 2026-10-31："打开页的标题把打开换个说明文字"——原 '打开' 是动词，
 * 读起来像按钮。改成 '面板'：这一页**是什么**（面板栏的锚页）。
 *
 * **三处必须同源**：`addPanel` 的 `title`、`fromJSON` 后的 `setTitle`
 * （存档里存着旧值，见 hydrate 注释）、`OpenTabHeader` 的兜底。
 */
const OPEN_PANEL_TITLE = '面板'

/** 打开页签头（根面板不可关：无 ✕ 的自定义 tab）。 */
const OpenTabHeader = (props: IDockviewPanelHeaderProps) => (
  <div className="dv-open-tab">
    <span className="dv-open-tab-title">{props.api.title ?? OPEN_PANEL_TITLE}</span>
  </div>
)

/**
 * 插件贡献 → dockview 面板的同步器（例程面板）。
 *
 * bots 插件在 Bot Mode 会话在屏时注册 `hermes-bots:routines` 贡献、离开时
 * 注销（上游 pane 引擎按贡献自动增删窗格）。宿主没有通用引擎，这里做窄
 * 对偶：贡献在 → 在主区右侧建面板；贡献消失 → 摘面板。api 未就绪时先空转，
 * onReady 会再调一次。
 */
let routinesPaneSync: (() => void) | null = null

export function DockviewShell() {
  const apiRef = useRef<DockviewApi | null>(null)
  /** fromJSON 期间抑制持久化（boot/hide-show 动词都会触发布局事件）。 */
  const hydratingRef = useRef(false)
  /** 打开页生命周期重入护栏。 */
  const anchorBusyRef = useRef(false)
  /** 拖出分栏进行中（dockview 重摊期间不能把列宽记成目标宽）。 */
  const splitBusyRef = useRef(false)

  // ── 打开页生命周期（ZCode 语义，2026-11-01 用户定稿） ──────────────────
  // "zcode打开页是没有标签的，只有一个标签的时候是关闭是会关闭面板栏的"：
  // - 实签抵达面板组 → 撤 open（本函数 boot 路径仍兜底：布局存档里
  //   panelsHidden=false 且面板列空置时重建锚——launcher 无标签条由 CSS
  //   `:has(.dv-open-tab-title)` 承担，见 flexlayout.css）；
  // - 最后一个实签关闭 → **关闭面板栏**（handlePanelRemoved →
  //   setPanelsHidden(true)），锚不复活；重新在场 = 右键「打开面板栏」或
  //   任一实签动作（openPagePanel/preview 均清 panelsHidden）。
  const restoreOpenAnchor = useCallback((a: DockviewApi) => {
    if (a.getPanel('open')) return
    const flags = columnFlagsOf()
    if (flags.panelsHidden) return
    // 实签在场 → 锚不该回来（2026-10-15 实锤：组内 [文件树|终端] 只关
    // 文件树时 didRemovePanel 路径把 open 误复活成 [打开|终端]）。有实签 =
    // 面板列有宿主，锚缺席即正确态；锚只在面板列空置或 boot 空列时兜底重建。
    const hasRealPanels = a.panels.some(
      (p) => p.id !== 'open' && p.params?.region === 'panels',
    )
    if (hasRealPanels) return
    const host = rootPanelsGroup(a)
    if (host) {
      a.addPanel({
        id: 'open',
        component: 'open',
        title: OPEN_PANEL_TITLE,
        tabComponent: 'openTab',
        minimumWidth: RAIL_MIN_WIDTH,
        // 与出厂面板同形（min+max）——漏 max 会吃到比例摊分宽（2026-11-01 实锤）
        maximumWidth: RAIL_MAX_WIDTH,
        params: { region: 'panels' },
        position: { referenceGroup: host.id, index: 0 },
      })
    } else {
      // 组不在树里（存档异常/收走未收干净）→ 重建（colOrder 语义位对齐）
      a.addPanel({
        id: 'open',
        component: 'open',
        title: OPEN_PANEL_TITLE,
        tabComponent: 'openTab',
        minimumWidth: RAIL_MIN_WIDTH,
        maximumWidth: RAIL_MAX_WIDTH,
        params: { region: 'panels' },
        position: { referencePanel: 'workspace', direction: 'right' },
      })
      alignVisibleToOrder(a)
    }
  }, [])

  const handlePanelAdded = useCallback(
    (a: DockviewApi, panelId: string) => {
      if (anchorBusyRef.current) return
      // 复位进行中：锚生命周期整个让位（fromJSON 内部 clear+重建的自发
      // 事件不是用户动作——见 dockview-column-ops layoutResetInProgress）
      if (layoutResetInProgress()) return
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
      // 复位进行中：末签关闭的重建/anchor 复位是清场中间态，让位；
      // fromJSON 完成即成品树（实锤：不复位护栏会把 addPanel 打进半清树，
      // referencePanel 'workspace' does not exist）
      if (layoutResetInProgress()) return
      const removed = /* 移除前 region 已不可考——用 id 判面板栏域 */ panelId === 'open' || panelId === 'files' || isTerminalPanelId(panelId) || panelId.startsWith('preview')
      if (!removed) return
      // **ZCode 语义**（2026-11-01 用户："只有一个标签的时候是关闭是会关闭
      // 面板栏的"）：面板列不再有实签 = 关闭面板栏，锚不复活。'open' 自身
      // 被关（标签总览的 ✕）同样走这条——2026-11-01 实锤：早退分支漏记账，
      // 组被收走而 panelsHidden 仍是 false（重启后 normalize 误报）。
      // 锚只在「打开面板栏」（setPanelsHidden(false) → ensurePanelsAnchor）
      // 与出厂布局里出现。
      anchorBusyRef.current = true
      try {
        const hasRealPanels = a.panels.some(
          (p) => p.id !== 'open' && p.params?.region === 'panels',
        )
        if (!hasRealPanels) setPanelsHidden(true)
      } finally {
        anchorBusyRef.current = false
      }
    },
    [],
  )

  // ── 会话分栏（v7.4 完整聊天 dockview 版；2026-10-15 落点感知）：
  //   左栏动作开 session panel = 主栏分栏（direction right = 并排对话列）。
  //   跨面拖拽带落点（SessionTabDropPosition）：拖到哪个组、哪个方位就
  //   开在哪儿——center = 堆叠进该组；四边 = 向该边分栏。同会话不重复开
  //   → 置前。 ──────────────────────────────────────────────────────────
  useEffect(() => {
    setSessionTabOpener((threadId, drop?: SessionTabDropPosition) => {
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
      // 落点组已被拖拽后的布局重组销毁 → 回退默认（right of workspace），
      // 错误可见不静默（规矩 12）。
      const referenceGroup = drop ? a.groups.find((g) => g.id === drop.referenceGroup) : undefined
      if (drop && !referenceGroup) {
        console.error(`[dv-shell] 落点组 ${drop.referenceGroup} 不在场——回退默认分栏位`)
      }
      a.addPanel({
        id,
        component: 'session',
        title: tabName,
        minimumWidth: CHAT_MIN_WIDTH,
        params: { region: 'chat', threadId, tabName },
        position:
          drop && referenceGroup
            ? { referenceGroup: referenceGroup.id, direction: drop.direction }
            : { referencePanel: 'workspace', direction: 'right' },
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
        minimumWidth: RAIL_MIN_WIDTH,
        params: { region: 'panels', filePath },
        position: panelsDropPosition(a),
      })
      // 栏若处于「末签关闭已关栏」态，实签抵达即重新在场（ZCode 生命周期）
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
    })
    return () => setPreviewOpener(null)
  }, [])

  // ── 子代理详情链（subagent-detail-opener）：单实例 subagent 面板，
  // payload 走 params（工具结果/名册真值；rpi 子代理是进程内 ChildAgent，
  // 没有可切换的会话页——这里只展示它的真实数据） ──
  useEffect(() => {
    setSubagentDetailOpener((payload) => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——子代理详情放弃')
        return
      }
      const existing = a.getPanel('subagent')
      if (existing) {
        a.removePanel(existing)
      }
      a.addPanel({
        id: 'subagent',
        component: 'subagent',
        title:
          payload.name && payload.name !== '子代理'
            ? `子代理 · ${payload.name}`
            : '子代理',
        minimumWidth: RAIL_MIN_WIDTH,
        params: { region: 'panels', payload },
        position: panelsDropPosition(a),
      })
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
    })
    return () => setSubagentDetailOpener(null)
  }, [])

  // ── 状态面板详情面（status-pane-openers）：上游 side tab 的宿主对偶。 ──
  // 计划详情：每个计划条目一个面板（id 带 entryId），重复打开置前不新增。
  useEffect(() => {
    setPlanDetailOpener((payload) => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——计划详情放弃')
        return
      }
      const id = `plan-detail:${payload.entryId}`
      const existing = a.getPanel(id)
      if (existing) {
        existing.api.setActive()
        if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
        return
      }
      a.addPanel({
        id,
        component: 'plan-detail',
        title: payload.title ?? '会话计划',
        minimumWidth: RAIL_MIN_WIDTH,
        params: { region: 'panels', payload },
        position: panelsDropPosition(a),
      })
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
    })
    return () => setPlanDetailOpener(null)
  }, [])

  // 已结束智能体目录：单实例面板（数据在面板内自行订阅线程消息）。
  useEffect(() => {
    setAgentDirectoryOpener(() => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——智能体目录放弃')
        return
      }
      const existing = a.getPanel('agent-directory')
      if (existing) {
        existing.api.setActive()
        if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
        return
      }
      a.addPanel({
        id: 'agent-directory',
        component: 'agent-directory',
        title: '已结束的智能体',
        minimumWidth: RAIL_MIN_WIDTH,
        params: { region: 'panels' },
        position: panelsDropPosition(a),
      })
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
    })
    return () => setAgentDirectoryOpener(null)
  }, [])

  // 工作流实例详情 / 目录：单实例一个标签（runId 入 id），目录单实例。
  // 数据在页面内自行订阅线程消息（图被替换后如实空态）。
  useEffect(() => {
    setWorkflowRunOpener((payload) => {
      const a = apiRef.current
      if (!a) {
        console.error('[dv-shell] 布局 api 不在场——工作流实例放弃')
        return
      }
      const runId = payload.runId
      const id = runId === undefined ? 'workflow-directory' : `workflow-run:${runId}`
      const existing = a.getPanel(id)
      if (existing) {
        existing.api.setActive()
        if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
        return
      }
      a.addPanel({
        id,
        component: 'workflow-run',
        title: runId === undefined ? '工作流实例' : (payload.title ?? '工作流实例'),
        minimumWidth: RAIL_MIN_WIDTH,
        params: { region: 'panels', payload },
        position: panelsDropPosition(a),
      })
      if (columnFlagsOf().panelsHidden) setPanelsHidden(false)
    })
    return () => setWorkflowRunOpener(null)
  }, [])

  // ── 打开页动作（open-page-actions.ts 单源；面板栏标签条 + 号同源） ────────
  const onOpen = useCallback((kind: OpenPageKind) => {
    const a = apiRef.current
    if (!a) return
    openPagePanel(a, kind)
  }, [])

  // ── 插件贡献 → 例程面板（见模块级 routinesPaneSync 注释）────────────────
  useEffect(() => {
    const sync = () => {
      const a = apiRef.current
      if (!a) return
      const wanted = registry.getArea('panes').some((c) => c.id === 'hermes-bots:routines')
      const panel = a.getPanel('routines')
      if (wanted && !panel) {
        try {
          a.addPanel({
            id: 'routines',
            component: 'routines',
            title: '定时任务',
            position: { referencePanel: 'workspace', direction: 'right' },
            initialWidth: 320,
          })
        } catch (e) {
          console.error('[plugins] 例程面板创建失败', e)
        }
      } else if (!wanted && panel) {
        try {
          a.removePanel(panel)
        } catch (e) {
          console.error('[plugins] 例程面板移除失败', e)
        }
      }
    }
    routinesPaneSync = sync
    const unsub = registry.subscribeArea('panes', sync)
    sync()
    return () => {
      unsub()
      routinesPaneSync = null
    }
  }, [])

  // ── 面板深链宿主（2026-11-18）：host.revealPane / host.undismissPane 的
  //    真监听面。此前这两个事件**全仓无监听者**（审计实锤）——屏幕面板的
  //    "二次打开重新聚焦"与"关闭后例程面板复活"都是死动作。 ────────────
  useEffect(() => {
    const normalize = (raw: string) =>
      raw.startsWith('plugin-workspace:') ? raw.slice('plugin-workspace:'.length) : raw
    const reveal = (event: Event) => {
      const raw = String((event as CustomEvent<unknown>).detail ?? '').trim()
      if (!raw) return
      const a = apiRef.current
      if (!a) {
        console.error(`[plugins] revealPane(${raw})：dockview api 未就绪`)
        return
      }
      const panel = a.getPanel(raw) ?? a.getPanel(normalize(raw))
      if (!panel) {
        console.error(`[plugins] revealPane：面板 ${raw} 不在场`)
        return
      }
      panel.api.setActive()
    }
    const undismiss = (event: Event) => {
      const raw = String((event as CustomEvent<unknown>).detail ?? '').trim()
      if (!raw) return
      const a = apiRef.current
      if (!a) return
      if (a.getPanel(raw) ?? a.getPanel(normalize(raw))) {
        reveal(event)
        return
      }
      // `hermes-bots:routines` = 例程贡献面板：贡献仍在时由同步器重建。
      if (/:routines$/.test(raw)) {
        routinesPaneSync?.()
        return
      }
      console.error(`[plugins] undismissPane：面板 ${raw} 不在场且无重建路径`)
    }
    window.addEventListener('mirach:reveal-pane', reveal)
    window.addEventListener('mirach:undismiss-pane', undismiss)
    return () => {
      window.removeEventListener('mirach:reveal-pane', reveal)
      window.removeEventListener('mirach:undismiss-pane', undismiss)
    }
  }, [])

  const components = {
    leftrail: () => <LeftRailPane />,
    // 机器人弹出栏：hermes bots 插件（bundled）的窗格贡献若已注册就用它
    // （完整 Bot Mode：花名册/群聊/例程）；插件未加载/被禁用时回落到宿主
    // 原生移植版 BotsPane（2026-11-07 完整移植）。两条面都是真 UI。
    bots: () => <PluginPane contributionId="hermes-bots:pane" fallback={<BotsPane />} />,
    // 例程（bots 插件的 routines 贡献，Bot Mode 会话在屏时注册）。
    routines: () => <PluginPane contributionId="hermes-bots:routines" />,
    // 主区工作台（2026-10-26）：聊天 / 技能与工具 视图开关（hermes 的
    // `/skills` 顶级路由语义——SkillsPage 替换对话区，`App.tsx:166`）。
    workspace: () => <MainWorkspacePane />,
    session: (props: IDockviewPanelProps) => (
      <SessionThreadPane threadId={props.params.threadId} tabName={props.params.tabName} />
    ),
    files: () => <HermesFileTreePane />,
    // 终端：一个面板 = 一个会话（ZCode 侧栏终端标签语义），cwd 由开面板时
    // 定（params，存档恢复沿用）；缺省回退到当前活动会话 cwd。
    terminal: (props: IDockviewPanelProps) => (
      <TerminalPane
        api={props.api}
        cwd={typeof props.params?.cwd === 'string' ? props.params.cwd : undefined}
      />
    ),
    review: (props: IDockviewPanelProps) => <ReviewPanelHost {...props} />,
    // 电台（2026-11-15）：hermes radio 插件改成 dockview 窗格——宿主已撤除
    // 底栏（用户定稿），所以不再走状态栏注入。播放器随面板挂载/卸载，
    // 关面板即停止播放并释放音频资源（上游 `ctx.onDispose` 同语义）。
    radio: (props: IDockviewPanelProps) => <RadioPane onClose={() => props.api.close()} />,
    preview: (props: IDockviewPanelProps) => <HermesPreviewPane filePath={props.params.filePath ?? ''} />,
    subagent: (props: IDockviewPanelProps) => (
      <SubagentDetailPane payload={props.params.payload ?? {}} />
    ),
    // 状态面板的两个详情面（上游 side tab 对偶）：计划详情 / 已结束智能体目录。
    'plan-detail': (props: IDockviewPanelProps) => (
      <PlanDetailPane payload={props.params.payload ?? { entryId: '', markdown: '' }} />
    ),
    'agent-directory': () => <AgentDirectoryPane />,
    // 工作流实例详情 / 目录（单实例 = payload.runId；省略 = 目录）。
    'workflow-run': (props: IDockviewPanelProps<{ payload?: { runId?: string } }>) => (
      <WorkflowRunDetailPane
        runId={
          typeof props.params.payload?.runId === 'string'
            ? props.params.payload.runId
            : undefined
        }
      />
    ),
    // 插件工作区（`host.openWorkspace` 的门；hermes-bots 群聊房间走这条）。
    'plugin-workspace': (props: IDockviewPanelProps<{ workspaceId?: string }>) => (
      <PluginWorkspacePane {...props} />
    ),
  }

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const a = event.api
      apiRef.current = a
      // 例程面板：插件贡献可能早于 api 就绪注册（boot 顺序），这里补一次。
      routinesPaneSync?.()
      // 调试句柄（__flModel 同惯例）：E2E/CDP 从 api 驱动，不猜 DOM
      ;(globalThis as { __dvApi?: DockviewApi }).__dvApi = a
      // 语义归属准入（v8.1 拖拽平移轮，2026-10-14）：M1 的 onWillDragPanel/
      // onWillDragGroup 全禁撤除——面板栏标签拖出分栏/浮动恢复原生（用户
      // 原话："标签和会话条没法拖拽出来分栏了"）。左/主栏组 hideHeader 无
      // 条 → 本就没有可拖的标签面，无需 per-panel 拦截。
      // 唯一例外 = 根面板「打开」：它是面板列存在的锚（锚缺席 = 面板列无
      // 宿主，v8.0 生命周期），拖走 = 不经旗标地拆列——整钮拦截。
      a.onWillDragPanel((e) => {
        if (e.panel.id === 'open') e.nativeEvent.preventDefault()
      })
      // 唯一的「非法面」= 内容区中心堆叠进 hideHeader 组：无条组收下第二
      // 个标签后不可见也不可切（隐形标签死结）——onWillShowOverlay（拖拽
      // 中不显示落点）+ onWillDrop（松手兜底拒绝）双缝拦。
      // 分栏（top/bottom/left/right）与有条组的堆叠、浮动、整组拖拽全部
      // 放行（dockview 原生行为）。
      const denyStackIntoHeaderless = (kind: string, position: string, group: unknown): boolean => {
        if (kind !== 'content' || position !== 'center') return false
        const g = group as { model?: { header?: { hidden?: boolean } } } | undefined
        return g?.model?.header?.hidden === true
      }
      // **左栏不是拖拽目标**（用户 2026-10-22 定稿："左栏不能分栏和被拖进
      // 标签，我说的是面板栏"）：左栏是会话列表，语义上是固定的一栏，
      // 任何标签拖进去/在它周围分栏都会破坏"左栏恒占端位"的布局定式。
      // 判据 = 组内有 left 域面板（`params.region === 'left'`）。
      const isLeftRailGroup = (group: unknown): boolean => {
        const g = group as { panels?: { params?: { region?: string } }[] } | undefined
        return g?.panels?.some((p) => p.params?.region === 'left') ?? false
      }
      // **必须 accept 未处理的 drag-over**（2026-10-22 实锤，拖不出分栏的根因）：
      // dockview 的 `canDisplayContentOverlay` 最后一步是 `canDisplayOverlay`，
      // 后者触发 `onUnhandledDragOver` 并**只看 `event.isAccepted`**——
      // `AcceptableEvent` 默认 `_isAccepted = false`。没有监听者调用 `accept()`
      // 时，**所有**内容区落点（含四个分栏方向）都被判定为"不允许"：overlay
      // 不显示、drop 不生效，标签只能拖回原组（表现为"拖不出来"）。
      // 所以这里要显式接受——除了上面那两条例外。
      a.onUnhandledDragOver((e) => {
        if (denyStackIntoHeaderless(e.target, e.position, e.group)) return
        if (isLeftRailGroup(e.group)) return
        e.accept()
      })
      a.onWillShowOverlay((e) => {
        if (denyStackIntoHeaderless(e.kind, e.position, e.group)) e.preventDefault()
        if (isLeftRailGroup(e.group)) e.preventDefault()
      })
      // **单面板组的拖出分栏必须自己接管**（2026-10-22 实锤）：
      // dockview 的 `_doMoveGroupOrPanel` 在 `sourceGroup.size < 2` 时走
      // 「整组移动」分支——同一层里 `moveView` 换位，**不拆新组**。面板栏
      // 常态只有一个标签，于是"把面板栏的标签拖出来分栏"永远只是换位，
      // 用户看到的就是"拖不出来"。
      // 这里在分栏位（top/bottom/left/right）且源组只有这一个面板时，
      // 阻止 dockview 的默认处理，自己 addPanel 到目标组的分栏位——语义
      // 与「源组有 2+ 面板」时 dockview 自己的行为一致。
      a.onWillDrop((e) => {
        if (denyStackIntoHeaderless(e.kind, e.position, e.group)) {
          e.preventDefault()
          return
        }
        // 左栏既不接收标签也不参与分栏
        if (isLeftRailGroup(e.group)) {
          e.preventDefault()
          return
        }
        if (e.kind !== 'content') return
        const position = e.position
        if (position === 'center') return
        const data = e.getData()
        const target = e.group
        const panelId = data?.panelId
        if (!panelId || !target) return
        const source = a.getPanel(panelId)
        if (!source) return
        // 只有**面板栏**的标签能拖出分栏（左栏无标签；对话栏标签是会话，
        // 拖出去由 dockview 原生分栏处理）
        if (source.params?.region !== 'panels') return
        // 源组 > 1 个面板：dockview 自己就能正确拆组，不接管
        if (source.group.panels.length > 1) return
        // 同组内换位由 dockview 处理（拖到自身组的边缘 = 无操作）
        if (source.group.id === target.id) return
        // 接管：阻止 dockview 的"单面板组 = 整组移动"默认行为
        e.preventDefault()
        // 分栏期间的重摊是 dockview 的几何让位，不是用户意图——期间不记
        // 目标宽（否则左栏被顶到 400 就会被当成新目标，钉不回来）。
        splitBusyRef.current = true
        // **分栏前的宽度只作参考，不作目标**：dockview 的重摊会把左栏顶到
        // max（400），如果直接把它当目标就等于接受了污染值。这里只在当前宽
        // 落在许可区间内、且**不等于 max**时才沿用，否则回落到默认宽 300
        // ——与"默认尺寸 300"的用户语义一致。
        for (const g of a.groups) {
          const region = g.panels[0]?.params?.region
          if (region !== 'left' && region !== 'panels') continue
          const w = Math.round(g.width)
          if (w <= 0) continue
          const atMax = Math.abs(w - RAIL_MAX_WIDTH) <= 1
          setRailTargetWidth(region, atMax ? RAIL_DEFAULT_WIDTH : w)
        }
        try {
          splitPanelOut(a, panelId, target.id, position)
        } finally {
          // **定时轮询钉宽**（2026-10-22 实测）：分栏触发的 relayout 分几步
          // 完成（addPanel → moveTo → 关占位 → 父 branch 重算），固定 150ms
          // 常常还停在中间态（左栏被顶到 max）。这里每 150ms 钉一次、连钉
          // 8 次（~1.2s）后解锁。
          //
          // **必须是定时器、不能挂在 onDidLayoutChange 里**：setSize 会同步
          // 再触发那个回调，在回调里再 setSize 就是无界循环——实测把主线程
          // 冻死（"软件卡死动不了"）。定时器在事件循环的下一轮执行，安全。
          // `repinRailWidths` 自身幂等（宽度已对就跳过），所以连钉不会抖动。
          let ticks = 0
          const tick = () => {
            repinRailWidths()
            ticks += 1
            if (ticks < 8) {
              setTimeout(tick, 150)
            } else {
              splitBusyRef.current = false
            }
          }
          requestAnimationFrame(tick)
        }
      })
      // 打开页生命周期 + 持久化（先订阅再灌布局——boot 布局事件也要记账）
      a.onDidAddPanel((p) => handlePanelAdded(a, p.id))
      a.onDidRemovePanel((p) => handlePanelRemoved(a, p.id))
      // 机器人弹出栏开合同步（✕ 关闭 / 存档恢复都走这条——store 是
      // Mirach 按钮态的唯一直观源）
      a.onDidAddPanel((p) => {
        if (p.id === BOTS_PANEL_ID) botsPanelStore.getState().setOpen(true)
      })
      a.onDidRemovePanel((p) => {
        if (p.id === BOTS_PANEL_ID) botsPanelStore.getState().setOpen(false)
        // 插件工作区关标签 → 回调插件 onClose + 清记录（plugin-workspaces）。
        workspacePanelClosed(p.id)
      })
      let persistTimer: ReturnType<typeof setTimeout> | null = null
      a.onDidLayoutChange(() => {
        if (hydratingRef.current) return
        // **绝不能在布局回调里 setSize**（2026-10-22 实锤：把应用冻死）。
        // `setSize` 会同步再触发本回调，形成无界递归/循环，主线程再也回不到
        // 事件循环——表现就是"软件卡死动不了"，只能强杀进程。
        // 分栏后的栏宽收敛一律走 `splitPanelOut` 之后那串**有上限的定时轮询**
        // （见 onWillDrop 里 tick 的实现），那里不在布局回调栈里。
        if (splitBusyRef.current) return
        // 两轨目标宽跟随用户拖拽（sash）：dockview 按比例存宽，所以目标宽
        // 必须自己记绝对值，窗口缩放后才能钉回同一个数（repinRailWidths）。
        // **只在主栏没被挤到 min 时记**（2026-10-22 实锤）：窗口窄到主栏
        // 撞 CHAT_MIN_WIDTH 时，dockview 会强行压窄某一轨（1000 宽窗口下
        // 左栏从 300 变 293）——那是几何让位，不是用户意图。把它记成新
        // 目标宽会导致窗口恢复后栏宽永久停在 293。
        const chatGroups = a.groups.filter((g) => g.panels[0]?.params?.region === 'chat')
        const chatAtMin = chatGroups.some((g) => Math.round(g.width) <= CHAT_MIN_WIDTH + 1)
        if (!chatAtMin) {
          for (const g of a.groups) {
            const region = g.panels[0]?.params?.region
            if (region !== 'left' && region !== 'panels') continue
            const w = Math.round(g.width)
            if (w > 0) setRailTargetWidth(region, w)
          }
        }
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
        a.fromJSON(saved ?? factoryLayout(a.width, a.height))
        // 插件工作区面板是窗口内记录（render 是插件闭包）——存档恢复出来的
        // 孤儿面板在这里剪掉；必须在 hydrate 窗口内、React 挂载前关（组件
        // 自己 close 会撞上 fromJSON 恢复过程抛 "invalid operation"）。
        pruneOrphanWorkspacePanels(a)
        // 终端面板**保持挂载**（`renderer: 'always'`）——旧存档里的终端面板
        // 没有这个标记，恢复时补写：切到别的标签/收起侧栏时终端不卸载、
        // PTY 不中断（ZCode side pane terminal 的 keepalive 语义）。
        for (const p of a.panels) {
          if (isTerminalPanelId(p.id) && p.api.renderer !== 'always') {
            p.api.setRenderer('always')
          }
        }
        // **打开页标签名以代码为准，不认存档**（2026-10-31）。
        //
        // 用户："打开页的标题把打开换个说明文字"。改 `addPanel` 的 title 只
        // 影响**新建**的锚；`fromJSON(saved)` 会用存档里持久化的旧 title，
        // 所以老用户升级后仍看到「打开」（实测：清 localStorage 后重启，
        // 首帧又写回了旧值——因为 fromJSON 读的是上一轮存档）。
        //
        // 修法 = 恢复后无条件覆写。这样 title 是**代码的常量**，与存档解耦；
        // 下次持久化自然写回新值。
        a.getPanel('open')?.api.setTitle(OPEN_PANEL_TITLE)
        // 两轨宽度**按绝对值**钉回（2026-10-22）：dockview 存档按比例记宽，
        // 恢复时如果窗口尺寸和存的时候不同（用户拖过窗口 / 换屏），300 会
        // 按比例缩成 270 之类——与"默认 300"冲突。所以无论出厂还是存档，
        // 都把两轨钉回目标宽（默认 300；用户拖过的宽由 onDidLayoutChange
        // 记在 railTargetWidth 里，本函数之后照常消费）。收起态（宽 0）不钉。
        const lg = a.groups.find((g) => g.panels.some((p) => p.params?.region === 'left'))
        const pg = a.groups.find((g) => g.panels.some((p) => p.params?.region === 'panels'))
        const left = leftRailDefaultWidth()
        const panels = panelsRailDefaultWidth()
        for (let i = 0; i < 3; i++) {
          if (pg && Math.round(pg.width) > 0) pg.api.setSize({ width: panels })
          if (lg && Math.round(lg.width) > 0) lg.api.setSize({ width: left })
        }
      } finally {
        hydratingRef.current = false
      }
      // boot 自愈（旗标 vs 实际树；列序对齐）。**关动画**：boot 期按旗标
      // 补藏/对齐是恢复既有形态，不是用户点动作——首帧看到"栏滑出去"是
      // 假象（2026-10-18 收放动画接入时同改）。
      withoutColumnMorph(() => {
        normalizeColumns()
        // 面板列缺席但旗标未藏（normalizeColumns 收敛过旗标）→ 一致性兜底：
        // 打开页锚重建（隐藏语义交给菜单动词，boot 只保证锚在场）
        restoreOpenAnchor(a)
      })
    },
    [handlePanelAdded, handlePanelRemoved, restoreOpenAnchor],
  )

  // ── 栏宽在窗口缩放时保持绝对值（2026-10-22）────────────────────────────────
  // dockview 按比例分配列宽：窗口从 1760 缩到 1400，300 的栏会自己缩成 240
  // 左右。用户定稿的语义是"栏宽 = 300 定值，min 270 / max 400"——与窗口大小
  // 无关。所以窗口尺寸稳定后把两轨钉回目标宽（主栏吃剩余）。
  //
  // 防抖 200ms：拖窗口边框时每秒几十次 resize，逐次 relayout 会抖。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        repinRailWidths()
      }, 200)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // ── 窗口拖动（M1 漏迁后从 flex-layout 原样回迁，2026-10-14）──────────────
  // window 捕获段按命中面分派：顶带（--logo-strip-h=75）内非交互面拖窗口、
  // 双击最大化；绝不改用绝对定位盖层——盖层会截胡顶带内页签 pointerdown
  //（2026-09-29 定稿）。
  // 75 必须与 tokens.css 的 --logo-strip-h 同值（2026-10-19：85 → 75）；
  // 卡片化后顶带整体下移 --pane-edge(10)——窗边 7.5（.app-main）+
  // 卡片内 2.5（.dv-view），可拖区的下界 = 10 + 75。改间距令牌必须同步这里。
  //
  // **再叠加透明边距**（2026-10-23）：窗口投影改 CSS 画之后壳从
  // `--shell-shadow-margin`(40) 处开始，clientY 是相对**窗口矩形**的，
  // 所以要加这条边距。最大化态令牌被覆盖成 0，判定自动回到贴屏边。
  // 令牌读不到时按 0 处理（不是兜底——`--shell-shadow-margin` 是
  // tokens.css 的常量，读不到说明样式没注入，那时整个界面都是坏的）。
  const TOP_BAND_PX = 85
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
      // 顶带内的面空白才拖窗（下界随透明边距下移）
      const margin =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--shell-shadow-margin')) || 0
      if (e.clientY > margin + TOP_BAND_PX) return
      // .app-main：卡片化后顶带里 10px 的栏间留白是主区，不是壳
      const onBandSurface =
        t.closest('.app-shell, .app-main, .rail-logo-leading, .left-rail-logo-row, .app-titlebar') !== null
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
  // .app-shell/Titlebar/ResizeHandles 全丢，2026-10-14 实锤补回）：
  // AssistantRuntime 包壳（左栏 useAui / AuiIf 依赖壳级 runtime provider）→
  // .app-shell（白底圆角窗）→ ResizeHandles + Titlebar（圆点浮层）+
  // .app-main（dockview 主区）。
  // 2026-10-19 用户："底栏不要了" —— StatusBar 整条撤除（占位 pill 从未接
  // 真数据；三栏卡片化后底栏还会切断卡片的下边距）。
  return (
    <AssistantRuntime>
      <div className="app-shell">
        {/* 全局快捷键派发器（2026-10-24 设置页「键盘快捷键」移植）：
            必须挂在 AssistantRuntime 内——session.new 要 aui 上下文。 */}
        <GlobalKeybinds />
        <ResizeHandles />
        <Titlebar />
        <div className="app-main dockview-host" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <DockviewReact
            // open 必须在注册表内（FACTORY 引用 contentComponent 'open'——缺键 =
            // ReactPart 抛 "Only React.memo..." → fromJSON 整体回退空布局）
            components={{ ...components, open: () => <OpenPage onOpen={onOpen} /> }}
            tabComponents={{ openTab: OpenTabHeader }}
            // 标签条溢出样式（用户 2026-10-15："面板栏的标签页样式不是 tabs
            // 里的 overflow 样式吗，之前的下拉选标签页的组件也保留"）：
            // 原生 ⋮N 下拉关闭（disableTabsOverflowList）→ beUI TabsList
            // 语义 = 横滚 + 两端渐隐 + 左右箭头（tab-strip-arrows.tsx，左挂
            // prefix、右与总览钮并排挂 right）；标签总览下拉（cmdk 检索 +
            // 关闭）保留为检索通道。
            disableTabsOverflowList
            // **标签条左右分工**（2026-11-01 用户纠正，前一版我放反了）：
            //
            //   [标签总览 ▾] [标签1 标签2 …] [+] [右箭头]
            //     ↑ 左：点开选标签            ↑ 右：新建面板
            //
            // 用户原话："标签的前面应该有个按钮，点击能打开，选择标签，这个
            // 组件不是已经做过了吗？加号应该在标签的右面啊"。
            //
            // dockview 的槽位语义（core `headerActionsService.ts` 的
            // SLOT_OPTION_KEY，DOM 序实测 pre-actions | tabs | left-actions
            // | void | right-actions）：
            //   prefix → dv-pre-actions-container  = tabs **之前** → 总览钮
            //   left   → dv-left-actions-container = tabs **之后** → 加号
            //   right  → dv-right-actions-container = 条最右 → 溢出箭头
            prefixHeaderActionsComponent={TabStripLeading}
            leftHeaderActionsComponent={TabStripTrailing}
            rightHeaderActionsComponent={TabStripRightSide}
            // 落点方位判定 = hermes radial 几何（drop-geometry.ts）：dockview
            // 内置 quadrant 是固定 20% 带 + 先横后纵（左下角 (15%,90%) 判
            // left），用户报「上下分栏判定不灵敏」的根因——换径向判定：
            // 中心椭圆 = center，椭圆外按归一化主轴主导（角区沿对角线倒向
            // 最近边）。组内容目标与整布局边缘目标同源消费（源码实证：
            // 两者都读 host.options.dropPositionResolver）。
            dropPositionResolver={radialDropResolver}
            // DnD 后端 = pointer（保留既有已验证行为；理由已随运行时换代更新）
            //
            // 历史：CEF 152 窗口模式下 HTML5 DnD 的 drop 事件根本不派发
            // （裸 <div draggable> 最小对照实测 dragstart=1/dragover=38/
            // drop=0），故当年切 pointer 自绘拖拽。
            // **2026-10-22 换回 wry/WebView2 后同一对照实测 drop=1** ——
            // 那个平台缺口不存在了。这里仍留 pointer，是为了**不改动已验收
            // 的拖拽行为**（pointer 全输入类型统一路径，与当年 E2E 一致）。
            // 若要恢复 dockview 默认（`'auto'`：鼠标走 HTML5、触摸/笔走
            // pointer，且 popout 跨窗拖拽与原生 drag image 可用），删掉本行
            // 即可——WebView2 下已验证可行。
            dndStrategy="pointer"
            onReady={onReady}
            className="dockview-theme-light"
          />
        </div>
      </div>
    </AssistantRuntime>
  )
}
