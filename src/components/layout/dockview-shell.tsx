/**
 * dockview 壳（v8.0 M1 骨架）——替换 flex-layout.tsx 的迁移起点。
 *
 * 三栏出厂布局：[左栏 | 主栏 | 面板栏]，面板栏唯一多标签（docs/layout-v8.md）。
 * 本骨架只落**结构与出厂布局 + 打开页动作**——语义迁移（分栏/会话指派/
 * 根面板守卫/colOrder 动词）在后续轮次逐项平移（映射表见 docs/architecture.md §2）。
 *
 * dockview 8.5.1 实测类型事实（对型依据，勿凭旧版文档写）：
 * - 序列化 leaf data 是**组视图状态** GroupPanelViewState：`{ id（组 id）,
 *   views: [panelId…] }`——panel 内容（contentComponent/params）在 panels
 *   记录里声明，组按 id 引用；
 * - 组级 **hideHeader: true** = 无标签条（左栏/主栏 v8 无标签的原生实现）；
 * - grid.orientation 是 dockview-core 的 **Orientation 枚举**（裸字符串不赋型）；
 * - SerializedDockview.grid 的 height/width 必填；
 * - dockview-react 不再导出 Orientation（从 dockview-core 导入）；
 * - 拖拽拦截 = api.onWillDragPanel/onWillDragGroup（react 层无此 prop）；
 * - params 必须可序列化——回调（OpenPage 的 onOpen）经组件闭包注入，不进 params。
 *
 * 与 flex-layout.tsx 并存策略：两壳不同时挂载（本组件暂未被 app/index.tsx
 * 消费——M1 迁移完成时切换挂载点、卸载 flex-layout）。
 */
import {
  DockviewReact,
  DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewApi,
  type SerializedDockview,
} from 'dockview-react'
import { Orientation } from 'dockview-core'
import { useRef } from 'react'

import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { SessionThreadPane } from '@/components/panes/session-thread-pane'
import { LeftRailPane } from '@/components/panes/left-rail-pane'
import { HermesFileTreePane } from '@/components/panes/hermes-sidebar/hermes-file-tree-pane'
import { ReviewPane } from '@/components/panes/review-pane'
import { TerminalPane } from '@/components/panes/terminal-pane'
import { OpenPage, type OpenPageKind } from '@/components/panes/open-page'
import { AssistantRuntime } from '@/components/assistant-ui/runtime'

/** 出厂布局（三栏）：[左栏 | 主栏 | 面板栏]；左栏/主栏组 hideHeader（无
 *  标签条，v8 定稿），面板栏出厂单签 open（打开页宿主，唯一多标签列）。
 *  width/height 为设计值，dockview 加载时按容器实际尺寸归一。 */
const FACTORY_LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { id: 'g-left', views: ['leftrail'], hideHeader: true } },
        { type: 'leaf', data: { id: 'g-chat', views: ['workspace'], hideHeader: true } },
        { type: 'leaf', data: { id: 'g-panels', views: ['open'] } },
      ],
    },
    height: 1000,
    width: 1800,
    orientation: Orientation.HORIZONTAL,
  },
  panels: {
    leftrail: { id: 'leftrail', contentComponent: 'leftrail', title: '', params: { region: 'left' } },
    workspace: { id: 'workspace', contentComponent: 'workspace', title: '', params: { region: 'chat' } },
    open: { id: 'open', contentComponent: 'open', title: '打开', params: { region: 'panels' } },
  },
}

/** 打开页三按钮的落点：开/激活对应 panel 于面板栏组。preview → review 组件
 *  （flexlayout 时代同映射：预览窗格 = ReviewPane）。 */
const OPEN_KIND_PANEL: Record<OpenPageKind, { id: string; component: string; title: string }> = {
  files: { id: 'files', component: 'files', title: '文件树' },
  terminal: { id: 'terminal', component: 'terminal', title: '终端' },
  preview: { id: 'review', component: 'review', title: '预览' },
}

/** panel 组件注册表（key = dockview contentComponent 名）。session 分栏 =
 *  v7.4 完整聊天（useThreadChatRuntime），栈无关原样平移。 */
const components: Record<string, (props: IDockviewPanelProps) => React.ReactElement> = {
  leftrail: () => <LeftRailPane />,
  workspace: () => <AssistantThreadPane />,
  session: (props) => (
    <SessionThreadPane threadId={props.params.threadId} tabName={props.params.tabName} />
  ),
  files: () => <HermesFileTreePane />,
  terminal: () => <TerminalPane />,
  review: () => <ReviewPane />,
}

export function DockviewShell() {
  const apiRef = useRef<DockviewApi | null>(null)

  const onOpen = (kind: OpenPageKind) => {
    const api = apiRef.current
    if (!api) return
    const target = OPEN_KIND_PANEL[kind]
    try {
      const existing = api.getPanel(target.id)
      if (existing) {
        existing.api.setActive()
        return
      }
      api.addPanel({
        ...target,
        params: { region: 'panels' },
        // 锚 open panel 所在组（组 id 由 fromJSON 归一，不依赖出厂命名）
        position: { referencePanel: 'open' },
      })
    } catch (e) {
      ;(window as unknown as { __dvErr?: string }).__dvErr = String(e)
    }
  }

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api
    // 调试句柄（__flModel 同惯例）：E2E/CDP 从 api 驱动，不猜 DOM
    ;(window as unknown as { __dvApi?: DockviewApi }).__dvApi = event.api
    // 语义归属准入（v8）：M1 骨架先全禁拖拽（左栏/主栏本就不可拖，面板栏
    // 页签的跨区准入规则在语义平移轮按 params.region 放行）
    event.api.onWillDragPanel((e) => e.nativeEvent.preventDefault())
    event.api.onWillDragGroup((e) => e.nativeEvent.preventDefault())
    event.api.fromJSON(FACTORY_LAYOUT)
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  // AssistantRuntime 包壳（flex-layout 同款）：左栏 useAui / Thread 的
  // AuiIf 都依赖壳级 runtime provider——不包则 AuiProvider 错误整树卸载。
  return (
    <AssistantRuntime>
      <div className="dockview-host" style={{ height: '100%' }}>
        <DockviewReact
          components={{
            ...components,
            open: () => <OpenPage onOpen={onOpen} />,
          }}
          onReady={onReady}
          className="dockview-theme-light"
        />
      </div>
    </AssistantRuntime>
  )
}
