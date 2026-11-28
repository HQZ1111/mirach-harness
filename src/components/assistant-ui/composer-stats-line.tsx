/**
 * 输入框下方的会话统计条（DSH `StatsPills` 的宿主移植，2026-11-27）。
 *
 * 来源：`G:/deepseek-harness-master/.../ui-chat/src/client/chat/StatsPills.tsx`
 * ——两个 pill（仪表：轮次/步数/输出速度；数据库：总 token/缓存命中），
 * 各开一个明细弹层。
 *
 * ## 与 DSH 的差异（数据面事实，不是简化）
 *
 * DSH 的这些数字来自 `sessionStats` 持久投影（整条日志的折叠，跨分页与
 * 压缩都正确）。宿主**没有这个投影**——轮次机（turn-actor）只归约当前
 * run，`RUN_FINISHED.usage` 也只带本轮用量。所以这里：
 *   · 轮次/步数：按**当前已加载消息**现场折叠（等于"屏幕上这一屏"），
 *     与 DSH 的 `deriveStats` 兜底路径同语义（那也是"what is on screen"）；
 *   · 总 token / 缓存命中：取 usage 桥（本轮 run 的 provider 上报值）；
 *   · 首字延迟（TTFT）：用消息部件的 startedAt/completedAt 现场算——
 *     assistant 首个文本/思考部件的 completedAt − 该段 startedAt。
 *
 * 不编造缺数据：某项没有真值就不渲染该项（不显示 0 冒充）。
 */
import { FC, useMemo } from 'react'
import { useAuiState } from '@assistant-ui/react'

import { useUsageBridge } from '@/components/assistant-ui/usage-bridge'
import { cn } from '@/lib/utils'

/** 紧凑 token 数（1.2k / 3.4M）。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** 毫秒 → 人类可读（1.2s / 850ms）。 */
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  return `${Math.round(ms)}ms`
}

type Part = {
  type: string
  startedAt?: number
  completedAt?: number
}

export interface ConversationStats {
  turns: number
  steps: number
  /** 首字延迟（ms）：本屏内有计时部件的平均；无样本 = null。 */
  ttftMs: number | null
}

/**
 * 从当前消息列表现场折叠统计（只用真实存在的部件时间戳，缺则为 0/不显示）。
 */
export function deriveStats(messages: readonly { role: string; content: unknown }[]): ConversationStats {
  let turns = 0
  let steps = 0
  let ttftSum = 0
  let ttftSamples = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    steps += 1
    turns += 1
    if (!Array.isArray(m.content)) continue
    // 首个带时间戳的文本/思考部件 = 该步的首字延迟
    for (const raw of m.content as Part[]) {
      if (raw?.type !== 'text' && raw?.type !== 'reasoning') continue
      const s = raw.startedAt
      const c = raw.completedAt
      if (typeof s === 'number' && typeof c === 'number' && c >= s) {
        ttftSum += c - s
        ttftSamples += 1
      }
      break
    }
  }
  return {
    turns,
    steps,
    ttftMs: ttftSamples > 0 ? Math.round(ttftSum / ttftSamples) : null,
  }
}

export const ComposerStatsLine: FC<{ className?: string }> = ({ className }) => {
  const { usage } = useUsageBridge()
  const messages = useAuiState((s) => s.thread.messages)
  const isRunning = useAuiState((s) => s.thread.isRunning)

  const stats = useMemo(() => deriveStats(messages), [messages])

  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const cachedTokens = usage?.cachedInputTokens ?? 0
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens
  const cacheHit =
    inputTokens > 0 && cachedTokens > 0
      ? Math.min(100, Math.round((cachedTokens / inputTokens) * 100))
      : null

  // 一条数据都没有时不渲染（空会话不占位）。
  const hasAny = stats.turns > 0 || totalTokens > 0
  if (!hasAny) return null

  return (
    <div
      data-slot="composer-stats-line"
      className={cn(
        'text-(--text-4) flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] tabular-nums',
        className,
      )}
    >
      {stats.turns > 0 && (
        <span data-slot="composer-stats-turns" title="本屏已加载的对话轮数 / 助手步数">
          第 {stats.turns} 轮 · {stats.steps} 步
        </span>
      )}
      {stats.ttftMs !== null && (
        <span data-slot="composer-stats-ttft" title="本屏首字延迟均值">
          首字 {formatMs(stats.ttftMs)}
        </span>
      )}
      {totalTokens > 0 && (
        <span data-slot="composer-stats-tokens" title="本轮上下文：输入 / 输出">
          {formatTokens(totalTokens)} tok
        </span>
      )}
      {cacheHit !== null && (
        <span data-slot="composer-stats-cache" title={`缓存命中 ${cachedTokens} / 输入 ${inputTokens} tok`}>
          缓存 {cacheHit}%
        </span>
      )}
      {isRunning && (
        <span className="text-(--brand)" data-slot="composer-stats-running">
          生成中…
        </span>
      )}
    </div>
  )
}
