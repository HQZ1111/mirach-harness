/**
 * 全局设置浮层（pi-integration.md §7-7 设置页接线）。
 *
 * **左导航结构（用户 2026-10-22 定稿，逐字对上）**：5 组 20 项——
 * 基础设置 / Agent 控制 / 安全与数据 / 插件集成 / 关于。分组与项名的
 * 真源是下方 NAV_GROUPS；组内顺序 = 键盘 ↑/↓ 的遍历顺序。
 * 视觉骨架照搬 beui AnimatedSidebar 的"组标题 + 菜单项"样式（见
 * overlays.css 的 .set-nav 家族），但**不引入 motion/react**——只用现有
 * CSS 令牌与静态样式。
 * 旧节映射（面板实现沿用，只换挂载点与标题）：
 *   模型 → Agent 控制 / 模型（默认模型 + 重试与故障转移两块）
 *   压缩 · compaction → Agent 控制 / 记忆
 *   提供方凭据 → 安全与数据 / 安全（第一个子块）
 *   重试 · retry → Agent 控制 / 模型（重试/故障转移是模型请求域）
 *   高级 · 原始配置 → 安全与数据 / 安全（第二个子块）
 *   关于 → 关于 / 版本与更新
 * 其余项无数据面，一律占位面板 + 逐项说明原因（铁律 12：不假装有
 * 功能、不造假数据）；文案在 NAV_GROUPS 的 placeholder 字段，右栏按
 * IMPLEMENTED_SECTIONS 分流到真实面板 / 占位。
 *
 * 结构化段只收录 rpi Settings 实锤字段——键名/类型/默认值逐项核对
 * rpi-cli/src/settings.rs（camelCase，见各段注释的行号）；Settings 没有的
 * 配置面（system_prompt / append_system_prompt 是 CLI/SDK 参数非
 * settings.json 字段）不造 UI，留原始 JSON 段。
 *
 * **GUI 相关字段覆盖（2026-11-14）**：模型节补 defaultThinkingLevel /
 * hideThinkingBlock / thinkingBudgets / scopedModels / steeringMode /
 * followUpMode；核心连接节补 httpProxy / cdnBaseUrl / streamIdleTimeout /
 * httpIdleTimeout；会话管理节（sessionDir）与技能与工具节（skillDirs /
 * promptDirs / extensionDirs / defaultTools）从占位改为真实面板。
 * **TUI 专属字段一律不做 UI**（keybindings、doubleEscapeAction、
 * editorPaddingX、autocompleteMaxVisible、fullscreenCopyOnSelect、
 * outputPad、quietStartup、showTerminalProgress、terminal.*、showImages、
 * last*ChangelogVersion、showCacheMissNotices、shellPath、branchSummary）
 * ——逐条理由见下方「TUI 专属字段」注释块。
 *
 * 配置真相 = pi 自己的配置文件（§5）：settings.json / models.json 经
 * pi_get_settings / pi_set_models_config 管理——**nested 对象整体替换
 * 不合并（§5 上游语义），保存的永远是完整文档**。凭据状态经
 * pi_auth_status（存在性 + 已声明环境变量键名，绝不返回 key 内容）。
 * 控制面走 Tauri IPC（§4.5），不走 hermes REST seam。
 *
 * 错误即错误（工程铁律 12）：所有 invoke 失败 console.error + 段内
 * 红色错误条，不吞；JSON.parse 失败就地显示错误且保存钮禁用——不静默
 * 不保存。portal 到 body：标题栏是 z-50 的 stacking context，浮层在
 * .app-titlebar 内会被压到 veil(55)/投放(60) 之下——portal 出去后
 * z 130（overlays.css .set-overlay）才盖得住。
 */

import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog'
import {
  Bell,
  BookOpen,
  Brain,
  Cable,
  Cpu,
  Folder,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  MessagesSquare,
  Mic,
  Monitor,
  Palette,
  Puzzle,
  Shield,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Wrench,
  XIcon,
} from 'lucide-react'

import { activateBundledPlugins, usePluginContributions } from '@/contrib/plugins'
import { ProjectsSettingsSection } from '@/app/settings/projects-settings'
import { ArchivesSettingsSection } from '@/app/settings/archives-settings'
import { Switch } from '@/components/ui/switch'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  loadAppPrefs,
  updateAppPrefs,
  type AppPrefs,
  type KeepAwakeMode,
} from '@/lib/app-prefs'
import pkg from '../../../package.json'
import { inTauri } from '@/lib/tauri-window'
import { GatewaySettings } from '@/app/settings/gateway-settings'
import { ProvidersSettings } from '@/app/settings/providers-settings'
import { PersonaSettings } from '@/app/settings/persona-settings'
import { AvatarSettings } from '@/app/settings/avatar-settings'
import { AppearanceSettings } from '@/app/settings/appearance-settings'
import { UsageSettings } from '@/app/settings/usage-settings'
import { VoiceSettings } from '@/app/settings/voice-settings'
import { AgentBehaviorSettings } from '@/app/settings/agent-behavior-settings'
import { DataSyncSettings } from '@/app/settings/data-sync-settings'
import { SkillsToolsSettings } from '@/app/settings/skills-tools-settings'
import {
  LOCALE_OPTIONS,
  deviceTimeZone,
  readLocale,
  readTimezone,
  setLocalePref,
  setTimezonePref,
  timezoneOptions,
  type AppLocale,
} from '@/lib/ui-prefs'
import {
  NOTIFICATION_KINDS,
  readNotifyPrefs,
  setNotifyEnabled,
  setNotifyKind,
  type NotificationKind,
  type NativeNotifyPrefs,
} from '@/lib/notification-prefs'
import {
  COMPLETION_SOUND_VARIANTS,
  completionSoundVariantId as readCompletionVariant,
  previewCompletionSound,
  setCompletionSoundVariantId,
} from '@/lib/completion-sound'
import {
  KEYBIND_ACTIONS,
  KEYBIND_READONLY,
  formatCombo,
  useKeybindStore,
} from '@/lib/keybinds'
import {
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHoverPill,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarMenuProvider,
  AnimatedSidebarMenuSub,
  AnimatedSidebarMenuSubItem,
} from '@/components/motion/animated-sidebar'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { useOverlayExit } from '@/lib/overlay-exit'

/** pi 模型目录条目（pi_list_models 返回形状，同 composer-wired）。 */
interface PiModelEntry {
  provider: string
  id: string
  name: string
  contextWindow: number
}

/** pi_auth_status 行——存在性与凭据类型，绝不携带 key 内容。 */
interface PiAuthRow {
  provider: string
  configured: boolean
  source: string
  credentialType: string | null
  envVar?: string
  envSet?: boolean
  envKeys?: { name: string; set: boolean }[]
}

interface PiAuthStatus {
  authPath: string
  settingsPath: string
  modelsPath: string
  authFileExists: boolean
  providers: PiAuthRow[]
}

type SettingsDoc = Record<string, unknown>

/** settings.json 默认模型键（**rpi 只认 camelCase**——rpi-cli Settings
    `#[serde(rename_all = "camelCase")]` 且无 snake_case alias，settings.rs:3
    注释列明 defaultProvider/defaultModel/defaultThinkingLevel；snake_case
    是旧 pi 时代遗留文档。双读兼容历史文件；写文档优先更新已存在的形式，
    新建键取首选项 = camelCase，避免同一键双形式并存造成歧义）。 */
const DEFAULT_PROVIDER_KEYS = ['defaultProvider', 'default_provider'] as const
const DEFAULT_MODEL_KEYS = ['defaultModel', 'default_model'] as const

/** 解析配置原始文本（空文本 = 文件尚未存在，从 {} 起步）。
    label 用于错误消息（settings / models）。 */
function parseJsonDoc(text: string, label: string): { doc: SettingsDoc } | { error: string } {
  if (text.trim() === '') return { doc: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `${label} 文档必须是 JSON object（pi load_settings_json_object 同约束）` }
  }
  return { doc: parsed as SettingsDoc }
}

/** 文档中已存在的键形式（snake 优先），不存在则取首选项。 */
function existingKey(doc: SettingsDoc, keys: readonly string[]): string {
  return keys.find((k) => k in doc) ?? keys[0]
}

/** 当前默认模型（defaultProvider/defaultModel 任一形式都读）。 */
function readDefaultModel(doc: SettingsDoc): { provider: string; modelId: string } | null {
  const p = doc[existingKey(doc, DEFAULT_PROVIDER_KEYS)]
  const m = doc[existingKey(doc, DEFAULT_MODEL_KEYS)]
  if (typeof p === 'string' && p !== '' && typeof m === 'string' && m !== '') {
    return { provider: p, modelId: m }
  }
  return null
}

// ── 结构化段（压缩/重试）共用原语 ─────────────────────────────────────
//
// 键名实锤（rpi-cli/src/settings.rs:19-168）：**全部结构体都是
// `#[serde(rename_all = "camelCase")]`，没有 snake_case alias**——
// `retry{maxRetries,baseDelayMs,maxAgentDelayMs}`、
// `compaction{reserveTokens,keepRecentTokens,modelOverrides}`、
// `branchSummary{reserveTokens,skipPrompt}`。旧 pi 时代的 snake_case 写法
// 对 rpi 不可见（写盘成功但引擎读不到 = 设置页"改了没效果"的来源）。
// 因此写文档一律用 canonical camelCase；文档里已有 snake_case 形式则原地
// 更新（历史文件兼容），避免同字段双形式并存。未设置的键 = rpi 内置默认
// （全字段 Option，JSON null 与缺键同为 None）。rpi 无对应字段的旧键
// （max_delay_ms / failover* / compaction 的 mode、顶层 compaction_mode）
// 2026-11-24 审计后已连同控件删除——不再写惰性键。

const U32_MAX = 4294967295
/** u64 字段在 JS 侧以安全整数封顶（超过即失去整数精度）。 */
const SAFE_U64_MAX = 9007199254740991

/** 压缩段键组（rpi CompactionSettingsJson 只有 enabled / reserveTokens /
    keepRecentTokens / modelOverrides；旧 pi 的 mode / compaction_mode 在
    rpi 无对应字段，2026-11-24 审计后连同控件一起删除）。 */
const K_ENABLED = ['enabled'] as const
const K_RESERVE_TOKENS = ['reserveTokens', 'reserve_tokens'] as const
const K_KEEP_RECENT_TOKENS = ['keepRecentTokens', 'keep_recent_tokens'] as const

/** 重试段键组（rpi RetrySettings：maxRetries / baseDelayMs /
    maxAgentDelayMs 为真字段；旧 max_delay_ms / failover* 在 rpi 无对应，
    2026-11-24 审计后连同控件一起删除）。 */
const K_MAX_RETRIES = ['maxRetries', 'max_retries'] as const
const K_BASE_DELAY_MS = ['baseDelayMs', 'base_delay_ms'] as const
const K_MAX_AGENT_DELAY_MS = ['maxAgentDelayMs', 'max_agent_delay_ms'] as const

// ── GUI 相关新增键组（2026-11-14，逐项核对 rpi-cli/src/settings.rs）─────
//
// 全部 canonical = camelCase（settings.rs 的 `#[serde(rename_all =
// "camelCase")]`，无 snake_case alias）。别名只用于**读**历史文件；
// applyFieldToRecord 会就地更新已存在的键形式、新建键取首选项，避免同一
// 字段两种拼法并存（别名与主名同时存在时 serde 报 duplicate field）。

/** 模型节：默认思考档位（settings.rs:94-97，字符串档位名）。 */
const K_DEFAULT_THINKING_LEVEL = ['defaultThinkingLevel', 'default_thinking_level'] as const
/** 模型节：隐藏思考块正文（settings.rs:189-191）。 */
const K_HIDE_THINKING_BLOCK = ['hideThinkingBlock', 'hide_thinking_block'] as const
/** 模型节：可用模型范围（settings.rs:101-106；`enabledModels` 是上游别名，
    与主名同时出现会被 serde 判重复字段）。 */
const K_SCOPED_MODELS = ['scopedModels', 'enabledModels'] as const
/** 模型节 · thinkingBudgets 段：档位 → token 预算（settings.rs:251-255，
    rpi-ai ThinkingBudgets 全字段 Option<u64>）。 */
const K_TB_MINIMAL = ['minimal'] as const
const K_TB_LOW = ['low'] as const
const K_TB_MEDIUM = ['medium'] as const
const K_TB_HIGH = ['high'] as const
const K_TB_XHIGH = ['xhigh'] as const
const K_TB_MAX = ['max'] as const
/** thinkingBudgets 的六个档位行（低 → 高；draftKey 只用于草稿表寻址）。 */
const THINKING_BUDGET_ROWS: readonly {
  keys: readonly string[]
  label: string
  draftKey: string
}[] = [
  { keys: K_TB_MINIMAL, label: '极简（minimal）', draftKey: 'thinkingBudgets.minimal' },
  { keys: K_TB_LOW, label: '低（low）', draftKey: 'thinkingBudgets.low' },
  { keys: K_TB_MEDIUM, label: '中（medium）', draftKey: 'thinkingBudgets.medium' },
  { keys: K_TB_HIGH, label: '高（high）', draftKey: 'thinkingBudgets.high' },
  { keys: K_TB_XHIGH, label: '极高（xhigh）', draftKey: 'thinkingBudgets.xhigh' },
  { keys: K_TB_MAX, label: '最高（max）', draftKey: 'thinkingBudgets.max' },
]
/** 模型节：队列排空节奏（settings.rs:155-163，kebab-case 落盘）。 */
const K_STEERING_MODE = ['steeringMode', 'steering_mode'] as const
const K_FOLLOW_UP_MODE = ['followUpMode', 'follow_up_mode'] as const

/** 核心连接节：HTTP 代理（settings.rs:125-128；rpi 只写进环境变量，
    显式 HTTP_PROXY/HTTPS_PROXY 优先）。 */
const K_HTTP_PROXY = ['httpProxy', 'http_proxy'] as const
/** 核心连接节：发布包下载加速前缀（settings.rs:130-133）。 */
const K_CDN_BASE_URL = ['cdnBaseUrl', 'cdn_base_url'] as const
/** 核心连接节：流静默超时秒数（settings.rs:247-250；0 = 关闭）。 */
const K_STREAM_IDLE_TIMEOUT = ['streamIdleTimeout', 'stream_idle_timeout'] as const
/** 核心连接节：连接池空闲超时（settings.rs:241-246；毫秒数字或
    "disabled"——上游还有 `httpIdleTimeoutMs` 别名）。 */
const K_HTTP_IDLE_TIMEOUT = ['httpIdleTimeout', 'httpIdleTimeoutMs', 'http_idle_timeout'] as const

/** 会话管理节：会话根目录（settings.rs:108-111）。 */
const K_SESSION_DIR = ['sessionDir', 'session_dir'] as const
/** 核心连接 → 终端执行（settings.rs shellPath / shellCommandPrefix，
    session.rs 建会话时真消费——2026-11-24 审计纠正了旧注释）。 */
const K_SHELL_PATH = ['shellPath', 'shell_path'] as const
const K_SHELL_COMMAND_PREFIX = ['shellCommandPrefix', 'shell_command_prefix'] as const

// ── TUI 专属字段（有 settings.rs 字段，但**不做 UI**）────────────────────
//
// 判据：字段只影响 rpi 的终端渲染/键位，宿主 GUI 不消费，也不该把"改了
// 没效果"的设置项摆给用户（铁律 12：不假装有功能）。
//
//   · keybindings / doubleEscapeAction —— 终端键位表。宿主的快捷键是
//     「安全与数据 · 键盘快捷键」节自有体系（lib/keybinds，localStorage
//     差分），与 rpi 的终端键位无关；混进设置页会出现两套"快捷键"。
//   · editorPaddingX / autocompleteMaxVisible —— 终端编辑器列距与补全
//     行数，宿主是 React 输入框，没有这两个几何量。
//   · fullscreenCopyOnSelect / outputPad —— 全屏终端选区复制与 transcript
//     左右内距，纯 TUI 渲染量。
//   · quietStartup / showTerminalProgress / terminal.*（showImages 嵌套、
//     clearOnShrink）—— 启动横幅与 OSC 9;4 进度条，终端进程才有；宿主
//     的窗口/任务栏进度不走这个键。
//   · showImages —— 终端内联图片渲染开关；宿主消息渲染是 DOM，不读它。
//   · lastChangelogVersion / lastRpiChangelogVersion —— 升级提示基线，
//     引擎自维护的标记，不是用户设置（手工改只会让更新提示错乱）。
//   · showCacheMissNotices —— 终端 transcript 的诊断提示行。
//   · branchSummary —— rpi 的两个访问器都注明"尚无消费方"
//     （settings.rs:144-153/323-341）。

/** 结构化键所在的嵌套段（null = 顶层键）。thinkingBudgets 是对象段
    （档位 → 预算），其余新增字段都在顶层。 */
type NestedLoc = 'compaction' | 'retry' | 'thinkingBudgets'

/** 写入队列的反馈分组：每个分组在右栏有自己的一对"已保存/错误"行。
    compaction/retry 是既有两段（状态各自独立）；model/connection/
    sessions/skills 是 2026-11-14 新增的四节（共用 extraFeedback）。 */
type WriteUi = 'compaction' | 'retry' | 'model' | 'connection' | 'sessions' | 'skills'

type ExtraWriteUi = Exclude<WriteUi, 'compaction' | 'retry'>

const EXTRA_WRITE_UIS: readonly ExtraWriteUi[] = ['model', 'connection', 'sessions', 'skills']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 字段读取结果：unset = 缺键/null（pi 默认生效）；ok = 文档里的原始值。 */
type FieldRead = { state: 'unset' } | { state: 'ok'; raw: unknown }

/** 读一个结构化字段（loc = 嵌套段名，null = 顶层键）。 */
function readField(
  doc: SettingsDoc,
  loc: NestedLoc | null,
  keys: readonly string[],
): FieldRead {
  const rec =
    loc === null ? doc : isPlainObject(doc[loc]) ? (doc[loc] as SettingsDoc) : undefined
  if (rec === undefined) return { state: 'unset' }
  const key = keys.find((k) => k in rec)
  if (key === undefined) return { state: 'unset' }
  const raw = rec[key]
  if (raw === null) return { state: 'unset' }
  return { state: 'ok', raw }
}

/** 按 [canonical, ...别名] 写/删一个键（value === undefined = 删键回默认）。 */
function applyFieldToRecord(
  rec: SettingsDoc,
  keys: readonly string[],
  value: unknown | undefined,
): void {
  const key = keys.find((k) => k in rec) ?? keys[0]
  if (value === undefined) delete rec[key]
  else rec[key] = value
}

/** 控件视图：unset（显示默认占位）/ set（文档值）/ invalid（文档里该键
    类型不符——pi 反序列化会拒绝整份文档，如实显示不兜底）。 */
type FieldView<T> =
  | { kind: 'unset' }
  | { kind: 'set'; value: T }
  | { kind: 'invalid'; raw: unknown }

function boolView(read: FieldRead): FieldView<boolean> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'boolean') return { kind: 'set', value: read.raw }
  return { kind: 'invalid', raw: read.raw }
}

function numView(read: FieldRead): FieldView<number> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'number' && Number.isInteger(read.raw)) {
    return { kind: 'set', value: read.raw }
  }
  return { kind: 'invalid', raw: read.raw }
}

function enumView(read: FieldRead, allowed: readonly string[]): FieldView<string> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'string' && allowed.includes(read.raw)) {
    return { kind: 'set', value: read.raw }
  }
  return { kind: 'invalid', raw: read.raw }
}

/**
 * 把 IPC 失败归一成**用户能看懂**的一句话（2026-10-23，web 端可用性）。
 *
 * 为什么需要：浏览器直开时（`inTauri === false`）每个 `invoke` 都抛
 * `TypeError: Cannot read properties of undefined (reading 'invoke')`
 * ——因为 `@tauri-apps/api/core.js:328` 直接读 `window.__TAURI_INTERNALS__`。
 * 直接 `String(e)` 把它当错误文案显示，用户看到的是 JS 内部细节。
 *
 * 这里只做**翻译**，不吞错：原始错误仍由各调用点的 `console.error` 打出
 * （铁律 12——失败必须可见），界面上换成"这个环境没有宿主后端"。
 */
function describeIpcError(e: unknown): string {
  if (!inTauri) {
    return '浏览器直开模式：没有桌面宿主后端，设置项不可读写（打包后的桌面应用里可用）'
  }
  return e instanceof Error ? e.message : String(e)
}

/** 串行写入队列的一笔改动（见 SettingsOverlay 内 drainWrites）。 */
interface StructuredWriteJob {  ui: WriteUi
  loc: NestedLoc | null
  keys: readonly string[]
  value: unknown | undefined
  savedMsg: string
  done: () => void
}

/** 在 base 上施加一笔结构化键改动（不改 base）。段存在但不是 object →
    err（pi 侧校验也会拒绝，这里给出可读消息）；否则返回新文档。 */
function applyStructuredMutation(
  base: SettingsDoc,
  loc: NestedLoc | null,
  keys: readonly string[],
  value: unknown | undefined,
): { ok: SettingsDoc } | { err: string } {
  const doc: SettingsDoc = { ...base }
  if (loc === null) {
    applyFieldToRecord(doc, keys, value)
    return { ok: doc }
  }
  const existing = doc[loc]
  if (value === undefined && existing === undefined) {
    return { ok: doc } // 段不存在 = 全默认，无可删（幂等写）
  }
  // null 与缺键同为 None（rpi 的 Option<T> 反序列化语义），视作空段——
  // 否则文档里写了 "compaction": null 会被误判成"段形状错误"而卡住编辑。
  if (existing !== undefined && existing !== null && !isPlainObject(existing)) {
    return { err: `${loc} 段不是 JSON object——先在「安全与数据 · 安全」的原始配置里修正后再改此设置` }
  }
  const obj: SettingsDoc = isPlainObject(existing) ? { ...existing } : {}
  applyFieldToRecord(obj, keys, value)
  if (Object.keys(obj).length === 0) delete doc[loc]
  else doc[loc] = obj
  return { ok: doc }
}

/** 结构化字段行：等宽键名 + 控件列（控件下可带说明/错误）。 */
function SetField({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="set-field">
      <span className="set-field-label">{name}</span>
      <div className="set-field-control">
        {children}
        {note !== undefined && <span className="set-field-note">{note}</span>}
      </div>
    </div>
  )
}

/** 类型不符的当前值——pi 会拒绝整份文档，如实显示（禁止兜底）。 */
function SetInvalidNote({ raw, expect }: { raw: unknown; expect: string }) {
  return (
    <div className="set-err">
      当前值 {JSON.stringify(raw)} 不是{expect}——pi 会拒绝该文档；请先在「安全与数据 · 安全」的原始配置里修正。
    </div>
  )
}

/** 三态布尔：未设置（删键，pi 默认生效）/ 启用 / 禁用。 */
function SetBoolField({ read, unsetLabel, onWrite }: {
  read: FieldRead
  unsetLabel: string
  onWrite: (value: boolean | undefined) => Promise<void>
}) {
  const view = boolView(read)
  return (
    <>
      <select
        className="set-select"
        onChange={(e) => {
          const v = e.target.value
          void onWrite(v === '' ? undefined : v === 'true')
        }}
        value={view.kind === 'set' ? (view.value ? 'true' : 'false') : ''}
      >
        <option value="">{unsetLabel}</option>
        <option value="true">启用</option>
        <option value="false">禁用</option>
      </select>
      {view.kind === 'invalid' && <SetInvalidNote expect="布尔值" raw={view.raw} />}
    </>
  )
}

/** 非负整数输入：草稿态本地保存（受控输入每击写盘 + IPC 回写会吃字），
    落盘成功或失败后回显文档值。空文本 = 删键回默认；越界/非整数 = 不写
    入，错误可见。草稿态由 overlay 顶层持有（numDrafts，状态提升）——
    右栏按节条件渲染后，切节往返不丢未落盘的输入。 */
function SetNumField({ read, max, placeholder, draft, onDraft, onWrite, onReject }: {
  read: FieldRead
  max: number
  placeholder: string
  draft: string | null
  onDraft: (value: string | null) => void
  onWrite: (value: number | undefined) => Promise<void>
  onReject: (message: string) => void
}) {
  const view = numView(read)
  const committed = view.kind === 'set' ? String(view.value) : ''
  return (
    <>
      <input
        className="set-input"
        max={max}
        min={0}
        onChange={(e) => {
          const text = e.target.value
          onDraft(text)
          if (text.trim() === '') {
            void onWrite(undefined).then(() => onDraft(null))
            return
          }
          const n = Number(text)
          if (!Number.isInteger(n) || n < 0 || n > max) {
            onReject(`「${text}」须为 0–${max} 的整数，未写入`)
            return
          }
          void onWrite(n).then(() => onDraft(null))
        }}
        placeholder={placeholder}
        step={1}
        type="number"
        value={draft ?? committed}
      />
      {view.kind === 'invalid' && <SetInvalidNote expect="整数" raw={view.raw} />}
    </>
  )
}

/** 枚举选择：未设置（删键回默认）/ 已知取值。 */
function SetEnumField({ read, options, unsetLabel, onWrite }: {
  read: FieldRead
  options: { label: string; value: string }[]
  unsetLabel: string
  onWrite: (value: string | undefined) => Promise<void>
}) {
  const view = enumView(
    read,
    options.map((o) => o.value),
  )
  return (
    <>
      <select
        className="set-select"
        onChange={(e) => {
          const v = e.target.value
          void onWrite(v === '' ? undefined : v)
        }}
        value={view.kind === 'set' ? view.value : ''}
      >
        <option value="">{unsetLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {view.kind === 'invalid' && <SetInvalidNote expect="已知枚举值" raw={view.raw} />}
    </>
  )
}

/** 字符串字段的已落盘文本；非法类型 → invalidRaw 非 null（如实显示）。 */
function textFieldView(read: FieldRead): { committed: string; invalidRaw: unknown | null } {
  if (read.state === 'unset') return { committed: '', invalidRaw: null }
  if (typeof read.raw === 'string') return { committed: read.raw, invalidRaw: null }
  return { committed: '', invalidRaw: read.raw }
}

/** 字符串数组字段（目录 / 模型 id）→ 多行文本；非法类型 → invalidRaw。 */
function listFieldView(read: FieldRead): { committed: string; invalidRaw: unknown | null } {
  if (read.state === 'unset') return { committed: '', invalidRaw: null }
  if (Array.isArray(read.raw) && read.raw.every((v) => typeof v === 'string')) {
    return { committed: (read.raw as string[]).join('\n'), invalidRaw: null }
  }
  return { committed: '', invalidRaw: read.raw }
}

/** httpIdleTimeout 的已落盘文本：毫秒数字或 "disabled"（settings.rs 注释：
    上游两种形态都合法；其它类型如实判非法）。 */
function httpIdleFieldView(read: FieldRead): { committed: string; invalidRaw: unknown | null } {
  if (read.state === 'unset') return { committed: '', invalidRaw: null }
  const raw = read.raw
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { committed: String(raw), invalidRaw: null }
  }
  if (typeof raw === 'string') return { committed: raw.trim(), invalidRaw: null }
  return { committed: '', invalidRaw: raw }
}

/** 纯文本：空 = 删键回默认（null 与缺键同为 None）。 */
function parsePlainText(text: string): { value: unknown | undefined } {
  const trimmed = text.trim()
  return { value: trimmed === '' ? undefined : trimmed }
}

/** 列表文本：换行或逗号分隔（逐项 trim、丢空项）；全空 = 删键回默认。 */
function parseListText(text: string): { value: unknown | undefined } {
  const entries = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return { value: entries.length === 0 ? undefined : entries }
}

/** httpIdleTimeout：非负整数毫秒或 disabled；空 = 删键回默认。 */
function parseHttpIdle(text: string): { value: unknown | undefined } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { value: undefined }
  if (trimmed.toLowerCase() === 'disabled') return { value: 'disabled' }
  if (!/^\d+$/.test(trimmed)) {
    return { error: `「${text}」须为非负整数（毫秒）或 disabled，未写入` }
  }
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n)) {
    return { error: `「${text}」超出安全整数范围，未写入` }
  }
  return { value: n }
}

/** 文本 / 列表字段：草稿态由 overlay 顶层持有（与 SetNumField 同一套
    numDrafts），失焦或 Enter 提交——受控输入逐击写盘会吃字，且每次写盘
    = 一次整文档 IPC。空文本 = 删键回默认；非法值不写入且错误可见。 */
function SetTextDraftField({
  committed,
  invalidRaw,
  expect,
  placeholder,
  multiline,
  rows,
  draft,
  onDraft,
  parse,
  onWrite,
  onReject,
}: {
  committed: string
  /** 文档里该键类型不符时的原始值（null = 合法）。 */
  invalidRaw: unknown | null
  expect: string
  placeholder: string
  multiline?: boolean
  rows?: number
  draft: string | null
  onDraft: (value: string | null) => void
  parse: (text: string) => { value: unknown | undefined } | { error: string }
  onWrite: (value: unknown | undefined) => Promise<void>
  onReject: (message: string) => void
}) {
  const value = draft ?? committed
  /** 提交草稿；内容与已落盘文本一致时只清草稿（不做无意义的整文档写盘）。 */
  const commit = (): void => {
    if (draft === null) return
    if (draft === committed) {
      onDraft(null)
      return
    }
    const parsed = parse(draft)
    if ('error' in parsed) {
      onReject(parsed.error)
      return
    }
    void onWrite(parsed.value).then(() => onDraft(null))
  }
  return (
    <>
      {multiline === true ? (
        <textarea
          className="set-textarea"
          onBlur={commit}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            // 多行：Enter 是换行，Ctrl/Cmd+Enter 提交（与单行的 Enter 语义对齐）
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
          rows={rows ?? 4}
          spellCheck={false}
          value={value}
        />
      ) : (
        <input
          className="set-input"
          onBlur={commit}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          type="text"
          value={value}
        />
      )}
      {draft !== null && draft !== committed && (
        <span className="set-field-note">
          未提交——失焦或按 Enter（多行 Ctrl+Enter）写入；清空文本 = 删键回默认
        </span>
      )}
      {invalidRaw !== null && <SetInvalidNote expect={expect} raw={invalidRaw} />}
    </>
  )
}

// ── 主从两栏（hermes settings 左导航右内容同构）────────────────────────
// 左栏节列表 + 右栏条件渲染选中节。id 仅用于左导航寻址（data-section-id），
// 不进任何持久化面。
//
// **分组结构（用户 2026-10-22 定稿，逐字对上，改之前先问）**：原 5 组 20 项；
// 2026-11-15 会话管理 P0 在「安全与数据」新增「项目」「归档会话」两节
// （22 项）——这是用户当轮明确要求的改动，其余项仍按 20 项定稿执行。
// 视觉骨架照搬 beui AnimatedSidebar 的「组标题 + 菜单项 + 子级竖线」三层
// 结构（样式见 overlays.css 的 .set-nav 家族），但不引入 motion/react——
// 这里只借视觉与信息层级，动效仍用本工程既有 CSS 令牌。
//
// 真实数据面的节（其余占位，见各条 placeholder 说明；完整清单以
// IMPLEMENTED_SECTIONS 为准）：
//   model    ← 旧 model（默认模型 + 引擎思考/预算/模型范围/队列）+ 旧 retry
//              （重试/故障转移都是模型请求域：429/过载重试与跨模型 failover
//              都发生在同一个 provider 请求上，放进「安全与数据」会把一次
//              请求的两半拆到两个组）
//   memory   ← 旧 compaction（上下文压缩 = pi 的记忆管理面，memory.rs 同域）
//   security ← 旧 auth（凭据存在性/来源）+ 旧 raw（settings.json / models.json
//              整体编辑）——凭据与配置文件同属"安全与数据"，且 raw 是修正
//              凭据/配置文档的最后手段，两者必须同屏可切换
//   updates  ← 旧 about（应用名/版本/配置文件路径）
//   core-connection ← 网关连接面板 + 引擎网络（httpProxy/cdn/超时）
//   sessions ← rpi sessionDir（会话存储目录）
//   skills-tools ← rpi 资源目录（技能/提示词/扩展）+ defaultTools
//
// 插件集成组没有可选节：它给"带设置页面的插件"预留位置，当前无插件注册
// 设置页 → 渲染一条空态行（带 beui 子级竖线），不造假入口。

type SectionId =
  | 'general'
  | 'appearance'
  | 'persona'
  | 'avatar'
  | 'notifications'
  | 'core-connection'
  | 'model'
  | 'agent-behavior'
  | 'memory'
  | 'browser-control'
  | 'computer-control'
  | 'skills-tools'
  | 'voice'
  | 'security'
  | 'password-login'
  | 'sessions'
  | 'projects'
  | 'archives'
  | 'data-sync'
  | 'shortcuts'
  | 'knowledge'
  | 'usage-stats'
  | 'updates'
  // 插件贡献页（2026-11-07）：`plugin:<id>` 动态面——render 在贡献表里
  | `plugin:${string}`

interface NavItem {
  icon: typeof Cpu
  id: SectionId
  label: string
  /** 占位节的说明（为什么还没有数据面）。有真实面板的节**不带**此字段
      （真实节登记在 IMPLEMENTED_SECTIONS）。两者都缺 = 编码错误，右栏
      会显示红色错误条而不是空白——所以新增节必须二选一。 */
  placeholder?: string
  /** 子项（hermes 的层级导航：如提供方的 账号/API 密钥/自定义端点）。
      选中节后子项展开（缩进渲染），点击 = 选中节 + 切子视图；
      页面按 activeSubView 渲染对应子视图。 */
  children?: readonly { id: string; label: string }[]
}

interface NavGroup {
  label: string
  items: readonly NavItem[]
  /** 组内无可选节时的空态文案（当前只有「插件集成」用）。 */
  emptyNote?: string
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '基础设置',
    items: [
      {
        icon: SlidersHorizontal,
        id: 'general',
        label: '常规',
      },
      {
        icon: Palette,
        id: 'appearance',
        label: '外观',
      },
      {
        icon: Sparkles,
        id: 'persona',
        label: '个性',
      },
      {
        icon: UserRound,
        id: 'avatar',
        label: '形象',
      },
      // hermes 的通知页是单页（提醒开关 + 完成提示音同屏），没有
      // 「提醒 / 声音」子页——2026-11-24 用户要求全链路复制，子项删除。
      { icon: Bell, id: 'notifications', label: '通知' },
      {
        icon: Cable,
        id: 'core-connection',
        label: '核心连接',
      },
    ],
  },
  {
    label: 'Agent 控制',
    items: [
      // 账号子项删除（2026-11-24 用户："模型的账号项删除"）——凭据统一走
      // 「安全与数据 · 密码与登录」，模型页只保留密钥 / 自定义端点 /
      // 默认模型三个子视图。
      { icon: Cpu, id: 'model', label: '模型', children: [
        { id: 'keys', label: 'API 密钥' },
        { id: 'custom-endpoints', label: '自定义端点' },
        { id: 'defaults', label: '默认模型' },
      ] },
      // 行为与工具（2026-11-22）：ZCode「Agent 能力 → 行为与工具」整节移植
      // （agent-behavior-settings.tsx）。ZCode 组内顺序在个性化之后、记忆
      // 之前；宿主对应位 = 模型之后、记忆与上下文之前。
      { icon: SlidersHorizontal, id: 'agent-behavior', label: '行为与工具' },
      { icon: Brain, id: 'memory', label: '记忆与上下文' },
      {
        icon: Globe,
        id: 'browser-control',
        label: '浏览器控制',
        placeholder:
          'pi 有 browser 配置段（config.rs 的 browser: BrowserSettings，工具在 tools.rs 按需装载），但宿主尚未接该段的表单——需要先定字段面，再按本页既有结构化段写法接线。',
      },
      {
        icon: Monitor,
        id: 'computer-control',
        label: '电脑控制',
        placeholder:
          'pi 有 computer 配置段（config.rs 的 computer: ComputerSettings），宿主尚未接表单；这是 opt-in 能力，默认不装载。',
      },
      {
        icon: Wrench,
        id: 'skills-tools',
        label: '技能与工具',
      },
      {
        icon: Mic,
        id: 'voice',
        label: '语音',
        placeholder:
          '语音输入走渲染层 Web Speech（composer 的 useDictation），语言/设备由浏览器与系统决定，宿主没有设置面。',
      },
    ],
  },
  {
    label: '安全与数据',
    items: [
      { icon: Shield, id: 'security', label: '安全' },
      {
        icon: KeyRound,
        id: 'password-login',
        label: '密码与登录',
        children: [
          { id: 'credentials', label: '凭据' },
          { id: 'sources', label: '来源' },
        ],
      },
      // 会话管理 = 总项（2026-11-24 用户："会话管理是总项，把数据与统计里
      // 的四个作为子项放进去"）。自身页 = 会话存储目录；四个子项分别是
      // ZCode 数据与统计组的四节。原「安全与数据 → 项目」顶层项删除。
      {
        icon: MessagesSquare,
        id: 'sessions',
        label: '会话管理',
        children: [
          { id: 'data-sync', label: '数据同步' },
          { id: 'usage-stats', label: '使用统计' },
          { id: 'projects', label: '项目管理' },
          { id: 'archives', label: '归档管理' },
        ],
      },
      {
        icon: Keyboard,
        id: 'shortcuts',
        label: '键盘快捷键',
      },
      {
        icon: BookOpen,
        id: 'knowledge',
        label: '知识库',
        placeholder:
          'pi 没有知识库概念（无索引/检索配置段）；技能与提示词模板见「技能与工具」浮层，不是知识库。',
      },
    ],
  },
  {
    // 插件集成：只承载真实插件注册的设置页（usePluginContributions）。
    // 2026-11-24 用户删除「核心（连接）/ 包」两页后，无贡献时整组隐藏
    // （navGroupsWithPlugins 过滤），不再显示空态占位。
    label: '插件集成',
    items: [],
    emptyNote: '暂无插件提供设置页',
  },
  {
    label: '关于',
    // 账户项删除（2026-11-24 用户："关于里面的账户删除"）：宿主无账户体系。
    items: [{ icon: Info, id: 'updates', label: '版本与更新' }],
  },
]

/** 会话管理的四个子视图（2026-11-24 从「数据与统计」组迁入）。 */
const SESSIONS_CHILD_IDS = new Set<string>([
  'data-sync',
  'usage-stats',
  'projects',
  'archives',
])

/** 扁平化后的可选节（键盘 ↑/↓ 的遍历顺序 = 组顺序 + 组内顺序）。 */
const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

// ── 插件贡献的设置页（2026-11-07）：settings.page 区的消费点 ──────────
// 贡献 id = `plugin:<pluginId>:<pageId>` → NavItem id 同串（SectionId 的
// `plugin:${string}` 臂），空组（插件集成）的 items 在此填充。
const PLUGIN_PAGE_PREFIX = 'plugin:'

function pluginNavItems(): readonly (NavItem & { sectionId: `plugin:${string}` })[] {
  const { contributions } = activateBundledPlugins()
  return contributions['settings.page'].map((c) => ({
    icon: Puzzle,
    id: c.id as `plugin:${string}`,
    label: c.title ?? c.id,
    sectionId: c.id as `plugin:${string}`,
  }))
}

/** 含插件页的导航（NAV_GROUPS 静态 + 插件组动态填充）。每次渲染重建——
 * 插件贡献是模块级常量，开销可忽略。 */
function navGroupsWithPlugins(): readonly NavGroup[] {
  const items = pluginNavItems()
  // 无插件贡献时整组隐藏（2026-11-24：核心/包两页删除后只剩空态文案，
  // 用户明确要求删掉这两项；组本身也不再占位）。
  return NAV_GROUPS.filter((g) => g.label !== '插件集成' || items.length > 0).map(
    (g) =>
      g.label === '插件集成' && items.length > 0
        ? { ...g, items, emptyNote: undefined }
        : g,
  )
}

/** 含插件页的扁平导航（键盘遍历 + activeSectionLabel 的真相源）。 */
const ALL_NAV_ITEMS: readonly NavItem[] = [
  ...NAV_ITEMS,
  ...navGroupsWithPlugins()
    .flatMap((g) => g.items)
    .filter((i) => !NAV_ITEMS.includes(i)),
]
const ALL_NAV_GROUPS: readonly NavGroup[] = navGroupsWithPlugins()

/** pi_vault_sources 行形状（src-tauri/src/pi_login.rs）：installed =
    CLI 真实在 PATH 上跑通 --version；enabled/unlocked 只有 local 源为
    true（外部管理器的解锁/列条目需要会话令牌管理，不在本面伪造）。 */
interface VaultSourceRow {
  name: string
  displayName: string
  installed: boolean
  enabled: boolean
  needsUnlock: boolean
  unlocked: boolean
}

/** 有真实面板实现的节（右栏据此分流到面板 / 占位；新增真实节必须同步
    这里，否则它会被当成占位渲染——占位文案缺失时右栏显示可见的编码错误，
    不会静默空白）。 */
const IMPLEMENTED_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
  'model',
  'memory',
  'security',
  'updates',
  'notifications',
  'password-login',
  'shortcuts',
  'core-connection',
  'general',
  'persona',
  // 外观（2026-11-23）：hermes Appearance 页复制——主题/字体/缩放/气泡。
  'appearance',
  // 形象（2026-11-23）：用户头像选择（内置 41 张，localStorage 持久化）。
  'avatar',
  'usage-stats',
  // 行为与工具（2026-11-22）：ZCode agentBehavior 节的完整移植——
  // app/settings/agent-behavior-settings.tsx（显示思考/待办为真实接线）。
  'agent-behavior',
  // 数据同步（2026-11-22）：ZCode DataSyncSection 的空态结构（宿主单机版，
  // 无远端设备栈——页面保留结构并如实说明）。
  'data-sync',
  // 2026-11-14：rpi settings 的 GUI 相关字段补齐后，这两个从占位改为真实面板
  // （sessions = sessionDir；skills-tools = skillDirs/promptDirs/
  // extensionDirs/defaultTools）。资源**浏览**仍在左栏浮层（pi_list_resources），
  // 本节只写引擎配置，两个入口不重复同一数据面。
  'sessions',
  'skills-tools',
  // 项目注册表 + 归档会话（2026-11-15 会话管理 P0）：面板实现分别在
  // app/settings/projects-settings.tsx / archives-settings.tsx（节标题由
  // 上方 set-inset-head 承担，面板传 headerLabel={null}）。
  'projects',
  'archives',
  // GPT-Live 语音（2026-11-12）：引擎模式 / OpenAI key / 模型音色 + 就绪
  // 读数——voice-settings.tsx（moss live 桥接层的配置面）
  'voice',
])

/** 占位节面板：明确说明（铁律 12——不假装有功能、不造假数据）。
    节名不在这里画——它已由右栏固定的 inset 头承担（beui Inset 形态），
    这里再画一次会出现两个同名标题。 */
function SetPlaceholder({ note }: { note: string }) {
  return (
    <section className="set-section">
      <div className="set-placeholder">
        <p className="set-placeholder-title">该设置项尚未接线</p>
        <p className="set-hint">{note}</p>
      </div>
    </section>
  )
}

/** 「常规」页的偏好行（标签 + 说明 + 右侧控件）。与 set-acct-field 同构，
    只是三处重复的卡片行不再复制粘贴。disabled 只用于**确实没有数据面**的
    项（引擎无该原语）——给死开关加透明度，不伪造可用性。 */
function SetPrefRow({
  label,
  desc,
  disabled = false,
  children,
}: {
  label: string
  desc: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <div className="set-acct-field" style={disabled ? { opacity: 0.55 } : undefined}>
      <div className="set-acct-field-text">
        <span className="set-acct-field-label">{label}</span>
        <p className="set-acct-field-desc">{desc}</p>
      </div>
      <div className="set-acct-field-control">{children}</div>
    </div>
  )
}

/** 通知事件文案：逐条抄 hermes `i18n/zh.ts` 的 settings.notifications.kinds
    （产品名 Hermes → Mirach）。与 NOTIFICATION_KINDS 同序同键。 */
const NOTIFICATION_COPY: Record<NotificationKind, { label: string; desc: string }> = {
  approval: { label: '需要批准', desc: '有命令正在等待你批准或拒绝。' },
  input: { label: '需要输入', desc: 'Mirach 提出了问题，或需要密码或密钥。' },
  turnDone: { label: '回复就绪', desc: 'Mirach 在后台时完成了一轮对话。' },
  turnError: { label: '本轮失败', desc: '后台回合错误。' },
  backgroundDone: { label: '后台任务完成', desc: '后台终端命令已完成。' },
  credits: { label: '额度提醒', desc: '额度访问被暂停或恢复。' },
  plugin: { label: '插件通知', desc: 'Mirach 在后台时，桌面插件发送了通知。' },
}

export function SettingsOverlay({
  onClose,
  variant = 'overlay',
  initialSection,
}: {
  onClose: () => void
  /**
   * 外壳形态（2026-10-23 设置独立窗口）：
   *   · `overlay`（默认）—— portal 到 body 的模态：遮罩 + 居中卡片 +
   *     点遮罩关闭 + 退场动画。主窗内用。
   *   · `window` —— 铺满整个独立窗口：无遮罩、无居中、无退场（窗口关闭
   *     即卸载）；壳圆角由 `.app-shell` 那层画，卡片圆角清零。
   * 内容（左栏 / 右栏 / 数据面 / 写盘队列）两种形态**完全共用**。
   */
  variant?: 'overlay' | 'window'
  /**
   * 深链初始节（2026-11-18）：`host.navigate('/settings?tab=gateway')` 的
   * 落点（网关 = 'core-connection'）。已开着的设置窗改走
   * `mirach:settings:section` 事件（不改窗口 URL）。
   */
  initialSection?: SectionId
}) {
  // 退场编排（2026-10-18，见 lib/overlay-exit.ts）：关闭先播退场再卸载。
  const { closing, requestClose } = useOverlayExit(onClose)
  // Esc 关闭（escape-layers overlay 层=40）：拖拽层（50）在拖拽中更高，
  // Esc 只中止拖拽不关浮层；编辑模式（20）更低，浮层开着时 Esc 不退编辑模式。
  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (!isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) return
      e.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      release()
    }
  }, [requestClose])

  // ── 数据面：挂载即拉取（§4.5 IPC）；null = 载入中（可见状态）──
  const [models, setModels] = useState<PiModelEntry[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [auth, setAuth] = useState<PiAuthStatus | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [settingsText, setSettingsText] = useState<string | null>(null)
  const [settingsMissing, setSettingsMissing] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  // ── hermes 设置移植（2026-10-24）：通知 / 核心连接 / 快捷键 / 凭据管理 ──
  // 通知偏好（localStorage 真相；读取失败已按默认值处理）
  const [notifyPrefs, setNotifyPrefs] = useState<NativeNotifyPrefs>(() =>
    inTauri || typeof window !== 'undefined' ? readNotifyPrefs() : { enabled: true, kinds: {} as NativeNotifyPrefs['kinds'] },
  )
  // pi 引擎版本（编译期 vendored Cargo.toml 真值）
  const [engineVersion, setEngineVersion] = useState<string | null>(null)
  // 凭据写入面（密码与登录）：provider → 草稿密钥输入 + 行内状态
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [keyBusy, setKeyBusy] = useState<string | null>(null)
  const [keyResult, setKeyResult] = useState<{ provider: string; ok: boolean; message: string } | null>(null)
  // 通知测试发送状态
  const [notifyTestState, setNotifyTestState] = useState<{ ok: boolean; message: string } | null>(null)
  // 完成提示音（hermes 通知页同屏）：变体选择
  const [completionVariant, setCompletionVariant] = useState(1)
  useEffect(() => {
    setCompletionVariant(readCompletionVariant())
  }, [])
  // 自定义端点（models.json providers CRUD）：新增表单 + 结果
  const [endpointDraftId, setEndpointDraftId] = useState('')
  const [endpointDraftUrl, setEndpointDraftUrl] = useState('')
  const [endpointDraftKey, setEndpointDraftKey] = useState('')
  const [endpointResult, setEndpointResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelsConfigText, setModelsConfigText] = useState<string | null>(null)
  const [modelsConfigMissing, setModelsConfigMissing] = useState(false)
  const [modelsConfigError, setModelsConfigError] = useState<string | null>(null)
  // 保存成功反馈（可见；任一文本改动即清除——陈旧的"已保存"= 假装成功）
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null)
  const [modelsConfigSaved, setModelsConfigSaved] = useState<string | null>(null)
  const [modelSaved, setModelSaved] = useState<string | null>(null)
  const [compactionSaved, setCompactionSaved] = useState<string | null>(null)
  const [compactionError, setCompactionError] = useState<string | null>(null)
  const [retrySaved, setRetrySaved] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  /** 新增四节（model / connection / sessions / skills）的写盘反馈。共用一份
      记录而不是四个 useState 对：drainWrites 需要在任一笔成功时把**其它
      分组**的"已保存"一并标陈旧（文档被整体替换），记录形态一次搞定。 */
  const [extraFeedback, setExtraFeedback] = useState<
    Record<ExtraWriteUi, { saved: string | null; error: string | null }>
  >({
    model: { saved: null, error: null },
    connection: { saved: null, error: null },
    sessions: { saved: null, error: null },
    skills: { saved: null, error: null },
  })
  // ── 主从两栏状态 ──
  // 选中节：左导航高亮 + 右栏条件渲染的依据，默认落模型节。
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'model')
  /** 手动收起的可展开节（2026-11-23 用户："设置页的选项不能折叠"）。
      默认空 = 选中节自动展开；再点一次当前选中的可展开节 → 收起其子项。
      切到别的节会把它从集合里移除（重新选中时默认展开）。 */
  const [collapsedSubmenus, setCollapsedSubmenus] = useState<
    ReadonlySet<SectionId>
  >(() => new Set())
  /** 选中节（导航点击 / 键盘 / 深链共用）：切节并展开目标节的子项。 */
  const activateSection = useCallback((id: SectionId) => {
    setActiveSection(id)
    setCollapsedSubmenus((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])
  // 深链切节（设置窗常开时 host.navigate 的落点；`mirach:settings:section`）。
  useEffect(() => {
    const onSection = (event: Event) => {
      const raw = String((event as CustomEvent<{ section?: string }>).detail?.section ?? '').trim()
      if (!raw) return
      const known = ALL_NAV_ITEMS.some((item) => item.id === raw)
      if (!known) {
        console.error(`[settings] 深链节 ${raw} 不在导航表——忽略`)
        return
      }
      activateSection(raw as SectionId)
    }
    window.addEventListener('mirach:settings:section', onSection)
    return () => window.removeEventListener('mirach:settings:section', onSection)
  }, [activateSection])
  /** 子视图（hermes 的 pview/kview 等价物）：有 children 的节选中后，
      子项点击切换此值；无 children 的节恒为 null。 */
  const [activeSubView, setActiveSubView] = useState<string | null>(null)

  // ── 界面偏好（常规节：语言 / 时区，openhuman 偏好卡的移植）────────
  // 初值从 localStorage 读（readLocale 未设置时按 navigator.language 推断，
  // 同上游 localeSlice）；时区 'device' = 跟随设备（上游文案语义）。
  const [uiLocale, setUiLocale] = useState<AppLocale>(() => readLocale())
  const [uiTimezone, setUiTimezone] = useState<string>(() => readTimezone())
  // 时区清单在挂载时算一次（Intl.supportedValuesOf 约 400 项，重算无意义）
  const [uiTimezoneOptions] = useState<string[]>(() => timezoneOptions())
  // ── 应用级偏好（2026-11-15，常规节）：真相在 Rust app-prefs.json ──
  // null = 载入中；错误可见（描述 IPC 原文），不拿默认值冒充已加载。
  const [appPrefs, setAppPrefs] = useState<AppPrefs | null>(null)
  const [appPrefsError, setAppPrefsError] = useState<string | null>(null)
  const [appPrefsSaved, setAppPrefsSaved] = useState<string | null>(null)
  // 最大智能体步数输入草稿（与引擎 settings 数字字段分开：这是 app prefs）
  const [stepsDraft, setStepsDraft] = useState('')
  // 记忆插件 rpi-optchat（2026-11-24 用户指定）：真实安装状态来自
  // pi_pkg_list 的原生扩展登记（rpi install 写 native-packages.json）。
  const [optchat, setOptchat] = useState<
    { installed: boolean; version: string | null; missing: string[] } | null
  >(null)
  const [optchatError, setOptchatError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void invoke<{
      packages: {
        scope: string
        name: string
        version: string
        missingArtifacts: string[]
      }[]
    }>('pi_pkg_list', { cwd: null })
      .then((result) => {
        if (cancelled) return
        const row = result.packages.find(
          (p) => p.scope === 'user' && p.name === 'rpi-optchat',
        )
        setOptchat(
          row
            ? { installed: true, version: row.version, missing: row.missingArtifacts }
            : { installed: false, version: null, missing: [] },
        )
        setOptchatError(null)
      })
      .catch((e: unknown) => {
        console.error('[pi] rpi-optchat 安装状态读取失败', e)
        if (!cancelled) setOptchatError(describeIpcError(e))
      })
    return () => {
      cancelled = true
    }
  }, [])
  /** 右栏固定 inset 头的标题（beui Inset header 形态：当前视图名）。
      从 NAV_ITEMS 取——节名只有一个真相源，不在 JSX 里重复写字面值。 */
  const activeNavItem = ALL_NAV_ITEMS.find((s) => s.id === activeSection)
  const activeChildLabel = activeNavItem?.children?.find(
    (c) => c.id === activeSubView,
  )?.label
  const activeSectionLabel = activeChildLabel ?? activeNavItem?.label ?? '设置'
  // 数字字段草稿（键 = 段.键名，如 compaction.reserve_tokens）——从
  // SetNumField 本地 state 提升到此，条件渲染下切节不丢未落盘输入。
  const [numDrafts, setNumDrafts] = useState<Record<string, string | null>>({})
  const numDraftFor = useCallback(
    (key: string) => ({
      draft: numDrafts[key] ?? null,
      onDraft: (value: string | null) => {
        setNumDrafts((prev) => ({ ...prev, [key]: value }))
      },
    }),
    [numDrafts],
  )

  /** 左导航键盘：↑/↓ 环绕切换选中节并移动焦点；Enter/Space 走按钮原生
      click（同一次选中）。只挂在导航容器上——右栏输入框（含 textarea）
      里的方向键不受影响。遍历面 = NAV_ITEMS（分组顺序展平；组标题与
      插件空态行不是按钮，不参与环绕）。 */
  const onNavKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const idx = ALL_NAV_ITEMS.findIndex((s) => s.id === activeSection)
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const next = ALL_NAV_ITEMS[(idx + dir + ALL_NAV_ITEMS.length) % ALL_NAV_ITEMS.length]
      activateSection(next.id)
      e.currentTarget
        .querySelector<HTMLButtonElement>(`[data-section-id="${next.id}"]`)
        ?.focus()
    },
    [activateSection, activeSection],
  )
  // 结构化段写入队列（见 drainWrites）：settingsTextRef = 渲染期同步的
  // 最新已提交文本；writesRef.committed = 最后一笔成功落盘的完整文档。
  const settingsTextRef = useRef<string | null>(null)
  settingsTextRef.current = settingsText
  const writesRef = useRef<{
    queue: StructuredWriteJob[]
    committed: SettingsDoc | null
    running: boolean
  }>({ queue: [], committed: null, running: false })

  /** 结构化段写入泵：每次改动 = 一笔完整文档写盘。快速连续改动（数字
      输入逐键、连点下拉）逐笔入队，每笔都基于「上一笔成功落盘的文档」
      重新施加自己的键改动——Tauri async 命令不保证落盘顺序，直接并发
      invoke 会互相覆盖（丢失更新）。失败路径（原始文档解析失败 / 高级段
      有未保存手改 / 段形状不符 / invoke Err）一律段内错误条可见，不静默。 */
  const drainWrites = useCallback(() => {
    const w = writesRef.current
    if (w.running || w.queue.length === 0) return
    w.running = true

    const failJob = (job: StructuredWriteJob, msg: string) => {
      if (job.ui === 'retry') {
        setRetrySaved(null)
        setRetryError(msg)
      } else if (job.ui === 'compaction') {
        setCompactionSaved(null)
        setCompactionError(msg)
      } else {
        // 新增四节：错误落在各自分组（切节后仍可见）
        setExtraFeedback((prev) => ({ ...prev, [job.ui]: { saved: null, error: msg } }))
      }
    }

    const step = (): void => {
      const cur = writesRef.current
      const job = cur.queue[0]
      if (job === undefined) {
        cur.running = false
        return
      }
      // 基准文档：首笔 = 当前 settings 文本（保留高级段未保存的手改）；
      // 后续 = 上一笔成功落盘的文档。原始文本与落盘文档内容不一致
      // （高级段有未保存手改）→ 拒绝并可见报错，不得静默覆盖用户编辑。
      let base: SettingsDoc
      const parsed = parseJsonDoc(settingsTextRef.current ?? '', 'settings')
      if ('error' in parsed) {
        failJob(
          job,
          `settings 文档解析失败，未写入——先在「安全与数据 · 安全」的原始配置里修正 JSON：${parsed.error}`,
        )
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      }
      if (cur.committed === null) {
        base = parsed.doc
      } else if (JSON.stringify(parsed.doc) !== JSON.stringify(cur.committed)) {
        failJob(job, '「安全与数据 · 安全」的原始配置有未保存的手动编辑——先保存或还原该段，再改此设置')
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      } else {
        base = { ...cur.committed }
      }
      const applied = applyStructuredMutation(base, job.loc, job.keys, job.value)
      if ('err' in applied) {
        failJob(job, applied.err)
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      }
      void invoke('pi_set_settings', { value: applied.ok })
        .then(() => {
          writesRef.current.committed = applied.ok
          setSettingsText(JSON.stringify(applied.ok, null, 2))
          setSettingsMissing(false)
          setSettingsError(null)
          // 文档被整体替换——其它段的“已保存”徽标按陈旧处理
          setSettingsSaved(null)
          setModelSaved(null)
          setCompactionSaved(null)
          setRetrySaved(null)
          // 新增四节：先全部标陈旧，再给本笔的分组上"已写入"
          setExtraFeedback((prev) => {
            const next = { ...prev }
            for (const key of EXTRA_WRITE_UIS) next[key] = { saved: null, error: null }
            if (job.ui !== 'compaction' && job.ui !== 'retry') {
              next[job.ui] = { saved: job.savedMsg, error: null }
            }
            return next
          })
          if (job.ui === 'retry') {
            setRetrySaved(job.savedMsg)
            setRetryError(null)
          } else {
            setCompactionSaved(job.savedMsg)
            setCompactionError(null)
          }
        })
        .catch((e: unknown) => {
          console.error('[pi] settings.json 写入失败（结构化段）', e)
          failJob(job, describeIpcError(e))
        })
        .finally(() => {
          writesRef.current.queue.shift()
          job.done()
          void Promise.resolve().then(step)
        })
    }
    step()
  }, [])

  /** 入队一笔结构化写入。promise 永不 reject——失败已经段内错误条上屏，
      resolve（成功或失败）供控件复位草稿态。 */
  const enqueueStructuredWrite = useCallback(
    (
      ui: WriteUi,
      loc: NestedLoc | null,
      keys: readonly string[],
      value: unknown | undefined,
      savedMsg: string,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        writesRef.current.queue.push({ ui, loc, keys, value, savedMsg, done: resolve })
        drainWrites()
      }),
    [drainWrites],
  )

  const writeCompactionKey = useCallback(
    (keys: readonly string[], value: unknown | undefined): Promise<void> =>
      enqueueStructuredWrite('compaction', 'compaction', keys, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  const writeRetryKey = useCallback(
    (keys: readonly string[], value: unknown | undefined): Promise<void> =>
      enqueueStructuredWrite('retry', 'retry', keys, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  const rejectNum = useCallback((ui: 'compaction' | 'retry', msg: string) => {
    if (ui === 'retry') {
      setRetrySaved(null)
      setRetryError(msg)
    } else {
      setCompactionSaved(null)
      setCompactionError(msg)
    }
  }, [])

  /** 新增四节的键写入（顶层键或 thinkingBudgets 段）；反馈落 ui 分组。 */
  const writeKey = useCallback(
    (
      ui: ExtraWriteUi,
      loc: NestedLoc | null,
      keys: readonly string[],
      value: unknown | undefined,
    ): Promise<void> =>
      enqueueStructuredWrite(ui, loc, keys, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  const rejectExtra = useCallback((ui: ExtraWriteUi, msg: string) => {
    setExtraFeedback((prev) => ({ ...prev, [ui]: { saved: null, error: msg } }))
  }, [])

  /** 应用级偏好的合并写（常规节）：成功才更新本地投影（不用乐观值）。
      失败 → 红条 + console.error，不静默回滚成"看起来成功"。 */
  const writeAppPrefs = useCallback(
    (patch: Partial<AppPrefs>, saved: string) => {
      setAppPrefsError(null)
      setAppPrefsSaved(null)
      void updateAppPrefs(patch)
        .then((next) => {
          setAppPrefs(next)
          setAppPrefsSaved(saved)
        })
        .catch((e) => {
          console.error('[app-prefs] 偏好写入失败', patch, e)
          setAppPrefsError(describeIpcError(e))
        })
    },
    [],
  )

  /** 最大智能体步数：本地校验后写 app prefs（0 = 不设上限）。 */
  const commitSteps = useCallback(() => {
    if (appPrefs === null) return
    const raw = stepsDraft.trim()
    const value = Number(raw)
    if (raw === '' || !Number.isInteger(value) || value < 0 || value > 100000) {
      setAppPrefsSaved(null)
      setAppPrefsError('最大智能体步数必须是 0（不设上限）到 100000 之间的整数')
      return
    }
    if (value === appPrefs.maxAgentSteps) return
    writeAppPrefs({ maxAgentSteps: value }, '已保存：下一次 run 生效')
  }, [appPrefs, stepsDraft, writeAppPrefs])

  /** 会话存储目录选择（常规节与「会话管理」同写 settings.json 的
      sessionDir；两个入口读写同一份引擎配置，不另造第二真相）。 */
  const pickSessionDir = useCallback(async () => {
    try {
      const picked = await openDirectoryDialog({
        directory: true,
        multiple: false,
        title: '选择会话存储目录',
      })
      if (typeof picked !== 'string' || picked.length === 0) return // 取消 = 无操作
      await writeKey('sessions', null, K_SESSION_DIR, picked.replace(/\\/g, '/'))
    } catch (e) {
      console.error('[settings] 会话目录选择/写入失败', e)
      rejectExtra('sessions', describeIpcError(e))
    }
  }, [writeKey, rejectExtra])

  /** 文档被某个非队列路径整体替换后，把四节的"已保存"一并标陈旧（陈旧
      徽标 = 假装成功）。 */
  const clearExtraSaved = useCallback(() => {
    setExtraFeedback((prev) => {
      const next = { ...prev }
      for (const key of EXTRA_WRITE_UIS) next[key] = { saved: null, error: null }
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<{ models: PiModelEntry[] }>('pi_list_models')
        if (!cancelled) setModels(res.models ?? [])
      } catch (e) {
        console.error('[pi] 模型目录获取失败', e)
        if (!cancelled) setModelsError(describeIpcError(e))
      }
    })()
    void (async () => {
      try {
        const res = await invoke<PiAuthStatus>('pi_auth_status')
        if (!cancelled) setAuth(res)
      } catch (e) {
        console.error('[pi] 凭据状态获取失败', e)
        if (!cancelled) setAuthError(describeIpcError(e))
      }
    })()
    void (async () => {
      try {
        const doc = await invoke<SettingsDoc | null>('pi_get_settings')
        if (!cancelled) {
          setSettingsText(doc ? JSON.stringify(doc, null, 2) : '')
          setSettingsMissing(doc === null)
        }
      } catch (e) {
        console.error('[pi] settings.json 读取失败', e)
        if (!cancelled) setSettingsError(describeIpcError(e))
      }
    })()
    void (async () => {
      try {
        const doc = await invoke<SettingsDoc | null>('pi_get_models_config')
        if (!cancelled) {
          setModelsConfigText(doc ? JSON.stringify(doc, null, 2) : '')
          setModelsConfigMissing(doc === null)
        }
      } catch (e) {
        console.error('[pi] models.json 读取失败', e)
        if (!cancelled) setModelsConfigError(describeIpcError(e))
      }
    })()
    // ── hermes 设置移植面（2026-10-24）：引擎版本（AG-UI 端点由
    //    GatewaySettings 组件自行拉取）──
    void (async () => {
      try {
        const v = await invoke<string>('pi_engine_version')
        if (!cancelled) setEngineVersion(v)
      } catch (e) {
        console.error('[pi] 引擎版本获取失败', e)
        if (!cancelled) setEngineVersion(describeIpcError(e))
      }
    })()
    // 应用级偏好（常规节）：与引擎 settings.json 无关的一份独立真相。
    void (async () => {
      try {
        const prefs = await loadAppPrefs()
        if (!cancelled) {
          setAppPrefs(prefs)
          setStepsDraft(String(prefs.maxAgentSteps))
        }
      } catch (e) {
        console.error('[app-prefs] 偏好读取失败', e)
        if (!cancelled) setAppPrefsError(describeIpcError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // settings 文档解析（模型段取默认值 + 高级段实时错误共用一份结果）
  const settingsParsed = useMemo(
    () => (settingsText === null ? null : parseJsonDoc(settingsText, 'settings')),
    [settingsText],
  )
  const modelsConfigParsed = useMemo(
    () => (modelsConfigText === null ? null : parseJsonDoc(modelsConfigText, 'models')),
    [modelsConfigText],
  )
  const defaultModel = useMemo(() => {
    if (!settingsParsed || 'error' in settingsParsed) return null
    return readDefaultModel(settingsParsed.doc)
  }, [settingsParsed])

  /** 默认模型选择 → 写 settings.json（整体替换：parse 当前文档 → 改键 →
      送完整文档）。默认键写 pi 的 canonical 形式 default_provider/
      default_model；文档已有 camelCase 形式则原地更新。 */
  const onDefaultModelChange = useCallback(
    (value: string) => {
      if (settingsText === null || settingsParsed === null) return
      if ('error' in settingsParsed) {
        // 解析失败的文档不得被整体替换覆盖（会把用户的坏文档合法化）
        setModelSaved(null)
        return
      }
      const idx = value.indexOf('/')
      if (idx <= 0) return
      const provider = value.slice(0, idx)
      const modelId = value.slice(idx + 1)
      const doc: SettingsDoc = { ...settingsParsed.doc }
      doc[existingKey(doc, DEFAULT_PROVIDER_KEYS)] = provider
      doc[existingKey(doc, DEFAULT_MODEL_KEYS)] = modelId
      void invoke('pi_set_settings', { value: doc })
        .then(() => {
          writesRef.current.committed = doc
          setSettingsText(JSON.stringify(doc, null, 2))
          setSettingsMissing(false)
          setSettingsError(null)
          setModelSaved('默认模型已写入 settings.json（pi 创建新会话时读取）')
          setCompactionSaved(null)
          setRetrySaved(null)
          clearExtraSaved()
        })
        .catch((e) => {
          console.error('[pi] 默认模型写入失败', e)
          setSettingsError(describeIpcError(e))
          setModelSaved(null)
        })
    },
    [settingsText, settingsParsed, clearExtraSaved],
  )

  /** 高级段保存：JSON.parse 失败就地显示错误且不发 invoke（禁止静默）。 */
  const saveSettingsDoc = useCallback(() => {
    if (settingsText === null || settingsParsed === null) return
    if ('error' in settingsParsed) {
      setSettingsError(`未保存：${settingsParsed.error}`)
      return
    }
    void invoke('pi_set_settings', { value: settingsParsed.doc })
      .then(() => {
        writesRef.current.committed = settingsParsed.doc
        setSettingsError(null)
        setSettingsSaved('已保存到 settings.json')
        clearExtraSaved()
      })
      .catch((e) => {
        console.error('[pi] settings.json 写入失败', e)
        setSettingsError(describeIpcError(e))
        setSettingsSaved(null)
      })
  }, [settingsText, settingsParsed, clearExtraSaved])

  const saveModelsConfigDoc = useCallback(() => {
    if (modelsConfigText === null || modelsConfigParsed === null) return
    if ('error' in modelsConfigParsed) {
      setModelsConfigError(`未保存：${modelsConfigParsed.error}`)
      return
    }
    void invoke('pi_set_models_config', { value: modelsConfigParsed.doc })
      .then(() => {
        setModelsConfigError(null)
        setModelsConfigMissing(false)
        setModelsConfigSaved('已保存到 models.json')
      })
      .catch((e) => {
        console.error('[pi] models.json 写入失败', e)
        setModelsConfigError(describeIpcError(e))
        setModelsConfigSaved(null)
      })
  }, [modelsConfigText, modelsConfigParsed])

  const refreshAuth = useCallback(() => {
    void invoke<PiAuthStatus>('pi_auth_status')
      .then((res) => {
        setAuth(res)
        setAuthError(null)
      })
      .catch((e) => {
        console.error('[pi] 凭据状态获取失败', e)
        setAuthError(describeIpcError(e))
      })
  }, [])

  // ── 凭据写入面（hermes keys-settings 的 set/delete 移植）────────────
  // 写入 = pi auth.json 的 api_key 凭据（上游形状 {"type":"api_key","key"}，
  // 其余条目原样保留）；删除 = 该 provider 键整体移除（幂等）。读回只报
  // 存在性——密钥内容永不回显（§7-7 纪律）。
  const setProviderKey = useCallback(
    (provider: string) => {
      const key = (keyDrafts[provider] ?? '').trim()
      if (key === '') return
      setKeyBusy(provider)
      setKeyResult(null)
      void invoke('pi_set_provider_key', { provider, key })
        .then(() => {
          setKeyDrafts((prev) => ({ ...prev, [provider]: '' }))
          setKeyResult({ provider, ok: true, message: `已写入 ${provider} 的凭据（auth.json）` })
          // 凭据状态刷新（存在性变化）
          void invoke<PiAuthStatus>('pi_auth_status')
            .then((res) => setAuth(res))
            .catch(() => {})
        })
        .catch((e) => {
          console.error('[pi] 凭据写入失败', e)
          setKeyResult({ provider, ok: false, message: describeIpcError(e) })
        })
        .finally(() => setKeyBusy(null))
    },
    [keyDrafts],
  )

  const deleteProviderKey = useCallback((provider: string) => {
    setKeyBusy(provider)
    setKeyResult(null)
    void invoke<boolean>('pi_delete_provider_key', { provider })
      .then((removed) => {
        setKeyResult({
          provider,
          ok: true,
          message: removed ? `已清除 ${provider} 的凭据（auth.json）` : `${provider} 本无 auth.json 凭据`,
        })
        void invoke<PiAuthStatus>('pi_auth_status')
          .then((res) => setAuth(res))
          .catch(() => {})
      })
      .catch((e) => {
        console.error('[pi] 凭据删除失败', e)
        setKeyResult({ provider, ok: false, message: describeIpcError(e) })
      })
      .finally(() => setKeyBusy(null))
  }, [])

  // ── 通知偏好写操作（localStorage 真相；跨窗同步走 storage 事件）────
  const onNotifyEnabled = useCallback((enabled: boolean) => {
    setNotifyPrefs(setNotifyEnabled(enabled))
  }, [])
  const onNotifyKind = useCallback((kind: NotificationKind, value: boolean) => {
    setNotifyPrefs(setNotifyKind(kind, value))
  }, [])
  const onNotifyTest = useCallback(() => {
    setNotifyTestState(null)
    void invoke<boolean>('pi_notify_test', {
      title: 'Mirach 通知测试',
      body: '如果你看到这条系统通知，说明 OS 通知通道已打通。',
    })
      .then((ok) => {
        setNotifyTestState({
          ok,
          message: ok ? '系统通知已发送——检查屏幕右下角/通知中心。' : '系统拒绝了通知请求。',
        })
      })
      .catch((e) => {
        console.error('[pi] 通知测试失败', e)
        setNotifyTestState({ ok: false, message: describeIpcError(e) })
      })
  }, [])

  // ── 快捷键写入面（hermes keybind-settings 的捕获/清除/重置移植）────
  const keybindBindings = useKeybindStore((s) => s.bindings)
  const keybindCapturing = useKeybindStore((s) => s.capturing)
  const keybindBeginCapture = useKeybindStore((s) => s.beginCapture)
  const keybindClearBinding = useKeybindStore((s) => s.clearBinding)
  const keybindResetBinding = useKeybindStore((s) => s.resetBinding)
  const keybindResetAllBindings = useKeybindStore((s) => s.resetAllBindings)
  // 搜索（hermes keybind-settings 的 search-field）+ 分类序（hermes 同序）
  const [keybindQuery, setKeybindQuery] = useState('')
  const keybindFiltered = useMemo(() => {
    const q = keybindQuery.trim().toLowerCase()
    if (q === '') return KEYBIND_ACTIONS
    return KEYBIND_ACTIONS.filter(
      (a) => a.label.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    )
  }, [keybindQuery])
  const KEYBIND_CATEGORIES = ['输入', '配置文件', '会话', '导航', '视图']

  // ── 密码库（hermes vault 的 local 源移植，2026-10-24）────────────────
  interface VaultItem {
    id: string
    kind: string
    label: string
    origin?: string | null
    createdAt: string
  }
  const [vaultItems, setVaultItems] = useState<VaultItem[] | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultKind, setVaultKind] = useState('login')
  const [vaultLabel, setVaultLabel] = useState('')
  const [vaultOrigin, setVaultOrigin] = useState('')
  const [vaultIdentifierType, setVaultIdentifierType] = useState('email')
  const [vaultIdentifier, setVaultIdentifier] = useState('')
  const [vaultPassword, setVaultPassword] = useState('')
  const [vaultOtpSecret, setVaultOtpSecret] = useState('')
  const [vaultCardNumber, setVaultCardNumber] = useState('')
  const [vaultCardName, setVaultCardName] = useState('')
  const [vaultExpiry, setVaultExpiry] = useState('')
  const [vaultExpYear, setVaultExpYear] = useState('')
  const [vaultCvc, setVaultCvc] = useState('')
  const [vaultPostal, setVaultPostal] = useState('')
  const [vaultAddress, setVaultAddress] = useState('')
  const [vaultAddress2, setVaultAddress2] = useState('')
  const [vaultCity, setVaultCity] = useState('')
  const [vaultState, setVaultState] = useState('')
  const [vaultCountry, setVaultCountry] = useState('')
  const [vaultError2, setVaultError2] = useState<string | null>(null)

  const refreshVault = useCallback(() => {
    void invoke<{ items: VaultItem[] }>('pi_vault_list')
      .then((res) => {
        setVaultItems(res.items)
        setVaultError(null)
      })
      .catch((e) => {
        console.error('[pi] 密码库读取失败', e)
        setVaultError(describeIpcError(e))
      })
  }, [])

  // 挂载即拉取（与其余数据面同一节奏）
  useEffect(() => {
    refreshVault()
  }, [refreshVault])

  // ── 密码管理器源探测（pi_vault_sources：spawn bw/op --version 真实
  //     探测安装；local 源恒可用）。进「来源」子页才拉取。 ──
  const [vaultSources, setVaultSources] = useState<VaultSourceRow[] | null>(null)
  const [vaultSourcesError, setVaultSourcesError] = useState<string | null>(null)
  useEffect(() => {
    if (activeSection !== 'password-login' || activeSubView !== 'sources') return
    let cancelled = false
    setVaultSources(null)
    setVaultSourcesError(null)
    void invoke<{ sources: VaultSourceRow[] }>('pi_vault_sources')
      .then((res) => {
        if (!cancelled) setVaultSources(res.sources)
      })
      .catch((e) => {
        console.error('[pi] 密码管理器源探测失败', e)
        if (!cancelled) setVaultSourcesError(describeIpcError(e))
      })
    return () => {
      cancelled = true
    }
  }, [activeSection, activeSubView])

  /** 表单 → hermes buildSecret 同构的 secret 载荷（读取 + 清空表单）。 */
  const resetVaultForm = useCallback((): Record<string, unknown> => {
    setVaultLabel('')
    setVaultOrigin('')
    setVaultIdentifier('')
    setVaultPassword('')
    setVaultOtpSecret('')
    setVaultCardNumber('')
    setVaultCardName('')
    setVaultExpiry('')
    setVaultExpYear('')
    setVaultCvc('')
    setVaultPostal('')
    setVaultAddress('')
    setVaultAddress2('')
    setVaultCity('')
    setVaultState('')
    setVaultCountry('')
    if (vaultKind === 'login') {
      return {
        identifier_type: vaultIdentifierType,
        identifier: vaultIdentifier.trim(),
        password: vaultPassword,
        ...(vaultOtpSecret.trim() === '' ? {} : { otp_secret: vaultOtpSecret.trim() }),
      }
    }
    if (vaultKind === 'payment') {
      return {
        card_number: vaultCardNumber.replace(/\s+/g, ''),
        cardholder_name: vaultCardName.trim(),
        exp_month: vaultExpiry.trim(),
        exp_year: vaultExpYear.trim(),
        cvc: vaultCvc,
        billing_postal_code: vaultPostal.trim(),
      }
    }
    const address: Record<string, unknown> = {
      address_line1: vaultAddress.trim(),
      city: vaultCity.trim(),
      postal_code: vaultPostal.trim(),
      country: vaultCountry.trim(),
    }
    if (vaultAddress2.trim() !== '') {
      address.address_line2 = vaultAddress2.trim()
    }
    if (vaultState.trim() !== '') {
      address.state = vaultState.trim()
    }
    return address
  }, [
    vaultKind,
    vaultIdentifierType,
    vaultIdentifier,
    vaultPassword,
    vaultOtpSecret,
    vaultCardNumber,
    vaultCardName,
    vaultExpiry,
    vaultExpYear,
    vaultCvc,
    vaultPostal,
    vaultAddress,
    vaultAddress2,
    vaultCity,
    vaultState,
    vaultCountry,
  ])

  const addVaultItem = useCallback(async () => {
    if (vaultLabel.trim() === '') {
      setVaultError2('标签为必填项。')
      return
    }
    const origin = vaultOrigin.trim()
    // hermes 同款校验：每种条目只在其保存的站点上填写——没有来源的卡
    // 无法填充。必须提供有效 http(s) URL。
    const originValid = origin.startsWith('http://') || origin.startsWith('https://')
    try {
      // eslint-disable-next-line no-new
      new URL(origin)
    } catch {
      setVaultError2('请输入有效的 URL，例如 https://example.com。')
      return
    }
    if (!originValid) {
      setVaultError2('请输入有效的 URL，例如 https://example.com。')
      return
    }
    if (vaultKind === 'login' && (vaultIdentifier.trim() === '' || vaultPassword === '')) {
      setVaultError2('标识符和密码为必填项。')
      return
    }
    setVaultBusy(true)
    setVaultError2(null)
    const secret = resetVaultForm()
    try {
      await invoke('pi_vault_add', {
        kind: vaultKind,
        label: vaultLabel.trim(),
        origin,
        secret,
      })
      setVaultError2(null)
      refreshVault()
    } catch (e) {
      console.error('[pi] 密码库写入失败', e)
      setVaultError2(describeIpcError(e))
    } finally {
      setVaultBusy(false)
    }
  }, [
    vaultKind,
    vaultLabel,
    vaultOrigin,
    vaultIdentifier,
    vaultPassword,
    resetVaultForm,
    refreshVault,
  ])

  const removeVaultItem = useCallback(
    async (id: string, label: string) => {
      setVaultBusy(true)
      try {
        await invoke('pi_vault_remove', { id })
        refreshVault()
      } catch (e) {
        console.error('[pi] 密码库删除失败', e)
        setVaultError(`「${label}」删除失败: ${describeIpcError(e)}`)
      } finally {
        setVaultBusy(false)
      }
    },
    [refreshVault],
  )

  // ── 自定义端点 CRUD（hermes custom-endpoints 的移植；存储 =
  //    models.json providers 表，带 baseUrl 的条目即端点）────────────
  const addCustomEndpoint = useCallback(() => {
    const id = endpointDraftId.trim()
    const url = endpointDraftUrl.trim()
    if (id === '' || url === '') return
    if (modelsConfigText === null || modelsConfigParsed === null) return
    if ('error' in modelsConfigParsed) {
      setEndpointResult({ ok: false, message: `models.json 解析失败：${modelsConfigParsed.error}` })
      return
    }
    const doc: SettingsDoc = { ...modelsConfigParsed.doc }
    const providers = (doc.providers ?? {}) as Record<string, unknown>
    if (providers[id] !== undefined) {
      setEndpointResult({ ok: false, message: `提供方 ${id} 已存在——同名条目会被覆盖，请换一个 ID` })
      return
    }
    providers[id] = {
      baseUrl: url,
      ...(endpointDraftKey.trim() === '' ? {} : { apiKey: endpointDraftKey.trim() }),
    }
    doc.providers = providers
    void invoke('pi_set_models_config', { value: doc })
      .then(() => {
        setModelsConfigText(JSON.stringify(doc, null, 2))
        setModelsConfigMissing(false)
        setModelsConfigError(null)
        setEndpointDraftId('')
        setEndpointDraftUrl('')
        setEndpointDraftKey('')
        setEndpointResult({ ok: true, message: `端点 ${id} 已写入 models.json` })
      })
      .catch((e) => {
        console.error('[pi] 端点写入失败', e)
        setEndpointResult({ ok: false, message: describeIpcError(e) })
      })
  }, [endpointDraftId, endpointDraftUrl, endpointDraftKey, modelsConfigText, modelsConfigParsed])

  const deleteCustomEndpoint = useCallback((pid: string) => {
    if (modelsConfigText === null || modelsConfigParsed === null) return
    if ('error' in modelsConfigParsed) return
    const doc: SettingsDoc = { ...modelsConfigParsed.doc }
    const providers = (doc.providers ?? {}) as Record<string, unknown>
    delete providers[pid]
    doc.providers = providers
    void invoke('pi_set_models_config', { value: doc })
      .then(() => {
        setModelsConfigText(JSON.stringify(doc, null, 2))
        setEndpointResult({ ok: true, message: `端点 ${pid} 已删除` })
      })
      .catch((e) => {
        console.error('[pi] 端点删除失败', e)
        setEndpointResult({ ok: false, message: describeIpcError(e) })
      })
  }, [modelsConfigText, modelsConfigParsed])

  const settingsParseError = settingsParsed !== null && 'error' in settingsParsed
    ? settingsParsed.error
    : null

  // 两种外壳（2026-10-23）：内容树只有一份，外壳按 variant 换。
  //   overlay → 遮罩 + 居中卡片（主窗内模态）
  //   window  → 铺满（独立窗口：窗口自己就是边界，无遮罩/无居中/无退场）
  const isWindow = variant === 'window'
  const shellClass = isWindow
    ? 'set-card set-card--split set-card--window'
    : 'set-card set-card--split'

  const card = (
    <div
      aria-label="设置"
      aria-modal={isWindow ? undefined : 'true'}
      className={shellClass}
      onClick={isWindow ? undefined : (e) => e.stopPropagation()}
      role="dialog"
    >
        {/* **没有跨栏顶栏**（2026-10-23 用户："beui 的没有顶栏"）。
            beui AnimatedSidebar 的骨架是两段各自带头：
              · 左栏 sidebar header  → 本文件左栏的「设置」标题
              · 右栏 inset header    → 下方 .set-inset-head（当前节名 + ✕）
            hermes 那套 `grid-template-rows: auto …` + `grid-column: 1/-1`
            的横跨带子已撤（`.set-card--split` 只覆盖设置页；bots-dialog 与
            pi-resources-dialog 仍是原样，它们有自己的标题需要横跨）。
            **左栏 head + nav 必须包在同一个 `.set-rail` 里**：分开放会让
            头（白底）与体（灰底）出现色阶接缝（用户看到的"横线"），且头
            与右栏白底头同高无缝 → 读成"白色顶栏"。详见 overlays.css 该段。 */}
        <div className="set-rail">
          {/* 左栏头：beui AnimatedSidebarHeader 形态（标题一行，48px） */}
          <div className="set-nav-head">设置</div>
          <nav aria-label="设置节" className="set-nav" onKeyDown={onNavKeyDown}>
          {/* 跨组滑动悬停块（2026-11-23）：挂在 nav 滚动容器一层，组头与
              子项共用一条 pill——SharedLayoutBg 的每组 pill 够不到子项
              （子项在父项 li 内部），用户实报"子项没有滑动效果"。 */}
          <AnimatedSidebarHoverPill />
          <AnimatedSidebarMenuProvider>
            {ALL_NAV_GROUPS.map((group) => (
              <AnimatedSidebarGroup key={group.label}>
                <AnimatedSidebarGroupLabel>
                  {group.label}
                </AnimatedSidebarGroupLabel>
                <AnimatedSidebarGroupContent>
                  {group.items.length > 0 && (
                    <AnimatedSidebarMenu sharedHover={false}>
                      {group.items.map((s) => {
                        const Icon = s.icon
                        const isActive = s.id === activeSection
                        const submenuCollapsed =
                          collapsedSubmenus.has(s.id)
                        const submenuOpen =
                          isActive &&
                          s.children !== undefined &&
                          !submenuCollapsed
                        return (
                          <AnimatedSidebarMenuItem key={s.id}>
                            <AnimatedSidebarMenuButton
                              ariaExpanded={
                                s.children !== undefined
                                  ? submenuOpen
                                  : undefined
                              }
                              icon={<Icon aria-hidden size={16} />}
                              isActive={isActive}
                              onSelect={() => {
                                if (
                                  isActive &&
                                  s.children !== undefined
                                ) {
                                  // 再点一次当前节 = 收起/展开子项（用户
                                  // 2026-11-23："设置页的选项不能折叠"）。
                                  setCollapsedSubmenus((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(s.id)) next.delete(s.id)
                                    else next.add(s.id)
                                    return next
                                  })
                                  return
                                }
                                activateSection(s.id)
                                // 有子项的节：默认落第一个子视图（hermes 的
                                // pview/kview 默认值语义）；无子项的节清空。
                                // 会话管理例外：总项自己是「会话存储」页，
                                // 四个子项必须点击才进入。
                                setActiveSubView(
                                  s.id === 'sessions'
                                    ? null
                                    : (s.children?.[0]?.id ?? null),
                                )
                              }}
                              sectionId={s.id}
                              sidebarRow
                              tabIndex={isActive ? 0 : -1}
                            >
                              {s.label}
                            </AnimatedSidebarMenuButton>
                            {/* 子项（hermes 的层级导航）：选中节展开，
                                缩进渲染——点击 = 选中节 + 切子视图。
                                `data-sidebar-row` = 跨组滑动块的行标记。 */}
                            {submenuOpen && s.children !== undefined && (
                              <AnimatedSidebarMenuSub open>
                                {s.children.map((child) => (
                                  <AnimatedSidebarMenuSubItem key={child.id}>
                                    <button
                                      className="set-nav-subitem"
                                      data-sidebar-row=""
                                      data-sub-id={child.id}
                                      onClick={() => {
                                        activateSection(s.id)
                                        setActiveSubView(child.id)
                                      }}
                                      type="button"
                                    >
                                      {child.label}
                                    </button>
                                  </AnimatedSidebarMenuSubItem>
                                ))}
                              </AnimatedSidebarMenuSub>
                            )}
                          </AnimatedSidebarMenuItem>
                        )
                      })}
                    </AnimatedSidebarMenu>
                  )}
                  {/* 空组（当前只有「插件集成」）：**走真正的子级组件**
                      （MenuSub + MenuSubItem）而不是普通 div——它视觉上就是
                      子级行（左竖线 + 缩进），用同一个原语才能吃到
                      clip-path 揭开 + 逐行 stagger（打开设置时随组一起进场）。
                      内容不是按钮：没有插件注册设置页就不给假入口。 */}
                  {group.emptyNote !== undefined && (
                    <AnimatedSidebarMenuSub open>
                      <AnimatedSidebarMenuSubItem>
                        <div className="set-nav-empty">{group.emptyNote}</div>
                      </AnimatedSidebarMenuSubItem>
                    </AnimatedSidebarMenuSub>
                  )}
                </AnimatedSidebarGroupContent>
              </AnimatedSidebarGroup>
            ))}
          </AnimatedSidebarMenuProvider>
          </nav>
        </div>
        {/* 右内容区：beui AnimatedSidebarInset 形态——**固定 inset 头**
            （当前节名 + ✕）+ 独立滚动的正文。头不随正文滚动（对应上游
            `<header>` 是 Inset 的直接子级、滚动只发生在下面的 div 里）。 */}
        <div className="set-content">
          <header className="set-inset-head">
            <h3 className="set-inset-title">{activeSectionLabel}</h3>
            <button
              aria-label="关闭设置"
              className="set-close pressable-sm"
              onClick={requestClose}
              type="button"
            >
              <XIcon size={14} />
            </button>
          </header>
          <div className="set-scroll">
          {/* ── 模型（Agent 控制 / 模型）：提供方三子视图 = 完整复刻组件
             （src/app/settings/providers-settings.tsx，2026-10-24 移植；
              账号/API 密钥/自定义端点 的全部字段与交互）。子视图**受控于
              左栏子项**（= hermes 的 pview 侧栏子导航，唯一导航源）；
              默认模型子视图仍是本文件的既有面板（目录 + default_* 写入
              + 重试段）。 ── */}
          {activeSection === 'model' && activeSubView !== 'defaults' && (
            <ProvidersSettings
              onViewChange={(v) => setActiveSubView(v)}
              view={activeSubView === 'custom-endpoints' ? 'custom-endpoints' : 'keys'}
            />
          )}

          {activeSection === 'model' && activeSubView === 'defaults' && (
          <section className="set-section">
            <h4 className="set-sub-title">默认模型</h4>
            {modelsError !== null && <div className="set-err">{modelsError}</div>}
            {models === null && modelsError === null && (
              <span className="set-file-missing">加载中…</span>
            )}
            {models !== null && (
              <>
                <select
                  className="set-select"
                  onChange={(e) => onDefaultModelChange(e.target.value)}
                  value={defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : ''}
                >
                  <option disabled value="">
                    未设置（pi 使用内置默认）
                  </option>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name || m.id} — {m.provider} ·{' '}
                      {typeof m.contextWindow === 'number'
                        ? `上下文 ${m.contextWindow.toLocaleString()} Token`
                        : '上下文窗口未知'}
                    </option>
                  ))}
                </select>
                <p className="set-hint">
                  默认模型写入 settings.json 的{' '}
                  <span className="set-code">defaultProvider</span> /{' '}
                  <span className="set-code">defaultModel</span>（rpi 只认 camelCase；
                  pi 创建新会话时读取。对当前会话用输入框的模型选择器切换）。
                </p>
                {settingsParseError !== null && (
                  <div className="set-err">
                    settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后再选默认模型：
                    {settingsParseError}
                  </div>
                )}
                {modelSaved !== null && <span className="set-saved">{modelSaved}</span>}
              </>
            )}

            {/* ── 思考与推理 / 可用模型范围 / 消息队列（2026-11-14 GUI 相关
                rpi settings 补齐）。全部是 settings.json **顶层**键（思考
                预算除外，它在 thinkingBudgets 对象里），rpi 建会话时经
                session::build / provider::resolve 读取；当前会话的思考档位
                仍用输入框旁的档位选择器（pi_set_thinking_level，只作用于
                本会话）。 ── */}
            {settingsText !== null &&
              settingsParsed !== null &&
              !('error' in settingsParsed) && (
                <>
                  <h4 className="set-sub-title">思考与推理</h4>
                  <p className="set-hint">
                    rpi 的默认思考档位与各档位的 token 预算。宿主当前会话的
                    档位用输入框旁的档位选择器切换（只改本会话）；这里的值是
                    引擎建会话时的默认（宿主新会话同样走 rpi 的 build，故生效）。
                  </p>
                  <SetField
                    name="默认思考档位"
                    note="合法值：off / minimal / low / medium / high / xhigh / max（模型不支持的档位会被 clamp）"
                  >
                    <SetEnumField
                      onWrite={(v) =>
                        writeKey('model', null, K_DEFAULT_THINKING_LEVEL, v)
                      }
                      options={[
                        { value: 'off', label: '关闭思考（off）' },
                        { value: 'minimal', label: '极简（minimal）' },
                        { value: 'low', label: '低（low）' },
                        { value: 'medium', label: '中（medium）' },
                        { value: 'high', label: '高（high）' },
                        { value: 'xhigh', label: '极高（xhigh）' },
                        { value: 'max', label: '最高（max）' },
                      ]}
                      read={readField(
                        settingsParsed.doc,
                        null,
                        K_DEFAULT_THINKING_LEVEL,
                      )}
                      unsetLabel="未设置（默认：中（medium））"
                    />
                  </SetField>
                  <SetField
                    name="隐藏思考块"
                    note="隐藏思考块正文、只保留紧凑标签（rpi 终端渲染偏好；宿主对话栏的思考块渲染尚未跟随此键）"
                  >
                    <SetBoolField
                      onWrite={(v) =>
                        writeKey('model', null, K_HIDE_THINKING_BLOCK, v)
                      }
                      read={readField(
                        settingsParsed.doc,
                        null,
                        K_HIDE_THINKING_BLOCK,
                      )}
                      unsetLabel="未设置（默认：显示正文）"
                    />
                  </SetField>
                  <p className="set-hint">
                    思考预算（tokens，按档位；只对 token-budget 型推理模型有效，
                    留空 = 模型内置预算）：
                  </p>
                  {THINKING_BUDGET_ROWS.map((row) => (
                    <SetField key={row.label} name={`思考预算 · ${row.label}`}>
                      <SetNumField
                        {...numDraftFor(row.draftKey)}
                        max={U32_MAX}
                        onReject={(msg) => rejectExtra('model', msg)}
                        onWrite={(v) =>
                          writeKey('model', 'thinkingBudgets', row.keys, v)
                        }
                        placeholder="模型内置预算"
                        read={readField(
                          settingsParsed.doc,
                          'thinkingBudgets',
                          row.keys,
                        )}
                      />
                    </SetField>
                  ))}

                  <SetField
                    name="可用模型范围"
                    note="一行一个 provider/modelId（也可用逗号分隔）；留空 = 删键，rpi 视为全部目录模型。enabledModels 是上游别名，文档里已有该形式时原地更新。"
                  >
                    <SetTextDraftField
                      {...numDraftFor('scopedModels')}
                      committed={
                        listFieldView(
                          readField(settingsParsed.doc, null, K_SCOPED_MODELS),
                        ).committed
                      }
                      expect="字符串数组"
                      invalidRaw={
                        listFieldView(
                          readField(settingsParsed.doc, null, K_SCOPED_MODELS),
                        ).invalidRaw
                      }
                      multiline
                      onReject={(msg) => rejectExtra('model', msg)}
                      onWrite={(v) =>
                        writeKey('model', null, K_SCOPED_MODELS, v)
                      }
                      parse={parseListText}
                      placeholder={'anthropic/claude-sonnet-5\ndeepseek/deepseek-chat'}
                      rows={3}
                    />
                  </SetField>
                  <p className="set-hint">
                    rpi 终端用此列表限定 Ctrl+P 循环的模型；宿主输入框的模型
                    选择器读 pi_list_models 全量目录，尚未按此键过滤。
                  </p>

                  <h4 className="set-sub-title">消息队列</h4>
                  <p className="set-hint">
                    运行中发送的消息分 steer（引导当前回合）与 follow-up
                    （回合结束后跟进）两条队列；这里是排空节奏。rpi 建会话时
                    读取，宿主与终端共用同一 build 路径。
                  </p>
                  <SetField name="引导队列节奏" note="steer 队列的排空节奏">
                    <SetEnumField
                      onWrite={(v) => writeKey('model', null, K_STEERING_MODE, v)}
                      options={[
                        { value: 'all', label: 'all（一次全部送达）' },
                        {
                          value: 'one-at-a-time',
                          label: 'one-at-a-time（逐条）',
                        },
                      ]}
                      read={readField(settingsParsed.doc, null, K_STEERING_MODE)}
                      unsetLabel="未设置（默认：one-at-a-time）"
                    />
                  </SetField>
                  <SetField name="跟进队列节奏" note="follow-up 队列的排空节奏">
                    <SetEnumField
                      onWrite={(v) =>
                        writeKey('model', null, K_FOLLOW_UP_MODE, v)
                      }
                      options={[
                        { value: 'all', label: 'all（一次全部送达）' },
                        {
                          value: 'one-at-a-time',
                          label: 'one-at-a-time（逐条）',
                        },
                      ]}
                      read={readField(
                        settingsParsed.doc,
                        null,
                        K_FOLLOW_UP_MODE,
                      )}
                      unsetLabel="未设置（默认：one-at-a-time）"
                    />
                  </SetField>
                  {extraFeedback.model.error !== null && (
                    <div className="set-err">{extraFeedback.model.error}</div>
                  )}
                  {extraFeedback.model.saved !== null && (
                    <span className="set-saved">{extraFeedback.model.saved}</span>
                  )}
                </>
              )}
            {settingsText !== null && settingsParseError !== null && (
              <div className="set-err">
                settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后，本节的引擎默认值才能编辑：
                {settingsParseError}
              </div>
            )}

            {/* ── 重试（rpi RetrySettings：enabled / maxRetries /
                baseDelayMs / maxAgentDelayMs）。2026-11-24 审计：旧
                max_delay_ms / failover* 控件写的键 rpi 不消费，已删除。 ── */}
            <h4 className="set-sub-title">重试</h4>
            <p className="set-hint">
              提供方请求瞬时失败（429/配额/过载）的自动重试。改动写入 settings.json
              的 <span className="set-code">retry</span> 对象；未设置的键 = rpi
              内置默认（enabled 启用、maxRetries 10、baseDelayMs 2000、
              maxAgentDelayMs 60000）。
            </p>
            {settingsMissing && (
              <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
            )}
            {retryError !== null && <div className="set-err">{retryError}</div>}
            {settingsText === null ? (
              settingsError === null ? (
                <span className="set-file-missing">加载中…</span>
              ) : (
                <div className="set-err">{settingsError}</div>
              )
            ) : settingsParsed !== null && !('error' in settingsParsed) ? (
              <>
                <SetField name="启用重试">
                  <SetBoolField
                    onWrite={(v) => writeRetryKey(K_ENABLED, v)}
                    read={readField(settingsParsed.doc, 'retry', K_ENABLED)}
                    unsetLabel="未设置（默认：启用）"
                  />
                </SetField>
                <SetField name="最大重试次数" note="重试次数上限">
                  <SetNumField
                    {...numDraftFor('retry.max_retries')}
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_MAX_RETRIES, v)}
                    placeholder="默认 10"
                    read={readField(settingsParsed.doc, 'retry', K_MAX_RETRIES)}
                  />
                </SetField>
                <SetField name="退避基数（毫秒）">
                  <SetNumField
                    {...numDraftFor('retry.base_delay_ms')}
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_BASE_DELAY_MS, v)}
                    placeholder="默认 2000"
                    read={readField(settingsParsed.doc, 'retry', K_BASE_DELAY_MS)}
                  />
                </SetField>
                <SetField
                  name="智能体重试退避上限（毫秒）"
                  note="单轮内所有重试累计等待的上限（rpi RetrySettings.maxAgentDelayMs，默认 60000）。"
                >
                  <SetNumField
                    {...numDraftFor('retry.maxAgentDelayMs')}
                    max={SAFE_U64_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_MAX_AGENT_DELAY_MS, v)}
                    placeholder="默认 60000"
                    read={readField(settingsParsed.doc, 'retry', K_MAX_AGENT_DELAY_MS)}
                  />
                </SetField>
              </>
            ) : (
              settingsParseError !== null && (
                <div className="set-err">
                  settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后才能使用此段：
                  {settingsParseError}
                </div>
              )
            )}
            {retrySaved !== null && <span className="set-saved">{retrySaved}</span>}
          </section>
          )}

          {/* ── 记忆与上下文（Agent 控制）：hermes「Memory & Context」整节的
              移植（2026-11-15 用户要求，结构/字段/默认值照抄 hermes
              settings/constants.ts 的 memory 段与 memory/ 子目录）。

              映射真相（不造假）：
                · 持久记忆 / 用户档案 / 记忆提供方 / 预算 —— 由
                  rpi-optchat 原生扩展提供（2026-11-24 用户指定并安装
                  0.1.0）：会话 append-only 日志 + 128 KB 摘要树 +
                  profile 存储 + zoom/search 工具；MEMORY.md / USER.md
                  与 mem0 等外部提供方协议仍无对偶。
                · 上下文引擎（compressor/default/custom）—— rpi 只有压缩器
                  一种实现，固定只读。
                · 自动压缩 / 预留空间 / 保留近期 tokens / 摘要形态 —— rpi
                  compaction 真实字段，可写（原「压缩」节内容，保留在
                  「引擎实现」小节）。
                · hermes 的百分比阈值 / target_ratio / protect_last_n /
                  Codex 自动提高 / 压缩模型超时 —— rpi 用绝对 token 数表达
                  且无独立压缩模型，禁用并说明替代字段。 ── */}
          {activeSection === 'memory' && (
          <section className="set-section">
            <h4 className="set-sub-title">记忆层</h4>
            <p className="set-hint">
              记忆层由 <span className="set-code">rpi-optchat</span> 原生扩展提供
              （2026-11-24 已安装）：整段会话写入 append-only 日志，按 128 KB
              摘要树折成有界视图，模型可用 zoom / search 工具回看；profile
              存储（<span className="set-code">.rpi/optchat/&lt;profile&gt;.jsonl</span>）
              跨会话保留。hermes 的 MEMORY.md / USER.md 与 mem0 等外部提供方
              协议 rpi 没有对偶，仍不可用。
            </p>
            {optchatError !== null && (
              <div className="set-err">rpi-optchat 安装状态读取失败：{optchatError}</div>
            )}
            {optchat?.installed && optchat.missing.length > 0 && (
              <div className="set-err">
                安装不完整：缺少 {optchat.missing.join('、')}——重新执行{' '}
                <span className="set-code">rpi install rpi-optchat --force</span>。
              </div>
            )}
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <SetPrefRow
                  label="当前记忆提供方"
                  desc="来自原生扩展登记表（native-packages.json）的真实状态。"
                >
                  {optchat === null ? (
                    <span className="set-hint">读取中…</span>
                  ) : optchat.installed ? (
                    <span className="set-row-ok">
                      OptChat {optchat.version}（rpi-optchat）
                    </span>
                  ) : (
                    <span className="set-row-miss">
                      未安装 — 执行 rpi install rpi-optchat
                    </span>
                  )}
                </SetPrefRow>
                <SetPrefRow
                  label="内置层"
                  desc="OptChat 的会话日志 / 摘要树 / profile 存储；不是 hermes 的 MEMORY.md / USER.md。"
                >
                  <span className="set-code">会话日志 + 128 KB 摘要树</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="记忆提供方"
                  desc="OptChat 是原生扩展（装即启用，没有第二个提供方可选）；mem0 等外部协议未移植。"
                >
                  <span className="set-code">OptChat（原生扩展）</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="持久记忆"
                  desc="rpi-optchat 记录整段会话并镜像到 profile 存储；插件没有单独开关，卸载才停。"
                >
                  <Switch aria-label="持久记忆" checked={optchat?.installed === true} disabled />
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="用户档案"
                  desc="profile 存储：.rpi/optchat/<profile>.jsonl（RPI_OPTCHAT_STORE_DIR 可改根目录）。"
                >
                  <Switch aria-label="用户档案" checked={optchat?.installed === true} disabled />
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="记忆预算"
                  desc="摘要树预算 128 KB，超出后同级两两合并到 64 KB（插件内置常量）。"
                >
                  <span className="set-code">128 KB / 折叠到 64 KB</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="档案预算"
                  desc="profile 存储不设上限；会话日志保留最近 20,000 条消息。"
                >
                  <span className="set-code">无上限（20,000 条窗口）</span>
                </SetPrefRow>
              </div>
            </div>
            <p className="set-hint">
              模型侧工具：zoom / search。宿主对话区暂未提供 /optchat 命令面板
              （导入、切换 profile、压缩开关需在终端 rpi 里执行）。
            </p>

            <h4 className="set-sub-title">上下文</h4>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <SetPrefRow
                  label="上下文引擎"
                  desc="hermes 可选 compressor / default / custom；rpi 只有压缩器一种实现。"
                >
                  <span className="set-code">compressor（固定）</span>
                </SetPrefRow>
                <SetPrefRow
                  label="自动压缩"
                  desc="上下文逼近模型上限时自动压缩历史（rpi compaction.enabled）。"
                >
                  {settingsParsed !== null && !('error' in settingsParsed) ? (
                    <SetBoolField
                      onWrite={(v) => writeCompactionKey(K_ENABLED, v)}
                      read={readField(settingsParsed.doc, 'compaction', K_ENABLED)}
                      unsetLabel="未设置（默认：启用）"
                    />
                  ) : (
                    <span className="set-hint">settings.json 解析失败，见「安全与数据 · 安全」。</span>
                  )}
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="压缩阈值"
                  desc="hermes 是上下文窗口百分比（默认 0.50）；rpi 用绝对 reserve_tokens 表达同一个触发点，见下方引擎字段。"
                >
                  <span className="set-code">50%（hermes 默认）</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="压缩目标"
                  desc="hermes target_ratio（默认 0.20，压低到窗口的 20%）；rpi 无该比例参数，摘要长度由模型预算决定。"
                >
                  <span className="set-code">0.20（hermes 默认）</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="保护近期消息"
                  desc="hermes protect_last_n（默认 20 条）；rpi 用 keep_recent_tokens 保护近期内容（按 token 而非条数），见下方引擎字段。"
                >
                  <span className="set-code">20 条（hermes 默认）</span>
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="Codex 压缩自动提高"
                  desc="仅 hermes 的 ChatGPT Codex OAuth 路由；rpi 无该路由与阈值自动提高逻辑。"
                >
                  <Switch aria-label="Codex 压缩自动提高" disabled />
                </SetPrefRow>
                <SetPrefRow
                  disabled
                  label="压缩模型超时"
                  desc="hermes 的辅助压缩模型调用超时（默认 120 秒）；rpi 压缩复用主模型，没有独立压缩模型与超时。"
                >
                  <span className="set-code">120 秒（hermes 默认）</span>
                </SetPrefRow>
              </div>
            </div>

            <h4 className="set-sub-title">引擎实现（rpi compaction 真实字段）</h4>
            <p className="set-hint">
              上下两组的阈值/保护窗在 rpi 侧的等价表达。改动写入 settings.json
              的 <span className="set-code">compaction</span> 对象；未设置的键 =
              rpi 内置默认（enabled 启用、reserve_tokens 16384、
              keep_recent_tokens 20000）。rpi 没有 mode / compaction_mode
              这两个旧 pi 键——2026-11-24 审计后已从本页删除。
            </p>
            {settingsMissing && (
              <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
            )}
            {compactionError !== null && <div className="set-err">{compactionError}</div>}
            {settingsText === null ? (
              settingsError === null ? (
                <span className="set-file-missing">加载中…</span>
              ) : (
                <div className="set-err">{settingsError}</div>
              )
            ) : settingsParsed !== null && !('error' in settingsParsed) ? (
              <>
                <SetField name="reserve_tokens" note="压缩前预留的空间（tokens）——对应 hermes 的压缩阈值：触发点 = 上下文窗口 − 本值">
                  <SetNumField
                    {...numDraftFor('compaction.reserve_tokens')}
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('compaction', msg)}
                    onWrite={(v) => writeCompactionKey(K_RESERVE_TOKENS, v)}
                    placeholder="默认 16384"
                    read={readField(settingsParsed.doc, 'compaction', K_RESERVE_TOKENS)}
                  />
                </SetField>
                <SetField name="keep_recent_tokens" note="压缩时保留的近期对话（tokens）——对应 hermes 的保护近期消息（按 token 而非条数）">
                  <SetNumField
                    {...numDraftFor('compaction.keep_recent_tokens')}
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('compaction', msg)}
                    onWrite={(v) => writeCompactionKey(K_KEEP_RECENT_TOKENS, v)}
                    placeholder="默认 20000"
                    read={readField(settingsParsed.doc, 'compaction', K_KEEP_RECENT_TOKENS)}
                  />
                </SetField>
              </>
            ) : (
              settingsParseError !== null && (
                <div className="set-err">
                  settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后才能使用此段：
                  {settingsParseError}
                </div>
              )
            )}
            {compactionSaved !== null && <span className="set-saved">{compactionSaved}</span>}
          </section>
          )}


          {/* ── 安全（安全与数据 / 安全）：两块共用一节——
              ①提供方凭据（旧「提供方凭据」节）：pi_auth_status 状态列表；
              ②原始配置（旧「高级 · 原始配置」节）：settings.json /
                models.json 整体编辑。
              两者同组同屏是刻意的：凭据与配置文件是同一个"数据面"，
              且凭据/结构修不好的最后手段就是手改原始文档——分到不同
              组会让"看到问题 → 去修"的路径断成两次跳转。 ── */}
          {activeSection === 'security' && (
          <section className="set-section">
            {/* 提供方凭据目录已随 hermes providers 的移植移到「Agent 控制 ·
                模型」节（2026-10-24 用户映射）；本节保留原始配置编辑。 */}
            <p className="set-hint">
              提供方凭据的状态与写入见「Agent 控制 · 模型」节的「提供方凭据」；
              本节是配置文档的完整编辑面。
            </p>

            {/* ── 原始配置（旧「高级 · 原始配置」节并入）：settings.json /
                models.json 整体替换 ── */}
            <h4 className="set-sub-title">原始配置</h4>
            <p className="set-hint">
              完整文档编辑，保存 = 整体替换写入（pi 语义：nested 对象不合并）。写入前经 pi
              自身 schema 校验，类型不符会被拒绝。
            </p>

            <span className="set-file-missing">
              settings.json{settingsMissing ? '（文件尚不存在——保存将创建）' : ''}
            </span>
            {settingsError !== null && <div className="set-err">{settingsError}</div>}
            {settingsText === null ? (
              settingsError === null && <span className="set-file-missing">加载中…</span>
            ) : (
              <>
                <textarea
                  aria-label="settings.json 原始配置"
                  className="set-textarea"
                  onChange={(e) => {
                    setSettingsText(e.target.value)
                    setSettingsSaved(null)
                    setModelSaved(null)
                    setCompactionSaved(null)
                    setCompactionError(null)
                    setRetrySaved(null)
                    setRetryError(null)
                    clearExtraSaved()
                  }}
                  spellCheck={false}
                  value={settingsText}
                />
                {settingsParseError !== null && (
                  <div className="set-err">{settingsParseError}</div>
                )}
                <div className="set-actions">
                  <button
                    className="set-btn set-btn-primary"
                    disabled={settingsParseError !== null}
                    onClick={saveSettingsDoc}
                    type="button"
                  >
                    保存 settings.json
                  </button>
                  {settingsSaved !== null && <span className="set-saved">{settingsSaved}</span>}
                </div>
              </>
            )}

            <span className="set-file-missing">
              models.json{modelsConfigMissing ? '（文件尚不存在——保存将创建）' : ''}
            </span>
            {modelsConfigError !== null && <div className="set-err">{modelsConfigError}</div>}
            {modelsConfigText === null ? (
              modelsConfigError === null && <span className="set-file-missing">加载中…</span>
            ) : (
              <>
                <textarea
                  aria-label="models.json 原始配置"
                  className="set-textarea"
                  onChange={(e) => {
                    setModelsConfigText(e.target.value)
                    setModelsConfigSaved(null)
                  }}
                  spellCheck={false}
                  value={modelsConfigText}
                />
                {modelsConfigParsed !== null && 'error' in modelsConfigParsed && (
                  <div className="set-err">{modelsConfigParsed.error}</div>
                )}
                <div className="set-actions">
                  <button
                    className="set-btn set-btn-primary"
                    disabled={modelsConfigParsed !== null && 'error' in modelsConfigParsed}
                    onClick={saveModelsConfigDoc}
                    type="button"
                  >
                    保存 models.json
                  </button>
                  {modelsConfigSaved !== null && (
                    <span className="set-saved">{modelsConfigSaved}</span>
                  )}
                </div>
              </>
            )}
          </section>
          )}

          {/* ── 会话管理（安全与数据 / 会话管理）：rpi 的会话存储目录。
              旧占位文案「没有需要在此配置的项」被 rpi 的 sessionDir 推翻
              （2026-11-14 补齐）——建/切/重命名/删除仍在左栏会话列表，
              本节只配"会话存在哪"。 ── */}
          {activeSection === 'sessions' &&
            (activeSubView === null || !SESSIONS_CHILD_IDS.has(activeSubView)) && (
          <section className="set-section">
            <h4 className="set-sub-title">会话存储</h4>
            <p className="set-hint">
              rpi 建会话时的会话根目录。优先级：命令行{' '}
              <span className="set-code">--session-dir</span> &gt; 本键{' '}
              <span className="set-code">sessionDir</span> &gt; 环境变量{' '}
              <span className="set-code">RPI_CODING_AGENT_SESSION_DIR</span> &gt;{' '}
              <span className="set-code">{'<workspace>/.rpi/sessions'}</span>。
              相对路径相对工作区；留空 = 删键回默认。
            </p>
            {settingsMissing && (
              <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
            )}
            {settingsText !== null && settingsParseError !== null && (
              <div className="set-err">
                settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后才能使用本段：
                {settingsParseError}
              </div>
            )}
            {settingsParsed !== null && !('error' in settingsParsed) && (
              <>
                <SetField
                  name="sessionDir"
                  note="绝对路径，或相对当前工作区的路径（rpi 按工作区解析相对根）"
                >
                  <SetTextDraftField
                    {...numDraftFor('sessionDir')}
                    committed={
                      textFieldView(
                        readField(settingsParsed.doc, null, K_SESSION_DIR),
                      ).committed
                    }
                    expect="字符串"
                    invalidRaw={
                      textFieldView(
                        readField(settingsParsed.doc, null, K_SESSION_DIR),
                      ).invalidRaw
                    }
                    onReject={(msg) => rejectExtra('sessions', msg)}
                    onWrite={(v) =>
                      writeKey('sessions', null, K_SESSION_DIR, v)
                    }
                    parse={parsePlainText}
                    placeholder="默认 <workspace>/.rpi/sessions"
                  />
                </SetField>
                <p className="set-hint">
                  注意（如实）：宿主左栏的会话列表固定扫{' '}
                  <span className="set-code">{'<workspace>/.rpi/sessions'}</span>
                  （pi_session.rs 的 list_sessions）。把本键指到别处后，rpi 会把
                  新会话写进那个目录，而宿主列表看不到它们——列表跟随本键是
                  宿主的待接线项。
                </p>
                {extraFeedback.sessions.error !== null && (
                  <div className="set-err">{extraFeedback.sessions.error}</div>
                )}
                {extraFeedback.sessions.saved !== null && (
                  <span className="set-saved">{extraFeedback.sessions.saved}</span>
                )}
              </>
            )}
          </section>
          )}

          {/* ── 项目（安全与数据 / 项目）：Rust 项目注册表（pi_projects_*）
              的列表/搜索/排序/置顶/重命名/根目录增删/移除与恢复。节标题由
              右栏 set-inset-head 承担，面板不重复画。彻底删除缺 IPC（只有
              软删/恢复），面板内如实标注。 ── */}
          {(activeSection === 'projects' ||
            (activeSection === 'sessions' && activeSubView === 'projects')) && (
            <ProjectsSettingsSection headerLabel={null} />
          )}

          {/* 数据同步（会话管理 / 数据同步，2026-11-22）：ZCode
              DataSyncSection 的空态结构（宿主单机版无远端设备栈）。 */}
          {(activeSection === 'data-sync' ||
            (activeSection === 'sessions' && activeSubView === 'data-sync')) && (
            <DataSyncSettings />
          )}

          {/* ── 归档会话（安全与数据 / 归档会话）：pi_sessions_index
              ({ archived: true }) 按项目分组，恢复 / 批量删除。活动会话
              跳过并明示（设置页不接管对话区）。 ── */}
          {(activeSection === 'archives' ||
            (activeSection === 'sessions' && activeSubView === 'archives')) && (
            <ArchivesSettingsSection headerLabel={null} />
          )}

          {activeSection === 'skills-tools' && <SkillsToolsSettings />}

          {/* ── 版本与更新（关于 / 版本与更新）：hermes about-settings 的
              结构重移植（2026-11-24 用户："版本与更新对齐 hermes 的关于
              重新完整移植"）。
              hermes = VersionHero（BrandMark + 版本）→ 更新状态卡（检查/
              更新/发行说明）→ 自动更新行 → 卸载区。宿主没有更新服务端、
              自动更新器与卸载器（本地构建），所以状态恒为"本地构建"，按钮
              禁用并写明真实升级路径——不画假进度、不假装能检查。 ── */}
          {activeSection === 'updates' && (
          <section className="set-section">
            <div className="set-about-hero set-about-hero--center">
              <img alt="Mirach Harness" className="set-about-logo set-about-logo--lg" src="/brand/logo.png" />
              <div>
                <div className="set-about-name">{pkg.productName}</div>
                <div className="set-row-env">版本 {pkg.version}</div>
              </div>
            </div>

            <div className="set-acct-card">
              <div className="set-acct-card-head">更新</div>
              <div className="set-acct-card-body">
                <div className="set-acct-field">
                  <div className="set-acct-field-text">
                    <span className="set-acct-field-label">本地构建</span>
                    <p className="set-acct-field-desc">
                      宿主没有更新服务端与自动更新器；当前版本即运行中的构建。
                      升级 = 更新上游源 + 重拷 vendor 后重新构建。
                    </p>
                  </div>
                  <div className="set-acct-field-control">
                    <div className="set-actions">
                      <button
                        className="set-btn"
                        disabled
                        title="没有更新服务端，无法检查远端版本"
                        type="button"
                      >
                        检查更新
                      </button>
                      <button
                        className="set-btn set-btn-primary"
                        disabled
                        title="没有更新通道，无法在线更新"
                        type="button"
                      >
                        立即更新
                      </button>
                    </div>
                  </div>
                </div>
                <SetPrefRow
                  label="自动更新"
                  desc="hermes 在后台自动检查并安装桌面更新；宿主没有更新器，无法开启。"
                >
                  <Switch aria-label="自动更新" disabled />
                </SetPrefRow>
                <SetPrefRow
                  label="更新渠道"
                  desc="hermes 提供稳定版 / 每日构建两条通道；宿主是本地构建，没有渠道可选。"
                >
                  <span className="set-code">本地构建（唯一）</span>
                </SetPrefRow>
              </div>
            </div>

            <h4 className="set-sub-title">运行信息</h4>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <dl className="set-about-defs" style={{ padding: '12px 16px' }}>
                  <dt>应用名</dt>
                  <dd>
                    {pkg.productName}（{pkg.name}）
                  </dd>
                  <dt>应用版本</dt>
                  <dd>{pkg.version}</dd>
                  <dt>引擎版本</dt>
                  <dd>rpi {engineVersion ?? '…'}</dd>
                  {auth !== null && (
                    <>
                      <dt>settings</dt>
                      <dd className="set-row-env">{auth.settingsPath}</dd>
                      <dt>models</dt>
                      <dd className="set-row-env">{auth.modelsPath}</dd>
                      <dt>auth</dt>
                      <dd className="set-row-env">{auth.authPath}</dd>
                    </>
                  )}
                </dl>
              </div>
            </div>
          </section>
          )}

          {/* ── 通知（基础设置 / 通知）：hermes notifications-settings 的
              全链路复制（2026-11-24 用户："通知项移植的 hermes 的设置里的
              通知，是不是全链路复制的"）。单页结构：说明 → 启用通知 →
              七类事件 ToggleRow → 完成提示音（选择 + 预览）→ 测试按钮 →
              后台提示。开关是右侧 Switch，行内垂直居中（hermes
              primitives.ToggleRow / ListRow 同构）。
              偏好持久化在 localStorage（hermes 同语义，mirach: 前缀）；
              派发端（会话事件 → 通知）在 message-queue 一轮接线。 ── */}
          {activeSection === 'notifications' && (
          <section className="set-section">
            <p className="set-hint">
              原生桌面通知，区别于应用内提示。设置按设备保存，每台电脑各自独立。
            </p>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <SetPrefRow label="启用通知" desc="关闭后静音下方所有通知。">
                  <Switch
                    aria-label="启用通知"
                    checked={notifyPrefs.enabled}
                    onCheckedChange={onNotifyEnabled}
                  />
                </SetPrefRow>
                {NOTIFICATION_KINDS.map((kind) => {
                  const copy = NOTIFICATION_COPY[kind]
                  return (
                    <SetPrefRow desc={copy.desc} key={kind} label={copy.label}>
                      <Switch
                        aria-label={copy.label}
                        checked={notifyPrefs.enabled && notifyPrefs.kinds[kind]}
                        disabled={!notifyPrefs.enabled}
                        onCheckedChange={(on) => onNotifyKind(kind, on)}
                      />
                    </SetPrefRow>
                  )
                })}
              </div>
            </div>

            <h4 className="set-sub-title">完成提示音</h4>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <SetPrefRow
                  label="提示音"
                  desc="智能体回合结束时播放。可在此选择预设并预览。"
                >
                  <div className="set-actions">
                    <select
                      className="set-select"
                      onChange={(e) => {
                        const id = Number(e.target.value)
                        setCompletionVariant(id)
                        setCompletionSoundVariantId(id)
                        previewCompletionSound(id)
                      }}
                      value={completionVariant}
                    >
                      {COMPLETION_SOUND_VARIANTS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="set-btn"
                      onClick={() => previewCompletionSound(completionVariant)}
                      type="button"
                    >
                      预览
                    </button>
                  </div>
                </SetPrefRow>
              </div>
            </div>

            <div className="set-actions">
              <button className="set-btn" onClick={onNotifyTest} type="button">
                发送测试通知
              </button>
              {notifyTestState !== null && (
                <span className={notifyTestState.ok ? 'set-saved' : 'set-err'}>
                  {notifyTestState.message}
                </span>
              )}
            </div>
            <p className="set-hint">完成提醒仅在 Mirach 处于后台时触发。</p>
          </section>
          )}

          {/* ── 密码与登录（安全与数据 / 密码与登录）：hermes keys-settings
              的移植——provider 凭据目录 + 写入/清除。凭据落 pi 的
              auth.json（api_key 型）；内容永不回显（写入口令一次有效）。
              hermes 的密码库（vault：登录/支付/地址，后端 RPC 加密存储）
              是独立后端设施，宿主没有该服务——不伪造。 ── */}
          {activeSection === 'password-login' && activeSubView !== 'sources' && (
          <section className="set-section">
            {/* ── hermes vault（密码與登入）的 local 源移植（2026-10-24）。
                条目元数据明文、secret 进 OS 凭据管理器（本机加密）。
                hermes 的价值主张"代理代你登入"需要浏览器代填扩展——pi 没有
                该机制，如实注明；存储/管理面本身是完整可用的。 ── */}
            <h4 className="set-sub-title">密码库</h4>
            <p className="set-hint">
              本机加密存储的登录信息（hermes「密码与登录」local 源同语义：
              secret 进操作系统凭据管理器，本机加密）。内容只在条目创建时
              写入一次，之后只能删除——设置页永不回显。
            </p>
            {vaultError !== null && <div className="set-err">{vaultError}</div>}
            {vaultItems === null && vaultError === null && (
              <span className="set-file-missing">加载中…</span>
            )}
            {vaultItems !== null && vaultItems.length === 0 && (
              <div className="set-file-missing">尚未保存任何条目。</div>
            )}
            {vaultItems !== null && vaultItems.length > 0 && (
              <div className="set-rows">
                {vaultItems.map((item) => (
                  <div className="set-row" key={item.id}>
                    <span className="set-row-provider">{item.label}</span>
                    <span className="set-row-ok">
                      {item.kind === 'login' ? '登录' : item.kind === 'payment' ? '支付卡' : '地址'}
                    </span>
                    {item.origin !== undefined && item.origin !== null && (
                      <span className="set-row-source">{item.origin}</span>
                    )}
                    <span className="set-row-env">{item.createdAt}</span>
                    <span className="set-actions">
                      <button
                        className="set-btn"
                        disabled={vaultBusy}
                        onClick={() => void removeVaultItem(item.id, item.label)}
                        type="button"
                      >
                        删除
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <h4 className="set-sub-title">新增条目</h4>
            <p className="set-hint">
              加密保存在本机。代理永远不会看到密码。地址类条目按 hermes 的
              完整字段集（两行地址/城市/省州/邮编/国家）——存储形状与
              hermes buildSecret 同构。
            </p>
            <div className="set-rows">
              <SetField name="类型">
                <select
                  className="set-select"
                  onChange={(e) => setVaultKind(e.target.value)}
                  value={vaultKind}
                >
                  <option value="login">登录</option>
                  <option value="payment">支付卡</option>
                  <option value="address">地址</option>
                </select>
              </SetField>
              <SetField name="标签" note="例如：GitHub 工作帐号">
                <input
                  className="set-input"
                  onChange={(e) => setVaultLabel(e.target.value)}
                  value={vaultLabel}
                />
              </SetField>
              <SetField name="网站来源" note="https:// 开头">
                <input
                  className="set-input"
                  onChange={(e) => setVaultOrigin(e.target.value)}
                  placeholder={vaultKind === 'payment' ? 'https://shop.example.com' : 'https://github.com'}
                  value={vaultOrigin}
                />
              </SetField>
              {vaultKind === 'login' && (
                <>
                  <SetField name="标识符类型">
                    <select
                      className="set-select"
                      onChange={(e) => setVaultIdentifierType(e.target.value)}
                      value={vaultIdentifierType}
                    >
                      <option value="email">邮箱</option>
                      <option value="phone">电话</option>
                      <option value="username">用户名</option>
                    </select>
                  </SetField>
                  <SetField name="标识符">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultIdentifier(e.target.value)}
                      value={vaultIdentifier}
                    />
                  </SetField>
                  <SetField name="密码">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultPassword(e.target.value)}
                      type="password"
                      value={vaultPassword}
                    />
                  </SetField>
                  <SetField name="验证器密钥" note="Base32 密钥或 otpauth:// 链接（可选）">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultOtpSecret(e.target.value)}
                      placeholder="两步验证的设置密钥"
                      type="password"
                      value={vaultOtpSecret}
                    />
                  </SetField>
                </>
              )}
              {vaultKind === 'payment' && (
                <>
                  <SetField name="卡号">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultCardNumber(e.target.value)}
                      type="password"
                      value={vaultCardNumber}
                    />
                  </SetField>
                  <SetField name="持卡人姓名">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultCardName(e.target.value)}
                      value={vaultCardName}
                    />
                  </SetField>
                  <div className="set-row">
                    <span className="set-row-provider">有效期 / CVC / 邮编</span>
                    <span className="set-actions">
                      <input
                        aria-label="到期月份"
                        className="set-input"
                        maxLength={2}
                        onChange={(e) => setVaultExpiry(e.target.value)}
                        placeholder="MM"
                        style={{ width: 64 }}
                        value={vaultExpiry}
                      />
                      <input
                        aria-label="到期年份"
                        className="set-input"
                        maxLength={4}
                        onChange={(e) => setVaultExpYear(e.target.value)}
                        placeholder="YYYY"
                        style={{ width: 80 }}
                        value={vaultExpYear}
                      />
                      <input
                        aria-label="CVC"
                        className="set-input"
                        maxLength={4}
                        onChange={(e) => setVaultCvc(e.target.value)}
                        placeholder="CVC"
                        style={{ width: 72 }}
                        type="password"
                        value={vaultCvc}
                      />
                      <input
                        aria-label="邮政编码"
                        className="set-input"
                        onChange={(e) => setVaultPostal(e.target.value)}
                        placeholder="邮编"
                        style={{ width: 88 }}
                        value={vaultPostal}
                      />
                    </span>
                  </div>
                </>
              )}
              {vaultKind === 'address' && (
                <>
                  <SetField name="地址第 1 行">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultAddress(e.target.value)}
                      value={vaultAddress}
                    />
                  </SetField>
                  <SetField name="地址第 2 行（可选）">
                    <input
                      className="set-input"
                      onChange={(e) => setVaultAddress2(e.target.value)}
                      value={vaultAddress2}
                    />
                  </SetField>
                  <div className="set-row">
                    <span className="set-row-provider">城市 / 省·州（可选）</span>
                    <span className="set-actions">
                      <input
                        aria-label="城市"
                        className="set-input"
                        onChange={(e) => setVaultCity(e.target.value)}
                        placeholder="城市"
                        value={vaultCity}
                      />
                      <input
                        aria-label="省 / 州"
                        className="set-input"
                        onChange={(e) => setVaultState(e.target.value)}
                        placeholder="省 / 州"
                        value={vaultState}
                      />
                    </span>
                  </div>
                  <div className="set-row">
                    <span className="set-row-provider">邮政编码 / 国家·地区</span>
                    <span className="set-actions">
                      <input
                        aria-label="邮政编码"
                        className="set-input"
                        onChange={(e) => setVaultPostal(e.target.value)}
                        placeholder="邮编"
                        value={vaultPostal}
                      />
                      <input
                        aria-label="国家/地区"
                        className="set-input"
                        onChange={(e) => setVaultCountry(e.target.value)}
                        placeholder="国家/地区"
                        value={vaultCountry}
                      />
                    </span>
                  </div>
                </>
              )}
            </div>
            {vaultError2 !== null && <div className="set-err">{vaultError2}</div>}
            <div className="set-actions">
              <button
                className="set-btn set-btn-primary"
                disabled={vaultBusy}
                onClick={() => void addVaultItem()}
                type="button"
              >
                保存（加密进本机凭据管理器）
              </button>
            </div>
          </section>
          )}

          {/* ── 通知 · 来源子页（hermes vault.sources 的移植面）：本宿主
              只有 local 源（OS 凭据管理器）启用；Bitwarden / 1Password 的
              CLI 安装探测走 pi_vault_sources（spawn --version 真实探测），
              解锁/列条目集成是下一轮——状态如实标注。 ── */}
          {activeSection === 'password-login' && activeSubView === 'sources' && (
          <section className="set-section">
            <h4 className="set-sub-title">密码管理器</h4>
            <p className="set-hint">
              已安装的密码管理器会被自动识别（hermes 语义）。本宿主的存储
              源 = 操作系统凭据管理器（本机加密、随用户账户）；外部管理器
              探测 CLI 是否安装（Bitwarden / 1Password），解锁与条目访问
              需要其会话令牌管理——尚未接线。
            </p>
            {vaultSourcesError !== null && <div className="set-err">{vaultSourcesError}</div>}
            {vaultSources === null && vaultSourcesError === null && (
              <span className="set-file-missing">探测中…</span>
            )}
            {vaultSources !== null && (
            <div className="set-rows">
              {vaultSources.map((s) => (
                <div className="set-row" key={s.name}>
                  <span className="set-row-provider">{s.displayName}</span>
                  {s.enabled ? (
                    <span className="set-row-ok">已启用{s.unlocked ? ' · 已解锁' : ''}</span>
                  ) : s.installed ? (
                    <span className="set-row-miss">已安装 · 未接线</span>
                  ) : (
                    <span className="set-row-miss">未安装</span>
                  )}
                  <span className="set-row-source">
                    {s.name === 'local'
                      ? '条目密文存于 Windows 凭据管理器（service: mirach.vault）'
                      : '检测 `bw --version` / `op --version`；解锁与条目访问待接线（不伪造）'}
                  </span>
                </div>
              ))}
            </div>
            )}
          </section>
          )}

          {/* ── 键盘快捷键（安全与数据 / 键盘快捷键）：hermes
              keybind-settings 的移植——捕获式改键 + 清除 + 重置。
              存储契约与 hermes 同语义（差分覆盖，localStorage）；派发器
              （全局 keydown → 动作）挂壳级 runtime 内，注册表只列宿主
              真有全局处理器的动作。 ── */}
          {activeSection === 'shortcuts' && (
          <section className="set-section">
            <h4 className="set-sub-title">全局快捷键</h4>
            <p className="set-hint">
              点击「修改」后按下新组合（Ctrl/Cmd + 键，可加 Alt/Shift）；
              Esc 取消捕获，退格清除绑定。覆盖保存在本机（localStorage，
              只存与默认不同的差分）。注册表 = hermes 全表（60 项）；标
              「未接线」的动作在 harness 还没有全局处理器——绑定与冲突
              检测真实生效，按下暂不触发行为。
            </p>
            <div className="set-actions">
              <input
                className="set-input"
                onChange={(e) => setKeybindQuery(e.target.value)}
                placeholder="搜索快捷键…"
                value={keybindQuery}
              />
            </div>
            {KEYBIND_CATEGORIES.map((cat) => {
              const rows = keybindFiltered.filter((a) => a.category === cat)
              if (rows.length === 0) return null
              return (
                <div key={cat}>
                  <h4 className="set-sub-title">{cat}</h4>
                  <div className="set-rows">
                    {rows.map((action) => {
                      const combos = keybindBindings[action.id] ?? []
                      const isCapturing = keybindCapturing === action.id
                      return (
                        <div className="set-row" key={action.id}>
                          <span className="set-row-provider">
                            {action.label}
                            {!action.wired && (
                              <span className="set-row-env-off" style={{ marginLeft: 8 }}>
                                未接线
                              </span>
                            )}
                          </span>
                          <span className="set-actions">
                            {combos.length === 0 ? (
                              <span className="set-row-miss">未绑定</span>
                            ) : (
                              combos.map((combo) => (
                                <span className="set-code" key={combo}>
                                  {formatCombo(combo)}
                                </span>
                              ))
                            )}
                            <button
                              className="set-btn"
                              onClick={() => keybindBeginCapture(action.id)}
                              type="button"
                            >
                              {isCapturing ? '按键…（Esc 取消）' : '修改'}
                            </button>
                            {combos.length > 0 && (
                              <button
                                className="set-btn"
                                onClick={() => keybindClearBinding(action.id)}
                                type="button"
                              >
                                清除
                              </button>
                            )}
                            {JSON.stringify(combos) !== JSON.stringify(action.defaults) && (
                              <button
                                className="set-btn"
                                onClick={() => keybindResetBinding(action.id)}
                                type="button"
                              >
                                恢复默认
                              </button>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            <h4 className="set-sub-title">固定快捷键（只读）</h4>
            <div className="set-rows">
              {KEYBIND_READONLY.map((ro) => (
                <div className="set-row" key={ro.id}>
                  <span className="set-row-provider">{ro.label}</span>
                  <span className="set-actions">
                    {ro.keys.map((k) => (
                      <span className="set-code" key={k}>
                        {formatCombo(k)}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <div className="set-actions">
              <button className="set-btn" onClick={keybindResetAllBindings} type="button">
                全部恢复默认
              </button>
            </div>
          </section>
          )}

          {/* ── 核心连接（基础设置 / 核心连接）：hermes gateway-settings 的
              完整复刻（src/app/settings/gateway-settings.tsx，2026-10-24
              子代理移植）——四张连接模式卡（远程/云/SSH 读连接注册表实态：
              有连接可跳「连接」页管理，无连接置灰指向同一入口）+ 本地面板
              （端点/token/复制）+ 诊断行。连接注册表的数据面 =
              pi_connections.rs + pi_gateway.rs + pi_ssh.rs（2026-11-22 与本页
              对齐；此前这里把远程/云/SSH 写成"单机未实现"，已纠正）。
              下半段「引擎网络」= rpi settings.json 的 HTTP 面（2026-11-14
              补齐）：rpi 建会话时读取（session::build 的 saved_settings
              段），改动对下一个会话生效。 ── */}
          {activeSection === 'core-connection' && (
            <>
              <GatewaySettings />
              <section className="set-section">
                <h4 className="set-sub-title">引擎网络</h4>
                <p className="set-hint">
                  引擎自身 HTTP 客户端的网络配置（settings.json 顶层键，rpi
                  建会话时读取）。这些不是宿主窗口/网关的设置——网关端点在
                  上方「本地面板」。
                </p>
                {settingsMissing && (
                  <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
                )}
                {settingsText !== null && settingsParseError !== null && (
                  <div className="set-err">
                    settings 文档解析失败——修正「安全与数据 · 安全」里的 JSON 后才能使用本段：
                    {settingsParseError}
                  </div>
                )}
                {settingsParsed !== null && !('error' in settingsParsed) && (
                  <>
                    <SetField
                      name="httpProxy"
                      note="写入 HTTP_PROXY/HTTPS_PROXY 供 rpi 的 HTTP 客户端使用；环境变量里已有值时以环境变量为准。留空 = 直连"
                    >
                      <SetTextDraftField
                        {...numDraftFor('httpProxy')}
                        committed={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_HTTP_PROXY),
                          ).committed
                        }
                        expect="字符串"
                        invalidRaw={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_HTTP_PROXY),
                          ).invalidRaw
                        }
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_HTTP_PROXY, v)
                        }
                        parse={parsePlainText}
                        placeholder="http://127.0.0.1:7890"
                      />
                    </SetField>
                    <SetField
                      name="cdnBaseUrl"
                      note="发布包下载的 CDN 加速前缀；GitHub 清单仍是权威来源（CDN 只是传输加速）。留空 = 直连 GitHub"
                    >
                      <SetTextDraftField
                        {...numDraftFor('cdnBaseUrl')}
                        committed={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_CDN_BASE_URL),
                          ).committed
                        }
                        expect="字符串"
                        invalidRaw={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_CDN_BASE_URL),
                          ).invalidRaw
                        }
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_CDN_BASE_URL, v)
                        }
                        parse={parsePlainText}
                        placeholder="https://assets.example.com"
                      />
                    </SetField>
                    <SetField
                      name="streamIdleTimeout"
                      note="流式回复两段数据之间的最大静默秒数（默认 300；0 = 关闭该保护）"
                    >
                      <SetNumField
                        {...numDraftFor('streamIdleTimeout')}
                        max={U32_MAX}
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_STREAM_IDLE_TIMEOUT, v)
                        }
                        placeholder="默认 300"
                        read={readField(
                          settingsParsed.doc,
                          null,
                          K_STREAM_IDLE_TIMEOUT,
                        )}
                      />
                    </SetField>
                    <SetField
                      name="httpIdleTimeout"
                      note="空闲连接在池中的保留时长：非负整数（毫秒）或 disabled（关闭回收）。留空 = 库内置默认"
                    >
                      <SetTextDraftField
                        {...numDraftFor('httpIdleTimeout')}
                        committed={
                          httpIdleFieldView(
                            readField(settingsParsed.doc, null, K_HTTP_IDLE_TIMEOUT),
                          ).committed
                        }
                        expect="毫秒整数或 disabled"
                        invalidRaw={
                          httpIdleFieldView(
                            readField(settingsParsed.doc, null, K_HTTP_IDLE_TIMEOUT),
                          ).invalidRaw
                        }
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_HTTP_IDLE_TIMEOUT, v)
                        }
                        parse={parseHttpIdle}
                        placeholder="30000 或 disabled"
                      />
                    </SetField>

                    <h4 className="set-sub-title">终端执行</h4>
                    <p className="set-hint">
                      rpi-tools 执行 bash 时使用的 shell 与每条命令前缀（从
                      「技能与工具」迁入；那页已改为纯本地开关）。未设置 =
                      自动发现 shell，环境变量 RPI_BASH_PATH 可覆盖发现结果。
                    </p>
                    <SetField
                      name="Shell 路径"
                      note="自定义 shell 可执行文件（如 Git Bash / PowerShell 的绝对路径）；留空 = 自动发现。"
                    >
                      <SetTextDraftField
                        {...numDraftFor('shellPath')}
                        committed={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_SHELL_PATH),
                          ).committed
                        }
                        expect="字符串"
                        invalidRaw={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_SHELL_PATH),
                          ).invalidRaw
                        }
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_SHELL_PATH, v)
                        }
                        parse={parsePlainText}
                        placeholder="C:\\Program Files\\Git\\bin\\bash.exe"
                      />
                    </SetField>
                    <SetField
                      name="Shell 命令前缀"
                      note="每条 bash 命令执行前拼接的脚本片段（如 shopt -s expand_aliases）；留空 = 无前缀。"
                    >
                      <SetTextDraftField
                        {...numDraftFor('shellCommandPrefix')}
                        committed={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_SHELL_COMMAND_PREFIX),
                          ).committed
                        }
                        expect="字符串"
                        invalidRaw={
                          textFieldView(
                            readField(settingsParsed.doc, null, K_SHELL_COMMAND_PREFIX),
                          ).invalidRaw
                        }
                        onReject={(msg) => rejectExtra('connection', msg)}
                        onWrite={(v) =>
                          writeKey('connection', null, K_SHELL_COMMAND_PREFIX, v)
                        }
                        parse={parsePlainText}
                        placeholder="shopt -s expand_aliases"
                      />
                    </SetField>
                    {extraFeedback.connection.error !== null && (
                      <div className="set-err">{extraFeedback.connection.error}</div>
                    )}
                    {extraFeedback.connection.saved !== null && (
                      <span className="set-saved">{extraFeedback.connection.saved}</span>
                    )}
                  </>
                )}
              </section>
            </>
          )}

          {/* ── 账户（关于 / 账户）：openhuman AccountPanel 的完整移植
               （src/app/settings/account-settings.tsx，2026-10-25）——
               签名至 Mirach + 套餐与账单（打开控制台）+ 会话卡（退出登录 /
               清除应用数据 + 二次确认）。上游的「偏好」卡按用户定稿移到
               常规节（语言 / 时区）。 ── */}

          {/* ── 个性（基础设置 / 个性）：openhuman PersonaPanel 的完整移植
               （src/app/settings/persona-settings.tsx，2026-10-26）——
               身份（显示名/描述）+ 六角色模板 + 引导式三字段/高级原文编辑器
               + 单一保存条。SOUL.md 落 ~/.pi/agent/SOUL.md，建会话时注入
               append_system_prompt。 ── */}
          {activeSection === 'persona' && <PersonaSettings />}
          {activeSection === 'appearance' && <AppearanceSettings />}
          {activeSection === 'avatar' && <AvatarSettings />}

          {/* ── 语音（基础设置 / 语音）：GPT-Live 双工语音的配置面
              （2026-11-12，moss live 桥接层）——引擎模式 / OpenAI key
               （只写不读）/ 模型音色 + 就绪状态读数。数据面 =
               pi_voice_live_set_config（settings.json voice 段 RMW）+
               pi_voice_live_status。 ── */}
          {activeSection === 'voice' && <VoiceSettings />}

          {/* ── 行为与工具（Agent 控制 / 行为与工具）：ZCode 设置页
              `agentBehavior` 节的完整移植（2026-11-22，逐行文案照抄
              zh-CN.ts:3572-3723）。两枚显示开关真实接线
              （conversation-display-store → 消息流渲染）；无引擎数据面的
              行按「引擎固定限制」同规禁用 + 「宿主实况」说明。 ── */}
          {activeSection === 'agent-behavior' && <AgentBehaviorSettings />}

          {/* ── 使用统计（安全与数据 / 使用统计）：ZCode AppUsagePanel 的移植
               （src/app/settings/usage-settings.tsx，2026-10-26）——
               概览条 + 52 周热力图 + 按天趋势 + 按模型占比，数据 = 本地
               pi 会话聚合（pi_usage_snapshot）。ZCode 的 Coding Plan tab
               读云端订阅额度，宿主没有 → 不移植（页面底部如实说明）。 ── */}
          {(activeSection === 'usage-stats' ||
            (activeSection === 'sessions' && activeSubView === 'usage-stats')) && (
            <UsageSettings />
          )}

          {/* ── 常规（基础设置 / 常规）：openhuman 账户页「偏好」卡的移植
               （用户 2026-10-25 定稿：偏好卡不要，语言与时区搬到这里）。
               语言只留中文 / 英文；时区默认「使用设备时区」。
               生效范围如实标注：选择持久化 + 驱动 <html lang> 与日期格式，
               界面文案本身仍是硬编码中文（i18n 未建）。
               下方「启动与窗口 / 电源与快捷键 / 链接 / 智能体限制 / 数据
               存储 / 引擎固定限制」是 2026-11-15 按 ZCode 常规页选项补齐：
               可接线的接真行为（app-prefs.json / settings.json sessionDir /
               引擎 env），引擎编译期常量如实标「固定」，没有原语的项明确
               禁用并说明原因——不造假开关。 ── */}
          {activeSection === 'general' && (
          <section className="set-section">
            <h4 className="set-sub-title" style={{ margin: 0 }}>偏好</h4>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <div className="set-acct-field">
                  <div className="set-acct-field-text">
                    <span className="set-acct-field-label">语言</span>
                    <p className="set-acct-field-desc">应用界面显示语言</p>
                  </div>
                  <div className="set-acct-field-control">
                    <select
                      aria-label="语言"
                      className="set-select"
                      onChange={(e) => {
                        const next = e.target.value as AppLocale
                        setLocalePref(next)
                        setUiLocale(next)
                      }}
                      value={uiLocale}
                    >
                      {LOCALE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.flag} {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="set-acct-field">
                  <div className="set-acct-field-text">
                    <span className="set-acct-field-label">时区</span>
                    <p className="set-acct-field-desc">你的本地时区。默认跟随此设备。</p>
                  </div>
                  <div className="set-acct-field-control">
                    <select
                      aria-label="时区"
                      className="set-select"
                      onChange={(e) => {
                        setTimezonePref(e.target.value)
                        setUiTimezone(e.target.value)
                      }}
                      value={uiTimezone}
                    >
                      <option value="device">使用设备时区（{deviceTimeZone()}）</option>
                      {uiTimezoneOptions.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <p className="set-acct-note" style={{ padding: '0' }}>
              语言选择会记住并驱动日期/时间格式与 <code className="set-code">&lt;html lang&gt;</code>；
              界面文案目前仍是中文（宿主 i18n 尚未建立）。
            </p>

            {/* ── 启动与窗口（应用级偏好） ── */}
            <h4 className="set-sub-title">启动与窗口</h4>
            {appPrefs === null ? (
              appPrefsError === null ? (
                <p className="set-hint">正在读取应用偏好…</p>
              ) : (
                <div className="set-err">{appPrefsError}</div>
              )
            ) : (
              <div className="set-acct-card">
                <div className="set-acct-card-body">
                  <SetPrefRow
                    label="启动时恢复上次会话"
                    desc="启动后自动打开上次的会话；关闭则每次启动都是新会话。"
                  >
                    <Switch
                      aria-label="启动时恢复上次会话"
                      checked={appPrefs.restoreLastSession}
                      onCheckedChange={(v) =>
                        writeAppPrefs({ restoreLastSession: v }, '已保存')
                      }
                    />
                  </SetPrefRow>
                  <SetPrefRow
                    label="关闭窗口时隐藏到托盘"
                    desc="点 ✕ 隐藏到系统托盘；关闭则点 ✕ 直接退出应用。"
                  >
                    <Switch
                      aria-label="关闭窗口时隐藏到托盘"
                      checked={appPrefs.closeToTray}
                      onCheckedChange={(v) =>
                        writeAppPrefs({ closeToTray: v }, '已保存')
                      }
                    />
                  </SetPrefRow>
                  <SetPrefRow
                    disabled
                    label="文件检查点"
                    desc="rpi 引擎没有文件快照原语：checkpoint_* 只记录会话回滚点，不能撤销文件改动，因此没有可接线的对象。"
                  >
                    <Switch aria-label="文件检查点" disabled />
                  </SetPrefRow>
                  <SetPrefRow
                    disabled
                    label="手机推送通知"
                    desc="宿主没有移动端 / 推送通道（通知仅本机 OS）。"
                  >
                    <Switch aria-label="手机推送通知" disabled />
                  </SetPrefRow>
                </div>
              </div>
            )}

            {/* ── 电源与快捷键 ── */}
            <h4 className="set-sub-title">电源与快捷键</h4>
            {appPrefs !== null && (
              <div className="set-acct-card">
                <div className="set-acct-card-body">
                  <SetPrefRow
                    label="保持电脑唤醒"
                    desc="运行期间 = 仅智能体执行任务时阻止系统睡眠；始终 = 应用运行期间一直阻止。"
                  >
                    <SegmentedControl<KeepAwakeMode>
                      onChange={(id) => writeAppPrefs({ keepAwake: id }, '已保存')}
                      options={[
                        { id: 'off', label: '关闭' },
                        { id: 'run', label: '运行期间' },
                        { id: 'always', label: '始终' },
                      ]}
                      sizing="content"
                      value={appPrefs.keepAwake}
                    />
                  </SetPrefRow>
                  <SetPrefRow
                    label="禁用 F12 开发者工具"
                    desc="拦截页面级 F12。发布构建本身不开放开发者工具，该开关主要影响开发构建。"
                  >
                    <Switch
                      aria-label="禁用 F12 开发者工具"
                      checked={appPrefs.disableF12}
                      onCheckedChange={(v) =>
                        writeAppPrefs({ disableF12: v }, '已保存')
                      }
                    />
                  </SetPrefRow>
                </div>
              </div>
            )}

            {/* ── 链接 ── */}
            <h4 className="set-sub-title">链接</h4>
            {appPrefs !== null && (
              <div className="set-acct-card">
                <div className="set-acct-card-body">
                  <SetPrefRow
                    label="始终在外部浏览器打开链接"
                    desc="http(s) 链接交系统默认浏览器；关闭则维持应用内行为。"
                  >
                    <Switch
                      aria-label="始终在外部浏览器打开链接"
                      checked={appPrefs.openLinksExternally}
                      onCheckedChange={(v) =>
                        writeAppPrefs({ openLinksExternally: v }, '已保存')
                      }
                    />
                  </SetPrefRow>
                </div>
              </div>
            )}

            {/* ── 智能体限制 ── */}
            <h4 className="set-sub-title">智能体限制</h4>
            {appPrefs !== null && (
              <div className="set-acct-card">
                <div className="set-acct-card-body">
                  <SetPrefRow
                    label="最大智能体步数"
                    desc="单次 run 的智能体步数上限（写入引擎的 RPI_MAX_TURNS_PER_RUN，下一次 run 生效）；0 = 不设上限，默认 100。"
                  >
                    <input
                      aria-label="最大智能体步数"
                      className="set-input"
                      min={0}
                      max={100000}
                      onBlur={commitSteps}
                      onChange={(e) => setStepsDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        commitSteps()
                      }}
                      style={{ width: 120 }}
                      type="number"
                      value={stepsDraft}
                    />
                  </SetPrefRow>
                  <SetPrefRow
                    label="API 重试次数"
                    desc="写入 settings.json 的 retry.maxRetries（与「模型」节同一字段）。"
                  >
                    {settingsParsed !== null && !('error' in settingsParsed) ? (
                      <SetNumField
                        {...numDraftFor('retry.max_retries')}
                        max={U32_MAX}
                        onReject={(msg) => rejectNum('retry', msg)}
                        onWrite={(v) => writeRetryKey(K_MAX_RETRIES, v)}
                        placeholder="默认 10"
                        read={readField(settingsParsed.doc, 'retry', K_MAX_RETRIES)}
                      />
                    ) : (
                      <span className="set-hint">settings.json 解析失败，见「安全与数据 · 安全」。</span>
                    )}
                  </SetPrefRow>
                </div>
              </div>
            )}
            {retryError !== null && <div className="set-err">{retryError}</div>}
            {retrySaved !== null && <span className="set-saved">{retrySaved}</span>}

            {/* ── 数据存储 ── */}
            <h4 className="set-sub-title">数据存储</h4>
            <div className="set-acct-card">
              <div className="set-acct-card-body">
                <SetPrefRow
                  label="数据存储路径"
                  desc="rpi 会话根目录（写入 settings.json 的 sessionDir）。与「会话管理」节同一字段；相对路径相对工作区。"
                >
                  <button
                    aria-label="选择数据存储目录"
                    className="set-select"
                    onClick={() => void pickSessionDir()}
                    style={{ cursor: 'pointer' }}
                    type="button"
                  >
                    选择文件夹…
                  </button>
                </SetPrefRow>
              </div>
            </div>
            {settingsParsed !== null && !('error' in settingsParsed) && (
              <p className="set-hint">
                当前：
                <code className="set-code">
                  {
                    textFieldView(
                      readField(settingsParsed.doc, null, K_SESSION_DIR),
                    ).committed || '默认（<workspace>/.rpi/sessions）'
                  }
                </code>
              </p>
            )}
            {extraFeedback.sessions.error !== null && (
              <div className="set-err">{extraFeedback.sessions.error}</div>
            )}
            {extraFeedback.sessions.saved !== null && (
              <span className="set-saved">{extraFeedback.sessions.saved}</span>
            )}

            {appPrefsError !== null && (
              <div className="set-err">{appPrefsError}</div>
            )}
            {appPrefsSaved !== null && (
              <span className="set-saved">{appPrefsSaved}</span>
            )}
          </section>
          )}

          {/* ── 插件贡献页（插件集成组，2026-11-07）：render 来自
              settings.page 贡献（当前无 bundled 插件注册——「连接」页
              已删除，连接注册表内嵌在「核心连接」页）。 ── */}
          {activeSection.startsWith('plugin:') &&
            usePluginContributions()['settings.page']
              .filter((c) => c.id === activeSection)
              .map((c) => (
                <Fragment key={c.id}>{c.render?.()}</Fragment>
              ))}

          {/* ── 占位节（其余 16 项）：标题 + 明确说明为什么还没有数据面。
              文案由 NAV_GROUPS 的 placeholder 字段驱动——不在 JSX 里再抄
              一遍，避免两处漂移。四个真实节之外若出现"既无面板又无说明"
              的 id，显示可见的编码错误（不静默、不编造内容）。 ── */}
          {!activeSection.startsWith('plugin:') &&
            !IMPLEMENTED_SECTIONS.has(activeSection) &&
            (() => {
              const item = ALL_NAV_ITEMS.find((s) => s.id === activeSection)
              if (item === undefined) return null
              if (item.placeholder === undefined) {
                return (
                  <section className="set-section">
                    <div className="set-err">
                      编码错误：设置节 {item.id} 既没有面板实现，也没有占位说明
                      （NAV_GROUPS 里缺 placeholder 字段）。
                    </div>
                  </section>
                )
              }
              return <SetPlaceholder note={item.placeholder} />
            })()}
          </div>
        </div>
    </div>
  )

  if (isWindow) return card

  return createPortal(
    <div
      className={closing ? 'set-overlay set-overlay--closing' : 'set-overlay'}
      onClick={requestClose}
      role="presentation"
    >
      {card}
    </div>,
    document.body,
  )
}
