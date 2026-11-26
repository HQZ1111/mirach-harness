/**
 * 待落点的 bot 新聊天草稿（2026-11-26 用户："hermes 也是这样吗 / 对齐啊，做啊"）。
 *
 * hermes 的 `host.newChat` 是 **fresh chat draft**（`openNewSessionTab`，
 * `listed:false`），不是立即 `session.create`。宿主没有插件草稿标签的独立
 * 数据面，等价物 = 主对话 New Chat 草稿：先只记下"这个草稿属于哪个 bot"，
 * 等第一条消息（或用户先选工作区文件夹）再由 `ensureDraftSession` 用该 bot
 * 的 SOUL/模型/工具集 + 选中 cwd 建真会话。
 *
 * 只有插件 `newBotChat`（`host.newChat(route,{workspaceMode:'bots',
 * workspaceOwnerKey})`）走这里；配置栏「在新分栏打开」仍是立即建会话列。
 */
import { createStore } from 'zustand'

export interface PendingBotChat {
  /** bot/profile 名（`default` = 本体 Mirach）。 */
  profile: string
}

interface PendingBotChatState {
  pending: PendingBotChat | null
  set(pending: PendingBotChat | null): void
}

export const pendingBotChatStore = createStore<PendingBotChatState>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}))
