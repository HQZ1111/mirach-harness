/**
 * 会话行时间标注（hermes lib/time.ts + components/assistant-ui/thread/
 * timestamp.ts + session-row.tsx 的行龄段逐语义照抄）：
 * - `coarseElapsed`：粗粒度流逝桶（day/hour/minute/second，向下取整）——
 *   调用方负责渲染，这里不出格式；
 * - `sessionRowAge`：行右侧 age（hermes formatAge：今天/一小时内 X 时 X 分、
 *   一分钟内读「刚刚」——侧栏永不显示秒刻度）；
 * - `formatMessageTimestamp`：绝对时间标注（今天/昨天 = 时钟，否则
 *   紧凑日期+时钟）——行 age 的 title 提示（hermes aria-label 同源）。
 *
 * 文案逐字取 hermes zh catalog（sidebar.row.ageNow/ageDay/ageHour/ageMin、
 * assistant.thread.today/yesterday）。Intl 实例模块级创建一次（hermes
 * styles 注释：every surface pulls from here so strings stay consistent）。
 */

export const SECOND = 1000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

// `hh:mm` 时钟（thread 今天/昨天行）；紧凑「日 + 时钟」（thread 兜底）。
const fmtClock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fmtDayTime = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
})

export type ElapsedUnit = 'day' | 'hour' | 'minute' | 'second'

/** 粗粒度流逝桶（clamp 非负、向下取整）。 */
export function coarseElapsed(deltaMs: number): { unit: ElapsedUnit; value: number } {
  const ms = Math.max(0, deltaMs)

  if (ms >= DAY) {
    return { unit: 'day', value: Math.floor(ms / DAY) }
  }

  if (ms >= HOUR) {
    return { unit: 'hour', value: Math.floor(ms / HOUR) }
  }

  if (ms >= MINUTE) {
    return { unit: 'minute', value: Math.floor(ms / MINUTE) }
  }

  return { unit: 'second', value: Math.floor(ms / SECOND) }
}

/** 行 age 文案（hermes zh sidebar.row：刚刚/天/时/分——`3天`/`5时`/`12分`）。 */
export interface AgeLabels {
  ageNow: string
  ageDay: string
  ageHour: string
  ageMin: string
}

export const AGE_LABELS: AgeLabels = { ageNow: '刚刚', ageDay: '天', ageHour: '时', ageMin: '分' }

/** 会话行的 age 标注（hermes session-row formatAge：`last_active ||
 *  started_at` 由调用方给 ms；一分钟内 = 「刚刚」——侧栏永不显示秒）。 */
export function sessionRowAge(ms: number, labels: AgeLabels = AGE_LABELS, nowMs = Date.now()): string {
  const { unit, value } = coarseElapsed(nowMs - ms)

  if (unit === 'second') {
    return labels.ageNow
  }

  const suffix = unit === 'day' ? labels.ageDay : unit === 'hour' ? labels.ageHour : labels.ageMin

  return `${value}${suffix}`
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 绝对时间标注（hermes timestamp.ts formatMessageTimestamp 逐语义）：
 *  今天/昨天 = 「今天，hh:mm」，否则紧凑「6月5日 14:20」形（Intl 决定）。 */
export function formatMessageTimestamp(
  value: Date | string | number | undefined,
  labels: { today: (time: string) => string; yesterday: (time: string) => string },
): string {
  if (!value) {
    return ''
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY)

  if (dayDelta === 0) {
    return labels.today(fmtClock.format(date))
  }

  if (dayDelta === 1) {
    return labels.yesterday(fmtClock.format(date))
  }

  return fmtDayTime.format(date)
}

/** 行 title/aria 的绝对标注（hermes zh assistant.thread，逐字）。 */
export const THREAD_TIME_LABELS = {
  today: (time: string) => `今天，${time}`,
  yesterday: (time: string) => `昨天，${time}`,
}

/** RFC3339 会话时间戳（pi header.timestamp）→ ms；缺失/解析失败 = undefined
 *  （禁止兜底——不假装成 0/now）。 */
export function parseTimestampMs(timestamp: string | undefined): number | undefined {
  if (typeof timestamp !== 'string' || timestamp.length === 0) {
    return undefined
  }

  const ms = Date.parse(timestamp)

  return Number.isFinite(ms) ? ms : undefined
}
