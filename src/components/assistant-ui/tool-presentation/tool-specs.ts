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
  ImageIcon,
  ListChecksIcon,
  ListTodoIcon,
  MonitorIcon,
  PlugIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareTerminalIcon,
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
}

/** 从 args 取动作字符串（`hub { action: "agent" }`）。 */
export function actionOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const a = (args as ToolArgs).action ?? (args as ToolArgs).op
  return typeof a === 'string' && a.trim() ? a.trim().toLowerCase() : undefined
}
