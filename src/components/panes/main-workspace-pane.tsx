/**
 * 主区工作台（2026-10-26，2026-10-29 加 cron）——dockview `workspace` 面板的
 * 内容，按 `main-view-store` 的视图在 **聊天** / **技能与工具** / **定时任务**
 * 之间切换。
 *
 * 对应 hermes 的路由形态：`/skills`（SkillsPage）与 `/cron`（CronView）各自
 * 替换 `/chat`（`apps/desktop/src/app/routes.ts:69,73`）。宿主没有 router，
 * 主内容区 = dockview 的 workspace 面板，所以这里做等价的视图开关。
 *
 * **聊天保持挂载**（`display:none` 隐藏而不是卸载）：流式 run 运行在
 * AssistantThreadPane 里，卸载会拆掉流 UI；hermes 嵌入式形态下 ChatPage
 * 同样常驻（`App.tsx:148` "Chat is rendered persistently (outside
 * <Routes>)"）。`display:contents` 让包装层在布局里透明（子元素直接成为
 * dockview 容器的布局子项，不引入多余盒子）。
 */
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { CapabilitiesPane } from '@/components/panes/capabilities-pane'
import { CronPane } from '@/components/panes/cron-pane'
import { useMainView } from '@/components/panes/main-view-store'

export function MainWorkspacePane() {
  const view = useMainView((s) => s.view)
  return (
    <>
      <div
        className={view === 'chat' ? 'main-view-slot' : 'main-view-slot main-view-slot--hidden'}
        aria-hidden={view !== 'chat'}
        // 隐藏的聊天树不参与焦点序（Tab 不会落到看不见的输入框）
        inert={view !== 'chat'}
      >
        <AssistantThreadPane />
      </div>
      {view === 'capabilities' && <CapabilitiesPane />}
      {view === 'cron' && <CronPane />}
    </>
  )
}
