/**
 * ui-settings — 通用设置（对话宽度等 UI 级偏好）的持久化状态。
 *
 * 形状照抄 dsh mirach 的 src/store/ui-settings.ts（2026-10-05 移植，仅取
 * 对话宽度切片——chatStyle/enterBehavior 等其余 atom 是 dsh 应用专属功能，
 * harness 无消费方不搬）；状态库从 dsh 的 nanostores atom 换成本工程定稿
 * 的 Zustand（消费方约定见 store/layout-store.ts 头注释）。
 */

import { create } from 'zustand'

import {
  applyChatWidth,
  getChatWidth,
  setChatWidth as persistChatWidth,
  type ChatWidth,
} from '@/lib/chat-width'

interface UiSettingsStore {
  /** 对话宽度三档（zosma 820/1080/无限制） */
  chatWidth: ChatWidth
  setChatWidth(width: ChatWidth): void
}

export const useUiSettings = create<UiSettingsStore>()((set) => ({
  chatWidth: getChatWidth(),
  setChatWidth: (width) => {
    set({ chatWidth: width })
    persistChatWidth(width)
    applyChatWidth(width)
  },
}))

/** 应用启动时一次性初始化（对话宽度 CSS 变量，main.tsx 调用） */
export function initUiSettings(): void {
  applyChatWidth(useUiSettings.getState().chatWidth)
}
