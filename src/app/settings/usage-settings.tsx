/**
 * 用量页 —— ZCode「设置 → 用量」的 App Usage tab 移植（2026-10-26）。
 *
 * 用户："用量移植 zcode 里设置页的用量"。
 *
 * ## 移植范围（ZCode 两个 tab，只有一个是本地数据）
 *
 * | tab | 上游数据来源 | 本页 |
 * |---|---|---|
 * | **App Usage** | 本地 session 聚合（`source: "local"`） | ✅ 完整移植：概览条 + 52 周热力图 + 按天趋势 + 按模型占比 + 刷新 |
 * | Coding Plan | 云端 monitor API（订阅额度 / 重置时间 / 权益） | ❌ 不移植：宿主没有订阅账户与那个端点。页面底部如实说明，**不渲染 0 冒充**（规矩 12） |
 *
 * ## 结构对照（ZCode `usage-stats/AppUsagePanel.tsx`）
 *
 * ```
 * AppUsageLifetimeSummaryStrip   5 格：总 tokens / 单日峰值 / 最长会话 / 当前连续 / 最长连续
 * UsageHeatmap                   52 周 × 7 天热力图（日 / 周 / 累计三态）
 * AppUsageRangeTabs              7天 / 30天 / 全部
 * AppUsageDailyModelTrendChart   按天趋势（上游用 recharts；宿主用内联 SVG 多模型折线）
 * AppUsageModelUsagePieChart     按模型占比（上游用 recharts；宿主用堆叠条 + 列表）
 * 刷新钮                         重拉快照
 * ```
 *
 * ## 与上游的差异（都是宿主事实）
 *
 * · **图表库**：上游用 recharts（含 decimal.js-light 的启动期副作用，ZCode 自己
 *   也要 lazy 隔离）。宿主不引新依赖——趋势图用内联 SVG 折线，占比用横向
 *   堆叠条。数据形状与配色梯度照上游（`appUsageChartPalette.ts` 的 6 色）。
 * · **不可得字段**：`avgTimeToFirstTokenMs` / `avgTurnDurationMs` /
 *   `toolErrorRate` / `modelErrorRate` 在 pi stats 里没有记录——后端返回 null，
 *   这里据此隐藏对应格子（不是显示 0）。
 * · **「最长会话」**：pi stats 不记会话时长 → 后端按会话首末消息时间戳差值
 *   真实计算；无时间戳的旧文件不计入。
 * · 文案硬编码中文（宿主设置页无 i18n 运行时）。
 */

import { RefreshCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { invoke } from '@tauri-apps/api/core'

import { inTauri } from '@/lib/tauri-window'

// ── 形状（对齐 ZCode AppUsageSnapshot 的子集）─────────────────────────

type UsageRange = 'all' | '7d' | '30d'

const RANGES: readonly { id: UsageRange; label: string }[] = [
  { id: '7d', label: '近 7 日' },
  { id: '30d', label: '近 30 日' },
]

interface UsageSummary {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  totalSessions: number
  totalTurns: number
  toolCallCount: number
  activeDays: number
  currentStreakDays: number
  longestStreakDays: number
  peakDayTokens: number
  favoriteModel: { modelId: string; totalTokens: number; share: number } | null
  /** 单会话首末消息时间差的最大值（毫秒，0 = 无可用时间戳）。 */
  longestSessionMs: number
  avgTimeToFirstTokenMs: number | null
  avgTurnDurationMs: number | null
  toolErrorRate: number | null
  modelErrorRate: number | null
}

interface HeatmapCell {
  date: string
  level: 0 | 1 | 2 | 3 | 4
  totalTokens: number
  turnCount: number
  toolCallCount: number
}

interface HeatmapWeek {
  weekIndex: number
  days: HeatmapCell[]
}

interface ModelUsage {
  modelId: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  requestCount: number
}

interface DailyUsage {
  date: string
  totalTokens: number
  turnCount: number
  /** 当天各模型用量（ZCode dailyModelUsage 的宿主等价物）。 */
  models: { modelId: string; totalTokens: number }[]
}

interface UsageSnapshot {
  range: UsageRange
  generatedAt: number
  source: string
  summary: UsageSummary
  heatmap: { maxTokens: number; weeks: HeatmapWeek[] }
  models: ModelUsage[]
  daily: DailyUsage[]
  costUsd: number
}

// ── 格式化（ZCode usageStatsUiParts 的对应物）─────────────────────────

/** 紧凑 token 数：1.2M / 34.5K / 812（ZCode formatSummaryCompactTokenUsage）。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '--'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '--'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`
}

/** ZCode formatAppUsageDuration：天 / 小时 / 分钟（0 分钟也显示）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--'
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`)
  return parts.join(' ')
}

function formatDate(iso: string): string {
  // "2026-10-26" → "2026/10/26"（避免 new Date 的时区偏移）
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${y}/${m}/${d}` : iso
}

// ── 概览条（上游 AppUsageLifetimeSummaryStrip）────────────────────────

function SummaryStrip({ summary }: { summary: UsageSummary | null }) {
  const items: { label: string; value: string; title?: string }[] = [
    {
      label: '累计 Token 数',
      value: summary ? formatTokens(summary.totalTokens) : '--',
    },
    {
      label: '峰值 Token 数',
      value: summary ? formatTokens(summary.peakDayTokens) : '--',
    },
    {
      label: '最长聊天时长',
      value: summary ? formatDuration(summary.longestSessionMs) : '--',
      title: '按会话首末消息时间戳计算（不记录时长的旧会话不计入）',
    },
    {
      label: '当前连续天数',
      value: summary ? `${summary.currentStreakDays} 天` : '--',
    },
    {
      label: '最长连续天数',
      value: summary ? `${summary.longestStreakDays} 天` : '--',
    },
  ]

  return (
    <section className="set-usage-strip">
      {items.map((item, index) => (
        <div className="set-usage-strip-cell-wrap" key={item.label}>
          {index > 0 && <div aria-hidden className="set-usage-strip-divider" />}
          <div className="set-usage-strip-cell" title={item.title}>
            <div className="set-usage-strip-value">{item.value}</div>
            <div className="set-usage-strip-label">{item.label}</div>
          </div>
        </div>
      ))}
    </section>
  )
}

// ── 热力图（上游 UsageHeatmap：日 / 周 / 累计三态）────────────────────

type HeatmapMode = 'daily' | 'weekly' | 'cumulative'

const HEATMAP_MODES: readonly { id: HeatmapMode; label: string }[] = [
  { id: 'daily', label: '每日' },
  { id: 'weekly', label: '每周' },
  { id: 'cumulative', label: '累计' },
]

const MONTH_NAMES = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
]

function levelForValue(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 0 | 1 | 2 | 3 | 4
}

/** ZCode filledRowsForValue：周/累计模式点亮该列底部 N 格（不是整列同色）。 */
function filledRowsForValue(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(7, Math.max(1, Math.ceil((value / max) * 7)))
}

function Heatmap({ weeks, mode }: { weeks: HeatmapWeek[]; mode: HeatmapMode }) {
  const [hovered, setHovered] = useState<{
    x: number
    y: number
    title: string
  } | null>(null)
  const columns = useMemo(() => {
    if (mode === 'daily') {
      return weeks.map((week) => ({
        key: `d-${week.weekIndex}`,
        cells: week.days.map((cell) => ({
          key: cell.date,
          level: cell.level,
          hasUsage: cell.totalTokens > 0,
          title: `${formatDate(cell.date)}\n${formatTokens(cell.totalTokens)} tokens · ${cell.turnCount} 轮消息`,
        })),
        monthDate: week.days.find((d) => d.date.endsWith('-01'))?.date ?? week.days[0]?.date ?? '',
      }))
    }
    const weeklyTotals = weeks.map((week) =>
      week.days.reduce((sum, cell) => sum + cell.totalTokens, 0),
    )
    const weeklyTurns = weeks.map((week) =>
      week.days.reduce((sum, cell) => sum + cell.turnCount, 0),
    )
    const values =
      mode === 'weekly'
        ? weeklyTotals
        : weeklyTotals.reduce<number[]>((acc, total) => {
            acc.push((acc.at(-1) ?? 0) + total)
            return acc
          }, [])
    const turnValues =
      mode === 'weekly'
        ? weeklyTurns
        : weeklyTurns.reduce<number[]>((acc, turns) => {
            acc.push((acc.at(-1) ?? 0) + turns)
            return acc
          }, [])
    const max = Math.max(0, ...values)
    return weeks.map((week, index) => {
      const value = values[index] ?? 0
      const turns = turnValues[index] ?? 0
      const level = levelForValue(value, max)
      const filledRows = filledRowsForValue(value, max)
      const weekEnd = week.days[week.days.length - 1]?.date ?? ''
      const title =
        mode === 'weekly'
          ? `${formatDate(weekEnd)} 当周\n${formatTokens(value)} tokens · ${turns} 轮消息`
          : `截至 ${formatDate(weekEnd)} 当周累计\n${formatTokens(value)} tokens · ${turns} 轮消息`
      return {
        key: `${mode}-${week.weekIndex}`,
        cells: week.days.map((cell, dayOffset) => {
          const filled = dayOffset >= 7 - filledRows
          return {
            key: cell.date,
            level: filled ? level : (0 as const),
            hasUsage: filled && value > 0,
            title,
          }
        }),
        monthDate: week.days.find((d) => d.date.endsWith('-01'))?.date ?? week.days[0]?.date ?? '',
      }
    })
  }, [weeks, mode])

  // 月份标签（上游 buildHeatmapMonthLabels：连续同月合并 span，最多 12 个）
  const monthLabels = useMemo(() => {
    const labels: { key: string; label: string; span: number }[] = []
    for (const column of columns) {
      const key = column.monthDate.slice(0, 7)
      const last = labels[labels.length - 1]
      if (last?.key === key) {
        last.span += 1
      } else {
        const month = Number(column.monthDate.slice(5, 7))
        labels.push({ key, label: MONTH_NAMES[month - 1] ?? '', span: 1 })
      }
    }
    // 52 周可能横跨 13 个月：只显示最近 12 个的文字，其余留空占位
    const hidden = Math.max(0, labels.length - 12)
    for (let i = 0; i < hidden; i += 1) {
      const label = labels[i]
      if (label) label.label = ''
    }
    return labels
  }, [columns])

  const gridStyle = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }

  return (
    <div className="set-usage-heatmap" onMouseLeave={() => setHovered(null)}>
      <div className="set-usage-heatmap-grid" style={gridStyle}>
        {columns.map((column) => (
          <div
            className={`set-usage-heatmap-col${
              mode === 'daily' ? '' : ' set-usage-heatmap-col--column-hover'
            }`}
            key={column.key}
          >
            {column.cells.map((cell) => (
              <div
                className={`set-usage-heatmap-cell set-usage-heatmap-cell--l${cell.level}${
                  cell.hasUsage ? ' set-usage-heatmap-cell--filled' : ''
                }`}
                key={cell.key}
                onMouseEnter={(event) => {
                  setHovered({
                    x: event.clientX,
                    y: event.clientY,
                    title: cell.title,
                  })
                }}
              />
            ))}
          </div>
        ))}
      </div>
      {hovered !== null && (
        <div
          className="set-usage-heatmap-tooltip"
          role="tooltip"
          style={{
            left: Math.min(hovered.x + 12, window.innerWidth - 230),
            top: hovered.y + 14,
          }}
        >
          {hovered.title}
        </div>
      )}
      <div className="set-usage-heatmap-months" style={gridStyle}>
        {monthLabels.map((label) => (
          <div
            className="set-usage-heatmap-month"
            key={label.key}
            style={{ gridColumn: `span ${label.span}` }}
          >
            {label.label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 按天趋势（上游 AppUsageDailyModelTrendChart，内联 SVG 多模型折线）───────

function DailyTrend({ daily, models }: { daily: DailyUsage[]; models: ModelUsage[] }) {
  const width = 720
  const height = 180
  const padX = 24
  const padY = 12
  const [hovered, setHovered] = useState<number | null>(null)

  const geometry = useMemo(() => {
    if (daily.length === 0) return null
    // ZCode 只画 token 总量前 6 的模型；其余模型不计入曲线。
    const topModels = [...models]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 6)
    const stepX = daily.length === 1 ? 0 : (width - padX * 2) / (daily.length - 1)
    let max = 0
    for (const day of daily) {
      for (const model of day.models) {
        if (topModels.some((candidate) => candidate.modelId === model.modelId)) {
          max = Math.max(max, model.totalTokens)
        }
      }
    }
    max = Math.max(1, max)
    const series = topModels.map((model, index) => {
      const points = daily.map((day, dayIndex) => {
        const value =
          day.models.find((entry) => entry.modelId === model.modelId)?.totalTokens ?? 0
        return {
          date: day.date,
          value,
          x: padX + dayIndex * stepX,
          y: height - padY - (value / max) * (height - padY * 2),
        }
      })
      const path = points
        .map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(' ')
      return {
        modelId: model.modelId,
        color: MODEL_COLORS[index % MODEL_COLORS.length]!,
        points,
        path,
      }
    })
    return { series, max, stepX }
  }, [daily, models])

  if (geometry === null) {
    return <p className="set-persona-note">该区间没有可绘制的数据。</p>
  }

  const hoveredDay = hovered === null ? null : daily[hovered]
  const hoveredX = hovered === null ? 0 : padX + hovered * geometry.stepX
  const hoveredRows =
    hoveredDay === null
      ? []
      : geometry.series
          .map((series) => ({
            modelId: series.modelId,
            color: series.color,
            value:
              hoveredDay.models.find((entry) => entry.modelId === series.modelId)
                ?.totalTokens ?? 0,
          }))
          .filter((row) => row.value > 0)
          .sort((a, b) => b.value - a.value)
  const hoveredPercent = (hoveredX / width) * 100
  const tickIndexes = useMemo(() => {
    if (daily.length <= 1) return [0]
    const count = Math.min(6, daily.length)
    const indexes = new Set<number>()
    for (let i = 0; i < count; i += 1) {
      indexes.add(Math.round((i * (daily.length - 1)) / (count - 1)))
    }
    return [...indexes].sort((a, b) => a - b)
  }, [daily.length])

  return (
    <div className="set-usage-trend">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
        {geometry.series.map((model) => (
          <div className="flex min-w-0 items-center gap-2 text-sm" key={model.modelId} role="listitem">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: model.color }}
            />
            <span className="min-w-0 truncate text-muted-foreground" title={model.modelId}>
              {model.modelId}
            </span>
          </div>
        ))}
      </div>
      <div className="set-usage-trend-chart" onMouseLeave={() => setHovered(null)}>
        <svg
          aria-label="按天 token 趋势"
          className="set-usage-trend-svg"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <line
              className="set-usage-trend-grid"
              key={fraction}
              x1={padX}
              x2={width - padX}
              y1={height - padY - fraction * (height - padY * 2)}
              y2={height - padY - fraction * (height - padY * 2)}
            />
          ))}
          {hoveredDay !== null && (
            <line
              className="set-usage-trend-cursor"
              x1={hoveredX}
              x2={hoveredX}
              y1={padY}
              y2={height - padY}
            />
          )}
          {geometry.series.map((model) => (
            <g key={model.modelId}>
              <path
                className="set-usage-trend-line"
                d={model.path}
                style={{ stroke: model.color }}
              />
              {model.points.map((point) => (
                <circle
                  cx={point.x}
                  cy={point.y}
                  fill={model.color}
                  key={`${model.modelId}:${point.date}`}
                  r={hoveredDay !== null && hoveredDay.date === point.date ? 4 : 2}
                />
              ))}
            </g>
          ))}
          {/* 每个日期一条全高透明命中带：鼠标落在图表任意位置都能出提示。 */}
          {daily.map((day, index) => {
            const half = geometry.stepX / 2
            const left = index === 0 ? 0 : padX + index * geometry.stepX - half
            const right =
              index === daily.length - 1
                ? width
                : padX + index * geometry.stepX + half
            return (
              <rect
                fill="transparent"
                height={height}
                key={day.date}
                onMouseEnter={() => setHovered(index)}
                pointerEvents="all"
                width={Math.max(0, right - left)}
                x={left}
                y={0}
              />
            )
          })}
        </svg>
        {hoveredDay !== null && (
          <div
            className="set-usage-trend-tooltip"
            role="tooltip"
            style={{
              left: `${hoveredPercent}%`,
              transform:
                hoveredPercent < 15
                  ? 'translateX(0)'
                  : hoveredPercent > 85
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            <div className="set-usage-trend-tooltip-title">
              {formatDate(hoveredDay.date)} · {formatTokens(hoveredDay.totalTokens)} tokens
            </div>
            {hoveredRows.length === 0 ? (
              <div className="set-usage-trend-tooltip-empty">当天没有模型用量</div>
            ) : (
              hoveredRows.map((row) => (
                <div className="set-usage-trend-tooltip-row" key={row.modelId}>
                  <span
                    aria-hidden
                    className="set-usage-trend-tooltip-dot"
                    style={{ background: row.color }}
                  />
                  <span className="set-usage-trend-tooltip-name" title={row.modelId}>
                    {row.modelId}
                  </span>
                  <span className="set-usage-trend-tooltip-value">
                    {formatTokens(row.value)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="set-usage-trend-axis">
        {tickIndexes.map((index) => (
          <span key={daily[index]!.date}>{formatDate(daily[index]!.date)}</span>
        ))}
      </div>
    </div>
  )
}

// ── 按模型占比（上游 AppUsageModelUsagePieChart，横向堆叠条 + 列表）───

/** ZCode `appUsageChartPalette.ts` 的 6 色（照抄，保证与上游观感一致）。 */
const MODEL_COLORS = [
  '#4F7CFF',
  '#22C3A6',
  '#F2A63B',
  '#E2607B',
  '#8B6BE0',
  '#5AA9E6',
]

function ModelShare({ models }: { models: ModelUsage[] }) {
  const total = models.reduce((sum, m) => sum + m.totalTokens, 0)
  const [hovered, setHovered] = useState<{
    key: string
    x: number
    y: number
  } | null>(null)
  if (models.length === 0 || total === 0) {
    return <p className="set-persona-note">该区间没有模型用量。</p>
  }
  const sorted = [...models].sort((a, b) => b.totalTokens - a.totalTokens)
  const top = sorted.slice(0, 6)
  const rest = sorted.slice(6)
  const restTokens = rest.reduce((sum, m) => sum + m.totalTokens, 0)
  const slices = [
    ...top.map((model, index) => ({
      key: model.modelId,
      label: model.modelId,
      tokens: model.totalTokens,
      color: MODEL_COLORS[index % MODEL_COLORS.length]!,
    })),
    ...(restTokens > 0
      ? [{ key: '__other__', label: '其他模型', tokens: restTokens, color: MODEL_COLORS[5]! }]
      : []),
  ]

  // 环形图：内径 56% / 外径 86%（ZCode PieChart 同参数）。
  const size = 200
  const center = size / 2
  const radius = 70
  const stroke = 26
  const circumference = 2 * Math.PI * radius
  const hoveredSlice =
    hovered === null ? undefined : slices.find((slice) => slice.key === hovered.key)
  let offset = 0

  return (
    <div className="grid gap-4 px-3 py-3 md:grid-cols-2">
      <div
        className="relative mx-auto h-56 w-full max-w-64 self-center"
        onMouseLeave={() => setHovered(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setHovered((current) =>
            current === null
              ? null
              : {
                  ...current,
                  x: event.clientX - rect.left,
                  y: event.clientY - rect.top,
                },
          )
        }}
      >
        <svg aria-label="模型用量环形图" className="h-full w-full" role="img" viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={center}
            cy={center}
            fill="none"
            r={radius}
            stroke="var(--stroke-soft)"
            strokeWidth={stroke}
          />
          {slices.map((slice) => {
            const length = (slice.tokens / total) * circumference
            const dash = `${Math.max(0, length - 2)} ${circumference}`
            const element = (
              <circle
                className="set-usage-donut-segment"
                cx={center}
                cy={center}
                fill="none"
                key={slice.key}
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                  setHovered({
                    key: slice.key,
                    x: event.clientX - (rect?.left ?? 0),
                    y: event.clientY - (rect?.top ?? 0),
                  })
                }}
                onMouseLeave={() => setHovered(null)}
                r={radius}
                stroke={slice.color}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeWidth={
                  hovered !== null && hovered.key === slice.key ? stroke + 3 : stroke
                }
                transform={`rotate(-90 ${center} ${center})`}
              />
            )
            offset += length
            return element
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-sm font-semibold text-foreground">{formatTokens(total)}</div>
          <div className="text-sm text-muted-foreground">tokens</div>
        </div>
        {hoveredSlice !== undefined && hovered !== null && (
          <div
            className="set-usage-donut-tooltip"
            role="tooltip"
            style={{
              left: hovered.x + (hovered.x > 130 ? -12 : 12),
              top: hovered.y > 150 ? hovered.y - 76 : hovered.y + 12,
              transform: hovered.x > 130 ? 'translateX(-100%)' : 'translateX(0)',
            }}
          >
            <div className="set-usage-donut-tooltip-title">{hoveredSlice.label}</div>
            <div className="set-usage-donut-tooltip-row">
              <span className="set-usage-donut-tooltip-value">
                {formatTokens(hoveredSlice.tokens)} tokens
              </span>
              <span className="set-usage-donut-tooltip-share">
                {formatPercent(hoveredSlice.tokens / total)}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="min-w-0 self-center">
        {slices.map((slice) => (
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-border/70 py-2 last:border-b-0"
            key={slice.key}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: slice.color }}
            />
            <span className="min-w-0 truncate font-mono text-sm text-foreground" title={slice.label}>
              {slice.label}
            </span>
            <span className="font-mono text-sm tabular-nums text-muted-foreground">
              {formatPercent(slice.tokens / total)}
            </span>
            <span className="col-start-2 min-w-0 truncate text-sm text-muted-foreground">
              {formatTokens(slice.tokens)} tokens
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 页壳（上游 AppUsagePanel）────────────────────────────────────────

export function UsageSettings() {
  const [range, setRange] = useState<UsageRange>('7d')
  const [lifetime, setLifetime] = useState<UsageSnapshot | null>(null)
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('daily')

  const load = useCallback(
    async (nextRange: UsageRange) => {
      if (!inTauri) {
        setError('浏览器直开模式：没有桌面宿主后端，用量统计不可读')
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const [life, ranged] = await Promise.all([
          invoke<UsageSnapshot>('pi_usage_snapshot', { range: 'all' }),
          invoke<UsageSnapshot>('pi_usage_snapshot', { range: nextRange }),
        ])
        setLifetime(life)
        setSnapshot(ranged)
      } catch (e) {
        // 错误即错误：不吞、不渲染空图假装成功
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void load(range)
  }, [load, range])

  const summary = lifetime?.summary ?? null

  return (
    <div className="set-usage">
      <SummaryStrip summary={summary} />

      {error !== null && (
        <div className="set-err set-err-row" role="alert">
          <span style={{ flex: '1 1 0', minWidth: 0 }}>用量统计读取失败：{error}</span>
          <button className="set-btn" disabled={loading} onClick={() => void load(range)} type="button">
            重试
          </button>
        </div>
      )}

      {/* 热力图固定用 lifetime（all）快照——上游同款：热力图永远看全年，
          不随区间 tab 变化 */}
      {lifetime !== null && lifetime.heatmap.weeks.length > 0 && (
        <section className="set-persona-card">
          <div className="set-persona-card-head">
            <div className="set-persona-card-head-text">
              <h3 className="set-persona-card-title">Token 活动</h3>
            </div>
            <div className="set-persona-card-head-right">
              <div aria-label="热力图口径" className="set-persona-seg" role="group">
                {HEATMAP_MODES.map((mode) => (
                  <button
                    aria-pressed={heatmapMode === mode.id}
                    className={
                      heatmapMode === mode.id
                        ? 'set-persona-seg-btn set-persona-seg-btn--on'
                        : 'set-persona-seg-btn'
                    }
                    key={mode.id}
                    onClick={() => setHeatmapMode(mode.id)}
                    type="button"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="set-persona-card-pad">
            <Heatmap mode={heatmapMode} weeks={lifetime.heatmap.weeks} />
          </div>
        </section>
      )}

      <div className="set-usage-range-row">
          <span className="set-usage-range-title">时间范围</span>
        <div aria-label="统计区间" className="set-persona-seg" role="group">
          {RANGES.map((option) => (
            <button
              aria-pressed={range === option.id}
              className={
                range === option.id
                  ? 'set-persona-seg-btn set-persona-seg-btn--on'
                  : 'set-persona-seg-btn'
              }
              key={option.id}
              onClick={() => setRange(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading && snapshot === null ? (
        <p className="set-persona-note">
          正在统计中 — 正在读取本地应用会话历史，可能需要一点时间。
        </p>
      ) : snapshot === null ? (
        <p className="set-persona-note">
          还没有可展示的数据 — 当前区间暂无可展示的用量数据。
        </p>
      ) : (
        <>
          <section className="set-persona-card">
            <div className="set-persona-card-head">
              <div className="set-persona-card-head-text">
                <h3 className="set-persona-card-title">每日 Token 趋势图</h3>
              </div>
            </div>
            <div className="set-persona-card-pad">
              <DailyTrend daily={snapshot.daily} models={snapshot.models} />
            </div>
          </section>

          <section className="set-persona-card">
            <div className="set-persona-card-head">
              <div className="set-persona-card-head-text">
                <h3 className="set-persona-card-title">模型用量</h3>
              </div>
            </div>
            <div className="set-persona-card-pad">
              <ModelShare models={snapshot.models} />
            </div>
          </section>
        </>
      )}

      {snapshot !== null && (
        <div className="set-usage-foot">
          <button
            className="set-btn"
            disabled={loading}
            onClick={() => void load(range)}
            type="button"
          >
            <RefreshCcw className="size-[var(--size-icon-sm)]" aria-hidden />
            刷新
          </button>
        </div>
      )}
    </div>
  )
}
