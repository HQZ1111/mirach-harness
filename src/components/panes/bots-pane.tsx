/**
 * 机器人花名册弹出栏——hermes plugins/hermes-bots 的 roster-pane 完整移植
 * （2026-11-07，用户："机器人页面完整移植……在左侧栏的右边弹出一个栏"）。
 *
 * ## 与 hermes 的逐项对照
 *
 * | hermes | 本栏 | 出处 |
 * |---|---|---|
 * | 工具条（段头 BOTS + New… 下拉 + 搜索） | ✅ | roster-pane-toolbar.tsx :92-136 |
 * | 新建… 下拉（机器人/群聊/分区） | ✅（群聊 = 本地假面标红） | :122-133 |
 * | 用户分区 + 未分类 + 行拖拽归区 | ✅（HTML5 DnD，私有 MIME；armed ring + lit 同款） | user-sections.ts / user-sections-ui.tsx |
 * | BotRow（BotFace 头像 + 14px lead 格状态点 + 名称 + 置顶/隐藏标记 + mono handle 细节行 + 年龄） | ✅ | bot-row.tsx :241-327 |
 * | 行右键菜单（打开/置顶/隐藏/编辑/移动到分区/删除） | ✅（+新聊天/克隆） | bot-row.tsx :330-492 |
 * | 已隐藏区（border-t 折叠头 + 计数；恢复走行右键） | ✅ | roster-pane-content.tsx :137-172 |
 * | 空态（无机器人 / 全隐藏 / 无匹配） | ✅ | 同上 :95-127 |
 * | 群聊 | 假面标红（本地 log，机器人互发未发生） | group-chat-view（不可达，数据面 pi 无承载） |
 * | 网关分区 | ✅（pi_connections 多环境分组；远端 = 尾部红标 + 行置灰） | roster-sections.tsx :240-324 |
 * | 活动 toasts 铃 | ✅（偏好切换；OS 派发未接通，标红） | roster-pane-toolbar :97-108 |
 * | kind·activity·gateway 筛选 / RoutinesPane（per-bot cron） | ❌ | 宿主无活动流 / cron 无 bot 绑定字段，**不造假 UI** |
 *
 * 行几何（2026-11-07 间距对齐轮）逐项对照 hermes row-geometry.ts：
 * 行 `min-h` 不设（py-2 + 内容自然高，hermes BotRow 同款）；lead 格
 * `size-3.5`（14px，名称与左栏会话行同左缘）；栈 `gap-px` / 块间
 * `gap-0.5`；段头 `px-2 py-1.5 text-[0.6875rem] font-semibold uppercase
 * tracking-wider` quaternary；搜索 = SearchField underline 变体（静止
 * opacity-50 / 聚焦 100 / 有词 100，无边框）；工具条钮 = icon-xs
 * `size-6 rounded-[4px]` svg 12px。
 *
 * 启动 = `pi_create_bot_session`（bot-launch 通道）。hermes "one bot = one
 * forever hidden chat" 的两个引擎依赖 pi 都没有（2026-11-08 vendor 源码
 * 核对）：sessions 表只有 path 主键（session_index.rs init_schema——
 * **name 无唯一索引**）、无会话级 hidden 面。宿主对偶 = **sessionId 锚定**
 * （create 返回快照直接采纳；open 经 pi_get_state 校验/锚定，同名会话
 * 不会误配）+ **前端显示层隐藏**（thread-list 按 bots-store botChatPaths
 * 的双锚 path 集过滤，花名册是唯一入口）。见 bot-launch.ts 头注释。
 *
 * 头像 = bot-face.tsx（avatar.tsx 逐字移植 + profileColor shim）。选择器
 * UI 在 bots-dialog 内部（AvatarPicker 的精简照抄：形状行 + 颜色行）。
 */

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  BellIcon,
  BellOffIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  EyeOffIcon,
  EyeIcon,
  FolderIcon,
  FolderPlusIcon,
  GlobeIcon,
  InboxIcon,
  ListFilterIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TerminalIcon,
  TimerIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/motion/popover'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/motion/context-menu'
import { cn } from '@/lib/utils'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'

import { BotsDialog } from './hub/bots-dialog'
import { CreateGroupDialog, GroupChatWorkspace } from './hub/bot-group'
import { RoutinesPane, ScreenStubPane } from './hub/bot-subpages'
import { BotFace, avatarColor, botAppearance } from './hub/bot-face'
import { launchBotSession, newBotChat } from './hub/bot-launch'
import { useSessionManage } from '@/components/panes/session-manage/session-catalog'
import {
  botDisplayName,
  botsStore,
  useBotsStore,
  type BotPreset,
  type BotSection,
} from './hub/bots-store'
import { botStubStore, useBotStubStore, type BotGroupChat } from './hub/bot-stub-store'

/** 连接注册表行（pi_connections.rs 的 IPC 投影——多环境分组数据面）。 */
interface ConnectionRow {
  id: string
  kind: 'cloud' | 'local' | 'remote' | 'ssh'
  label: string
}

/** 读连接注册表（弹窗/分组数据面）。 */
function useConnections(): readonly ConnectionRow[] {
  const [connections, setConnections] = useState<readonly ConnectionRow[]>([])
  useEffect(() => {
    void invoke<ConnectionRegistry>('pi_connections_list')
      .then((r) => setConnections(r.connections))
      .catch((e) => console.error('[bots] 连接清单读取失败', e))
  }, [])
  return connections
}

interface ConnectionRegistry {
  connections: ConnectionRow[]
}

const isLocal = (connectionId: string | undefined): boolean =>
  !connectionId || connectionId === 'local'

/** 行拖拽的私有 MIME（hermes BOT_DRAG_MIME 同款——只有分区头认它）。 */
const BOT_DRAG_MIME = 'application/x-mirach-bot'

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; bot: BotPreset }
  | { mode: 'section-create'; bot: BotPreset | null }
  | { mode: 'section-rename'; section: BotSection }

/** 排序：置顶优先，其余按创建时间倒序（hermes sortRosterBots 的宿主版——
 *  活动面 = createdAt，宿主没有会话活动流）。 */
function sortBots(bots: readonly BotPreset[]): BotPreset[] {
  return [...bots].sort((a, b) => {
    const pa = a.pinned ? 1 : 0
    const pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.createdAt - a.createdAt
  })
}

/** 行年龄（hermes rowAge 同款粗粒度：刚刚/52分/3时/18天）。 */
function rowAge(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}时`
  return `${Math.floor(hour / 24)}天`
}

// ── 行 ────────────────────────────────────────────────────────────────

interface BotRowProps {
  bot: BotPreset
  sections: readonly BotSection[]
  launching: boolean
  isActive: boolean
  /** 连接可达性（hermes sourceStatus.available——不可达 = 头像置灰）。 */
  sourceAvailable: boolean
  /** 拖拽飞行状态上报（hermes $draggingBot——落区据此画出淡 ring）。 */
  onDragStateChange?: (botName: string | null) => void
  /** 打开屏幕子页（pi 无 gateway 屏幕面——红显占位子页）。 */
  onOpenScreen: (bot: BotPreset) => void
  /** 打开 per-bot 例程子页（宿主 cron 无 bot 绑定——红显占位子页）。 */
  onOpenRoutines: (bot: BotPreset) => void
  onLaunch: (bot: BotPreset) => void
  onEdit: (bot: BotPreset) => void
  onDelete: (bot: BotPreset) => void
  onNewSectionFor: (bot: BotPreset) => void
}

/** 机器人行（hermes BotRow 的宿主版）。右键菜单 = motion ContextMenu
 *  （受控 open+point——宿主 goo 弹层统一体系）。 */
function BotRow({
  bot,
  sections,
  launching,
  isActive,
  sourceAvailable,
  onDragStateChange,
  onOpenScreen,
  onOpenRoutines,
  onLaunch,
  onEdit,
  onDelete,
  onNewSectionFor,
}: BotRowProps) {
  const patchMeta = useBotsStore((s) => s.patchMeta)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { shape, color, image } = botAppearance(bot.name, {
    color: bot.color,
    shape: bot.shape ?? '',
    image: bot.image ?? null,
  })

  return (
    <>
      {/* 行本体（右键 = 菜单受控落点；点击 = 打开会话；拖拽 = 归区） */}
      <div
        aria-busy={launching || undefined}
        aria-label={`打开机器人「${botDisplayName(bot)}」会话`}
        className={cn(
          'hover:bg-accent/60 group/row flex w-full min-w-0 max-w-full cursor-default items-center gap-2 overflow-hidden rounded-md px-2 py-2 text-left transition-colors',
          isActive && 'bg-accent/80',
        )}
        data-roster-key={bot.name}
        draggable
        onClick={() => onLaunch(bot)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onDragEnd={() => onDragStateChange?.(null)}
        onDragStart={(e) => {
          e.dataTransfer.setData(BOT_DRAG_MIME, bot.name)
          e.dataTransfer.effectAllowed = 'move'
          onDragStateChange?.(bot.name)
        }}
        role="button"
        tabIndex={0}
      >
        <span
          className={cn(
            'relative shrink-0',
            launching && 'opacity-60',
            !sourceAvailable && 'grayscale opacity-60',
          )}
        >
          <BotFace
            color={avatarColor(color, bot.name)}
            image={bot.image || null}
            mood={launching ? 'work' : 'idle'}
            name={bot.name}
            shape={shape}
            size={28}
          />
          {/* 状态点叠头像右下角（2026-11-14 间距对齐轮：原 14px lead 格前置在
              名称链里，把名称推到 pane+89——比段头/侧栏文字线深 39px。头像列
              28px + gap-2 后名称与所属段头同线；点改角标（ring 分色）。） */}
          <span
            aria-hidden
            className={cn(
              'absolute bottom-0 right-0 rounded-full ring-2 ring-(--surface)',
              launching ? 'size-1.5 animate-pulse bg-blue-500' : 'size-1 bg-muted-foreground/60',
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {bot.pinned ? (
                <PinIcon className="shrink-0 text-muted-foreground/60 size-[0.6875rem]" />
              ) : null}
              {bot.hidden ? (
                <EyeOffIcon className="shrink-0 text-muted-foreground/60 size-[0.6875rem]" />
              ) : null}
              <span className="text-foreground min-w-0 truncate text-[0.8125rem] font-medium">
                {botDisplayName(bot)}
              </span>
            </span>
            {launching ? (
              <span className="text-muted-foreground shrink-0 text-[0.6875rem]">启动中…</span>
            ) : (
              <span className="text-muted-foreground/60 shrink-0 text-[0.6875rem] tabular-nums">
                {rowAge(bot.createdAt)}
              </span>
            )}
          </span>
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground/60">
              @{bot.name}
            </span>
            {bot.description.trim() && (
              <>
                <span className="shrink-0 text-muted-foreground/60">·</span>
                <span className="min-w-0 truncate">{bot.description.trim()}</span>
              </>
            )}
          </span>
        </span>
      </div>
      {/* 右键菜单（受控 point——app-context-menu 同款形态） */}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) setMenu(null)
        }}
        open={menu !== null}
        point={menu ?? { x: 0, y: 0 }}
      >
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onLaunch(bot)}>
          <PlayIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          打开会话
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => patchMeta(bot.name, { pinned: !bot.pinned })}>
          {bot.pinned ? (
            <PinOffIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          ) : (
            <PinIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          )}
          {bot.pinned ? '取消置顶' : '置顶'}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => patchMeta(bot.name, bot.hidden ? { hidden: false } : { hidden: true })}
        >
          {bot.hidden ? (
            <EyeIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          ) : (
            <EyeOffIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          )}
          {bot.hidden ? '取消隐藏' : '从花名册隐藏'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onEdit(bot)}>
          <PencilIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          编辑…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void newBotChat(bot)}
        >
          <BotIcon className="mr-1.5 size-[var(--size-icon-sm)]" />          与此机器人开新聊天
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            // 克隆 = 新预设（锚字段清空——副本首启建自己的会话）
            const copy = {
              ...bot,
              name: `${bot.name}-copy`,
              chatSessionPath: null,
              chatSessionId: null,
              createdAt: Date.now(),
            }
            botsStore.getState().upsert(copy)
          }}
        >
          <PlusIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          克隆机器人
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onOpenScreen(bot)}
        >
          <MonitorIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          打开屏幕…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onOpenRoutines(bot)}
        >
          <TimerIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          例程…
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderPlusIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
            移动到分区
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => patchMeta(bot.name, { sectionId: null, sectionName: null })}
            >
              <span className="min-w-0 flex-1">未分类</span>
              {!bot.sectionId ? <CheckIcon className="size-[var(--size-icon-sm)]" /> : null}
            </ContextMenuItem>
            {sections.map((s) => (
              <ContextMenuItem
                key={s.id}
                onSelect={() => patchMeta(bot.name, { sectionId: s.id, sectionName: s.name })}
              >
                <span className="min-w-0 flex-1">{s.name}</span>
                {bot.sectionId === s.id ? <CheckIcon className="size-[var(--size-icon-sm)]" /> : null}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onNewSectionFor(bot)}>
              <PlusIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
              新建分区…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onDelete(bot)}>
          <TrashIcon className="mr-1.5 size-[var(--size-icon-sm)]" />
          删除…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    </>
  )
}

/** 筛选菜单行（hermes DropdownMenuItem + check 同构：可选前导图标、
 *  可选尾缀（计数/未接通）、选中勾）。 */
function FilterItem({
  checked = false,
  glyph,
  label,
  onSelect,
  trailing,
}: {
  checked?: boolean
  glyph?: React.ReactNode
  label: string
  onSelect: () => void
  trailing?: React.ReactNode
}) {
  return (
    <button
      className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none"
      onClick={onSelect}
      type="button"
    >
      {glyph}
      <span className="min-w-0 flex-1">{label}</span>
      {trailing}
      {checked && <CheckIcon className="size-[var(--size-icon-sm)]" />}
    </button>
  )
}

// ── 段头 + 分区块（hermes RosterSectionHeader / UserSectionHeader /
//    SectionDropZone 同构） ──────────────────────────────────────────────

/** hermes DisclosureCaret 的宿主版（右指闭合，展开旋 90°）。 */
function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      className={cn('shrink-0 size-3 transition-transform', open && 'rotate-90')}
    />
  )
}

/** 段头通用按钮行（hermes RosterSectionHeader :256 的类逐项对应：
 *  px-2 py-1.5 quaternary 半粗大写 + hover 浮起，计数同色 font-normal）。 */
function SectionHead({
  count,
  icon,
  name,
  open,
  onToggle,
  onRename,
  onMenu,
  trailing,
}: {
  count: number
  icon: React.ReactNode
  name: string
  open: boolean
  onToggle: () => void
  onRename?: () => void
  /** 悬停 ⋯（用户分区专用；hermes HEADER_ACTION_BTN 同款显隐）。 */
  onMenu?: (point: { x: number; y: number }) => void
  /** 头部尾部附件（不可达连接的断连标记等，hermes 放 debug-disconnect 的位）。 */
  trailing?: React.ReactNode
}) {
  return (
    <div className="group/section mt-1 flex w-full min-w-0 items-center gap-1 pr-1" data-slot="bots-section-heading">
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/60 transition-colors hover:bg-accent/60 hover:text-foreground"
        onClick={onToggle}
        onContextMenu={(e) => {
          if (!onMenu) return
          e.preventDefault()
          onMenu({ x: e.clientX, y: e.clientY })
        }}
        onDoubleClick={onRename}
        type="button"
      >
        <Caret open={open} />
        {icon}
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{name}</span>
        </span>
        <span aria-hidden className="min-w-0 flex-1" />
        <span className="shrink-0 font-normal tabular-nums text-muted-foreground/60">
          {count}
        </span>
        {trailing}
      </button>
      {onMenu && (
        <button
          aria-label={`分区选项（${name}）`}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground/60 opacity-0 transition hover:text-foreground group-hover/section:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onMenu({ x: r.left, y: r.bottom })
          }}
          type="button"
        >
          <MoreHorizontalIcon className="size-3" />
        </button>
      )}
    </div>
  )
}

interface SectionBlockProps {
  name: string
  count: number
  section: BotSection | null
  /** 网关桶内嵌套形态（hermes SectionDropZone nested：缩进 + 左边线；
   *  空块只在拖拽中渲染——落区用）。 */
  nested?: boolean
  /** 有机器人正在拖拽（hermes armed——合法落区画淡 ring）。 */
  armed: boolean
  /** 该块当前含被拖机器人（hermes isSource——源块不高亮不接收）。 */
  isSource?: boolean
  children: React.ReactNode
  onDropBot: (botName: string, section: BotSection | null) => void
  onRename?: (section: BotSection) => void
  onDelete?: (section: BotSection) => void
}

/** 用户分区块：头（折叠 + 右键/⋯ 同菜单 + 双击改名）+ 拖拽落区
 *  （hermes SectionDropZone：飞行中全部合法落区 ring-inset，悬停中 lit）。
 *  空块：平铺 = 头 + 虚线槽（hermes emptyHint 同位）；嵌套 = 只在拖拽中
 *  出现（每个网关桶都重复空头是噪声——hermes 同规则）。 */
function SectionBlock({
  name,
  count,
  section,
  nested = false,
  armed,
  isSource = false,
  children,
  onDropBot,
  onRename,
  onDelete,
}: SectionBlockProps) {
  const [open, setOpen] = useState(true)
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const editable = section !== null
  const empty = count === 0
  // 嵌套 + 空 + 非拖拽 = 不渲染（hermes :filter(block.rows.length || !nested || dragging)）
  if (empty && nested && !armed) return null
  const accepts = (e: React.DragEvent) =>
    armed && !isSource && e.dataTransfer.types.includes(BOT_DRAG_MIME)
  return (
    <div
      className={cn(
        'relative min-w-0 rounded-md transition-[background-color,box-shadow] duration-100',
        nested && 'ml-2.5 border-l border-border/60 pl-1',
        armed && !isSource && 'ring-1 ring-inset ring-border/60',
        over && armed && !isSource && 'bg-accent/10 ring-accent',
      )}
      data-drop-over={over ? 'true' : undefined}
      onDragEnter={(e) => {
        if (accepts(e)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={(e) => {
        // 只在指针真正离开块（而非跨过内部行边界）时清除，否则高亮频闪。
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return
        // preventDefault 才使这里成为落点，否则浏览器拒绝放置。
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDrop={(e) => {
        setOver(false)
        if (!accepts(e)) return
        const botName = e.dataTransfer.getData(BOT_DRAG_MIME)
        if (botName) onDropBot(botName, section)
      }}
    >
      <SectionHead
        count={count}
        icon={editable ? <FolderIcon className="shrink-0 size-3" /> : <InboxIcon className="shrink-0 size-3" />}
        name={name}
        onMenu={
          editable
            ? (point) => setMenu(point)
            : undefined
        }
        onRename={editable ? () => section && onRename?.(section) : undefined}
        onToggle={() => setOpen((v) => !v)}
        open={open}
      />
      {editable && (
        <ContextMenu
          onOpenChange={(o) => {
            if (!o) setMenu(null)
          }}
          open={menu !== null}
          point={menu ?? { x: 0, y: 0 }}
        >
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => section && onRename?.(section)}>重命名…</ContextMenuItem>
            <ContextMenuItem onSelect={() => section && onDelete?.(section)}>删除分区</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {open &&
        (empty ? (
          // 空分区：安静虚线槽（hermes emptyHint 同位）——兼作宽松落区
          <div className="mx-1 mb-1 rounded-md border border-dashed border-border/70 px-2 py-2 text-center text-[0.6875rem] text-muted-foreground/60">
            把机器人拖到这里归入此分区
          </div>
        ) : (
          <div className="grid w-full min-w-0 gap-px">{children}</div>
        ))}
    </div>
  )
}

/** 连接分区（hermes GatewaySectionHeading 同构）：折叠头 + kind 图标 +
 *  计数；不可达连接尾部红标（宿主占位规则，hermes 同位放断连图标）。 */
function GatewayBlock({
  conn,
  count,
  children,
}: {
  conn: ConnectionRow
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  const available = conn.id === 'local'
  return (
    <div className="min-w-0">
      <SectionHead
        count={count}
        icon={
          conn.kind === 'local' ? (
            <MonitorIcon className="shrink-0 size-3" />
          ) : conn.kind === 'ssh' ? (
            <TerminalIcon className="shrink-0 size-3" />
          ) : conn.kind === 'cloud' ? (
            <CloudIcon className="shrink-0 size-3" />
          ) : (
            <GlobeIcon className="shrink-0 size-3" />
          )
        }
        name={conn.label}
        onToggle={() => setOpen((v) => !v)}
        open={open}
        trailing={
          available ? undefined : (
            <span className="shrink-0 text-[0.625rem] normal-case tracking-normal text-rose-600/80 dark:text-rose-400/80">
              未接通
            </span>
          )
        }
      />
      {open && <div className="grid w-full min-w-0 gap-px">{children}</div>}
    </div>
  )
}

// ── 空态（hermes PanelEmpty 形态） ────────────────────────────────────

function PanelEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof BotIcon
  title: string
  description: string
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      <Icon className="size-5 opacity-60" />
      <div className="text-foreground/80 text-xs font-medium">{title}</div>
      <div className="text-muted-foreground/80 text-xs">{description}</div>
    </div>
  )
}

/** 全部已隐藏（hermes roster-pane-content :98-112 的左对齐块 + 显示钮）。 */
function AllHiddenBlock({ onShow }: { onShow: () => void }) {
  return (
    <div className="text-muted-foreground grid content-start gap-2 px-3 py-4 text-xs">
      <div className="text-foreground/80 flex items-center gap-1.5 font-medium">
        <EyeOffIcon className="text-muted-foreground/60 size-3" />
        全部机器人已隐藏
      </div>
      <p className="leading-relaxed">隐藏的机器人不进花名册，可随时从行右键恢复。</p>
      <button className="set-btn justify-self-start pressable" onClick={onShow} type="button">
        显示已隐藏
      </button>
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────

/** 机器人花名册弹出栏。 */
export function BotsPane() {
  const bots = useBotsStore((s) => s.bots)
  const sections = useBotsStore((s) => s.sections)
  const activityToasts = useBotStubStore((s) => s.activityToasts)
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' })
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [launchingName, setLaunchingName] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  const [sectionDraft, setSectionDraft] = useState('')
  // 拖拽飞行状态（hermes $draggingBot：落区 armed ring 的数据源）
  const [draggingBot, setDraggingBot] = useState<string | null>(null)
  // pane 内视图（hermes 的 pane body 替换语义：群聊房间 / 屏幕子页 /
  // per-bot 例程——后两者 pi 无数据面，红显占位）
  const [paneView, setPaneView] = useState<
    null | { kind: 'group'; name: string } | { kind: 'screen'; bot: string } | { kind: 'routines'; bot: BotPreset }
  >(null)
  const [groupCreate, setGroupCreate] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(true)
  // 工具条筛选（hermes roster-pane-toolbar Filters：kind + activity +
  // gateway 三组——activity 无数据面，红显占位不生效）
  const [kindFilter, setKindFilter] = useState<'all' | 'bots' | 'groups'>('all')
  const [gatewayFilter, setGatewayFilter] = useState<string>('all')
  // 主视图当前会话（花名册「正在看」高亮的数据源）
  const activeId = useSessionManage((s) => s.activeId)

  useEffect(() => {
    botsStore.getState().load()
    botStubStore.getState().load()
  }, [])

  const groupChats = useBotStubStore((s) => s.groupChats)
  const openGroup =
    paneView?.kind === 'group' ? groupChats.find((g) => g.name === paneView.name) : undefined

  const launch = async (bot: BotPreset) => {
    setLaunchError(null)
    setLaunchingName(bot.name)
    const ok = await launchBotSession(bot)
    setLaunchingName(null)
    if (!ok) {
      setLaunchError(
        bot.connectionId && !isLocal(bot.connectionId)
          ? `机器人「${bot.name}」归属远端连接——gateway 未接通（占位，标红）。`
          : `机器人「${bot.name}」会话启动失败——详见控制台。`,
      )
    }
  }

  // 连接注册表（多环境分组数据面——pi_connections_list）
  const connections = useConnections()

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = (bot: BotPreset): boolean =>
    normalizedQuery === '' ||
    botDisplayName(bot).toLocaleLowerCase().includes(normalizedQuery) ||
    bot.name.toLocaleLowerCase().includes(normalizedQuery) ||
    bot.description.toLocaleLowerCase().includes(normalizedQuery)

  const { visible, hiddenBots } = useMemo(() => {
    const all = bots.filter(matches)
    return {
      visible: sortBots(all.filter((b) => !b.hidden)),
      hiddenBots: sortBots(all.filter((b) => b.hidden === true)),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, normalizedQuery])

  const hasConstraint = normalizedQuery !== ''
  const allHidden = !hasConstraint && visible.length === 0 && hiddenBots.length > 0

  // 筛选应用（hermes rosterGatewayOptions/filterBotsByGateway 同构）：
  // kind = 机器人/群聊二选一；gateway = 连接桶；activity 无数据面（红显
  // 占位）不参与投影。activeFilterCount 只数生效的组。
  const activeFilterCount =
    (kindFilter !== 'all' ? 1 : 0) + (gatewayFilter !== 'all' ? 1 : 0)
  const visibleFiltered = useMemo(() => {
    if (kindFilter === 'groups') return []
    return gatewayFilter === 'all'
      ? visible
      : visible.filter((b) => (b.connectionId ?? 'local') === gatewayFilter)
  }, [visible, kindFilter, gatewayFilter])
  const groupChatsFiltered = useMemo(
    () => (kindFilter === 'bots' ? [] : groupChats),
    [groupChats, kindFilter],
  )
  // 网关分区模式（hermes rosterGatewaySections :139 的真语义）：
  // filter=all 且连接数 > 1 → 按连接分桶（用户分区隐藏）；
  // 选了具体连接 或 连接数 ≤ 1 → 平铺（用户分区在过滤后的行上渲染）。
  const gatewayMode = connections.length > 1 && gatewayFilter === 'all'
  // 孤儿连接桶（hermes :181-198：注册表里已删的 connectionId 的 bot 不静默
  // 丢失——自成一个区块，红显）。
  const orphanRows = useMemo(() => {
    if (!gatewayMode) return []
    const known = new Set(connections.map((c) => c.id))
    return visibleFiltered.filter((b) => b.connectionId && !known.has(b.connectionId))
  }, [gatewayMode, connections, visibleFiltered])
  // 群聊分区（两个布局分支共用——hermes showGatewaySections 分支也渲染
  // group chat section：showGatewaySections ? [groups, ...gateways] : users）
  const groupSection =
    groupChatsFiltered.length > 0 ? (
      <div className="min-w-0">
        <SectionHead
          count={groupChatsFiltered.length}
          icon={<UsersIcon className="size-3 shrink-0" />}
          name="群聊"
          onToggle={() => setGroupsOpen((v) => !v)}
          open={groupsOpen}
        />
        {groupsOpen && (
          <div className="grid w-full min-w-0 gap-px">
            {groupChatsFiltered.map((g) => (
              <button
                className={cn(
                  'hover:bg-accent/60 flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-2 text-left transition-colors',
                  paneView?.kind === 'group' && paneView.name === g.name && 'bg-accent/80',
                )}
                key={g.name}
                onClick={() => setPaneView({ kind: 'group', name: g.name })}
                type="button"
              >
                {/* hermes GroupRow 的头像列（2026-11-14 间距对齐轮 34→28px：
                    与机器人行头像同宽、名称与所属段头同线；size-8 圆角盒 +
                    ring，有群图 = object-cover 图，否则组织字形盒） */}
                <span className="relative flex w-7 shrink-0 items-center justify-center">
                  {g.image ? (
                    <img
                      alt=""
                      className="size-7 rounded-md object-cover ring-1 ring-border/60"
                      src={g.image}
                    />
                  ) : (
                    <span className="text-muted-foreground flex size-7 items-center justify-center rounded-md bg-accent/60 ring-1 ring-border/60">
                      <UsersIcon className="size-4" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {g.pinned ? (
                        <PinIcon className="shrink-0 text-muted-foreground/60 size-[0.6875rem]" />
                      ) : null}
                      <span className="text-foreground min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                        {g.name}
                      </span>
                    </span>
                  </span>
                  <span className="text-muted-foreground block min-w-0 truncate text-xs">
                    {g.members.length} 人
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    ) : null

  const dropBot = (botName: string, section: BotSection | null) => {
    if (!bots.some((b) => b.name === botName)) return
    botsStore
      .getState()
      .patchMeta(botName, { sectionId: section?.id ?? null, sectionName: section?.name ?? null })
  }

  const submitSection = () => {
    const trimmed = sectionDraft.trim()
    if (!trimmed) return
    if (dialog.mode === 'section-create') {
      const created = botsStore.getState().addSection(trimmed)
      if (created && dialog.bot) {
        botsStore.getState().patchMeta(dialog.bot.name, {
          sectionId: created.id,
          sectionName: created.name,
        })
      }
    } else if (dialog.mode === 'section-rename') {
      botsStore.getState().renameSection(dialog.section.id, trimmed)
    }
    setDialog({ mode: 'closed' })
  }

  const renderRows = (rows: readonly BotPreset[]) =>
    rows.map((bot) => (
      <BotRow
        bot={bot}
        // 花名册的「正在看」：当前主视图会话 = 该 bot 的永久会话锚。
        // 此前硬编码 false（2026-11-21 用户："bot 本身好像并没有切换"）。
        isActive={activeId === bot.chatSessionId}
        key={bot.name}
        launching={launchingName === bot.name}
        sections={sections}
        sourceAvailable={isLocal(bot.connectionId)}
        onDragStateChange={setDraggingBot}
        onOpenScreen={(b) => setPaneView({ kind: 'screen', bot: b.name })}
        onOpenRoutines={(b) => setPaneView({ kind: 'routines', bot: b })}
        onDelete={(b) => setConfirmDelete(b.name)}
        onEdit={(b) => setDialog({ mode: 'edit', bot: b })}
        onLaunch={launch}
        onNewSectionFor={(b) => {
          setSectionDraft('')
          setDialog({ mode: 'section-create', bot: b })
        }}
      />
    ))

  const confirmDeleteBot = bots.find((b) => b.name === confirmDelete) ?? null

  // 用户分区渲染器（hermes rosterSectionRenderers.renderUserSections 宿主版，
  // 头注原文 "composed with the gateway sections, not instead of them"）：
  // 平铺 = 顶层（空命名分区画虚线槽，删除/重命名入口可达）；嵌套 = 网关桶内
  // （空块仅拖拽中显示——每个桶都重复空头是噪声，hermes 同规则）。
  const renderUserSections = (rows: readonly BotPreset[], nested: boolean): React.ReactNode[] => {
    const out: React.ReactNode[] = []
    for (const s of sections) {
      const srows = rows.filter((b) => b.sectionId === s.id)
      out.push(
        <SectionBlock
          armed={draggingBot !== null}
          count={srows.length}
          isSource={draggingBot !== null && srows.some((b) => b.name === draggingBot)}
          key={s.id}
          name={s.name}
          nested={nested}
          onDropBot={dropBot}
          onDelete={(x) => botsStore.getState().removeSection(x.id)}
          onRename={(x) => {
            setSectionDraft(x.name)
            setDialog({ mode: 'section-rename', section: x })
          }}
          section={s}
        >
          {renderRows(srows)}
        </SectionBlock>,
      )
    }
    const unfiled = rows.filter((b) => !b.sectionId)
    if (unfiled.length > 0) {
      out.push(
        <SectionBlock
          armed={draggingBot !== null}
          count={unfiled.length}
          isSource={draggingBot !== null && unfiled.some((b) => b.name === draggingBot)}
          key="unfiled"
          name="未分类"
          nested={nested}
          onDropBot={dropBot}
          section={null}
        >
          {renderRows(unfiled)}
        </SectionBlock>,
      )
    }
    return out
  }

  // 子页替换整个 pane body（hermes pane body 替换语义：群聊房间 / 屏幕 /
  // per-bot 例程——后两者 pi 无数据面，红显占位子页）
  if (paneView?.kind === 'screen') {
    return (
      <ScreenStubPane
        bot={paneView.bot}
        onBack={() => setPaneView(null)}
      />
    )
  }
  if (paneView?.kind === 'routines') {
    return (
      <RoutinesPane
        bot={paneView.bot}
        onBack={() => setPaneView(null)}
      />
    )
  }
  if (paneView?.kind === 'group' && openGroup) {
    return (
      <>
        <GroupChatWorkspace group={openGroup} onBack={() => setPaneView(null)} />
        {dialog.mode === 'section-create' && (
          <SectionDialog
            mode="section-create"
            onChange={setSectionDraft}
            onClose={() => setDialog({ mode: 'closed' })}
            onSubmit={submitSection}
            value={sectionDraft}
          />
        )}
      </>
    )
  }

  return (
    <div className="relative flex h-full flex-col" data-slot="bots-pane">
      {/* 工具条（roster-pane-toolbar :92-136 段头 + 新建钮 + 搜索）。
          2026-11-14 间距对齐轮：①mt-[22px] = 首行行盒顶与左侧栏入口条首项
          对齐（侧栏新建会话盒顶 y=109.8；bots 原贴 pane 顶 85）；②pl-11 =
          BOTS 标签对齐全栏文字线 pane+50（roster px-1.5 + 44；原 px-2.5
          贴左缘，与搜索/段头三条线互不相同）。 */}
      <div className="mt-[22px] flex items-center justify-between gap-2 pl-11 pr-2.5 pb-1.5">
        <span className="text-muted-foreground/70 text-[0.6875rem] font-semibold tracking-wider uppercase">
          Bots
        </span>
        <div className="flex items-center gap-0.5">
          {/* 活动 toasts 开关（hermes roster-pane-toolbar 铃钮同位——宿主
              通知派发未接通，切换存偏好但不生效，标红） */}
          <button
            aria-label={activityToasts ? '关闭活动通知' : '开启活动通知'}
            className={cn(
              'flex size-6 items-center justify-center rounded-[4px] transition-colors',
              activityToasts ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground hover:text-foreground',
            )}
            data-stub="true"
            onClick={() => botStubStore.getState().setActivityToasts(!activityToasts)}
            title={activityToasts ? '活动通知开（派发未接通）' : '活动通知关'}
            type="button"
          >
            {activityToasts ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
          </button>
          {/* 筛选（hermes roster-pane-toolbar :152-243 Filters 同位：kind +
              activity + gateway 三组 + 清除；activity 无数据面红显占位） */}
          <Popover align="end" sideOffset={6}>
            <PopoverTrigger>
              <button
                aria-label={activeFilterCount ? `筛选（${activeFilterCount} 生效）` : '筛选'}
                className={cn(
                  'flex size-6 items-center justify-center rounded-[4px] transition-colors',
                  activeFilterCount
                    ? 'text-(--color-brand)'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                type="button"
              >
                <ListFilterIcon className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1">
              {(
                [
                  ['all', '机器人与群聊'],
                  ['bots', '仅机器人'],
                  ['groups', '仅群聊'],
                ] as const
              ).map(([value, label]) => (
                <FilterItem
                  checked={kindFilter === value}
                  key={`kind:${value}`}
                  label={label}
                  onSelect={() => setKindFilter(value)}
                />
              ))}
              <div className="my-1 border-t border-border/60" />
              {/* 活动筛选组：hermes 的 active/recent/older 依赖会话活动流，
                  pi 无此数据面——选项原样列出但禁用（红显占位，不装可用） */}
              <div
                className="text-rose-600 dark:text-rose-400 px-2.5 py-1 text-[0.625rem]"
                data-stub="true"
              >
                活动筛选（未接通）
              </div>
              {['任意活动', '活跃中', '近期活跃', '更早'].map((label) => (
                <button
                  className="flex w-full cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] opacity-50 outline-none"
                  disabled
                  key={`act:${label}`}
                  title="pi 无会话活动流——该筛选不可用（占位）"
                  type="button"
                >
                  <span className="min-w-0 flex-1">{label}</span>
                </button>
              ))}
              {connections.length > 1 && (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <FilterItem
                    checked={gatewayFilter === 'all'}
                    label="全部连接"
                    onSelect={() => setGatewayFilter('all')}
                  />
                  {connections.map((conn) => {
                    const count = visible.filter(
                      (b) => (b.connectionId ?? 'local') === conn.id,
                    ).length
                    return (
                      <FilterItem
                        checked={gatewayFilter === conn.id}
                        glyph={
                          conn.kind === 'local' ? (
                            <MonitorIcon className="text-muted-foreground size-3 shrink-0" />
                          ) : conn.kind === 'ssh' ? (
                            <TerminalIcon className="text-muted-foreground size-3 shrink-0" />
                          ) : conn.kind === 'cloud' ? (
                            <CloudIcon className="text-muted-foreground size-3 shrink-0" />
                          ) : (
                            <GlobeIcon className="text-muted-foreground size-3 shrink-0" />
                          )
                        }
                        key={`gw:${conn.id}`}
                        label={conn.label}
                        onSelect={() => setGatewayFilter(conn.id)}
                        trailing={
                          <>
                            <span className="text-muted-foreground/60 text-[0.625rem] tabular-nums">
                              {count}
                            </span>
                            {conn.id !== 'local' && (
                              <span className="text-rose-600/80 dark:text-rose-400/80 text-[0.625rem]">
                                未接通
                              </span>
                            )}
                          </>
                        }
                      />
                    )
                  })}
                </>
              )}
              {activeFilterCount > 0 && (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <FilterItem
                    label="清除筛选"
                    onSelect={() => {
                      setKindFilter('all')
                      setGatewayFilter('all')
                    }}
                  />
                </>
              )}
            </PopoverContent>
          </Popover>
          {/* New… 下拉（hermes roster-pane-toolbar :109-134 同位） */}
          <Popover align="end" sideOffset={6}>
            <PopoverTrigger>
              <button
                aria-label="新建…"
                className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-[4px] transition-colors"
                type="button"
              >
                <PlusIcon className="size-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1">
              <button
                className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none"
                onClick={() => setDialog({ mode: 'create' })}
                type="button"
              >
                <BotIcon className="text-muted-foreground size-[var(--size-icon-sm)]" />
                新建机器人
              </button>
              <button
                className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none"
                onClick={() => setGroupCreate(true)}
                type="button"
              >
                <UsersIcon className="text-muted-foreground size-[var(--size-icon-sm)]" />
                新建群聊
              </button>
              <button
                className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none"
                onClick={() => {
                  setSectionDraft('')
                  setDialog({ mode: 'section-create', bot: null })
                }}
                type="button"
              >
                <FolderPlusIcon className="text-muted-foreground size-[var(--size-icon-sm)]" />
                新建分区
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {/* 搜索（hermes SearchField underline 变体：无边框，静止 50% 透明、
          聚焦/有词 100%——roster-pane-toolbar :142 的容器类逐项对应）。
          pl-[30px] = 2026-11-14 间距对齐轮：搜索文字线对齐全栏文字线
          pane+50（原 px-2.5 → 文字 pane+32，与段头/行名称三条线互不相同）。 */}
      <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-[30px] pr-2.5">
        <div
          className={cn(
            'inline-flex h-7 min-w-0 max-w-full flex-1 items-center gap-1.5 border-b border-transparent px-0.5 transition-[color,border-color,opacity]',
            query ? 'opacity-100' : 'opacity-50 focus-within:opacity-100',
          )}
        >
          <SearchIcon className="pointer-events-none text-muted-foreground/70 size-3.5 shrink-0" />
          <input
            aria-label="搜索机器人"
            className="text-foreground placeholder:text-muted-foreground h-7 min-w-0 max-w-full flex-1 bg-transparent text-[0.75rem] outline-none"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索机器人…"
            value={query}
          />
          {query && (
            <button
              aria-label="清空搜索"
              className="text-muted-foreground/85 hover:bg-accent/60 hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-[4px]"
              onClick={() => setQuery('')}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      </div>

      {launchError && (
        <div className="set-err mx-2.5 mt-1" role="alert">
          {launchError}
        </div>
      )}

      {/* 内容（hermes roster-pane-content：空态在滚动区外；全部区块收进一个
          grid 容器——段头与行的左缘同线（容器 px-1.5 + 头/行 px-2）） */}
      {bots.length === 0 ? (
        <PanelEmpty
          description="点上方「机器人」图标新建一个预设。"
          icon={BotIcon}
          title="还没有机器人"
        />
      ) : allHidden && !hiddenExpanded ? (
        <AllHiddenBlock onShow={() => setHiddenExpanded(true)} />
      ) : visible.length === 0 && hiddenBots.length === 0 ? (
        <PanelEmpty description="换个关键词试试。" icon={SearchIcon} title="没有匹配的机器人" />
      ) : visibleFiltered.length === 0 && groupChatsFiltered.length === 0 ? (
        <PanelEmpty
          description="换个筛选条件试试。"
          icon={ListFilterIcon}
          title="没有匹配的机器人"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-slot="bots-roster">
          <div className="grid w-full min-w-0 gap-0.5 px-1.5 pb-2">
            {gatewayMode ? (
              /* 网关分区模式（hermes 同构）：每个连接一个区块；远端连接 =
                 头部尾部红标（占位规则）+ 行头像置灰。孤儿连接自成区块。 */
              <>
                {connections.map((conn) => {
                  const rows = visibleFiltered.filter(
                    (b) => (b.connectionId ?? 'local') === conn.id,
                  )
                  if (rows.length === 0) return null
                  return (
                    <GatewayBlock conn={conn} count={rows.length} key={conn.id}>
                      {renderUserSections(rows, true)}
                    </GatewayBlock>
                  )
                })}
                {orphanRows.length > 0 && (
                  <GatewayBlock
                    conn={{ id: 'orphan', kind: 'remote', label: '已删除的连接' }}
                    count={orphanRows.length}
                  >
                    {renderUserSections(orphanRows, true)}
                  </GatewayBlock>
                )}
              </>
            ) : null}
            {groupSection}
            {gatewayMode ? null : renderUserSections(visibleFiltered, false)}

            {/* 已隐藏区（hermes roster-pane-content :137-172：border-t 分隔 +
                caret 折叠 + 计数尾缀；行本体照常渲染，恢复走行右键
                「取消隐藏」——hermes 不渲染额外的恢复钮） */}
            {hiddenBots.length > 0 && (
              <div className="mt-1 border-t border-border/60 pt-1">
                {hasConstraint ? (
                  <div className="text-muted-foreground flex w-full items-center gap-1 px-2 py-1.5 text-[0.6875rem] font-medium">
                    <EyeOffIcon className="size-3" />
                    <span>已隐藏</span>
                    <span className="text-muted-foreground/60">{hiddenBots.length}</span>
                  </div>
                ) : (
                  <button
                    aria-expanded={hiddenExpanded}
                    className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[0.6875rem] font-medium transition-colors hover:bg-accent/60"
                    onClick={() => setHiddenExpanded((v) => !v)}
                    type="button"
                  >
                    <Caret open={hiddenExpanded} />
                    <span>已隐藏</span>
                    <span className="text-muted-foreground/60">{hiddenBots.length}</span>
                  </button>
                )}
                {(hiddenExpanded || hasConstraint) && renderRows(hiddenBots)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 删除确认（hermes DeleteBotDialog 的宿主轻量形态） */}
      {confirmDeleteBot && (
        <div className="bg-background/95 border-border/70 absolute inset-x-3 bottom-3 z-10 rounded-xl border p-3 shadow-lg">
          <div className="text-foreground text-xs font-medium">
            删除机器人「{botDisplayName(confirmDeleteBot)}」？
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            预设从花名册移除；已开的会话不受影响。
          </div>
          <div className="set-actions mt-2">
            <button
              className="set-btn pressable"
              onClick={() => setConfirmDelete(null)}
              type="button"
            >
              取消
            </button>
            <button
              className="set-btn set-btn-primary pressable"
              onClick={() => {
                botsStore.getState().remove(confirmDeleteBot.name)
                setConfirmDelete(null)
              }}
              type="button"
            >
              删除
            </button>
          </div>
        </div>
      )}

      {/* 对话框（新建/编辑 + 分区） */}
      {(dialog.mode === 'create' || dialog.mode === 'edit') && (
        <BotsDialog
          callbacks={{ launched: (bot) => void launch(bot) }}
          editing={dialog.mode === 'edit' ? dialog.bot : null}
          onClose={() => setDialog({ mode: 'closed' })}
        />
      )}
      {(dialog.mode === 'section-create' || dialog.mode === 'section-rename') && (
        <SectionDialog
          mode={dialog.mode}
          onChange={setSectionDraft}
          onClose={() => setDialog({ mode: 'closed' })}
          onSubmit={submitSection}
          value={sectionDraft}
        />
      )}
      {groupCreate && (
        <CreateGroupDialog
          bots={bots.filter((b) => !b.hidden)}
          groupChats={groupChats}
          onClose={() => setGroupCreate(false)}
          onCreate={(name, members, image) => {
            botStubStore.getState().createGroup(name, members, image)
            setGroupCreate(false)
          }}
        />
      )}
    </div>
  )
}

/** 分区新建/重命名小对话框（settings-overlay 族外观）。 */
function SectionDialog({
  mode,
  onChange,
  onClose,
  onSubmit,
  value,
}: {
  mode: 'section-create' | 'section-rename'
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
  value: string
}) {
  // Esc 关闭（CreateGroupDialog 同款分层）
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
  return (
    <div className="set-overlay" onClick={onClose} role="presentation">
      <div
        aria-label={mode === 'section-create' ? '新建分区' : '重命名分区'}
        aria-modal="true"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={{ width: 384, maxWidth: '95vw', height: 'auto', display: 'block' }}
      >
        {/* hermes SectionNameDialog（user-sections-ui.tsx :81-112）度量：
            body = grid gap-3 p-4；标题 15px semibold 无描述行；Input 直接放
            （maxLength 40、autofocus、Enter 提交）；footer 右对齐 gap-2。 */}
        <div className="grid gap-3 p-4" onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}>
          <h2 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
            {mode === 'section-create' ? '新建分区' : '重命名分区'}
          </h2>
          <input
            aria-label="分区名"
            autoFocus
            className="set-input"
            maxLength={40}
            onChange={(e) => onChange(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="分区名"
            value={value}
          />
          <div className="flex justify-end gap-2">
            <button className="set-btn pressable" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary pressable"
              disabled={!value.trim()}
              onClick={onSubmit}
              type="button"
            >
              {mode === 'section-create' ? '创建' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
