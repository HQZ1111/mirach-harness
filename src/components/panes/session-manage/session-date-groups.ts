/**
 * 会话列表的日期分组纯函数（hermes lib/time.ts 的 calendarBucket 段 +
 * lib/session-date-groups.ts + chat/sidebar/order.ts 的 orderRowsWithinGroups
 * /hideCollapsedGroupRows 逐语义照抄；pi 会话列表无父子行——分支孩子
 * branchStem 簇规则不适用，每个簇就是单行）。
 *
 * 数据行 = {id, ms}（ms = SessionRowMeta.lastActiveMs，对应 hermes
 * recencyMs = last_active || started_at）。
 *
 * hermes 结构照抄要点：
 * - 未标名的"头部"（head）＝最近一波会话（headRunCutoffMs：按真实停顿
 *   切一刀，落点最接近 5 条），头部不带分隔线；
 * - 头部以下按粗粒度日历桶出分隔线（今天早些时候 → 昨天 → 本周 → 上周 →
 *   本月 → 月 → 月+年），一个活动簇一条线，绝不逐日出线；自然日边界在
 *   凌晨 4 点（熬夜会话与前一晚同组）；
 * - 第一条渲染的行永不带标签（分隔线只用于两组之间）；
 * - 折叠：分隔线保留、其下行隐藏（hideCollapsedGroupRows）。
 */

export const SECOND = 1000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

export interface SessionListEntry {
  readonly id: string
  /** 活跃时刻（ms）。0/缺失的行按"现在"处理（hermes：新会话 started_at
   *  即当下，落进头部而不是 1970 月桶）。 */
  readonly ms: number
}

export type SessionListRow =
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'divider'; readonly key: string; readonly label: string }

// ── lib/time.ts：日历桶（逐语义） ─────────────────────────────────────────

const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'long' })
const fmtMonthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

export type SessionBucketKind = 'lastWeek' | 'month' | 'monthYear' | 'thisMonth' | 'thisWeek' | 'today' | 'yesterday'

export interface SessionBucket {
  readonly at: number
  readonly key: string
  readonly kind: SessionBucketKind
}

/** 分隔线的固定相对标签（月标签走 Intl）——hermes zh catalog 原样。 */
export const SESSION_BUCKET_LABELS = {
  today: '今天早些时候',
  yesterday: '昨天',
  thisWeek: '本周',
  lastWeek: '上周',
  thisMonth: '本月',
} as const

export const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms)

  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// 自然日不在午夜结束，在你睡着时结束——凌晨的会话归前一晚（同活动/睡眠
// 追踪的惯用伎俩）。4:30 的会话和 23:50 的会话同组，不被拆开。
export const DAY_ROLLOVER_HOUR = 4

export const nominalDayStart = (ms: number): number => startOfLocalDay(ms - DAY_ROLLOVER_HOUR * HOUR)

/** 区域一周起始日（JS getDay() 约定 0=周日…6=周六）；不支持 → 周一。 */
export function localeWeekStartDay(): number {
  try {
    const locale = new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale)
    const withWeekInfo = locale as {
      getWeekInfo?: () => { firstDay?: number }
      weekInfo?: { firstDay?: number }
    }
    const firstDay = (withWeekInfo.getWeekInfo?.() ?? withWeekInfo.weekInfo)?.firstDay

    return typeof firstDay === 'number' ? firstDay % 7 : 1
  } catch {
    return 1
  }
}

/** 含 `ms` 的本地日历周起点（DST 安全的 Date 字段运算）。 */
export function startOfLocalWeek(ms: number, weekStartsOn: number): number {
  const d = new Date(startOfLocalDay(ms))
  const back = (d.getDay() - weekStartsOn + 7) % 7

  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
}

/**
 * 粗粒度日历桶（Unix 毫秒入参，hermes 版是秒——同式换单位）。粒度随年龄
 * 变粗：今天早些时候 → 昨天 → 本周早些时候 → 上周 → 本月早些时候 → 月 →
 * 月+年。空区间永不产桶；最新的连续会话根本到不了这里（它是未标名头部）。
 */
export function calendarBucket(ms: number, nowMs = Date.now(), weekStartsOn = localeWeekStartDay()): SessionBucket {
  const nominal = nominalDayStart(ms)
  const todayNominal = nominalDayStart(nowMs)
  const dayDiff = Math.round((todayNominal - nominal) / DAY)

  if (dayDiff <= 0) {
    return { at: nominal, key: 'today', kind: 'today' }
  }

  if (dayDiff === 1) {
    return { at: nominal, key: 'yesterday', kind: 'yesterday' }
  }

  const weekStart = startOfLocalWeek(todayNominal, weekStartsOn)

  if (nominal >= weekStart) {
    return { at: nominal, key: 'this-week', kind: 'thisWeek' }
  }

  const ws = new Date(weekStart)

  if (nominal >= new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 7).getTime()) {
    return { at: nominal, key: 'last-week', kind: 'lastWeek' }
  }

  const d = new Date(nominal)
  const now = new Date(todayNominal)
  const sameYear = d.getFullYear() === now.getFullYear()

  if (sameYear && d.getMonth() === now.getMonth()) {
    return { at: nominal, key: 'this-month', kind: 'thisMonth' }
  }

  const ym = `${d.getFullYear()}-${d.getMonth()}`

  return sameYear ? { at: nominal, key: `m-${ym}`, kind: 'month' } : { at: nominal, key: `my-${ym}`, kind: 'monthYear' }
}

/** 桶的分隔线标签：固定相对串 + Intl 月/月年。 */
export function sessionBucketLabel(bucket: SessionBucket, labels = SESSION_BUCKET_LABELS): string {
  switch (bucket.kind) {
    case 'today':
      return labels.today

    case 'yesterday':
      return labels.yesterday

    case 'thisWeek':
      return labels.thisWeek

    case 'lastWeek':
      return labels.lastWeek

    case 'thisMonth':
      return labels.thisMonth

    case 'month':
      return fmtMonth.format(bucket.at)

    case 'monthYear':
      return fmtMonthYear.format(bucket.at)
  }
}

// ── session-date-groups.ts：头部切点 + 出组（逐语义） ────────────────────

// 头部瞄准"最近的几波"：短于 MIN_RUN_BREAK_MS 的间歇不算断口（不然会把
// 密集突发切散），长于 MAX_RUN_GAP_MS 的静默必然终结突发（稀疏列表不至
// 于把几周的陈旧会话串成一个巨型头部）。
const TARGET_HEAD_SESSIONS = 5
const MIN_RUN_BREAK_MS = 30 * MINUTE
const MAX_RUN_GAP_MS = 8 * HOUR

/** 头部内仍算头部的最老时间戳（ms）；-Infinity=全列表一个突发，
 *  +Infinity=无头部（日历组接管一切）。 */
function headRunCutoffMs(timesIn: readonly number[], nowMs: number, weekStartsOn: number): number {
  // hermes 原样对 times 降序排（调用方已按新近排序，这里防御式再排一次，
  // 折叠/搜索态乱序输入不至于让切点算歪）。
  const times = [...timesIn].sort((a, b) => b - a)
  let bestIdx = -1
  let bestScore = Number.POSITIVE_INFINITY
  let runEnded = false

  for (let i = 1; i < times.length; i++) {
    const gap = times[i - 1] - times[i]
    const endsRun = gap > MAX_RUN_GAP_MS

    if (gap >= MIN_RUN_BREAK_MS || endsRun) {
      // 在 `i` 处切一刀，头部压 `i` 条会话。
      const score = Math.abs(Math.log(i / TARGET_HEAD_SESSIONS))

      if (score < bestScore) {
        bestScore = score
        bestIdx = i
        runEnded = endsRun
      }
    }

    if (endsRun) {
      break
    }
  }

  if (bestIdx === -1) {
    return Number.NEGATIVE_INFINITY
  }

  // 模糊合并：切点落在突发末端、且紧随其下的会话与头部同桶时，头部没有
  // 信息量——就地化掉，分隔线不悬空隔开几乎相同的邻居。
  if (runEnded) {
    const headBucket = calendarBucket(times[0], nowMs, weekStartsOn)
    const belowBucket = calendarBucket(times[bestIdx], nowMs, weekStartsOn)

    if (headBucket.key === belowBucket.key) {
      return Number.POSITIVE_INFINITY
    }
  }

  return times[bestIdx - 1]
}

/**
 * 按新近分组：未标名头部 + 每个粗日历桶一条分隔线。entries 必须已按
 * ms 降序。第一条渲染的行永不带标签（分隔线只用于两组之间）。
 */
export function groupEntriesByRecency(
  entries: readonly SessionListEntry[],
  opts: { nowMs?: number; weekStartsOn?: number } = {},
): SessionListRow[] {
  const nowMs = opts.nowMs ?? Date.now()
  const weekStartsOn = opts.weekStartsOn ?? localeWeekStartDay()
  const times = entries.map((entry) => (entry.ms > 0 ? entry.ms : nowMs))
  const cutoff = headRunCutoffMs(times, nowMs, weekStartsOn)
  const rows: SessionListRow[] = []
  const emitted = new Set<string>()
  let lastKey: null | string = null

  for (const [index, entry] of entries.entries()) {
    const ms = times[index]

    // 头部会话永不标名。
    if (ms >= cutoff) {
      rows.push({ id: entry.id, kind: 'session' })
      lastKey = '__recent__'

      continue
    }

    const bucket = calendarBucket(ms, nowMs, weekStartsOn)

    if (bucket.key !== lastKey) {
      lastKey = bucket.key
      const alreadyEmitted = emitted.has(bucket.key)

      // 即便跳过也要登记——非单调顺序（折叠后重排等）不得让它重复出线
      // 或撞 React key。
      emitted.add(bucket.key)

      if (rows.length > 0 && !alreadyEmitted) {
        rows.push({ key: bucket.key, kind: 'divider', label: sessionBucketLabel(bucket) })
      }
    }

    rows.push({ id: entry.id, kind: 'session' })
  }

  return rows
}

/**
 * 分隔线之下折叠时只掉会话、分隔线保留（可再展开）。首条分隔线之前的
 * （未标名头部）永不折叠。无隐藏时原数组返回（引用稳定）。
 */
export function hideCollapsedGroupRows(
  rows: readonly SessionListRow[],
  isOpen: (key: string) => boolean,
): readonly SessionListRow[] {
  const out: SessionListRow[] = []
  let hiding = false

  for (const row of rows) {
    if (row.kind === 'divider') {
      hiding = !isOpen(row.key)
      out.push(row)

      continue
    }

    if (!hiding) {
      out.push(row)
    }
  }

  return out.length === rows.length ? (rows as SessionListRow[]) : out
}

// ── sidebar/order.ts：日期组内应用手挑顺序（逐语义，簇=单行） ─────────────

/**
 * 把持久化顺序应用到每个时间桶内部，绝不跨桶。拖一次重排不再冻结整表
 * 为无日期的手动模式——日历桶留在新近性放它的位置，手动顺序只决定桶内
 * 次序。持久化顺序没点名的簇保持新近给的槽位。
 */
export function orderRowsWithinGroups(
  rows: readonly SessionListRow[],
  orderIds: readonly string[],
): readonly SessionListRow[] {
  if (!orderIds.length || !rows.length) {
    return rows
  }

  const rank = new Map(orderIds.map((id, index) => [id, index]))
  const out: SessionListRow[] = []
  let cluster: SessionListRow[][] = []
  let reordered = false

  const flushGroup = () => {
    const ranked = cluster
      .map((rows_, index) => ({ index, rank: rank.get(clusterId(rows_)) }))
      .filter((entry): entry is { index: number; rank: number } => entry.rank !== undefined)

    const slots = ranked.map((entry) => entry.index)
    const sorted = [...ranked].sort((a, b) => a.rank - b.rank)
    const next = [...cluster]

    slots.forEach((slot, i) => {
      const source = cluster[sorted[i].index]

      reordered ||= source !== next[slot]
      next[slot] = source
    })

    for (const rows_ of next) {
      out.push(...rows_)
    }

    cluster = []
  }

  for (const row of rows) {
    if (row.kind === 'divider') {
      flushGroup()
      out.push(row)

      continue
    }

    cluster.push([row])
  }

  flushGroup()

  return reordered ? out : rows
}

/** 一簇的身份：根行的会话 id（无父子行时簇恒为单行）。 */
function clusterId(rows: readonly SessionListRow[]): string {
  const root = rows[0]

  return root && root.kind === 'session' ? root.id : ''
}
