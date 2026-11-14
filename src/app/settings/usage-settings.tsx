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
 * AppUsageDailyModelTrendChart   按天趋势（上游用 recharts；宿主用内联 SVG）
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
 * · **「最长会话」**：pi stats 不记会话时长 → 该格显示 "—" 并在 title 里说明。
 * · 文案硬编码中文（宿主设置页无 i18n 运行时）。
 */

import { RefreshCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { invoke } from '@tauri-apps/api/core'

import { inTauri } from '@/lib/tauri-window'

// ── 形状（对齐 ZCode AppUsageSnapshot 的子集）─────────────────────────

type UsageRange = 'all' | '7d' | '30d'

const RANGES: readonly { id: UsageRange; label: string }[] = [
  { id: '7d', label: '7 天' },
  { id: '30d', label: '30 天' },
  { id: 'all', label: '全部' },
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

function formatDate(iso: string): string {
  // "2026-10-26" → "2026/10/26"（避免 new Date 的时区偏移）
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${y}/${m}/${d}` : iso
}

// ── 概览条（上游 AppUsageLifetimeSummaryStrip）────────────────────────

function SummaryStrip({ summary }: { summary: UsageSummary | null }) {
  const items: { label: string; value: string; title?: string }[] = [
    {
      label: '累计 Token',
      value: summary ? formatTokens(summary.totalTokens) : '--',
    },
    {
      label: '单日峰值',
      value: summary ? formatTokens(summary.peakDayTokens) : '--',
    },
    {
      label: '最长会话',
      value: '—',
      title: 'pi 的统计不记录会话时长，无法给出这一项（不编造）',
    },
    {
      label: '当前连续',
      value: summary ? `${summary.currentStreakDays} 天` : '--',
    },
    {
      label: '最长连续',
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
  { id: 'daily', label: '按天' },
  { id: 'weekly', label: '按周' },
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

function Heatmap({ weeks, mode }: { weeks: HeatmapWeek[]; mode: HeatmapMode }) {
  // 按周/累计：整列按该周总量着色（上游 filledRowsForValue 的简化：
  // 上游把一列的下 N 格点亮，这里整列同色——信息量相同，DOM 少一半）
  const columns = useMemo(() => {
    if (mode === 'daily') {
      return weeks.map((week) => ({
        key: `d-${week.weekIndex}`,
        cells: week.days.map((cell) => ({
          key: cell.date,
          level: cell.level,
          title: `${formatDate(cell.date)} · ${formatTokens(cell.totalTokens)} tokens · ${cell.turnCount} 轮`,
        })),
        monthDate: week.days.find((d) => d.date.endsWith('-01'))?.date ?? week.days[0]?.date ?? '',
      }))
    }
    const weeklyTotals = weeks.map((week) =>
      week.days.reduce((sum, cell) => sum + cell.totalTokens, 0),
    )
    const values =
      mode === 'weekly'
        ? weeklyTotals
        : weeklyTotals.reduce<number[]>((acc, total) => {
            acc.push((acc.at(-1) ?? 0) + total)
            return acc
          }, [])
    const max = Math.max(0, ...values)
    return weeks.map((week, index) => {
      const value = values[index] ?? 0
      const level = levelForValue(value, max)
      const weekEnd = week.days[week.days.length - 1]?.date ?? ''
      return {
        key: `${mode}-${week.weekIndex}`,
        cells: week.days.map((cell) => ({
          key: cell.date,
          level,
          title: `${mode === 'weekly' ? '本周' : '累计至'} ${formatDate(weekEnd)} · ${formatTokens(value)} tokens`,
        })),
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
    <div className="set-usage-heatmap">
      <div className="set-usage-heatmap-grid" style={gridStyle}>
        {columns.map((column) => (
          <div className="set-usage-heatmap-col" key={column.key}>
            {column.cells.map((cell) => (
              <div
                className={`set-usage-heatmap-cell set-usage-heatmap-cell--l${cell.level}`}
                key={cell.key}
                title={cell.title}
              />
            ))}
          </div>
        ))}
      </div>
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
      <div className="set-usage-heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <div
            className={`set-usage-heatmap-cell set-usage-heatmap-cell--l${level}`}
            key={level}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  )
}

// ── 按天趋势（上游 AppUsageDailyModelTrendChart，内联 SVG 折线）───────

function DailyTrend({ daily }: { daily: DailyUsage[] }) {
  const width = 640
  const height = 140
  const padX = 8
  const padY = 12

  const geometry = useMemo(() => {
    if (daily.length === 0) return null
    const max = Math.max(1, ...daily.map((d) => d.totalTokens))
    const stepX =
      daily.length === 1 ? 0 : (width - padX * 2) / (daily.length - 1)
    const points = daily.map((d, i) => {
      const x = padX + i * stepX
      const y = height - padY - (d.totalTokens / max) * (height - padY * 2)
      return { x, y, ...d }
    })
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ')
    const area = `${path} L${points[points.length - 1]!.x.toFixed(1)} ${height - padY} L${points[0]!.x.toFixed(1)} ${height - padY} Z`
    return { points, path, area, max }
  }, [daily])

  if (geometry === null) {
    return <p className="set-persona-note">该区间没有可绘制的数据。</p>
  }

  return (
    <div className="set-usage-trend">
      <svg
        aria-label="按天 token 趋势"
        className="set-usage-trend-svg"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <path className="set-usage-trend-area" d={geometry.area} />
        <path className="set-usage-trend-line" d={geometry.path} />
        {geometry.points.map((p) => (
          <circle className="set-usage-trend-dot" cx={p.x} cy={p.y} key={p.date} r={2.5}>
            <title>{`${formatDate(p.date)} · ${formatTokens(p.totalTokens)} tokens · ${p.turnCount} 轮`}</title>
          </circle>
        ))}
      </svg>
      <div className="set-usage-trend-axis">
        <span>{formatDate(daily[0]!.date)}</span>
        <span>峰值 {formatTokens(geometry.max)}</span>
        <span>{formatDate(daily[daily.length - 1]!.date)}</span>
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
  if (models.length === 0 || total === 0) {
    return <p className="set-persona-note">该区间没有模型用量。</p>
  }
  const sorted = [...models].sort((a, b) => b.totalTokens - a.totalTokens)

  return (
    <div className="set-usage-models">
      <div className="set-usage-models-bar">
        {sorted.map((model, index) => (
          <div
            className="set-usage-models-seg"
            key={model.modelId}
            style={{
              background: MODEL_COLORS[index % MODEL_COLORS.length],
              flexGrow: model.totalTokens,
            }}
            title={`${model.modelId} · ${formatTokens(model.totalTokens)} tokens`}
          />
        ))}
      </div>
      <ul className="set-usage-models-list">
        {sorted.map((model, index) => (
          <li className="set-usage-models-row" key={model.modelId}>
            <span
              aria-hidden
              className="set-usage-models-dot"
              style={{ background: MODEL_COLORS[index % MODEL_COLORS.length] }}
            />
            <span className="set-usage-models-name" title={model.modelId}>
              {model.modelId}
            </span>
            <span className="set-usage-models-count">
              {formatTokens(model.totalTokens)} · {formatPercent(model.totalTokens / total)}
            </span>
          </li>
        ))}
      </ul>
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

  const summary = snapshot?.summary ?? lifetime?.summary ?? null

  return (
    <div className="set-usage">
      <SummaryStrip summary={summary} />

      {error !== null && (
        <div className="set-err" role="alert">
          用量统计读取失败：{error}
        </div>
      )}

      {/* 热力图固定用 lifetime（all）快照——上游同款：热力图永远看全年，
          不随区间 tab 变化 */}
      {lifetime !== null && lifetime.heatmap.weeks.length > 0 && (
        <section className="set-persona-card">
          <div className="set-persona-card-head">
            <div className="set-persona-card-head-text">
              <h3 className="set-persona-card-title">活跃热力图</h3>
              <p className="set-persona-card-desc">最近 52 周，按自然周（周日起）</p>
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
        <span className="set-usage-range-title">统计区间</span>
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
        <p className="set-persona-note">正在汇总本地会话…</p>
      ) : snapshot === null ? (
        <p className="set-persona-note">还没有可统计的会话。</p>
      ) : (
        <>
          <section className="set-persona-card">
            <div className="set-persona-card-head">
              <div className="set-persona-card-head-text">
                <h3 className="set-persona-card-title">按天趋势</h3>
                <p className="set-persona-card-desc">
                  每日 token 总量（输入 {formatTokens(snapshot.summary.inputTokens)} · 输出{' '}
                  {formatTokens(snapshot.summary.outputTokens)}）
                </p>
              </div>
            </div>
            <div className="set-persona-card-pad">
              <DailyTrend daily={snapshot.daily} />
            </div>
          </section>

          <section className="set-persona-card">
            <div className="set-persona-card-head">
              <div className="set-persona-card-head-text">
                <h3 className="set-persona-card-title">按模型占比</h3>
                <p className="set-persona-card-desc">
                  {snapshot.models.length} 个模型 · 共 {formatTokens(snapshot.summary.totalTokens)} tokens
                  {' · '}
                  成本 {formatCost(snapshot.costUsd)}
                </p>
              </div>
            </div>
            <div className="set-persona-card-pad">
              <ModelShare models={snapshot.models} />
            </div>
          </section>

          <section className="set-persona-card">
            <div className="set-persona-card-head">
              <div className="set-persona-card-head-text">
                <h3 className="set-persona-card-title">明细</h3>
              </div>
            </div>
            <div className="set-persona-card-body">
              <div className="set-acct-field">
                <div className="set-acct-field-text">
                  <span className="set-acct-field-label">会话 / 轮次</span>
                  <p className="set-acct-field-desc">
                    {snapshot.summary.totalSessions} 个会话 · {snapshot.summary.totalTurns} 轮
                  </p>
                </div>
              </div>
              <div className="set-acct-field">
                <div className="set-acct-field-text">
                  <span className="set-acct-field-label">工具调用</span>
                  <p className="set-acct-field-desc">{snapshot.summary.toolCallCount} 次</p>
                </div>
              </div>
              <div className="set-acct-field">
                <div className="set-acct-field-text">
                  <span className="set-acct-field-label">缓存</span>
                  <p className="set-acct-field-desc">
                    读 {formatTokens(snapshot.summary.cacheReadTokens)} · 写{' '}
                    {formatTokens(snapshot.summary.cacheCreationTokens)} · 命中率{' '}
                    {formatPercent(snapshot.summary.cacheHitRate)}
                  </p>
                </div>
              </div>
              <div className="set-acct-field">
                <div className="set-acct-field-text">
                  <span className="set-acct-field-label">活跃天</span>
                  <p className="set-acct-field-desc">{snapshot.summary.activeDays} 天</p>
                </div>
              </div>
              {snapshot.summary.favoriteModel !== null && (
                <div className="set-acct-field">
                  <div className="set-acct-field-text">
                    <span className="set-acct-field-label">最常用模型</span>
                    <p className="set-acct-field-desc">
                      {snapshot.summary.favoriteModel.modelId} ·{' '}
                      {formatTokens(snapshot.summary.favoriteModel.totalTokens)}（
                      {formatPercent(snapshot.summary.favoriteModel.share)}）
                    </p>
                  </div>
                </div>
              )}
              {/* 时延 / 错误率：pi stats 不记录 → 后端返回 null。这里不渲染
                  那几行（不显示 0，不编造）。 */}
            </div>
          </section>
        </>
      )}

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

      <p className="set-persona-note">
        本页只统计本机 pi 会话记录（tokens / 成本 / 轮次 / 工具调用）。ZCode 的
        「Coding Plan」tab 读的是它的云端订阅额度，本应用没有订阅账户与该端点，
        因此没有那一页——不显示为 0 冒充。
      </p>
    </div>
  )
}
