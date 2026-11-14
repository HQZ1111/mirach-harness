/**
 * 群聊房间 + 创建对话框（hermes GroupChatWorkspace / CreateGroupChatDialog
 * 的宿主假面，2026-11-07 用户定稿："可以做假ui，但是标红显示"）。
 *
 * ## 结构对齐（2026-11-10，hermes group-chat-view.tsx 的宿主假面升级）
 * 逐项对照 hermes 群聊视图结构（数据面仍是本地 log——机器人互发不发生）：
 * - 头部：返回钮 + **成员头像栈**（BotFace 22px 重叠，hermes 成员栈同位）
 *   + 群名 + 成员数；
 * - 时间线：每行 **BotFace 22px 头像 + 发送者名 + 时间**（hermes
 *   group-chat-parts 的行头同构；user 行右对齐——hermes 自己的消息靠右）；
 * - **@提及高亮**：消息文本里 @成员名 上色（hermes group-mention-text
 *   的宿主版，纯正则不上 DOM 面板）；
 * - 成员条：BotFace 小头像 + 名（原色点升级）。
 * 全部 UI 带红色标记——群聊的 groups.* RPC 面在 pi 无对等承载。
 */
import { useEffect, useRef, useState, type FC } from 'react'
import { ArrowLeftIcon, SearchIcon, SendIcon, UsersIcon, XIcon } from 'lucide-react'

import { useBotStubStore, type BotGroupChat } from './bot-stub-store'
import { botDisplayName, useBotsStore, type BotPreset } from './bots-store'
import { BotFace, avatarColor, botAppearance } from './bot-face'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { cn } from '@/lib/utils'

/** 群成员的 BotFace 外观解析（花名册行同款——名字 hash 兜底色）。 */
function memberFace(b: BotPreset | undefined, name: string) {
  const appearance = botAppearance(name, {
    color: b?.color,
    shape: b?.shape ?? '',
    image: b?.image ?? null,
  })
  return {
    color: avatarColor(appearance.color, name),
    image: appearance.image,
  }
}

/** @提及高亮（hermes group-mention-text 宿主版）：按成员名分词上色。
 *  纯文本分段渲染，不碰 innerHTML。 */
function MentionText({ members, text }: { members: readonly string[]; text: string }) {
  const parts = useMemoParts(text, members)
  return (
    <>
      {parts.map((p, i) =>
        p.mention ? (
          <span className="text-(--color-brand) font-medium" key={i}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/** 提及分词（useMemo 里不用 map 的纪律——这是组件内的纯派生，直接算）。 */
function useMemoParts(
  text: string,
  members: readonly string[],
): { mention: boolean; text: string }[] {
  if (members.length === 0) return [{ mention: false, text }]
  const escaped = members.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(@(?:${escaped.join('|')}))`, 'g')
  return text.split(re).map((seg) => ({
    mention: seg.startsWith('@') && members.includes(seg.slice(1)),
    text: seg,
  }))
}

/** 群聊房间视图（hermes GroupChatWorkspace 的结构假面）。 */
export const GroupChatWorkspace: FC<{
  group: BotGroupChat
  onBack: () => void
}> = ({ group, onBack }) => {
  const bots = useBotsStore((s) => s.bots)
  const members = group.members.map((name) => bots.find((b) => b.name === name))
  const append = useBotStubStore((s) => s.appendGroupMessage)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [group.log.length])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    append(group.name, 'user', text)
    setDraft('')
  }

  return (
    <div className="flex h-full flex-col" data-slot="bot-group-workspace">
      {/* 头部（hermes group-chat-view 头：返回 + 成员头像栈 + 群名 + 计数） */}
      <div className="border-border/70 flex items-center gap-2 border-b px-2.5 py-2">
        <button
          className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon className="size-[var(--size-icon-sm)]" />
        </button>
        {/* 群头像：有群图 = 圆图（hermes 房间头同位）；无 = 成员头像栈
            （重叠 8px——hermes 成员栈同构） */}
        {group.image ? (
          <img
            alt=""
            className="size-7 shrink-0 rounded-full object-cover"
            src={group.image}
          />
        ) : (
        <span className="flex shrink-0 items-center">
          {members.slice(0, 4).map((m, i) => {
            const name = m?.name ?? group.members[i] ?? 'bot'
            const face = memberFace(m, name)
            return (
              <span
                className="ring-background rounded-full ring-2"
                key={name}
                style={{ marginLeft: i === 0 ? 0 : -8 }}
              >
                <BotFace color={face.color} image={face.image} name={name} shape="circle" size={22} />
              </span>
            )
          })}
        </span>
        )}
        <span className="text-foreground min-w-0 truncate text-sm font-medium">{group.name}</span>
        <span className="text-muted-foreground/60 shrink-0 text-xs">{group.members.length} 人</span>
      </div>
      <div
        className="text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 border-b px-2.5 py-1 text-xs"
        data-stub="true"
      >
        机器人互发未接通——消息仅本地记录（占位）。
      </div>
      {/* 时间线（hermes group-chat-parts 行头同构：头像 + 发送者 + 时间；
          user 行右对齐） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2" ref={logRef}>
        {group.log.length === 0 ? (
          <div className="text-muted-foreground/60 py-8 text-center text-xs">
            还没有消息——发送一条开始（仅本地记录）。
          </div>
        ) : (
          group.log.map((msg, i) => {
            const isUser = msg.from === 'user'
            const bot = isUser ? undefined : bots.find((b) => b.name === msg.from)
            const face = memberFace(bot, isUser ? 'you' : msg.from)
            return (
              <div
                className={cn('mb-2.5 flex gap-2', isUser && 'flex-row-reverse')}
                key={i}
              >
                {isUser ? (
                  <span className="bg-muted text-muted-foreground/80 flex size-[22px] shrink-0 items-center justify-center rounded-full text-[0.625rem] font-medium">
                    你
                  </span>
                ) : (
                  <BotFace color={face.color} image={face.image} name={msg.from} shape="circle" size={22} />
                )}
                <div className={cn('min-w-0', isUser && 'text-right')}>
                  <div className="text-muted-foreground text-[0.6875rem] font-medium">
                    {isUser ? '你' : `@${msg.from}`}
                    <span className="ml-1.5 opacity-50">
                      {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div
                    className={cn(
                      'text-foreground mt-0.5 inline-block max-w-full rounded-lg px-2 py-1 text-left text-[0.8125rem]',
                      isUser ? 'bg-accent/80' : 'bg-muted/60',
                    )}
                  >
                    <MentionText members={group.members} text={msg.text} />
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="border-border/70 flex items-center gap-1.5 border-t px-2.5 py-2">
        <input
          className="text-foreground placeholder:text-muted-foreground/50 border-border/70 focus:border-border h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="发消息…（@成员名 提及）"
          value={draft}
        />
        <button
          aria-label="发送"
          className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
          disabled={!draft.trim()}
          onClick={send}
          type="button"
        >
          <SendIcon className="size-[var(--size-icon-sm)]" />
        </button>
      </div>
      {/* 成员条（BotFace 小头像——花名册行同源外观） */}
      <div className="border-border/70 flex flex-wrap items-center gap-1.5 border-t px-2.5 py-1.5">
        {members.map((m, i) => {
          const name = m?.name ?? group.members[i] ?? 'bot'
          const face = memberFace(m, name)
          return (
            <span
              className="bg-muted text-muted-foreground flex items-center gap-1 rounded-full py-0.5 pr-1.5 pl-0.5 text-[0.625rem]"
              key={name}
            >
              <BotFace color={face.color} image={face.image} name={name} shape="circle" size={14} />
              {m ? botDisplayName(m) : name}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** 群聊成员上限（hermes GROUP_CHAT_MAX_MEMBERS = 6，group-chat.ts）。 */
const GROUP_CHAT_MAX_MEMBERS = 6

/** 群聊创建对话框（hermes CreateGroupChatDialog，create-dialog.tsx :1279
 *  逐段照抄；数据面仍是本地 log 红显）。结构：
 *  ①标题 + 描述（Pick 2–N bots…）②搜索框（underline 变体）③已选徽章行
 *  （点 ✕ 移除）④成员列表（BotFace 24 + 名 + @handle·已在群 + 右侧
 *  Checkbox；满 6 禁用未选行）⑤群图片控件（40px 圆预览 + 上传；AI 生成
 *  钮 hermes 仅 imagen 可用时渲染——宿主无 imagen，同款条件不渲染）
 *  ⑥名称输入（placeholder = 已选成员名，空名创建 = 成员名连接，slice 64）
 *  ⑦footer：取消 + 创建群聊 (N)。 */
export const CreateGroupDialog: FC<{
  bots: readonly BotPreset[]
  groupChats: readonly BotGroupChat[]
  onClose: () => void
  onCreate: (name: string, members: string[], image: null | string) => void
}> = ({ bots, groupChats, onClose, onCreate }) => {
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [name, setName] = useState('')
  const [image, setImage] = useState<null | string>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Esc 关闭（BotsDialog 同款分层——缺了它 Esc 会穿透到下层）
  useEffect(() => {
    const dispose = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    return () => dispose()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const selected = bots.filter((b) => checked[b.name])
  const q = query.trim().toLocaleLowerCase()
  const visible = q
    ? bots.filter(
        (b) =>
          botDisplayName(b).toLocaleLowerCase().includes(q) ||
          b.name.toLocaleLowerCase().includes(q),
      )
    : bots
  const atCap = selected.length >= GROUP_CHAT_MAX_MEMBERS
  const placeholder = selected.length
    ? selected.map((b) => botDisplayName(b)).join(', ')
    : '群名'
  const canCreate = selected.length >= 2

  const toggle = (botName: string, on: boolean) =>
    setChecked((prev) => ({ ...prev, [botName]: on }))

  return (
    <div className="set-overlay" onClick={onClose} role="presentation">
      <div
        aria-modal="true"
        aria-label="新建群聊"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={{ width: 448, maxWidth: '95vw', maxHeight: '85vh', height: 'auto', overflow: 'auto', display: 'block' }}
      >
        {/* hermes Dialog 度量（dialog.tsx :247）：body = grid gap-3 p-4；
            header = flex-col gap-1（标题 15px semibold + 描述 caption 级
            tertiary）；footer 右对齐 gap-2。皮肤仍用 set-card。 */}
        <div className="grid gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
              新建群聊
            </h2>
            <p className="text-muted-foreground text-xs">
              选择 2–{GROUP_CHAT_MAX_MEMBERS} 台机器人。宿主无群聊网关——消息仅本地记录
              （<span className="text-rose-600 dark:text-rose-400" data-stub="true">互发未接通</span>）。
            </p>
          </div>
          {/* 搜索（hermes SearchField underline，:1425-1432 同位） */}
          <div className="inline-flex h-7 w-full items-center gap-1.5 border-b border-transparent px-0.5 transition-[color,border-color,opacity] focus-within:opacity-100 opacity-50">
            <SearchIcon className="pointer-events-none text-muted-foreground/70 size-3.5 shrink-0" />
            <input
              aria-label="搜索以添加机器人"
              className="text-foreground placeholder:text-muted-foreground h-7 w-full bg-transparent text-xs outline-none"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索以添加机器人…"
              value={query}
            />
          </div>
          {/* 已选徽章（hermes Badge :1433-1458 同构：圆角胶囊 + ✕ 移除） */}
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.map((b) => (
                <button
                  className="hover:bg-accent flex items-center gap-1 rounded-full bg-accent/60 py-0.5 pl-2 pr-1.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
                  key={b.name}
                  onClick={() => toggle(b.name, false)}
                  title="从选择中移除"
                  type="button"
                >
                  {botDisplayName(b)}
                  <XIcon className="size-2.5" />
                </button>
              ))}
            </div>
          )}
          {/* 成员列表（hermes :1459-1514：BotFace 24 + 名 + @handle · 已在群 +
              Checkbox 右侧；满员禁用未选行） */}
          <div className="max-h-64 min-h-0 overflow-y-auto overscroll-contain">
            <div className="grid gap-0.5 pr-2">
              {visible.length > 0 ? (
                visible.map((b) => {
                  const face = botAppearance(b.name, {
                    color: b.color,
                    shape: b.shape ?? '',
                    image: b.image ?? null,
                  })
                  const isChecked = Boolean(checked[b.name])
                  const disabled = !isChecked && atCap
                  const inGroups = groupChats.filter((g) => g.members.includes(b.name))
                  return (
                    <label
                      className={cn(
                        'hover:bg-accent/60 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors',
                        disabled && 'cursor-not-allowed opacity-50',
                      )}
                      key={b.name}
                    >
                      <BotFace
                        color={avatarColor(face.color, b.name)}
                        image={face.image}
                        name={b.name}
                        shape={face.shape}
                        size={24}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-xs">
                          {botDisplayName(b)}
                        </span>
                        <span className="text-muted-foreground/60 block truncate text-[0.625rem]">
                          {inGroups.length > 0
                            ? `@${b.name} · 已在 ${inGroups.map((g) => `“${g.name}”`).join('、')}`
                            : `@${b.name}`}
                        </span>
                      </span>
                      <input
                        checked={isChecked}
                        className="accent-(--color-brand)"
                        disabled={disabled}
                        onChange={(e) => toggle(b.name, e.target.checked)}
                        type="checkbox"
                      />
                    </label>
                  )
                })
              ) : (
                <div className="text-muted-foreground px-1.5 py-3 text-center text-xs">
                  {q ? `没有匹配“${q}”的机器人` : '还没有机器人——先创建一个。'}
                </div>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            {/* 群图片（hermes GroupImageControls 同构：40px 圆预览 + 上传；
                AI 生成钮 = imagen 条件渲染，宿主无 imagen → 同款不渲染） */}
            <div className="flex items-center gap-2">
              <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
                {image ? (
                  <img alt="" className="size-full object-cover" src={image} />
                ) : (
                  <UsersIcon className="size-4" />
                )}
              </span>
              <input
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') setImage(reader.result)
                  }
                  reader.readAsDataURL(file)
                }}
                ref={fileInputRef}
                type="file"
              />
              <button className="set-btn pressable" onClick={() => fileInputRef.current?.click()} type="button">
                上传
              </button>
              {image && (
                <button className="set-btn pressable" onClick={() => setImage(null)} type="button">
                  移除
                </button>
              )}
            </div>
            {/* 名称（hermes :1522-1535：placeholder = 已选成员名；空名创建 =
                成员名连接，slice 64） */}
            <input
              aria-label="群名"
              className="set-input"
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholder}
              value={name}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="set-btn pressable" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary pressable"
              disabled={!canCreate}
              onClick={() => {
                const base = (name.trim() || placeholder).slice(0, 64)
                onCreate(base, selected.map((b) => b.name), image)
              }}
              type="button"
            >
              创建群聊{selected.length > 0 ? ` (${selected.length})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
