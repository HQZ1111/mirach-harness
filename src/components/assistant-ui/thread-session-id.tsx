import { createContext, useContext } from 'react'

/**
 * 会话 pane → composer 的会话 id 通道。
 *
 * 主 runtime 用 `threadListAdapter.threadId` 把当前会话告诉 assistant-ui，
 * `threadListItem.id` 就是落盘 id；**分栏 runtime（session-runtime.ts）没有
 * thread adapter**，`threadListItem.id` 恒为 assistant-ui 的
 * `DEFAULT_THREAD_ID` —— composer 的会话级能力（审批模式芯片、插件
 * `composer.top` 贡献的 `useComposerSession`）必须拿到真实 id，所以由 pane
 * 显式提供。
 *
 * 值 = 落盘会话 id（宿主 sessionCatalog 的键）；null = 由 threadListItem
 * 兜底（主 runtime）。
 */
const ThreadSessionIdContext = createContext<null | string>(null)

export const ThreadSessionIdProvider = ThreadSessionIdContext.Provider

export const useThreadSessionId = (): null | string => useContext(ThreadSessionIdContext)
