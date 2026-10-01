/**
 * 会话未读态（hermes store/session-unread.ts 的水位语义客户端化——pi 无
 * 已读概念，真相全在客户端；hermes 对照行号见各函数）：
 *
 * - **已读水位**（SEEN_WATERMARKS，session-unread.ts:27）：每会话最后确认的
 *   message_count。live count 超过水位 = 未读（session-unread.ts:482 同款
 *   判定）——重启后绿点仍在（"finished while the app was CLOSED still comes
 *   up unread"），因为差距记在持久化水位里，不靠进程内存。
 * - **显式未读标记**（session-unread.ts:78 markers）：用户「标记为未读」的
 *   旗标——水位上没有差距也亮（hermes set_session_read 的对偶）。
 * - **播种**（ingestRows，session-unread.ts:360-405）：从未见过的会话按当前
 *   count 播种（首见不亮绿，hermes "seeds at its current count instead of
 *   lighting up green on first sight"）；选中会话恒跟踪 live count（在屏幕
 *   上 = 已读）；已知未选中行不动——水位与 live count 的差就是未读信号。
 * - **确认**（ackSession，hermes ackStoredSessionId）：打开会话 = 水位 := 当前
 *   count + 撤销显式标记。
 * - **全部标记为已读**（ackAll，hermes ackAllSessionsRead:298）：确认每一条
 *   已加载行（"an unseen session in a collapsed profile stays honestly
 *   unread"——未加载的不碰）。
 * - prune：会话消失（删除）时清键——与 pinned/order 的 prune 同款纪律，
 *   列表非空才清（首帧空列表是"未加载"不是"已删光"）。
 *
 * 持久化键 mirach.harness.sessions.*.v1；形状非法 console.error 从空态起
 * （禁止兜底/不冒充旧数据）。
 */
import { createStore, useStore } from 'zustand'

export const SEEN_COUNTS_KEY = 'mirach.harness.sessions.seenCounts.v1'
export const UNREAD_MARKERS_KEY = 'mirach.harness.sessions.unreadMarkers.v1'

/** 未读判定的行输入（pi SessionMeta 投影：threadItems[].custom）。 */
export interface UnreadRowInput {
  readonly id: string
  readonly messageCount: number
}

const safeGetItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[session-unread] localStorage 读取失败（${key}）`, e)
    return null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[session-unread] localStorage 写入失败（${key}）——未读态不持久`, e)
  }
}

/** 严格解析水位表：Record<string, 有限数> 之外 → console.error + 空表。 */
export const parseSeenCounts = (raw: string | null): Record<string, number> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-unread] ${SEEN_COUNTS_KEY} JSON 解析失败——从空水位起`, e)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[session-unread] ${SEEN_COUNTS_KEY} 形状非法（应为 Record<string, number>）——从空水位起`, parsed)
    return {}
  }
  const out: Record<string, number> = {}
  for (const [id, count] of Object.entries(parsed)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      console.error(`[session-unread] 水位条目 ${id} 非法——跳过`, count)
      continue
    }
    out[id] = count
  }
  return out
}

/** 严格解析显式未读标记：string[] 之外 → console.error + 空表（去重）。 */
export const parseUnreadMarkers = (raw: string | null): string[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-unread] ${UNREAD_MARKERS_KEY} JSON 解析失败——从空标记起`, e)
    return []
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    console.error(`[session-unread] ${UNREAD_MARKERS_KEY} 形状非法（应为 string[]）——从空标记起`, parsed)
    return []
  }
  return [...new Set(parsed as string[])]
}

/** 未读判定（hermes recomputeUnread:482 同款）：显式标记命中，或 live
 *  count 超过已读水位（无水位 = 从未见 = 已播种语义下不应出现——ingestRows
 *  会播种；这里对无水位行按「有消息即未读」处理，防御刷新先于播种的窗口）。 */
export function isRowUnread(
  row: UnreadRowInput,
  seen: Readonly<Record<string, number>>,
  markers: readonly string[],
): boolean {
  if (markers.includes(row.id)) return true
  const watermark = seen[row.id]
  return row.messageCount > (watermark ?? 0)
}

interface SessionUnreadState {
  /** 已读水位（sessionId → 最后确认的 message_count）。 */
  seen: Readonly<Record<string, number>>
  /** 显式未读标记（「标记为未读」旗标）。 */
  markers: readonly string[]
  /** 列表刷新播种（hermes ingestRows）：未知会话按当前 count 播种、选中会话
   *  恒跟踪 live count；返回是否有写入（调用方决定）。 */
  ingestRows(rows: readonly UnreadRowInput[], selectedId: string | null): boolean
  /** 确认已读（打开会话）：水位 := count + 撤销显式标记（hermes ack）。 */
  ackSession(id: string, messageCount: number): void
  /** 「标记为未读」：加显式标记（对偶：再点菜单里的「标记为已读」走 ack）。 */
  markSessionUnread(id: string): void
  /** 「全部标记为已读」：确认全部已加载行（hermes ackAllSessionsRead）。 */
  ackAll(rows: readonly UnreadRowInput[]): void
  /** 已消失会话清键（列表非空才清——同 sessionManageStore.prune 纪律）。 */
  prune(existingIds: readonly string[]): void
}

const loadSeen = (): Record<string, number> => parseSeenCounts(safeGetItem(SEEN_COUNTS_KEY))
const loadMarkers = (): string[] => parseUnreadMarkers(safeGetItem(UNREAD_MARKERS_KEY))

export const sessionUnreadStore = createStore<SessionUnreadState>((set, get) => ({
  seen: loadSeen(),
  markers: loadMarkers(),
  ingestRows: (rows, selectedId) => {
    const seen = { ...get().seen }
    let changed = false
    for (const row of rows) {
      if (!Number.isFinite(row.messageCount)) continue
      // 选中会话恒跟踪（在屏幕上 = 已读——hermes ingestRows 分支一）
      if (selectedId !== null && row.id === selectedId) {
        if (seen[row.id] !== row.messageCount) {
          seen[row.id] = row.messageCount
          changed = true
        }
        continue
      }
      // 从未见过的会话按当前 count 播种（首见不亮绿）
      if (!(row.id in seen)) {
        seen[row.id] = row.messageCount
        changed = true
      }
    }
    if (!changed) return false
    set({ seen })
    safeSetItem(SEEN_COUNTS_KEY, JSON.stringify(seen))
    return true
  },
  ackSession: (id, messageCount) => {
    const s = get()
    const nextSeen = { ...s.seen, [id]: messageCount }
    const nextMarkers = s.markers.filter((m) => m !== id)
    const markersChanged = nextMarkers.length !== s.markers.length
    set({ seen: nextSeen, ...(markersChanged ? { markers: nextMarkers } : {}) })
    safeSetItem(SEEN_COUNTS_KEY, JSON.stringify(nextSeen))
    if (markersChanged) safeSetItem(UNREAD_MARKERS_KEY, JSON.stringify(nextMarkers))
  },
  markSessionUnread: (id) => {
    if (get().markers.includes(id)) return
    const next = [...get().markers, id]
    set({ markers: next })
    safeSetItem(UNREAD_MARKERS_KEY, JSON.stringify(next))
  },
  ackAll: (rows) => {
    if (rows.length === 0) return
    const seen = { ...get().seen }
    const markerSet = new Set(get().markers)
    let changed = false
    for (const row of rows) {
      if (!Number.isFinite(row.messageCount)) continue
      if (seen[row.id] !== row.messageCount) {
        seen[row.id] = row.messageCount
        changed = true
      }
      if (markerSet.delete(row.id)) changed = true
    }
    if (!changed) return
    const markers = [...markerSet]
    set({ seen, markers })
    safeSetItem(SEEN_COUNTS_KEY, JSON.stringify(seen))
    safeSetItem(UNREAD_MARKERS_KEY, JSON.stringify(markers))
  },
  prune: (existingIds) => {
    if (existingIds.length === 0) return
    const s = get()
    const alive = new Set(existingIds)
    const nextSeen: Record<string, number> = {}
    for (const [id, count] of Object.entries(s.seen)) {
      if (alive.has(id)) nextSeen[id] = count
    }
    const nextMarkers = s.markers.filter((id) => alive.has(id))
    if (
      Object.keys(nextSeen).length === Object.keys(s.seen).length &&
      nextMarkers.length === s.markers.length
    ) {
      return
    }
    set({ seen: nextSeen, markers: nextMarkers })
    safeSetItem(SEEN_COUNTS_KEY, JSON.stringify(nextSeen))
    safeSetItem(UNREAD_MARKERS_KEY, JSON.stringify(nextMarkers))
  },
}))

/** React 订阅（组件层用；runtime 回调用 sessionUnreadStore.getState()）。 */
export const useSessionUnread = <T,>(selector: (s: SessionUnreadState) => T): T =>
  useStore(sessionUnreadStore, selector)
