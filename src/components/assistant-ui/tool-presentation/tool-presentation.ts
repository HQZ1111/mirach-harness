/**
 * pi 工具调用 → 呈现（图标 / 短语 / chip / 富内容体）。
 *
 * 移植自 openhuman `features/conversations/tools/toolPresentation.ts`
 * （2026-10-17），解析顺序与语义保持一致，**去掉了 openhuman 专有的
 * composio / subagent 前缀 / serverLabel 分支**（pi 没有这些概念）。
 *
 * 解析顺序（首个命中的赢）：
 * 1. 参数分叉：`工具名:动作`（`hub:agent` / `jobs:list`）
 * 2. 精确表 `EXACT_TOOL_SPECS`（pi 的 46 个内核工具）
 * 3. 前缀家族 `FAMILY_TOOL_SPECS`（`ast_` / `lsp_`）
 * 4. 兜底：扳手图标 + "Used <工具名>"
 *
 * 纯函数、同步——可安全用于渲染与单测。
 */
import type { LucideIcon } from 'lucide-react'

import { chip as chipRules, genericChip, truncateChip, type ToolArgs } from './tool-chips'
import { TOOL_PHRASES, type ToolPhraseId, type ToolPhraseTense } from './tool-phrases'
import {
  ACTION_TOOL_SPECS,
  EXACT_TOOL_SPECS,
  FALLBACK_ICON,
  FAMILY_TOOL_SPECS,
  actionOf,
  type ToolBodyKind,
  type ToolCategory,
  type ToolSpec,
} from './tool-specs'

export type { ToolBodyKind, ToolCategory } from './tool-specs'

/** 与 TurnPart 的 tool-call 状态对齐（running = 无 result）。 */
export type ToolCallStatus = 'running' | 'success' | 'error'

export type ToolPresentationSource = 'action' | 'exact' | 'family' | 'fallback'

export interface DescribeToolCallInput {
  /** 工具名（pi 注册表名，如 `read` / `hub`）。 */
  name: string
  /** 解析后的参数对象（pi 的 ToolCall.args）。 */
  args?: unknown
  status?: ToolCallStatus
}

export interface ToolCallPresentation {
  /** 工具名（原样）。 */
  name: string
  /** 图标组件（lucide）。 */
  icon: LucideIcon
  category: ToolCategory
  /** 目标 chip 文本（已清洗/截断；无则 undefined）。 */
  chip: string | undefined
  /** 富内容体形态（详情面板用）。 */
  body: ToolBodyKind | undefined
  /** 短语 id（i18n 键用）。 */
  phrase: ToolPhraseId
  /** 当前时态文案（en；中文由 `toolLabelZh` 提供）。 */
  label: string
  source: ToolPresentationSource
}

const asArgs = (args: unknown): ToolArgs =>
  typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as ToolArgs)
    : {}

/** 兜底：把 `some_tool_name` 变成 "Some tool name"，绝不显示裸 snake_case。 */
function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function resolveSpec(
  name: string,
  args: ToolArgs,
): { spec: ToolSpec; source: ToolPresentationSource } | null {
  // 1. 参数分叉
  const action = actionOf(args)
  if (action !== undefined) {
    const keyed = ACTION_TOOL_SPECS[`${name}:${action}`]
    if (keyed) return { spec: keyed, source: 'action' }
  }
  // 2. 精确表
  const exact = EXACT_TOOL_SPECS[name]
  if (exact) return { spec: exact, source: 'exact' }
  // 3. 前缀家族
  for (const [prefix, spec] of Object.entries(FAMILY_TOOL_SPECS)) {
    if (name.startsWith(prefix)) return { spec, source: 'family' }
  }
  return null
}

/**
 * 描述一次工具调用。未知工具返回兜底（不抛错——pi 允许扩展新增工具）。
 */
export function describeToolCall(input: DescribeToolCallInput): ToolCallPresentation {
  const args = asArgs(input.args)
  const resolved = resolveSpec(input.name, args)
  const tense: ToolPhraseTense =
    input.status === 'running' || input.status === undefined ? 'active' : 'done'

  if (resolved === null) {
    return {
      name: input.name,
      icon: FALLBACK_ICON,
      category: 'system',
      chip: genericChip(args),
      body: undefined,
      phrase: 'runCommand',
      label: `${tense === 'active' ? 'Using' : 'Used'} ${humanize(input.name)}`,
      source: 'fallback',
    }
  }

  const { spec, source } = resolved
  const chip = spec.chip ? spec.chip(args) : undefined
  const phraseEntry = TOOL_PHRASES[spec.phrase]
  return {
    name: input.name,
    icon: spec.icon,
    category: spec.category,
    chip: chip === undefined ? undefined : truncateChip(chip),
    body: spec.body,
    phrase: spec.phrase,
    label: phraseEntry[tense],
    source,
  }
}

/** 短语的中文文案（en 为源；zh 缺失时回落英文）。 */
const ZH: Partial<Record<ToolPhraseId, string>> = {
  readFile: '读取文件',
  writeFile: '写入文件',
  editFile: '编辑文件',
  applyEdits: '应用编辑',
  searchCode: '搜索代码',
  findFiles: '查找文件',
  listFolder: '列出目录',
  runCommand: '运行命令',
  updateTodos: '更新待办',
  submitPlan: '提交计划',
  runAgent: '运行子代理',
  useHub: '使用代理中枢',
  useJob: '使用后台任务',
  useGithub: '使用 GitHub',
  readImage: '读取图片',
  readMedia: '读取媒体',
  generateImage: '生成图片',
  speak: '合成语音',
  useComputer: '控制电脑',
  useBrowser: '使用浏览器',
  runSecurityScan: '安全扫描',
  runEval: '运行代码',
  readTime: '查看时间',
  askUser: '向你提问',
  runService: '管理服务',
  searchWeb: '搜索网页',
  askQuestion: '提问',
  runDebugger: '调试',
}

/** 中文短语（active/done 同形——中文动词无时态变化，用「正在」前缀区分）。 */
export function toolLabelZh(phrase: ToolPhraseId, running: boolean): string {
  const base = ZH[phrase]
  if (base === undefined) {
    const en = TOOL_PHRASES[phrase]
    return running ? en.active : en.done
  }
  return running ? `正在${base}` : base
}
