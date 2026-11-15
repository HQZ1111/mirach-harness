/**
 * 流式文本揭示参数（对齐 ZCode `packages/stream-animate` 的平滑口径）。
 *
 *   ## 上游在测什么
 *
 * `stream-animate` 是一个 **SSE 帧剖面上具**：它把模型输出按 60/120fps 切成
 * 每帧字符数（`frameBuckets.ts`），用 200ms 滚动窗口 + EMA(α=0.32) 抹平
 * 突发（`frameForecast.ts::smoothValues`），再用 p85×1.35 的峰值上限裁掉
 * 极端 chunk（`resolvePeakLimit`），最后按 1–3s 视界外推
 * （`FORECAST_RATIO=0.2` + 阻尼 0.78）画出「应该以多快的速度吐字」。
 *
 * 结论直接可用在我们的揭示率上：**别按 chunk 到达节奏一次性贴上去，按平滑
 * 后的速率逐字揭示**；主线程忙时允许跳帧追赶（上游的
 * `resolveQueuedSummaryPlaybackQueue` 同思路：漂移 > 250ms 就丢弃积压，
 * 不补播过时状态）。
 *
 * ## 与 assistant-ui `useSmooth` 的映射
 *
 * assistant-ui 的 `SmoothOptions`（`@assistant-ui/react`）就是逐字揭示器，
 * 参数语义一一对应：
 *
 * | stream-animate | useSmooth | 取值 | 理由 |
 * |---|---|---|---|
 * | 平滑速率（200ms 窗口 + EMA） | `drainMs` | 300 | 每次增量在 ~300ms 内铺开，突发 chunk 不再整块跳出 |
 * | 峰值上限（p85×1.35） | `maxCharsPerFrame` | 24 | 单帧最多 24 字（≈1440 字/秒上限），异常大 chunk 不瞬移 |
 * | 最慢速率上限 | `maxCharIntervalMs` | 8 | 每字至少 8ms（≈125 字/秒），积压少时也不会慢到卡顿 |
 * | 主线程繁忙跳帧 | `minCommitMs` | 48 | 提交间隔 ≥48ms：Markdown 重解析从每帧 1 次降到 ~20 次/秒 |
 *
 * `prefers-reduced-motion: reduce` 时 assistant-ui 自动整段直出（上游的
 * 「别做动画」回退），本文件不需要额外分支。
 *
 * 纯常量 + 纯函数（可单测），不 import 任何运行时。
 */
export interface StreamRevealOptions {
  /** 每次积压的目标排空时长（ms）。 */
  drainMs: number
  /** 单帧最多揭示的字符数。 */
  maxCharsPerFrame: number
  /** 最慢揭示节奏：每字最小间隔（ms）。 */
  maxCharIntervalMs: number
  /** 最小提交间隔（ms）——限制 Markdown 重解析频率。 */
  minCommitMs: number
}

export const STREAM_REVEAL_DEFAULTS: StreamRevealOptions = {
  drainMs: 300,
  maxCharsPerFrame: 24,
  maxCharIntervalMs: 8,
  minCommitMs: 48,
}

const MIN_CHAR_INTERVAL_MS = 4
const MAX_CHAR_INTERVAL_MS = 24

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * 由实测出字速率（字/秒）派生揭示参数；无实测（历史消息、无 timing）时
 * 用默认值。速率非法（0/负/NaN）同样回落默认——调用方不传即可。
 */
export function resolveStreamRevealOptions(
  charsPerSecond?: number,
): StreamRevealOptions {
  if (
    charsPerSecond === undefined ||
    !Number.isFinite(charsPerSecond) ||
    charsPerSecond <= 0
  ) {
    return STREAM_REVEAL_DEFAULTS
  }
  // 每字间隔 = 1000/rate，夹在 [4, 24]ms：模型越快，间隔越小；但绝不
  // 允许「比 125 字/秒还慢」的观感，也不允许单帧灌几十字。
  const maxCharIntervalMs = clamp(
    Math.round(1000 / charsPerSecond),
    MIN_CHAR_INTERVAL_MS,
    MAX_CHAR_INTERVAL_MS,
  )
  return {
    drainMs: STREAM_REVEAL_DEFAULTS.drainMs,
    // 单帧预算按 20 提交/秒折算（与 minCommitMs 同源），至少 1 字
    maxCharsPerFrame: Math.max(
      1,
      Math.ceil(charsPerSecond / (1000 / STREAM_REVEAL_DEFAULTS.minCommitMs)),
    ),
    maxCharIntervalMs,
    minCommitMs: STREAM_REVEAL_DEFAULTS.minCommitMs,
  }
}

/**
 * EMA 平滑（上游 `smoothValues` 同款 α=0.32）：把 chunk 到达的抖动抹平，
 * 供将来的自适应揭示率使用。纯函数。
 */
export function smoothRate(
  previous: number | undefined,
  sample: number,
  alpha = 0.32,
): number {
  if (previous === undefined || !Number.isFinite(previous)) return sample
  return previous + alpha * (sample - previous)
}

/**
 * 峰值上限（上游 `resolvePeakLimit`：p85×1.35，且不低于中位数×1.8）——
 * 一次性到达的超大 chunk 不允许直接把揭示率顶到天上。纯函数。
 */
export function peakLimit(values: readonly number[]): number {
  const positive = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (positive.length === 0) return 1
  const p85 = positive[Math.floor((positive.length - 1) * 0.85)] ?? 1
  const median = positive[Math.floor((positive.length - 1) * 0.5)] ?? p85
  return Math.max(1, p85 * 1.35, median * 1.8)
}
