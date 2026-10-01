/**
 * 会话侧栏展示行投影（纯函数）——hermes chat/sidebar/index.tsx 段
 * （pinnedSessions / unpinnedAgentSessions / trimmedQuery 三分支）+
 * sessions-section.tsx flatRows（groupEntriesByRecency →
 * orderRowsWithinGroups → hideCollapsedGroupRows）的管线照抄。
 *
 * 分组结构（hermes 定稿）：
 * - 搜索态：单一「结果」区（置顶/会话区整体不渲染），命中行按新近降序，
 *   无日期组、不可拖排（不可排序面）。
 * - 常态：已置顶区（$pinnedSessionIds 数组序＝展示序，组内可拖排）＋
 *   会话区（日期分隔线 + 手挑序在桶内应用 + 桶折叠）。
 */
import {
  groupEntriesByRecency,
  hideCollapsedGroupRows,
  orderRowsWithinGroups,
  type SessionListRow,
} from './session-date-groups'
import {
  prunePins,
  recencyCompare,
  reconcileOrder,
  type SessionRowMeta,
} from './session-order'

export interface SessionDisplayState {
  /** 置顶区行（pinned 数组序＝展示序，hermes pinSession 追加语义） */
  pinnedIds: string[]
  /** 会话区行（含日期分隔线；已应用桶内手动序与折叠） */
  rows: readonly SessionListRow[]
  /** 会话区全量非置顶展示序（含被折叠桶藏的行）——拖拽提交的 `allIds` */
  allUnpinnedIds: string[]
}

export interface SessionSearchState {
  /** 命中行（新近降序） */
  resultIds: string[]
}

const isHidden = (collapsed: Readonly<Record<string, boolean>>, key: string): boolean =>
  collapsed[key] === true

/** 常态分组投影。 */
export function buildSessionDisplay(
  metas: readonly SessionRowMeta[],
  pinned: readonly string[],
  order: Readonly<Record<string, number>>,
  collapsed: Readonly<Record<string, boolean>>,
  opts: { nowMs?: number; weekStartsOn?: number } = {},
): SessionDisplayState {
  const pinnedIds = prunePins(pinned, metas.map((m) => m.id))
  const pinnedSet = new Set(pinnedIds)
  const unpinned = metas.filter((m) => !pinnedSet.has(m.id)).sort(recencyCompare)
  const allUnpinnedIds = reconcileOrder(unpinned.map((m) => m.id), order)

  const grouped = groupEntriesByRecency(
    unpinned.map((m) => ({ id: m.id, ms: m.lastActiveMs })),
    opts,
  )
  // 手挑序在日期桶内应用（hermes：日历组留在新近给的位置，顺序只动桶内）。
  const reordered = orderRowsWithinGroups(grouped, allUnpinnedIds)
  // 折叠键 = 分隔线桶 key（'today'/'yesterday'/'this-week'/'m-2026-8'…）；
  // 未标名头部（第一条分隔线之前）永不折叠。
  const visible = hideCollapsedGroupRows(reordered, (key) => !isHidden(collapsed, key))

  return { pinnedIds, rows: visible, allUnpinnedIds }
}

/** 标题匹配（客户端子串；pi 无服务端 FTS——hermes searchSessions 那半
 *  不适用，本地这半对齐 sessionMatchesSearch 的小写子串语义）。 */
export function matchesTitleSearch(title: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (title || 'New Chat').toLowerCase().includes(q)
}

/** 搜索态投影（命中集按新近降序）。 */
export function buildSessionSearch(
  matchedMetas: readonly SessionRowMeta[],
): SessionSearchState {
  return {
    resultIds: [...matchedMetas].sort(recencyCompare).map((m) => m.id),
  }
}
