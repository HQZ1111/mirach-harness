/**
 * 左栏底部「配置档案切换器」（2026-11-26 用户："把档案栏组件改成显示头像和
 * 名字，点击头像弹窗切换档案，就是把现在的档案栏上下排列，放在弹窗中显示。
 * 把这个组件替换原来的底部头像组件，原来的删除。"）。
 *
 * 结构：
 * - **底栏 = 当前生效环境的头像 + 名字**（头像/名字同源 botsStore + 活动
 *   环境，与旧 RailUserZone 的面孔一致；齿轮保留）；
 * - **点击头像/名字 → 弹窗**（Radix Popover）里**上下排列**的档案
 *   列表：每行 = 头像 + 显示名（+ 未读/运行中/待输入状态点 / 切换中
 *   spinner / 活动勾选）；点击行 = 切活动环境（selectProfile 语义：引擎
 *   set_active + 侧栏换源 + 机器人页选中同步）。
 * - 列表顶部=本体（Mirach），具名档案按 `profileRailOrder` 拖拽重排
 *   （垂直列表，抓手在行尾）；底部 = 全部配置档案 / 管理配置档案 /
 *   新建 / 导入。
 * - 重命名 / 编辑 SOUL / 导出 / 删除 / 颜色 全部在「管理配置档案」页
 *   （`openProfilesPanel`）里做——弹窗只负责切换与环境动作，不再塞第二套
 *   管理菜单。
 *
 * **不移植且不造假**（宿主没有对应数据面）：每档案远端覆盖（profile
 * remote override）、多网关 fleet 分组（宿主只有 local 连接）。
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useStore } from '@nanostores/react'
import {
  CheckIcon,
  Columns2Icon,
  DownloadIcon,
  EllipsisIcon,
  GripVerticalIcon,
  LayersIcon,
  Loader2,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react'
import { useEffect, useState, type FC, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { useApprovalBridge } from '@/components/assistant-ui/approval-bridge'
import { errorBridge } from '@/components/assistant-ui/error-bridge'
import { openSettingsOverlay } from '@/components/layout/app-context-menu'
import { Tooltip } from '@/components/motion/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  avatarColor,
  botAppearance,
  BotFace,
} from '@/hermes-mirror/plugins/hermes-bots/avatar'
import {
  botDisplayName,
  botPhotoImage,
  botsStore,
  DEFAULT_BOT_AVATAR,
  DEFAULT_BOT_NAME,
  type BotPreset,
  useBotsStore,
} from '@/components/panes/hub/bots-store'
import { openBotsPanel } from '@/components/panes/hub/bots-panel-actions'
import {
  switchProfileBridge,
  useActiveProfile,
} from '@/components/panes/session-manage/active-profile-bridge'
import { sidebarViewStore, useSidebarView } from '@/components/panes/session-manage/sidebar-view'
import { isRowUnread, useSessionManage } from '@/components/panes/session-manage/session-catalog'
import { STATUS_DOT_CLASS } from '@/components/panes/session-manage/session-status'
import { setProfileRailOrder, useProfileRailOrder } from '@/lib/profile-rail-pref'
import { requestBotsAction } from '@/plugins/bots-request-bridge'
import { useBotsFeatureDesired } from '@/plugins/bots-gate'
import { $hostBusy } from '@/sdk/host'

import { NoticeDialog } from './profile-dialogs'
import { openProfilesPanel } from './profiles-actions'

/** 拖拽只走垂直轴（列表上下换位）。 */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** 悬停预热（hermes useProfilePrewarm 的宿主对偶；每名字每次会话一次）。 */
const warmedProfiles = new Set<string>()

function prewarmProfile(name: string): void {
  if (name === DEFAULT_BOT_NAME || warmedProfiles.has(name)) return
  warmedProfiles.add(name)
  void import('@/sdk/host').then(({ host }) => host.warmProfile(name)).catch((e) => {
    console.error(`[profile-switcher] 预热 ${name} 失败（忽略，不影响点击）`, e)
  })
}

interface ProfileDotSummary {
  state: 'needs-input' | 'unread' | 'working'
  needsInputCount: number
  workingCount: number
  unreadCount: number
}

function profileStatusLabel(summary: ProfileDotSummary): string {
  const parts: string[] = []
  if (summary.needsInputCount > 0) parts.push(`${summary.needsInputCount} 个会话需要你的回答`)
  if (summary.workingCount > 0) parts.push(`${summary.workingCount} 个会话运行中`)
  if (summary.unreadCount > 0) parts.push(`${summary.unreadCount} 个会话未读`)
  return parts.join('，')
}

function ProfileStatusDot({ summary }: { summary: ProfileDotSummary }) {
  return <span aria-hidden className={STATUS_DOT_CLASS[summary.state]} data-slot="profile-status-dot" />
}

/** 单档案的未读会话数（hermes profile-dot-state 的宿主投影）。 */
function useProfileUnreadCount(profile: null | string): number {
  return useSessionManage((s) => {
    let count = 0
    for (const entry of Object.values(s.entries)) {
      if ((entry.profile ?? null) !== profile) continue
      const messageCount = typeof entry.messageCount === 'number' ? entry.messageCount : 0
      if (messageCount > 0 && isRowUnread({ id: entry.id, messageCount }, s.seen, s.markers)) {
        count += 1
      }
    }
    return count
  })
}

/** 行内状态汇总：未读 + 当前活动会话的运行中/待输入（hermes #91710 语义：
 *  活动行自身不画点）。 */
function useProfileDotSummary(active: boolean, profileKey: null | string): ProfileDotSummary | null {
  const unread = useProfileUnreadCount(profileKey)
  const busy = useStore($hostBusy)
  const pendingApprovals = useApprovalBridge().pending.length
  const activeSessionProfile = useSessionManage((s) => {
    const id = s.activeId
    return id ? (s.entries[id]?.profile ?? null) : null
  })
  const needsInputCount = !active && pendingApprovals > 0 && activeSessionProfile === profileKey ? 1 : 0
  const workingCount = !active && needsInputCount === 0 && busy && activeSessionProfile === profileKey ? 1 : 0
  if (active || (needsInputCount === 0 && workingCount === 0 && unread === 0)) return null
  return {
    state: needsInputCount > 0 ? 'needs-input' : workingCount > 0 ? 'working' : 'unread',
    needsInputCount,
    workingCount,
    unreadCount: unread,
  }
}

/** 头像（机器人页同一判定：真照片用 img；160×160 人脸回填用实时 BotFace；
 *  无行/无图回落品牌 logo）。 */
function ProfileAvatar({ bot, size = 22 }: { bot: BotPreset | null; size?: number }) {
  const wrapper = (children: ReactNode) => (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {children}
    </span>
  )
  if (!bot) return wrapper(<img alt="" className="rail-user-avatar-img" src={DEFAULT_BOT_AVATAR} />)
  const appearance = botAppearance(bot.name, {
    color: bot.color ?? undefined,
    shape: bot.shape ?? undefined,
    image: bot.image ?? undefined,
    custom: bot.custom === true,
  })
  const photo = botPhotoImage(bot)
  if (photo) return wrapper(<img alt="" className="rail-user-avatar-img" src={photo} />)
  return wrapper(
    <BotFace
      color={avatarColor(appearance.color, bot.name)}
      mood="idle"
      name={bot.name}
      shape={appearance.shape}
      size={size}
    />,
  )
}

function sortBots(bots: readonly BotPreset[], order: readonly string[]): BotPreset[] {
  const rank = new Map(order.map((name, index) => [name, index]))
  const defaults = bots.filter((bot) => bot.name === DEFAULT_BOT_NAME)
  const named = bots
    .filter((bot) => bot.name !== DEFAULT_BOT_NAME)
    .sort(
      (a, b) =>
        (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
    )
  return [...defaults, ...named]
}

const MenuRow: FC<{
  icon: ReactNode
  label: ReactNode
  onClick: () => void
  trailing?: ReactNode
}> = ({ icon, label, onClick, trailing }) => (
  <button
    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground"
    onClick={onClick}
    type="button"
  >
    <span className="grid size-5 shrink-0 place-items-center text-(--ui-text-tertiary)">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {trailing}
  </button>
)

/** 一行档案：头像 + 名字 + 状态；活动行带勾选；具名行有拖拽抓手。 */
function ProfileRow({
  active,
  bot,
  draggable,
  failed,
  onOpenInColumn,
  onSelect,
  pending,
}: {
  active: boolean
  bot: BotPreset
  draggable: boolean
  failed: boolean
  onOpenInColumn: () => void
  onSelect: () => void
  pending: boolean
}) {
  const summary = useProfileDotSummary(active, bot.name === DEFAULT_BOT_NAME ? null : bot.name)
  const statusText = summary ? profileStatusLabel(summary) : null
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: bot.name,
    disabled: !draggable,
  })
  const label = botDisplayName(bot)

  return (
    <div
      className="group relative flex items-center"
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <button
        aria-label={statusText ? `${label}, ${statusText}` : label}
        aria-pressed={active}
        className={
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ' +
          (active
            ? 'bg-(--ui-control-active-background) text-foreground'
            : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground') +
          (isDragging ? ' opacity-80' : '')
        }
        onClick={onSelect}
        onPointerEnter={() => prewarmProfile(bot.name)}
        title={statusText ? `${label} · ${statusText}` : label}
        type="button"
      >
        <ProfileAvatar bot={bot} size={24} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {pending && <Loader2 aria-hidden className="size-3 shrink-0 animate-spin text-(--ui-text-tertiary)" />}
        {failed && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--destructive)" />}
        {!failed && summary && <ProfileStatusDot summary={summary} />}
        {active && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-(--brand)" />}
      </button>
      <button
        aria-label={`在新分栏打开 ${label}`}
        className="grid size-5 shrink-0 place-items-center rounded text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onOpenInColumn()
        }}
        title="在新分栏打开"
        type="button"
      >
        <Columns2Icon className="size-3.5" />
      </button>
      {draggable && (
        <button
          aria-label={`拖动排序 ${label}`}
          className="grid size-5 shrink-0 cursor-grab place-items-center rounded text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** 设置齿轮（档案栏与"仅齿轮"回退态共用；设置入口不能随插件关闭消失）。 */
function SettingsGear() {
  return (
    <Tooltip content="设置" side="top">
      <button
        aria-label="设置"
        className="rail-user-settings pressable-sm"
        onClick={() => openSettingsOverlay()}
        type="button"
      >
        <SettingsIcon aria-hidden className="size-[var(--size-icon-lg)]" />
      </button>
    </Tooltip>
  )
}

export function ProfileSwitcher() {
  const bots = useBotsStore((s) => s.bots)
  const order = useProfileRailOrder()
  const activeProfile = useActiveProfile()
  const showAllProfiles = useSidebarView((s) => s.showAllProfiles)
  // bots 插件关闭 = 整个机器人面（含配置档案栏）一起消失（用户 2026-11-26：
  // "bots关了之后是整个关吗，机器人页和配置档案栏一起消失"）。档案栏是
  // bots 面的入口（切换/新建/导入配置档案都经它），插件关掉后只剩设置齿轮；
  // 侧栏「环境」菜单仍是核心 profile 切换的兜底入口（不锁死用户）。
  const botsEnabled = useBotsFeatureDesired()

  const [open, setOpen] = useState(false)
  const [pendingName, setPendingName] = useState<null | string>(null)
  const [failedName, setFailedName] = useState<null | string>(null)
  const [notice, setNotice] = useState<null | string>(null)

  // 窗口重新获得焦点/可见时重拉花名册（hermes useProfileRailRefreshOnActive
  // 对偶：机器人页/设置页/CLI 改了档案，底栏不能停在旧快照）。
  useEffect(() => {
    const refresh = () => botsStore.getState().load()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const sorted = sortBots(bots, order)
  const activeBot = sorted.find((bot) => bot.name === (activeProfile ?? DEFAULT_BOT_NAME)) ?? sorted[0] ?? null
  const triggerLabel = activeBot ? botDisplayName(activeBot) : 'Mirach'

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (!botsEnabled) {
    return (
      <div className="rail-user-zone" data-bots-disabled="true" data-slot="profile-switcher">
        <SettingsGear />
      </div>
    )
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const named = sorted.filter((bot) => bot.name !== DEFAULT_BOT_NAME).map((bot) => bot.name)
    const from = named.indexOf(String(active.id))
    const to = named.indexOf(String(over.id))
    if (from >= 0 && to >= 0) setProfileRailOrder(arrayMove(named, from, to))
  }

  const switchTo = (profile: null | string): void => {
    const key = profile ?? DEFAULT_BOT_NAME
    setOpen(false)
    setFailedName(null)
    setPendingName(key)
    void switchProfileBridge(profile).then((ok) => {
      setPendingName((current) => (current === key ? null : current))
      if (!ok) setFailedName(key)
    })
  }

  const importProfile = async (): Promise<void> => {
    setOpen(false)
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
      const archive = await openDialog({
        title: '导入配置档案',
        multiple: false,
        filters: [{ name: 'Mirach profile', extensions: ['tar.gz', 'tgz'] }],
      })
      if (!archive || Array.isArray(archive)) return
      const result = await invoke<{ name: string }>('pi_profile_import', { archive })
      if (!botsStore.getState().bots.some((bot) => bot.name === result.name)) {
        botsStore.getState().upsert({
          name: result.name,
          title: '',
          systemPrompt: '',
          model: '',
          cwd: '',
          description: '导入的配置档案',
          createdAt: Date.now(),
        })
      }
      botsStore.getState().load()
      setNotice(`已导入配置档案「${result.name}」`)
    } catch (e) {
      errorBridge
        .getState()
        .setError(`导入配置档案失败：${e instanceof Error ? e.message : String(e)}`, false)
    }
  }

  const createProfile = (): void => {
    setOpen(false)
    openBotsPanel()
    requestBotsAction({ kind: 'create' })
  }

  /** 在新分栏打开该档案的新会话（hermes launch 菜单「在新窗口中打开」的
   *  宿主对偶：主窗单实例，但 dockview 可以多栏——host.newChat 的
   *  workspaceMode:'bots' 就把新会话开在主区右侧新栏）。 */
  const openInColumn = (bot: BotPreset): void => {
    setOpen(false)
    void import('@/sdk/host')
      .then(({ host }) => host.newChat(bot.name, { workspaceMode: 'bots' }))
      .catch((e) => {
        errorBridge
          .getState()
          .setError(`在新分栏打开「${botDisplayName(bot)}」失败：${e instanceof Error ? e.message : String(e)}`, false)
      })
  }

  return (
    <div className="rail-user-zone" data-slot="profile-switcher">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-label={`配置档案：${triggerLabel}`}
            className="profile-switcher-trigger"
            title={triggerLabel}
            type="button"
          >
            <ProfileAvatar bot={activeBot} size={26} />
            <span className="rail-user-name">{triggerLabel}</span>
            {pendingName && (
              <Loader2 aria-hidden className="size-3 shrink-0 animate-spin text-(--ui-text-tertiary)" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 max-h-[65vh] overflow-y-auto p-1.5"
          onOpenAutoFocus={(event) => event.preventDefault()}
          side="top"
          sideOffset={8}
        >
          <div className="px-2 pb-1 pt-0.5 text-[0.65rem] text-(--ui-text-tertiary)">
            配置档案 · {sorted.length}
          </div>

          {/* 本体行（固定第一，不参与拖拽） */}
          {sorted
            .filter((bot) => bot.name === DEFAULT_BOT_NAME)
            .map((bot) => (
              <ProfileRow
                active={!showAllProfiles && (activeProfile ?? DEFAULT_BOT_NAME) === bot.name}
                bot={bot}
                draggable={false}
                failed={failedName === bot.name}
                key={bot.name}
                onOpenInColumn={() => openInColumn(bot)}
                onSelect={() => switchTo(null)}
                pending={pendingName === bot.name}
              />
            ))}

          {/* 具名档案（垂直拖拽重排） */}
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[verticalOnly]}
            onDragEnd={handleDragEnd}
            sensors={sensors}
          >
            <SortableContext
              items={sorted.filter((bot) => bot.name !== DEFAULT_BOT_NAME).map((bot) => bot.name)}
              strategy={verticalListSortingStrategy}
            >
              {sorted
                .filter((bot) => bot.name !== DEFAULT_BOT_NAME)
                .map((bot) => (
                  <ProfileRow
                    active={!showAllProfiles && activeProfile === bot.name}
                    bot={bot}
                    draggable
                    failed={failedName === bot.name}
                    key={bot.name}
                    onOpenInColumn={() => openInColumn(bot)}
                    onSelect={() => switchTo(bot.name)}
                    pending={pendingName === bot.name}
                  />
                ))}
            </SortableContext>
          </DndContext>

          <div className="mx-1 my-1 h-px bg-(--stroke-soft)" />

          <MenuRow
            icon={<LayersIcon className="size-3.5" />}
            label="全部配置档案"
            onClick={() => {
              sidebarViewStore.getState().setShowAllProfiles(!showAllProfiles)
              setOpen(false)
            }}
            trailing={showAllProfiles ? <CheckIcon aria-hidden className="size-3.5 text-(--brand)" /> : null}
          />
          <MenuRow
            icon={<EllipsisIcon className="size-3.5" />}
            label="管理配置档案…"
            onClick={() => {
              setOpen(false)
              openProfilesPanel()
            }}
          />
          <MenuRow icon={<PlusIcon className="size-3.5" />} label="新建配置档案…" onClick={createProfile} />
          <MenuRow
            icon={<DownloadIcon className="size-3.5" />}
            label="导入配置档案…"
            onClick={() => void importProfile()}
          />
        </PopoverContent>
      </Popover>

      <SettingsGear />

      <NoticeDialog message={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
