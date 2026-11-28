/**
 * 输入框下方的会话统计条（DSH `StatsPills` 的宿主移植，2026-11-28 补完整）。
 *
 * 来源：`G:/deepseek-harness-master/packages/client/ui-chat/src/client/chat/
 * StatsPills.tsx`——DSH 是**两个 pill**：仪表（轮次/步数/输出速度 → 时间与
 * 速度明细弹层）+ 数据库（总 token/缓存命中 → token 明细弹层）。本文件与
 * 该形状对齐。
 *
 * ## 数据源（2026-11-28 补齐）
 *
 * DSH 的会话统计来自 `sessionStats` 持久投影（整条日志折叠，跨分页/压缩
 * 都正确）。宿主现在有对偶了：**`pi_session_stats`（Rust 折叠整条 JSONL）**
 * ——usage 本来就逐条落盘（每步 assistant 条目带 `usage.input/output/
 * cacheRead/cacheWrite/reasoning`），所以轮次/步数/工具数/token/首字延迟/
 * 墙钟都能给**整会话**口径，不再停在"屏幕这一屏"。
 *
 * 展示优先级与降级（都不编造）：
 *   · 优先 = 投影（持久口径）；投影缺席（无会话/读取失败）→ 屏幕折叠
 *     （DSH deriveStats 兜底语义）并如实标注口径；
 *   · 输出速度始终是**本轮 run** 的速度（输出 token ÷ 本轮用时）——投影里
 *     没有逐 run 时长，标注清楚，不冒充整会话平均；
 *   · 某项没有真值就不渲染该项（不显示 0 冒充）。
 */
import { FC, useEffect, useMemo, useState, type ReactNode } from 'react'
import { GaugeIcon, DatabaseIcon } from 'lucide-react'
import { useAuiState } from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from 'zustand'

import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import { useUsageBridge } from '@/components/assistant-ui/usage-bridge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/motion/popover'
import { cn } from '@/lib/utils'

/** `pi_session_stats` 的 wire 形状（Rust `session_stats_projection`）。 */
export interface SessionStatsProjection {
  path: string
  turns: number
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costTotal: number
  ttftMs: number | null
  wallMs: number | null
}

/** 紧凑 token 数（1.2k / 3.4M）。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** 毫秒 → 人类可读（1.2s / 850ms / 2m42s）。 */
function formatMs(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1000)
    return `${m}m${s}s`
  }
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
  /** 工具耗时合计（ms）：tool-call 部件 startedAt→completedAt；无样本 = null。 */
  toolMs: number | null
  /** 最后一条 assistant 段的 run 用时（ms，createdAt→completedAt）；未定稿 = null。 */
  runWallMs: number | null
}

/**
 * 从当前消息列表现场折叠统计（只用真实存在的部件时间戳，缺则为 0/不显示）。
 */
export function deriveStats(
  messages: readonly {
    role: string
    content: unknown
    createdAt?: unknown
    completedAt?: unknown
  }[],
): ConversationStats {
  let turns = 0
  let steps = 0
  let ttftSum = 0
  let ttftSamples = 0
  let toolSum = 0
  let toolSamples = 0
  let runWallMs: number | null = null
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    steps += 1
    turns += 1
    const msg = m
    if (msg.createdAt instanceof Date && typeof msg.completedAt === 'number') {
      runWallMs = Math.max(0, msg.completedAt - msg.createdAt.getTime())
    }
    if (!Array.isArray(m.content)) continue
    // 首个带时间戳的文本/思考部件 = 该步的首字延迟
    for (const raw of m.content as Part[]) {
      if (raw?.type === 'tool-call') {
        if (typeof raw.startedAt === 'number' && typeof raw.completedAt === 'number') {
          toolSum += Math.max(0, raw.completedAt - raw.startedAt)
          toolSamples += 1
        }
        continue
      }
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
    toolMs: toolSamples > 0 ? Math.round(toolSum) : null,
    runWallMs,
  }
}

/** 明细弹层的一行（label 左、值右、等宽数字）。 */
const StatRow: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-6 text-[12px]">
    <span className="text-(--text-3)">{label}</span>
    <span className="text-(--text-1) font-mono tabular-nums">{value}</span>
  </div>
)

/** 一个统计 pill：图标+摘要，点击开明细弹层（DSH 两 pill 的形状）。 */
const StatPill: FC<{
  icon: ReactNode
  summary: ReactNode
  title: string
  children: ReactNode
}> = ({ icon, summary, title, children }) => {
  const [open, setOpen] = useState(false)
  return (
    <Popover align="start" onOpenChange={setOpen} open={open} side="top" sideOffset={8}>
      <PopoverTrigger>
        <button
          type="button"
          title={title}
          data-slot="composer-stats-pill"
          className="text-(--text-4) hover:bg-(--hover-wash) hover:text-(--text-2) flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] tabular-nums transition-colors"
        >
          {icon}
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent className="min-w-52 p-3">
        <div className="flex flex-col gap-1.5">{children}</div>
      </PopoverContent>
    </Popover>
  )
}

export const ComposerStatsLine: FC<{ className?: string }> = ({ className }) => {
  const { usage } = useUsageBridge()
  const messages = useAuiState((s) => s.thread.messages)
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const activeId = useStore(sessionCatalog, (s) => s.activeId)
  const [projection, setProjection] = useState<SessionStatsProjection | null>(null)

  // 持久投影拉取：会话变化 / 消息数变化 / run 收尾都重拉（Rust 侧 stat 缓存，
  // append-only 文件不变即复用）。失败 = console 可见并退回屏幕口径（不编造）。
  const messageCount = messages.length
  useEffect(() => {
    let cancelled = false
    const path = activeId ? sessionCatalog.getState().entries[activeId]?.path : undefined
    if (activeId && !path) {
      // 目录还没就绪（行缺 path）：等下一次 catalog/messages 变化再拉。
      setProjection(null)
      return
    }
    invoke<SessionStatsProjection | null>('pi_session_stats', path ? { path } : {})
      .then((value) => {
        if (!cancelled) setProjection(value ?? null)
      })
      .catch((e) => {
        if (cancelled) return
        setProjection(null)
        console.error('[stats] 会话统计投影读取失败——退回屏幕折叠口径', e)
      })
    return () => {
      cancelled = true
    }
  }, [activeId, messageCount, isRunning])

  const screen = useMemo(() => deriveStats(messages), [messages])

  // 投影优先（整会话持久口径）；缺席退回屏幕折叠（DSH deriveStats 兜底）。
  const turns = projection?.turns ?? screen.turns
  const steps = projection?.steps ?? screen.steps
  const inputTokens = projection?.inputTokens ?? usage?.inputTokens ?? 0
  const outputTokens = projection?.outputTokens ?? usage?.outputTokens ?? 0
  const cachedTokens = projection?.cachedTokens ?? usage?.cachedInputTokens ?? 0
  const totalTokens = projection
    ? projection.totalTokens
    : (usage?.totalTokens ?? inputTokens + outputTokens)
  const cacheHit =
    inputTokens > 0 && cachedTokens > 0
      ? Math.min(100, Math.round((cachedTokens / inputTokens) * 100))
      : null
  // 输出速度（tok/s）：**本轮 run** 同口径——本轮输出 token ÷ 本轮用时
  // （投影没有逐 run 时长，整会话平均不在这里冒充）。
  const tps =
    outputTokens > 0 && screen.runWallMs !== null && screen.runWallMs > 0
      ? Math.round((outputTokens / screen.runWallMs) * 1000)
      : null
  const ttftMs = projection?.ttftMs ?? screen.ttftMs

  // 一条数据都没有时不渲染（空会话不占位）。
  const hasAny = turns > 0 || totalTokens > 0
  if (!hasAny) return null

  return (
    <div
      data-slot="composer-stats-line"
      className={cn(
        'text-(--text-4) flex flex-wrap items-center gap-2 px-1 text-[11px] tabular-nums',
        className,
      )}
    >
      {turns > 0 && (
        <StatPill
          icon={<GaugeIcon className="size-[var(--size-icon-sm)]" />}
          summary={
            <span data-slot="composer-stats-turns">
              第 {turns} 轮 · {steps} 步{tps !== null ? ` · ${tps} tok/s` : ''}
            </span>
          }
          title="时间与速度（点击看明细）"
        >
          <StatRow label="轮次 / 步数" value={`${turns} / ${steps}`} />
          {projection && projection.toolCalls > 0 && (
            <StatRow label="工具调用" value={projection.toolCalls} />
          )}
          {ttftMs !== null && <StatRow label="首字延迟（均）" value={formatMs(ttftMs)} />}
          {projection?.wallMs != null && projection.wallMs > 0 && (
            <StatRow label="会话跨度" value={formatMs(projection.wallMs)} />
          )}
          {!projection && screen.toolMs !== null && (
            <StatRow label="工具耗时合计" value={formatMs(screen.toolMs)} />
          )}
          {screen.runWallMs !== null && <StatRow label="本轮用时" value={formatMs(screen.runWallMs)} />}
          {tps !== null && <StatRow label="输出速度（本轮）" value={`${tps} tok/s`} />}
          <p className="text-(--text-4) mt-1 text-[10.5px] leading-snug">
            {projection
              ? '口径：会话日志全量投影（pi_session_stats——轮次/步数/工具数/token/首字延迟跨分页与压缩累计）。'
              : '口径：屏幕已加载的这一屏（DSH deriveStats 兜底；统计投影暂不可读）。'}
          </p>
        </StatPill>
      )}
      {totalTokens > 0 && (
        <StatPill
          icon={<DatabaseIcon className="size-[var(--size-icon-sm)]" />}
          summary={
            <span data-slot="composer-stats-tokens">
              {formatTokens(totalTokens)} tok{cacheHit !== null ? ` · 缓存 ${cacheHit}%` : ''}
            </span>
          }
          title="Token 用量（点击看明细）"
        >
          <StatRow label="输入" value={formatTokens(inputTokens)} />
          {cachedTokens > 0 && <StatRow label="缓存命中" value={formatTokens(cachedTokens)} />}
          {projection && projection.cacheWriteTokens > 0 && (
            <StatRow label="缓存写入" value={formatTokens(projection.cacheWriteTokens)} />
          )}
          <StatRow label="输出" value={formatTokens(outputTokens)} />
          {projection && projection.reasoningTokens > 0 && (
            <StatRow label="推理" value={formatTokens(projection.reasoningTokens)} />
          )}
          <StatRow label="合计" value={formatTokens(totalTokens)} />
          {cacheHit !== null && <StatRow label="命中率" value={`${cacheHit}%`} />}
          {projection && projection.costTotal > 0 && (
            <StatRow label="成本" value={`$${projection.costTotal.toFixed(4)}`} />
          )}
          <p className="text-(--text-4) mt-1 text-[10.5px] leading-snug">
            {projection
              ? '口径：会话日志里逐步 provider 上报的 usage 累计（pi_session_stats）。'
              : '口径：provider 上报的本轮 run 用量（usage 桥）。'}
          </p>
        </StatPill>
      )}
      {isRunning && (
        <span className="text-(--brand)" data-slot="composer-stats-running">
          生成中…
        </span>
      )}
    </div>
  )
}
