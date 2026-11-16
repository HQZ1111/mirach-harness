/**
 * `@hermes/plugin-sdk` 的宿主 shim —— 让上游 `hermes-bots` 插件的 121 个文件
 * 能**逐字复制**进 Mirach 而不改一行 import。
 *
 * ## 为什么需要它
 *
 * 上游 bots 用 `import { X } from '@hermes/plugin-sdk'` 147 次，涉及 88 个符号。
 * 上游的 SDK 是 `apps/desktop/src/sdk/index.ts`（5,518 行），它自己又深依赖
 * hermes 的 store 层（48 个模块 / 17,831 行）。
 *
 * 宿主（Mirach）没有那套 store。所以这里是**能力对偶**：把 88 个符号逐个映射到
 * 宿主已有的实现，缺的用薄封装补齐。
 *
 * ## 分类
 *
 * | 类别 | 来源 | 数量 |
 * |---|---|---|
 * | UI 组件 | `@/components/ui/*` | 约 30 |
 * | 镜像组件 | `@/hermes-mirror/*`（已从 hermes 复制） | 约 10 |
 * | 状态原语 | `nanostores` 直接转发 | 5 |
 * | 数据面 | 宿主 IPC / query | 约 10 |
 * | 常量/工具 | 本地实现 | 约 30 |
 *
 * ## 与上游的差异（诚实标注，不假装等价）
 *
 * 上游 SDK 的部分能力宿主**没有**，这里返回明确的安全默认值并注释原因，
 * 而不是编造行为：
 *
 * - `host.*` 的多租户/多连接语义 → 宿主单身份，固定返回本地
 * - `gatewayActivationEpoch` / `useGatewayActivationEpoch` → 宿主无 gateway 概念，恒 0
 * - `resolveSiblingWsUrl` → 宿主无 sibling 窗口，返回 null
 * - `catalogProviderMatches` → 宿主无 catalog，恒 false
 */

// ── UI 组件：全部来自 hermes-mirror 的逐字副本 ────────────────────────────
//
// 2026-11-16：原实现 re-export 宿主 `@/components/ui/*`（shadcn/自造），props
// 与上游组件不是一套（Select 甚至被映射成 ToggleRow），插件的 121 个文件
// 因此报 200+ 个 TS2322/2339/2554。改为逐字副本后，插件看到的就是 hermes
// 的 API。

export { Badge } from '@/hermes-mirror/components/ui/badge'
export { Button } from '@/hermes-mirror/components/ui/button'
export { Checkbox } from '@/hermes-mirror/components/ui/checkbox'
export { Codicon } from '@/hermes-mirror/components/ui/codicon'
export { ColorSwatches } from '@/hermes-mirror/components/ui/color-swatches'
export { ConfirmDialog } from '@/hermes-mirror/components/ui/confirm-dialog'
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/hermes-mirror/components/ui/context-menu'
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/hermes-mirror/components/ui/dialog'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/hermes-mirror/components/ui/dropdown-menu'
export { EmptyState } from '@/hermes-mirror/components/ui/empty-state'
export { Input } from '@/hermes-mirror/components/ui/input'
export { RowButton } from '@/hermes-mirror/components/ui/row-button'
export { SearchField } from '@/hermes-mirror/components/ui/search-field'
export { SegmentedControl } from '@/hermes-mirror/components/ui/segmented-control'
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/hermes-mirror/components/ui/select'
export { Switch } from '@/hermes-mirror/components/ui/switch'
export { Textarea } from '@/hermes-mirror/components/ui/textarea'
export {
  Tip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/hermes-mirror/components/ui/tooltip'

// ── 镜像组件（`src/hermes-mirror/` 已从 hermes 逐字复制）─────────────────────

export { GlyphSpinner } from '@/hermes-mirror/components/ui/glyph-spinner'
export { DisclosureCaret } from '@/hermes-mirror/components/ui/disclosure-caret'
export { CopyButton } from '@/hermes-mirror/components/ui/copy-button'
export { ListRow, ToggleRow } from '@/hermes-mirror/app/settings/primitives'
export { SidebarRowLead } from '@/hermes-mirror/app/chat/sidebar/chrome'
export { PanelEmpty } from '@/hermes-mirror/app/overlays/panel'
export { LocalizedTabTitle } from '@/hermes-mirror/i18n'

// ── 状态原语（nanostores / react-query 直接转发）────────────────────────────

export { atom, computed } from 'nanostores'
export { useStore as useValue } from '@nanostores/react'
export { useQuery } from '@tanstack/react-query'

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 上游 `cn`：clsx + tailwind-merge。宿主同源（`src/lib/utils`）。 */
export { cn } from '@/lib/utils'

/** 上游 `randomUuid`：用于窗口/会话临时 id。 */
export function randomUuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 上游 `LruCache`：有界 LRU。宿主侧同一语义的最小实现。 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // 命中即提到队尾（Map 保持插入序）
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/** 上游 `relativeTime` / `coarseElapsed`：复用宿主已有的时间工具（同一个镜像源）。
 *  注意 `coarseElapsed` 返回 `{unit, value}` 而不是字符串——与上游同形。 */
export { relativeTime, coarseElapsed } from '@/hermes-shim/lib/time'

/** 上游 `nextRunOverdueMs(job)`：cron 下次运行是否已逾期（null = 未逾期）。
 *  必须用镜像里的真实现——曾在这里手写 `(next:number)` 近似版，插件传的是
 *  **job 对象**，`now - object` = NaN → 恒判"逾期"，列表每行都显示
 *  「逾期自：15小时后」这种自相矛盾的标签。 */
export { nextRunOverdueMs, NEXT_RUN_OVERDUE_GRACE_MS } from '@/hermes-mirror/app/cron/job-state'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 上游：审批应答超时（毫秒）。 */
export const APPROVAL_RESPOND_TIMEOUT_MS = 30_000

/** 上游：编辑器回车提交判定（Shift+Enter 换行）。 */
export function isSubmitEnter(event: {
  key: string
  shiftKey?: boolean
  isComposing?: boolean
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey) return false
  if (event.isComposing) return false
  return true
}

// ── 布局区域常量（上游 Area id）─────────────────────────────────────────────
//
// 上游用「贡献区」把 UI 挂到宿主不同位置。宿主没有那套 Area 系统（bots 改落
// 独立面板），所以这些恒量只保留**标识符**，让上游代码能 import 而不报错，
// 实际挂载位置由宿主面板决定。

export const CHAT_EMPTY_AREA = 'chat.empty'
/**
 * 上游 `COMPOSER_AREAS`（`app/chat/composer/contrib.ts:32`）：输入区的 11 个
 * 贡献槽位。
 *
 * 宿主没有那套贡献区系统（ bots 已改落独立面板），但**标识符必须齐全**——
 * 上游代码按 `COMPOSER_AREAS.atCompletions` 这类方式取键，缺一个就编译不过。
 * 保留全部键让代码能编译；实际挂载点由宿主面板决定。
 */
export const COMPOSER_AREAS = {
  top: 'composer.top',
  bottom: 'composer.bottom',
  underside: 'composer.underside',
  leading: 'composer.leading',
  actions: 'composer.actions',
  middleware: 'composer.middleware',
  attachments: 'composer.attachments',
  microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions',
  modelPill: 'composer.modelPill',
  contextMenu: 'composer.contextMenu',
} as const
export const PALETTE_AREA = 'command.palette'
export const SIDEBAR_PROFILE_GROUP_HEADER_AREA = 'sidebar.profile.group.header'

// ── 样式类常量 ──────────────────────────────────────────────────────────────

/** 上游：幽灵图标按钮的尺寸类。 */
export const GHOST_ICON_BTN = 'size-6 rounded-[4px] hover:bg-[var(--hover-wash)]'

/** 上游：主图标按钮的尺寸类。 */
export const PRIMARY_ICON_BTN = 'size-7 rounded-md'

/** 上游：composer 输入区的 backing 样式。 */
export const composerInputBacking = 'rounded-md border bg-background'

/** 上游：composer 表面描边。 */
export const composerSurfaceRing = 'ring-1 ring-border'

// ── 调色板 ──────────────────────────────────────────────────────────────────

/** 上游 `PROFILE_SWATCHES` / `profileColor`：纯色板与确定性取色。
 *  `ColorSwatches` 本身是 UI 组件（上面从 hermes-mirror 导出），不要再导出
 *  同名数组——重复导出会让 tsc 直接报错。 */
export { PROFILE_SWATCHES, profileColor } from '@/lib/profile-color'
// ── host 数据面 ─────────────────────────────────────────────────────────────

export { host } from './host'

// ── query client ────────────────────────────────────────────────────────────

export { queryClient } from '@/hermes-shim/lib/query-client'

// ── 触感反馈 ────────────────────────────────────────────────────────────────

/**
 * 上游 `haptic`：轻触反馈（macOS 触控板 / 移动端震动）。
 * 宿主对偶：`@/hermes-shim/lib/haptics`（已从 hermes 复制）。
 */
export { triggerHaptic as haptic } from '@/hermes-shim/lib/haptics'

// ── 会话状态点 / 连接字形 / 侧栏行首 ────────────────────────────────────────

/**
 * 上游 `SessionStatusDot`：会话状态圆点（忙/闲/错误）。
 * 宿主对偶：本地实现（同形：tone → 颜色）。
 */
export { SessionStatusDot } from './session-status-dot'

/**
 * 上游 `ConnectionGlyph`：连接类型图标（本地/SSH/远程）。
 * 宿主对偶：本地实现。
 */
export { ConnectionGlyph } from './connection-glyph'

/**
 * 上游 `Wordmark`：品牌字标。
 * 宿主对偶：本地实现（Mirach 字标）。
 */
export { Wordmark } from './wordmark'

// ── i18n ────────────────────────────────────────────────────────────────────

/**
 * 上游 `useI18n` / `usePluginI18n` / `translateNow` / `PluginTranslate` 等：
 * 宿主 i18n 是 `@/hermes-mirror/i18n`（已从 hermes 复制），语义同源。
 *
 * `usePluginI18n(id)` 在上游是"取该插件的语言包"。宿主单语言包，
 * 忽略 id 返回同一个 t。
 */
export { useI18n } from '@/hermes-mirror/i18n'

/** 上游 `usePluginI18n`：插件命名空间的翻译器（读 ctx.i18n.register 的包）。
 *  **不要**别名到 useI18n——后者返回 `{t, locale}` 对象，插件按函数调用，会
 *  在第一次读字符串时抛 "t is not a function"。 */
export { usePluginI18n } from '@/hermes-mirror/i18n'

/** 上游 `translateNow`：命令式翻译（不订阅）。 */
export { translateNow } from '@/hermes-mirror/i18n'

/** 上游 `PluginTranslate` / `PluginLocaleBundles`：类型别名，运行时不需要值。 */
export type PluginTranslate = (key: string, vars?: Record<string, unknown>) => string
export type PluginLocaleBundles = Record<string, Record<string, string>>

// ── 会话未读 / 激活代际 ─────────────────────────────────────────────────────

/**
 * 上游 `gatewayActivationEpoch`：网关每次重连自增，用于让订阅者知道"要重取"。
 * **上游是函数不是常量**（`store/gateway.ts:434`：`export function
 * gatewayActivationEpoch(): number`；插件在 `groupCreationSource` 等处直接
 * 调用 `gatewayActivationEpoch()`）。写成 `const = 0` 会让调用点抛
 * "gatewayActivationEpoch is not a function"——群聊创建对话框因此永远停在
 * "检查中"（settle 在 then 里抛错，capability 永不落地）。
 *
 * 宿主没有 gateway socket（进程内引擎），**恒 0**。上游代码用它做 cache
 * 失效，恒 0 等价于"从不失效"——宿主侧数据本来就由 query 的 staleTime 管理。
 */
export function gatewayActivationEpoch(): number {
  return 0
}

/** 上游 `useGatewayActivationEpoch`：同上，hook 形态。 */
export function useGatewayActivationEpoch(): number {
  return 0
}

/** 上游 `ackStoredSessionId`：把某存储会话标记为已读。 */
export function ackStoredSessionId(_sessionId: string): void {
  // 宿主会话未读由 sessionCatalog 管理；这里用事件通知
  window.dispatchEvent(new CustomEvent('mirach:ack-session', { detail: _sessionId }))
}

/** 上游 `markSessionUnreadFinished`：会话的"进行中"标记结束。 */
export function markSessionUnreadFinished(_sessionId: string): void {}

/** 上游 `forgetSessionUnread`：忘掉某会话的未读状态。 */
export function forgetSessionUnread(_sessionId: string): void {}

/** 上游 `resolveSiblingWsUrl`：解析 sibling 窗口的 WebSocket URL。 */
export function resolveSiblingWsUrl(_args?: unknown): null {
  // 宿主没有 sibling 窗口概念（单主窗 + 设置窗），返回 null
  return null
}

/** 上游 `surfaceModelSwitchConfirm`：切模型时的确认门。 */
export function surfaceModelSwitchConfirm(_args: unknown): Promise<boolean> {
  // 宿主模型切换在 composer 里，无二次确认需求 → 直接放行
  return Promise.resolve(true)
}

// ── 消息正文渲染 ────────────────────────────────────────────────────────────

export { MessageTextContent, MarkdownTextContent, Streamdown } from './message-text'

// ── 会话水合超时 ────────────────────────────────────────────────────────────

/**
 * 上游 `DEFAULT_SESSION_HYDRATION_TIMEOUT_MS`：普通会话水合的等待上限。
 * 宿主一次性 `pi_get_state` 是本地 IPC，不需要 20 秒；但保留上游数值，
 * 让上层超时逻辑行为一致（早退 vs 晚退不影响正确性）。
 */
export const DEFAULT_SESSION_HYDRATION_TIMEOUT_MS = 20_000

/** 上游：Bot 会话水合上限（机器人会话历史更长，给 60 秒）。 */
export const BOT_CHAT_SESSION_HYDRATION_TIMEOUT_MS = 60_000

/** 上游：水合期同步徽标的显示上限。 */
export const HYDRATION_SYNC_BADGE_TIMEOUT_MS = 30_000

// ── 能力视图（宿主**不提供**——上游 own 这些面是可选门）────────────────────
//
// 上游 profile-config / create-dialog 用 `import * as sdk` + 存在性检测来
// 决定是否渲染训练能力页；**旧版宿主没有这些导出是上游支持的一等状态**。
// 2026-11-16：这三个组件来自 hermes-mirror 的 capabilities/settings 树，那棵树
// 反向 import 了本仓不存在的 `@/app/*`、`@/store/*` 模块——导出它们会把整棵
// 断链图拖进插件模块图（vite Failed to resolve import 一串）。所以不导出，
// 上游自然走"老网关/老宿主"分支。

// ── blobatar（生成式头像）───────────────────────────────────────────────────

/**
 * 上游 `blobatarSvg`：根据 seed 生成确定性 SVG 头像。
 *
 * 宿主没有该算法（上游在 SDK 内部实现）。返回 `undefined` 是上游**自己的
 * 降级路径**（见 `avatar.tsx:16`：`typeof sdk === 'undefined' ? undefined :
 * sdk.blobatarSvg`），上游代码会自然回落到字母头像。
 *
 * 不在这里伪造一个"看起来像"的 SVG——那会让用户以为换了算法。
 */
export const blobatarSvg: undefined | ((seed: string, opts?: Record<string, unknown>) => null | string) = undefined

// ── 预算循环（波形/动画节流）────────────────────────────────────────────────

/**
 * 上游 `createBudgetedLoop`：带 fps 预算与 idle 判据的 rAF 循环。
 *
 * 宿主已有等价实现（`@/lib/budgeted-loop`，从 hermes 复制）。
 */
export { createBudgetedLoop } from './budgeted-loop'

// ── 类型导出（编译期擦除；形态见 ./types.ts）─────────────────────────────────

export type {
  ChatEmptyProps,
  DisplayLease,
  DisplayObserveResult,
  DisplayStatus,
  DisplayThumbnailResult,
  PetSayOptions,
  PluginContext,
  PluginNativeNotificationInput,
  PluginNewChatOptions,
  PluginOpenSessionOptions,
  PluginProfileRoute,
  ProfileGroupRoute,
  ProfileSessionPreview,
  ProfilesCreateResult,
  RpcEvent,
  SessionListRow,
} from './types'

// ── catalogProviderMatches ──────────────────────────────────────────────────

/**
 * 上游 `catalogProviderMatches`：判断 catalog 条目的 provider 是否等于当前 provider。
 *
 * 宿主对偶：`@/hermes-mirror/lib/model-options`（同一个镜像源）。
 */
export { catalogProviderMatches } from '@/hermes-mirror/lib/model-options'
