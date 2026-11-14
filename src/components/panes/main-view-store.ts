/**
 * 主区视图开关（2026-10-26，2026-10-29 加 cron）——hermes 的 `/skills` 与
 * `/cron` 都是**顶级路由**：侧栏点「Skills」/「定时任务」→ 主内容区整体换成
 * 对应页面，聊天不再可见（`apps/desktop/src/app/routes.ts:69,73`，路由懒加载）。
 * 宿主没有 react-router，主内容区是 dockview 的 `workspace` 面板——所以用
 * 这个 store 表达"主区当前显示什么"。
 *
 * 回到聊天的路径（与 hermes 同语义）：
 * - 侧栏点某个会话（thread-list 行点击 = resume → `showChat()`）；
 * - 侧栏点「新建会话」（entry-bar 的 newThread 动作 → `showChat()`）；
 * - 页面自己的关闭钮（cron 页的 `onClose`）。
 *
 * **为什么 workspace 组件保持挂载只隐藏**：对话流式输出运行在
 * AssistantThreadPane 里，路由式卸载会在 run 进行中把流 UI 拆掉（hermes
 * 的 ChatPage 在嵌入式形态下也是常驻的——`App.tsx:148` "Chat is rendered
 * persistently"）。所以切到技能页/定时任务页时聊天只是 `display:none`，
 * run 不中断；切回来时流式内容原样在。
 */
import { createStore, useStore } from 'zustand'

export type MainView = 'chat' | 'capabilities' | 'cron'

interface MainViewState {
  view: MainView
  setView: (view: MainView) => void
  showChat: () => void
}

export const mainViewStore = createStore<MainViewState>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  showChat: () => set({ view: 'chat' }),
}))

export function useMainView<T>(selector: (s: MainViewState) => T): T {
  return useStore(mainViewStore, selector)
}
