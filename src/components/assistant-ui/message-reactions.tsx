/**
 * 消息表情反应 UI（hermes components/assistant-ui/thread/message-reactions.tsx
 * 的宿主移植，2026-11-28——无 assistant-ui 上游对偶，属"完整移植"档；
 * 形态/管理照抄 hermes，表面用宿主令牌）。
 *
 * - ReactionPicker：六枚快速反应 + "＋" 展开全量 frimousse 表情选择器
 *   （emojibase 数据随包，见 vite.config.ts 的 mirach:emojibase-assets）；
 * - ReactionBadge：消息携带的反应（扁平、无底色 pill——DESIGN 同款）；
 * - useMessageReactionState：读本机反应 + 切换/撤销（数据面
 *   reactions-store.ts）。
 */
import { EmojiPicker } from 'frimousse'
import { type FC, useCallback, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { useAuiState } from '@assistant-ui/react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover'
import { ghostButton } from '@/components/assistant-ui/elements/surfaces'
import { useThreadSessionId } from '@/components/assistant-ui/thread-session-id'
import { cn } from '@/lib/utils'
import {
  DOUBLE_CLICK_REACTION,
  QUICK_REACTIONS,
  reactionKey,
  reactionsStore,
  useReaction,
} from './reactions-store'

// 本地 Serve 的 emojibase 数据（dev = vite 中间件，build = 随包资产；
// 桌面端离线可用，绝不连 CDN）。
const EMOJIBASE_URL = './emojibase'

// Slack 式单元格染色（hermes 同款手法）：长滚动可扫读，按码点确定，
// frimousse 虚拟行下稳定。
const CELL_TINTS = [
  'hover:bg-emerald-500/15 data-[active]:bg-emerald-500/20',
  'hover:bg-sky-500/15 data-[active]:bg-sky-500/20',
  'hover:bg-amber-500/15 data-[active]:bg-amber-500/20',
  'hover:bg-pink-500/15 data-[active]:bg-pink-500/20',
  'hover:bg-orange-500/15 data-[active]:bg-orange-500/20',
  'hover:bg-violet-500/15 data-[active]:bg-violet-500/20',
] as const
const cellTint = (emoji: string) =>
  CELL_TINTS[(emoji.codePointAt(0) ?? 0) % CELL_TINTS.length]

/** 全量 emoji 选择器（无头组件，样式在这里）。 */
const FullEmojiPicker: FC<{ onSelect: (emoji: string) => void }> = ({ onSelect }) => (
  <EmojiPicker.Root
    className="flex h-72 w-76 flex-col"
    emojibaseUrl={EMOJIBASE_URL}
    locale="zh"
    onEmojiSelect={(emoji) => onSelect(emoji.emoji)}
  >
    <EmojiPicker.Search
      autoFocus
      className="border-(--ui-stroke-tertiary) focus:border-(--ui-stroke-secondary) mx-1 border-b bg-transparent px-1 pb-1 text-sm focus:outline-hidden"
      placeholder="搜索…"
    />
    <EmojiPicker.Viewport className="relative flex-1">
      <EmojiPicker.Loading className="text-(--ui-text-tertiary) absolute inset-0 grid place-items-center text-xs">
        加载表情…
      </EmojiPicker.Loading>
      <EmojiPicker.Empty className="text-(--ui-text-tertiary) absolute inset-0 grid place-items-center text-xs">
        没有匹配的表情。
      </EmojiPicker.Empty>
      <EmojiPicker.List
        className="pb-1 select-none"
        components={{
          CategoryHeader: ({ category, ...props }) => (
            <div
              className="bg-(--ui-bg-elevated) text-(--ui-text-tertiary) px-1.5 pt-2 pb-1 text-[0.6875rem]"
              {...props}
            >
              {category.label}
            </div>
          ),
          Emoji: ({ emoji, ...props }) => (
            <button
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-md text-lg',
                cellTint(emoji.emoji),
              )}
              {...props}
            >
              {emoji.emoji}
            </button>
          ),
          Row: ({ children, ...props }) => (
            <div className="flex px-1" {...props}>
              {children}
            </div>
          ),
        }}
      />
    </EmojiPicker.Viewport>
  </EmojiPicker.Root>
)

/**
 * 反应选择器（快速行 + "＋" 展开全量），宿主 motion Popover 承载
 * （与全应用弹层同一套表面/动效）。
 */
export const ReactionPicker: FC<{
  align?: 'end' | 'start'
  children: React.ReactElement
  open: boolean
  selected?: string | null
  onOpenChange: (open: boolean) => void
  onSelect: (emoji: string) => void
}> = ({ align = 'end', children, open, selected, onOpenChange, onSelect }) => {
  const [expanded, setExpanded] = useState(false)
  return (
    <Popover
      align={align}
      onOpenChange={(next) => {
        onOpenChange(next)
        // 每次关都回到快速行（hermes 同款）。
        if (!next) setExpanded(false)
      }}
      open={open}
      side="top"
      sideOffset={6}
    >
      <PopoverTrigger>{children}</PopoverTrigger>
      <PopoverContent
        className={cn('w-auto p-1', !expanded && 'flex gap-0.5')}
      >
        {expanded ? (
          <FullEmojiPicker onSelect={onSelect} />
        ) : (
          <>
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                aria-pressed={selected === emoji}
                data-quick-reaction={emoji}
                className={cn(
                  ghostButton,
                  'pressable-sm grid size-7 place-items-center rounded-md text-base',
                  selected === emoji && 'bg-(--chrome-action-hover)',
                )}
                onClick={() => onSelect(emoji)}
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              aria-label="更多表情"
              className={cn(ghostButton, 'pressable-sm grid size-7 place-items-center rounded-md')}
              onClick={() => setExpanded(true)}
            >
              <PlusIcon className="size-[var(--size-icon-sm)]" />
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 消息携带的反应（扁平、静默元数据；自己的可点击撤销）。 */
export const ReactionBadge: FC<{
  className?: string
  emoji: string | null
  onRetract: () => void
}> = ({ className, emoji, onRetract }) => {
  if (!emoji) return null
  return (
    <span
      data-slot="aui_msg-reactions"
      className={cn('flex items-center gap-1 text-[0.8125rem] leading-none', className)}
    >
      <button
        type="button"
        aria-label={`撤销 ${emoji} 反应`}
        className="reaction-pop cursor-pointer leading-none transition-transform hover:scale-110 active:scale-95"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onRetract()
        }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {emoji}
      </button>
    </span>
  )
}

/**
 * 当前消息的反应状态与切换入口。
 *
 * 会话键 = 分栏显式 id → threadListItem.id 兜底（与 composer 同一解析链）；
 * 消息文本 = 各 text 部件拼接（折叠轮按整段也算同一句，见 store 注释）。
 */
export function useMessageReactionState(): {
  emoji: string | null
  react: (emoji: string) => void
  retract: () => void
  key: string
} {

  const threadIdFromAui = useAuiState((s) => s.threadListItem.id)
  const scopedThreadId = useThreadSessionId()
  const sessionId = scopedThreadId ?? threadIdFromAui
  const role = useAuiState((s) => s.message.role)
  const text = useAuiState((s) => {
    const parts = s.message.content
    let acc = ''
    for (const part of parts) {
      if (part.type === 'text') acc += (acc ? '\n' : '') + part.text
    }
    return acc
  })
  const key = reactionKey(String(sessionId ?? 'local'), role === 'user' ? 'user' : 'assistant', text)
  const emoji = useReaction(String(sessionId ?? 'local'), role === 'user' ? 'user' : 'assistant', text)
  const react = useCallback(
    (next: string) => {
      reactionsStore.getState().toggle(key, next)
    },
    [key],
  )
  const retract = useCallback(() => {
    reactionsStore.getState().retract(key)
  }, [key])
  return { emoji, react, retract, key }
}

// 双击有别的含义的元素：链接/控件点击、输入/代码选择——手势只认正文。
const NOT_A_TAPBACK =
  'a, button, input, pre, select, textarea, [contenteditable="true"], [role="button"]'

/** 双击是否 = "点个心"手势（hermes isTapbackDoubleClick 逐字语义）。 */
function isTapbackDoubleClick(event: { detail: number; target: EventTarget | null }): boolean {
  if (event.detail !== 2) return false
  const target = event.target
  return target instanceof Element ? !target.closest(NOT_A_TAPBACK) : true
}

/**
 * 双击消息 = 点心（iMessage 手势；hermes useTapbackDoubleClick 对偶）。
 * 懒读反应状态（事件时刻取快照）：手势本身不渲染，别把消息根订阅到
 * 每次反应变化上。同一手势再来一次 = 撤销。
 */
export function useTapbackDoubleClick(): (event: React.MouseEvent<HTMLElement>) => void {
  const { react } = useMessageReactionState()
  return useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!isTapbackDoubleClick(event.nativeEvent)) return
      // 双击已顺带选中了下面的词——手势要的是 tapback，不是选区。
      window.getSelection()?.removeAllRanges()
      // toggle 语义：已是同一枚 = 撤销（第二次双击收手）。
      react(DOUBLE_CLICK_REACTION)
    },
    [react],
  )
}

/**
 * 消息反应控件：反应徽章 + "添加反应" 触发器（气泡操作条上的同位）。
 * 自足组件——挂进操作条即可，会话/消息身份走 useMessageReactionState。
 */
export const ReactionControl: FC<{ align?: 'end' | 'start' }> = ({ align = 'end' }) => {
  const { emoji, react, retract } = useMessageReactionState()
  const [open, setOpen] = useState(false)
  return (
    <span className="inline-flex items-center gap-1" data-slot="aui_reaction-control">
      <ReactionBadge emoji={emoji} onRetract={retract} />
      <ReactionPicker
        align={align}
        open={open}
        selected={emoji}
        onOpenChange={setOpen}
        onSelect={(next) => {
          react(next)
          setOpen(false)
        }}
      >
        <button
          type="button"
          aria-label="添加表情反应"
          title="添加表情反应"
          className={cn(
            ghostButton,
            // 常驻低强调（hermes 的 ☺ 槽在行悬停时显形；宿主的操作条分组类
            // 因消息类型而异，统一走"低调但可发现"——opacity-60 → 悬停 100）。
            'pressable-sm grid size-6 place-items-center rounded-md text-[13px] leading-none opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          ☺
        </button>
      </ReactionPicker>
    </span>
  )
}
