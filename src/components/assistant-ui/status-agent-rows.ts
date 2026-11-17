/**
 * 活动面板「智能体」分区的宿主派生面（纯函数，无 DOM/React——可单测）。
 *
 * rpi 的子代理（rpi-subagents / rpi-orchestrator）运行态只在插件进程内存
 * （`pi_hub_roster` 已如实 Err）；唯一真值 = 本线程里的工具调用：
 * - 运行中 = 工具调用未完成（timing.completedAt 缺席）；
 * - 已结束 = 有完成时间（目录行计数；上游 `endedSubagentCount` 对偶）。
 *
 * 工具名三套：rpi-subagents 的 `delegate_task`，rpi-orchestrator 的
 * `subagent` / `dispatch`（tool-presentation 同判定）。
 */
import { parseDelegationResult } from './elements/delegation-card'
import type { SubagentDetailPayload } from '@/components/panes/subagent-detail-opener'

export const AGENT_TOOL_NAMES = new Set(['delegate_task', 'subagent', 'dispatch'])

export interface DerivedAgentRow {
  id: string
  title: string
  startedAt: number | null
}

export interface EndedAgentRow extends DerivedAgentRow {
  completedAt: number | null
  status: string | null
  payload: SubagentDetailPayload
}

/** ToolOutput（`{content: blocks}`）/ 字符串 → 文本；其余形状 → null。 */
export function toolOutputText(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return null
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  return content
    .map((b) =>
      typeof b === 'string'
        ? b
        : typeof (b as { text?: unknown })?.text === 'string'
          ? (b as { text: string }).text
          : '',
    )
    .join('')
}

/**
 * 从线程消息派生智能体行（输入形状 = assistant-ui ThreadMessageState 的
 * 最小结构：`{role, content: [{type:'tool-call', toolName, toolCallId,
 * args, result, timing}]}`）。
 */
export function deriveAgentRows(messages: readonly unknown[]): {
  running: DerivedAgentRow[]
  ended: EndedAgentRow[]
} {
  const running: DerivedAgentRow[] = []
  const ended: EndedAgentRow[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const role = (message as { role?: unknown }).role
    if (role !== 'assistant') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const p = part as Record<string, unknown>
      if (p.type !== 'tool-call') continue
      const toolName = typeof p.toolName === 'string' ? p.toolName : ''
      if (!AGENT_TOOL_NAMES.has(toolName)) continue
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : ''
      if (toolCallId === '') continue
      const args = (p.args ?? {}) as Record<string, unknown>
      const parsed = parseDelegationResult(p.result)
      const title =
        parsed?.task ??
        (typeof args.task === 'string' && args.task !== '' ? args.task : null) ??
        (typeof args.agent === 'string' && args.agent !== '' ? args.agent : null) ??
        parsed?.role ??
        '子代理'
      const timing = p.timing as { startedAt?: number; completedAt?: number } | undefined
      const startedAt = typeof timing?.startedAt === 'number' ? timing.startedAt : null
      const completedAt = typeof timing?.completedAt === 'number' ? timing.completedAt : null
      const output = toolOutputText(p.result) ?? undefined
      const payload: SubagentDetailPayload = {
        title: '子代理详情',
        name: typeof args.agent === 'string' && args.agent !== '' ? args.agent : '子代理',
        role: parsed?.role ?? undefined,
        task: parsed?.task ?? (typeof args.task === 'string' ? args.task : undefined),
        status: parsed?.status ?? (completedAt !== null ? 'completed' : 'running'),
        running: completedAt === null,
        report: parsed?.report ?? undefined,
        output,
        turns: parsed?.turns,
        maxTurns: parsed?.maxTurns,
        turnLimited: parsed?.turnLimited,
        timeoutSeconds: parsed?.timeoutSeconds,
        childId: parsed?.childId ?? null,
        sessionId: parsed?.sessionId ?? null,
      }
      if (completedAt === null) {
        running.push({ id: toolCallId, title, startedAt })
      } else {
        ended.push({
          id: toolCallId,
          title,
          startedAt,
          completedAt,
          status: parsed?.status ?? null,
          payload,
        })
      }
    }
  }
  // 目录按完成时间倒序（最新在前，与上游目录页同序）。
  ended.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  return { running, ended }
}
