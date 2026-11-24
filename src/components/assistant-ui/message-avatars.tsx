/**
 * 对话区消息头像（2026-11-23 用户："现在的对话显示能加入头像系统吗，用户一个
 * 头像，ai也有头像"）。
 *
 * - 用户头像 = 设置 → 形象选择的图（`lib/user-avatar.ts`）。
 * - AI 头像 = 当前会话若属于某个 bot，用该 bot 的 image（默认 Mirach bot 已
 *   内置 `/brand/logo.png`）；普通会话/无图 bot 回落 Mirach 品牌 logo。
 *
 * 不 import hermes-bots 插件的 BotFace：插件可被关闭，消息层不能依赖它。
 */
import { useAuiState } from '@assistant-ui/react'
import { useStore } from 'zustand'

import { botDisplayName, botsStore } from '@/components/panes/hub/bots-store'
import { useThreadSessionId } from '@/components/assistant-ui/thread-session-id'
import { usePersona } from '@/lib/persona-store'
import { useUserAvatar } from '@/lib/user-avatar'
import { cn } from '@/lib/utils'

export const AI_AVATAR_FALLBACK = '/brand/logo.png'

/** 2026-11-23 用户："头像太小"——26px → 36px → 45px；同日再定稿 40px
 *  （名字行同高，中线仍对齐）。 */
const AVATAR_CLASS = 'border-(--stroke-soft) size-[40px] shrink-0 rounded-full border object-cover'

export function UserMessageAvatar({ className }: { className?: string }) {
  const src = useUserAvatar()

  return <img alt="" aria-hidden className={cn(AVATAR_CLASS, className)} src={src} />
}

/** 当前会话的 bot（分栏 pane 用显式会话 id，主 pane 用 threadList id）。 */
function useSessionBot() {
  const scopedId = useThreadSessionId()
  const auiId = useAuiState((s) => s.threadListItem.id)
  const threadId =
    scopedId ?? (auiId === 'DEFAULT_THREAD_ID' || auiId === '__DEFAULT_ID__' ? null : auiId)
  const bots = useStore(botsStore, (s) => s.bots)

  return threadId ? bots.find((b) => b.chatSessionId === threadId) : undefined
}

export function AiMessageAvatar({ className }: { className?: string }) {
  const bot = useSessionBot()
  const src = bot?.image?.trim() || AI_AVATAR_FALLBACK
  const alt = bot ? botDisplayName(bot) : 'Mirach'

  return <img alt={alt} className={cn(AVATAR_CLASS, className)} src={src} />
}

/** 用户身份名（设置 → 个性 → 显示名称；未设置时「你」）。 */
export function useUserIdentityName(): string {
  const name = usePersona((s) => s.displayName)
  const trimmed = (name ?? '').trim()

  return trimmed || '你'
}

/** AI 身份名：所属 bot 的显示名；普通会话 = Mirach。 */
export function useAiIdentityName(): string {
  const bot = useSessionBot()

  return bot ? botDisplayName(bot) : 'Mirach'
}
