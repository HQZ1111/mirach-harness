/**
 * pi 工具名 → 呈现规格（图标 / 短语 / 分类 / chip 规则）。
 *
 * 架构与命名规则沿用 openhuman
 * `features/conversations/tools/toolSpecs.ts`（2026-10-17 移植），
 * **工具表按 pi 的 46 个内核工具重写**（openhuman 的表是它自己的工具集，
 * 直接搬会全落 fallback）。
 *
 * 三层解析（见 `tool-presentation.ts`）：
 * - `EXACT_TOOL_SPECS`：pi 注册表里每个工具名一条；
 * - `ACTION_TOOL_SPECS`：同一工具按参数分叉（`jobs {action}` /
 *   `hub {action}` / `list|create|update|delete`）；
 * - `FAMILY_TOOL_SPECS`：前缀家族（ai 的 `ast_*`）。
 *
 * 不在表里的工具走 generic 兜底（图标 = 扳手，短语 = "Used <name>"）——
 * 与 openhuman 不同，我们**不强制编目**（pi 可通过扩展新增工具，编目
 * 失败不应报错）。
 */
import type { LucideIcon } from 'lucide-react'
import {
  ActivityIcon,
  BookmarkIcon,
  BotIcon,
  BoxesIcon,
  BrainIcon,
  BugIcon,
  CodeIcon,
  DatabaseIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderSearchIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  LightbulbIcon,
  ListChecksIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MonitorIcon,
  PlugIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TargetIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'

import { chip, type ChipRule, type ToolArgs } from './tool-chips'
import type { ToolPhraseId } from './tool-phrases'

export type ToolCategory = 'file' | 'code' | 'web' | 'agent' | 'system' | 'media' | 'plan'

/** 工具详情面板的富内容形态（pi 实装：diff / 终端 / 搜索 / 计划 / 文件）。 */
export type ToolBodyKind =
  | 'file'
  | 'diff'
  | 'terminal'
  | 'webSearch'
  | 'plan'
  | 'todo'
  | 'agent'
  | 'job'
  | 'generic'

export interface ToolSpec {
  phrase: ToolPhraseId
  icon: LucideIcon
  category: ToolCategory
  chip?: ChipRule
  body?: ToolBodyKind
}

const spec = (
  phrase: ToolPhraseId,
  icon: LucideIcon,
  category: ToolCategory,
  extra: Partial<Pick<ToolSpec, 'chip' | 'body'>> = {},
): ToolSpec => ({ phrase, icon, category, ...extra })

export const FALLBACK_ICON = WrenchIcon
export const INTEGRATION_ICON = PlugIcon

/** pi 内核工具（`tools.rs` 注册表逐名核对，2026-10-17）。 */
export const EXACT_TOOL_SPECS: Record<string, ToolSpec> = {
  // ── 文件与代码 ────────────────────────────────────────────────────────
  read: spec('readFile', FileTextIcon, 'file', { chip: chip.path(), body: 'file' }),
  write: spec('writeFile', FilePlusIcon, 'file', { chip: chip.path(), body: 'file' }),
  edit: spec('editFile', FilePenIcon, 'file', { chip: chip.path(), body: 'diff' }),
  hashline_edit: spec('editFile', FilePenIcon, 'file', { chip: chip.path(), body: 'diff' }),
  grep: spec('searchCode', SearchIcon, 'code', { chip: chip.text('pattern', 'query') }),
  find: spec('findFiles', FolderSearchIcon, 'file', { chip: chip.text('pattern', 'glob') }),
  ls: spec('listFolder', FolderOpenIcon, 'file', { chip: chip.path() }),
  ast_grep: spec('searchCode', FileSearchIcon, 'code', {
    chip: chip.text('pattern', 'query'),
  }),
  ast_edit: spec('applyEdits', FilePenIcon, 'code', { chip: chip.path(), body: 'diff' }),
  lsp: spec('searchCode', CodeIcon, 'code', { chip: chip.text('query', 'symbol') }),
  debug: spec('runDebugger', BugIcon, 'code', { chip: chip.text('command', 'target') }),

  // ── Shell ─────────────────────────────────────────────────────────────
  bash: spec('runCommand', TerminalIcon, 'system', {
    chip: chip.command(),
    body: 'terminal',
  }),

  // ── 计划与待办 ─────────────────────────────────────────────────────────
  todo: spec('updateTodos', ListTodoIcon, 'plan', { body: 'todo' }),
  submit_plan: spec('submitPlan', ListChecksIcon, 'plan', { body: 'plan' }),

  // ── 子代理与任务 ───────────────────────────────────────────────────────
  subagent: spec('runAgent', BotIcon, 'agent', {
    chip: chip.text('agent', 'task', 'name'),
    body: 'agent',
  }),
  hub: spec('useHub', BoxesIcon, 'agent', {
    chip: chip.text('action', 'name'),
    body: 'agent',
  }),
  jobs: spec('useJob', SquareTerminalIcon, 'system', {
    chip: chip.text('action', 'command'),
    body: 'job',
  }),
  ask: spec('askUser', BrainIcon, 'agent', { chip: chip.text('question') }),

  // ── Web 与外部 ─────────────────────────────────────────────────────────
  web_search: spec('searchWeb', GlobeIcon, 'web', {
    chip: chip.query(),
    body: 'webSearch',
  }),
  github: spec('useGithub', GitBranchIcon, 'web', {
    chip: chip.text('action', 'repo', 'query'),
  }),

  // ── 媒体 ───────────────────────────────────────────────────────────────
  inspect_image: spec('readImage', ImageIcon, 'media', { chip: chip.path() }),
  read_media: spec('readMedia', ImageIcon, 'media', { chip: chip.path() }),
  generate_image: spec('generateImage', SparklesIcon, 'media', {
    chip: chip.text('prompt'),
  }),
  tts: spec('speak', SparklesIcon, 'media', { chip: chip.text('text') }),

  // ── 系统 ───────────────────────────────────────────────────────────────
  computer: spec('useComputer', MonitorIcon, 'system', {
    chip: chip.text('action', 'target'),
  }),
  browser: spec('useBrowser', GlobeIcon, 'web', {
    chip: chip.text('action', 'url'),
  }),
  security_scan: spec('runSecurityScan', ShieldCheckIcon, 'system', {
    chip: chip.path(),
  }),
  eval: spec('runEval', CodeIcon, 'code', { chip: chip.text('code', 'expression') }),
  current_time: spec('readTime', DatabaseIcon, 'system'),

  // ── 扩展 UI ────────────────────────────────────────────────────────────
  extension_ui_request: spec('askUser', PlugIcon, 'system'),

  // ── rpi 插件工具（2026-11-15 补；注册表来自 rpi 各插件）─────────────────
  // 子代理 / 编排：delegate_task = rpi-subagents；subagent/dispatch/plan =
  // orchestrator（plan 与 submit_plan 不是同一件事——前者是编排器的任务
  // 分解工具，后者是内核的计划提交）。
  delegate_task: spec('runAgent', BotIcon, 'agent', {
    chip: chip.text('task', 'prompt', 'description'),
    body: 'agent',
  }),
  dispatch: spec('runAgent', BotIcon, 'agent', {
    chip: chip.text('task', 'prompt', 'description'),
    body: 'agent',
  }),
  plan: spec('submitPlan', ListChecksIcon, 'plan', {
    chip: chip.text('goal', 'objective', 'task', 'plan'),
    body: 'plan',
  }),
  ask_user: spec('askUser', BrainIcon, 'agent', {
    chip: chip.text('question', 'prompt', 'message'),
  }),

  // 检查点：rpi 的会话打点（mark / list / rewind）
  checkpoint_mark: spec('markCheckpoint', BookmarkIcon, 'plan', {
    chip: chip.text('label', 'name', 'message'),
  }),
  checkpoint_list: spec('listCheckpoints', HistoryIcon, 'plan'),
  checkpoint_rewind: spec('rewindCheckpoint', RotateCcwIcon, 'plan', {
    chip: chip.text('checkpointId', 'id', 'label'),
  }),

  // MCP：四类工具共用一个短语（服务器 / 工具名做 chip）
  mcp_list: spec('useMcp', PlugIcon, 'system', { chip: chip.text('server', 'query') }),
  mcp_call: spec('useMcp', PlugIcon, 'system', {
    chip: chip.text('tool', 'name', 'server'),
  }),
  mcp_request: spec('useMcp', PlugIcon, 'system', { chip: chip.text('server', 'method') }),
  mcp_resource: spec('useMcp', PlugIcon, 'system', { chip: chip.text('uri', 'server') }),

  // Web 取用（rpi 的 websearch/webfetch 与内核 web_search 是不同工具名）
  websearch: spec('searchWeb', GlobeIcon, 'web', {
    chip: chip.query(),
    body: 'webSearch',
  }),
  webfetch: spec('readWebpage', GlobeIcon, 'web', { chip: chip.url() }),

  // 计划模式（rpi-plan-mode）：进入 / 完成两个工具
  plan_mode_start: spec('startPlanMode', LightbulbIcon, 'plan', {
    chip: chip.text('goal', 'objective', 'task'),
  }),
  plan_mode_complete: spec('finishPlan', ListChecksIcon, 'plan', { body: 'plan' }),

  // 其它插件面
  goal: spec('useGoal', TargetIcon, 'plan', { chip: chip.text('goal', 'objective', 'task') }),
  code_lens: spec('useCodeLens', CodeIcon, 'code', { chip: chip.text('query', 'symbol') }),
  codemode: spec('runCode', CodeIcon, 'code', { chip: chip.text('code', 'expression') }),
  permissions: spec('usePermissions', ShieldCheckIcon, 'system', {
    chip: chip.text('action', 'path', 'tool'),
  }),
  im_message_server: spec('useMessaging', MessageSquareIcon, 'system', {
    chip: chip.text('action', 'channel'),
  }),
  rpc_server: spec('useRpc', PlugIcon, 'system', { chip: chip.text('action', 'name') }),
  rpc_client: spec('useRpc', PlugIcon, 'system', { chip: chip.text('server', 'method') }),
}

/**
 * 按参数分叉的工具（pi 的 `jobs`/`hub` 子动作、CRUD 家族）。
 * key 形如 `工具名:动作`。
 */
export const ACTION_TOOL_SPECS: Record<string, ToolSpec> = {
  'jobs:list': spec('useJob', SquareTerminalIcon, 'system', { body: 'job' }),
  'jobs:wait': spec('useJob', SquareTerminalIcon, 'system', { body: 'job' }),
  'jobs:cancel': spec('useJob', SquareTerminalIcon, 'system', { body: 'job' }),
  'hub:agent': spec('runAgent', BotIcon, 'agent', { body: 'agent' }),
  'hub:jobs': spec('useJob', SquareTerminalIcon, 'system', { body: 'job' }),
  'hub:start': spec('runService', TerminalIcon, 'system'),
  'hub:stop': spec('runService', TerminalIcon, 'system'),
  'hub:ps': spec('runService', TerminalIcon, 'system'),
  'hub:logs': spec('runService', TerminalIcon, 'system'),
}

/** 前缀家族（pi 的 `ast_*` 已精确列出，这里留给将来扩展工具）。 */
export const FAMILY_TOOL_SPECS: Record<string, ToolSpec> = {
  ast_: spec('searchCode', CodeIcon, 'code'),
  lsp_: spec('searchCode', CodeIcon, 'code'),
  // rpi-langfuse 的观测工具（langfuse_trace / langfuse_score / …）
  langfuse_: spec('useLangfuse', ActivityIcon, 'system'),
}

/** 从 args 取动作字符串（`hub { action: "agent" }`）。 */
export function actionOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const a = (args as ToolArgs).action ?? (args as ToolArgs).op
  return typeof a === 'string' && a.trim() ? a.trim().toLowerCase() : undefined
}
