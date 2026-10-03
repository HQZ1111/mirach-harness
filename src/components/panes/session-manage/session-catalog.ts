/**
 * 会话目录——**会话数据的单一真相源**（用户 2026-10-03 定稿："所有的数据
 * 都只有一个真相源……参考 hermes 和 zcode 的管理"）。
 *
 * 结构照抄 zcode tabStore（packages/ui/src/store/tabStore.ts）：单 store
 * 承载全部会话维度状态 + 动作内聚 + 统一持久化；hermes 对照 = 其后端
 * session 元数据面（api/sessions.ts 的 pinned/archived/unread/name——pi
 * 无此后端，客户端统一承载）。
 *
 * 三段数据：
 * 1. **目录**（pi 真相面投影）：entries/piOrder/activeId/pendingCwd——
 *    runtime 唯一写入（pi_list_sessions 灌入 + 消息流派生标题 + 活动
 *    切换 + 工作区新建 cwd）；不持久化（pi 是真相，启动重拉）。
 * 2. **管理维度**（hermes 后端字段的客户端对应物）：pinned/manualOrder/
 *    archived/seen/markers/groupsCollapsed——持久化单 key
 *    `mirach.harness.sessions.v1`；**旧五 key 一次性迁移**（pinned.v1/
 *    order.v1/session-groups.v1/archived.v1/seenCounts.v1/
 *    unreadMarkers.v1 读入合成，旧键保留不删——回滚安全）。
 * 3. **统一选择器**：sessionDisplayName（pi name ?? 派生标题 ?? New
 *    Chat）/sessionProjectCwd/isRowUnread——所有消费方同源同公式。
 *
 * 消费方 hook：useSessionManage/useSessionArchive/useSessionUnread（三个
 * 别名都指向本 store 的对应切片——原三 store 的调用点只改 import 路径）。
 */
import { createStore, useStore } from 'zustand'

import { pruneOrder, prunePins, togglePinId } from './session-order'

// ── 持久化键 ──────────────────────────────────────────────────────────────

/** 统一持久化键（管理维度全量）。 */
export const SESSION_STORE_KEY = 'mirach.harness.sessions.v1'
// 旧键（一次性迁移来源，保留不删——回滚安全）
const LEGACY_PINNED_KEY = 'mirach.harness.sessions.pinned.v1'
const LEGACY_ORDER_KEY = 'mirach.harness.sessions.order.v1'
const LEGACY_GROUPS_KEY = 'mirach.harness.session-groups.v1'
const LEGACY_ARCHIVED_KEY = 'mirach.harness.sessions.archived.v1'
const LEGACY_SEEN_KEY = 'mirach.harness.sessions.seenCounts.v1'
const LEGACY_MARKERS_KEY = 'mirach.harness.sessions.unreadMarkers.v1'

const safeGetItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[session-catalog] localStorage 读取失败（${key}）`, e)
    return null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[session-catalog] localStorage 写入失败（${key}）`, e)
  }
}

// ── 严格解析（沿用三旧 store 的纪律：形状非法 console.error 从空态起） ────

const parseStringArray = (raw: string | null, label: string): string[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-catalog] ${label} JSON 解析失败——从空态起`, e)
    return []
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    console.error(`[session-catalog] ${label} 形状非法（应为 string[]）——从空态起`, parsed)
    return []
  }
  return [...new Set(parsed as string[])]
}

const parseNumberRecord = (raw: string | null, label: string): Record<string, number> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-catalog] ${label} JSON 解析失败——从空态起`, e)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[session-catalog] ${label} 形状非法（应为 Record<string, number>）——从空态起`, parsed)
    return {}
  }
  const out: Record<string, number> = {}
  for (const [id, rank] of Object.entries(parsed)) {
    if (typeof rank !== 'number' || !Number.isFinite(rank)) {
      console.error(`[session-catalog] ${label} 条目 ${id} 非法——跳过`, rank)
      continue
    }
    out[id] = rank
  }
  return out
}

const parseBooleanRecord = (raw: string | null, label: string): Record<string, boolean> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-catalog] ${label} JSON 解析失败——从全展开起`, e)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[session-catalog] ${label} 形状非法（应为 Record<string, boolean>）——从全展开起`, parsed)
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [id, collapsed] of Object.entries(parsed)) {
    if (typeof collapsed !== 'boolean') {
      console.error(`[session-catalog] ${label} 条目 ${id} 非法——跳过`, collapsed)
      continue
    }
    out[id] = collapsed
  }
  return out
}

// ── 类型 ─────────────────────────────────────────────────────────────────

export interface SessionCatalogEntry {
  id: string
  path?: string
  piName?: string
  derivedTitle?: string
  cwd?: string
  messageCount?: number
  lastModifiedMs?: number
  createdMs?: number
}

export interface SessionCatalogRow {
  id: string
  title?: string
  custom?: {
    path?: unknown
    cwd?: unknown
    messageCount?: unknown
    lastModifiedMs?: unknown
    timestamp?: unknown
  }
}

/** 未读判定的行输入（pi SessionMeta 投影：threadItems[].custom）。 */
export interface UnreadRowInput {
  readonly id: string
  readonly messageCount: number
}

/** 分区 id（侧栏两区渲染：已置顶 + 会话）。 */
export type SessionGroupId = 'pinned' | 'recent'

/** 拖拽落点所在列表组（hermes：置顶区与会话区各自独立可排，互不越组）。 */
export type SessionRowGroup = 'pinned' | 'recent'

export interface SessionCatalogState {
  // ── 目录（pi 投影，不持久化） ──
  entries: Record<string, SessionCatalogEntry>
  piOrder: string[]
  activeId: string | null
  pendingCwd: string | null
  // ── 管理维度（持久化） ──
  pinned: string[]
  manualOrder: Record<string, number>
  archived: string[]
  seen: Record<string, number>
  markers: string[]
  groupsCollapsed: Record<string, boolean>
  // ── 目录动作（runtime 唯一写入） ──
  ingest(rows: readonly SessionCatalogRow[], activeId: string | null): void
  setActive(id: string | null): void
  setDerivedTitle(id: string, title: string | undefined): void
  setPendingCwd(cwd: string | null): void
  // ── 管理动作（原三 store 语义迁入） ──
  togglePin(id: string): void
  setPinnedOrder(ids: readonly string[]): void
  setManualOrder(map: Readonly<Record<string, number>>): void
  toggleArchive(id: string): void
  ackSession(id: string, messageCount: number): void
  markSessionUnread(id: string): void
  ackAll(rows: readonly UnreadRowInput[]): void
  setGroupCollapsed(id: string, collapsed: boolean): void
  prune(existingIds: readonly string[]): void
}

const strOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

// ── 统一持久化 ───────────────────────────────────────────────────────────

interface PersistedSessions {
  pinned: string[]
  manualOrder: Record<string, number>
  archived: string[]
  seen: Record<string, number>
  markers: string[]
  groupsCollapsed: Record<string, boolean>
}

const loadPersisted = (): PersistedSessions => {
  const raw = safeGetItem(SESSION_STORE_KEY)
  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      console.error('[session-catalog] 统一持久化 JSON 解析失败——尝试旧键迁移', e)
      parsed = null
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const o = parsed as Partial<PersistedSessions>
      return {
        pinned: Array.isArray(o.pinned) ? (o.pinned as string[]) : [],
        manualOrder: typeof o.manualOrder === 'object' && o.manualOrder !== null ? (o.manualOrder as Record<string, number>) : {},
        archived: Array.isArray(o.archived) ? (o.archived as string[]) : [],
        seen: typeof o.seen === 'object' && o.seen !== null ? (o.seen as Record<string, number>) : {},
        markers: Array.isArray(o.markers) ? (o.markers as string[]) : [],
        groupsCollapsed:
          typeof o.groupsCollapsed === 'object' && o.groupsCollapsed !== null
            ? (o.groupsCollapsed as Record<string, boolean>)
            : {},
      }
    }
  }
  // 一次性迁移：旧五键 → 合成（新键已存在时不迁移）
  const legacy: PersistedSessions = {
    pinned: parseStringArray(safeGetItem(LEGACY_PINNED_KEY), '旧 pinned'),
    manualOrder: parseNumberRecord(safeGetItem(LEGACY_ORDER_KEY), '旧 order'),
    archived: parseStringArray(safeGetItem(LEGACY_ARCHIVED_KEY), '旧 archived'),
    seen: parseNumberRecord(safeGetItem(LEGACY_SEEN_KEY), '旧 seenCounts'),
    markers: parseStringArray(safeGetItem(LEGACY_MARKERS_KEY), '旧 unreadMarkers'),
    groupsCollapsed: parseBooleanRecord(safeGetItem(LEGACY_GROUPS_KEY), '旧 session-groups'),
  }
  const hasLegacy =
    legacy.pinned.length > 0 ||
    legacy.archived.length > 0 ||
    legacy.markers.length > 0 ||
    Object.keys(legacy.manualOrder).length > 0 ||
    Object.keys(legacy.seen).length > 0 ||
    Object.keys(legacy.groupsCollapsed).length > 0
  if (hasLegacy) {
    safeSetItem(SESSION_STORE_KEY, JSON.stringify(legacy))
  }
  return legacy
}

const persist = (s: PersistedSessions): void => {
  safeSetItem(SESSION_STORE_KEY, JSON.stringify(s))
}

// ── 未读判定（session-unread.ts isRowUnread 原样迁入） ────────────────────

export function isRowUnread(
  row: UnreadRowInput,
  seen: Readonly<Record<string, number>>,
  markers: readonly string[],
): boolean {
  if (markers.includes(row.id)) return true
  const watermark = seen[row.id]
  return row.messageCount > (watermark ?? 0)
}

// ── store ────────────────────────────────────────────────────────────────

const persisted0 = loadPersisted()

export const sessionCatalog = createStore<SessionCatalogState>((set, get) => ({
  entries: {},
  piOrder: [],
  activeId: null,
  pendingCwd: null,
  pinned: persisted0.pinned,
  manualOrder: persisted0.manualOrder,
  archived: persisted0.archived,
  seen: persisted0.seen,
  markers: persisted0.markers,
  groupsCollapsed: persisted0.groupsCollapsed,

  ingest: (rows, activeId) => {
    const prev = get().entries
    const entries: Record<string, SessionCatalogEntry> = {}
    const piOrder: string[] = []
    const seen = { ...get().seen }
    let seenChanged = false
    for (const row of rows) {
      const prior = prev[row.id]
      entries[row.id] = {
        id: row.id,
        path: strOrUndef(row.custom?.path) ?? prior?.path,
        piName: strOrUndef(row.title),
        derivedTitle: prior?.derivedTitle,
        cwd: strOrUndef(row.custom?.cwd),
        messageCount: numOrUndef(row.custom?.messageCount),
        lastModifiedMs: numOrUndef(row.custom?.lastModifiedMs),
        createdMs: numOrUndef(row.custom?.timestamp),
      }
      piOrder.push(row.id)
      // 未读播种（原 sessionUnreadStore.ingestRows 语义迁入）：选中恒跟踪、
      // 从未见按当前 count 播种（首见不亮绿）
      const count = numOrUndef(row.custom?.messageCount)
      if (count !== undefined) {
        if (activeId !== null && row.id === activeId) {
          if (seen[row.id] !== count) {
            seen[row.id] = count
            seenChanged = true
          }
        } else if (!(row.id in seen)) {
          seen[row.id] = count
          seenChanged = true
        }
      }
    }
    set({ entries, piOrder, activeId, ...(seenChanged ? { seen } : {}) })
    if (seenChanged) persist({ ...get(), seen })
  },
  setActive: (id) => set({ activeId: id }),
  setDerivedTitle: (id, title) => {
    const e = get().entries[id]
    if (!e) {
      if (title === undefined) return
      set({ entries: { ...get().entries, [id]: { id, derivedTitle: title } } })
      if (!get().piOrder.includes(id)) set({ piOrder: [...get().piOrder, id] })
      return
    }
    if (e.derivedTitle === title) return
    set({ entries: { ...get().entries, [id]: { ...e, derivedTitle: title } } })
  },
  setPendingCwd: (cwd) => set({ pendingCwd: cwd }),

  togglePin: (id) => {
    const next = togglePinId(get().pinned, id)
    set({ pinned: next })
    persist({ ...get(), pinned: next })
  },
  setPinnedOrder: (ids) => {
    const next = [...new Set(ids)]
    set({ pinned: next })
    persist({ ...get(), pinned: next })
  },
  setManualOrder: (map) => {
    set({ manualOrder: map })
    persist({ ...get(), manualOrder: map })
  },
  toggleArchive: (id) => {
    const next = get().archived.includes(id)
      ? get().archived.filter((x) => x !== id)
      : [...get().archived, id]
    set({ archived: next })
    persist({ ...get(), archived: next })
  },
  ackSession: (id, messageCount) => {
    const s = get()
    const seen = { ...s.seen, [id]: messageCount }
    const markers = s.markers.filter((m) => m !== id)
    set({ seen, markers })
    persist({ ...get(), seen, markers })
  },
  markSessionUnread: (id) => {
    if (get().markers.includes(id)) return
    const markers = [...get().markers, id]
    set({ markers })
    persist({ ...get(), markers })
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
    persist({ ...get(), seen, markers })
  },
  setGroupCollapsed: (id, collapsed) => {
    const groupsCollapsed = { ...get().groupsCollapsed, [id]: collapsed }
    set({ groupsCollapsed })
    persist({ ...get(), groupsCollapsed })
  },
  prune: (existingIds) => {
    if (existingIds.length === 0) return
    const s = get()
    const alive = new Set(existingIds)
    const pinned = prunePins(s.pinned, existingIds)
    const manualOrder = pruneOrder(s.manualOrder, existingIds)
    const archived = s.archived.filter((id) => alive.has(id))
    const markers = s.markers.filter((id) => alive.has(id))
    const seen: Record<string, number> = {}
    for (const [id, count] of Object.entries(s.seen)) {
      if (alive.has(id)) seen[id] = count
    }
    if (
      pinned.length === s.pinned.length &&
      Object.keys(manualOrder).length === Object.keys(s.manualOrder).length &&
      archived.length === s.archived.length &&
      markers.length === s.markers.length &&
      Object.keys(seen).length === Object.keys(s.seen).length
    ) {
      return
    }
    set({ pinned, manualOrder, archived, markers, seen })
    persist({ ...get(), pinned, manualOrder, archived, markers, seen })
  },
}))

// ── 统一选择器 ───────────────────────────────────────────────────────────

/** 统一显示名（所有消费方同源）：pi name ?? 派生标题 ?? New Chat。 */
export const sessionDisplayName = (e: SessionCatalogEntry | undefined): string =>
  e?.piName ?? e?.derivedTitle ?? 'New Chat'

/** 统一项目名来源：会话 cwd ?? 待落盘新会话 cwd。 */
export const sessionProjectCwd = (
  e: SessionCatalogEntry | undefined,
  pendingCwd: string | null,
): string | undefined => e?.cwd ?? pendingCwd ?? undefined

// ── React 订阅（原三 store 的 hook 别名——消费方只改 import 路径） ─────────

export const useSessionManage = <T,>(selector: (s: SessionCatalogState) => T): T =>
  useStore(sessionCatalog, selector)

export const useSessionArchive = <T,>(selector: (s: SessionCatalogState) => T): T =>
  useStore(sessionCatalog, selector)

export const useSessionUnread = <T,>(selector: (s: SessionCatalogState) => T): T =>
  useStore(sessionCatalog, selector)
