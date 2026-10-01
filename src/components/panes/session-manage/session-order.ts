/**
 * 会话侧栏排序纯函数（置顶 + 手动顺序 + 日期组内应用序）。
 *
 * hermes 对照（apps/desktop/src/app/chat/sidebar/order.ts + store/layout.ts）：
 * - hermes 置顶 = localStorage $pinnedSessionIds **数组顺序即展示顺序**
 *   （pinSession 追加到尾、置顶组内可拖排 reorderPinned）；pi 无 pin 字段
 *   → harness 全本地化（键见 session-manage-store.ts）。组内不再按活跃
 *   降序（上一轮自创，与 hermes 相悖，本轮对齐）。
 * - hermes 手动顺序折回 = mergeFreshByPosition（order.ts）：不在持久化顺序
 *   里的 id 按"相对第一个已排 id 的新近位置"折回——新会话不沉底、翻页的
 *   旧会话不跳顶。此处逐语义照抄（order 是 id→序号表，非 id 数组）。
 * - 日期组内应用手动序 = orderRowsWithinGroups（session-date-groups.ts，
 *   逐语义照抄）：日历桶由新近性钉死，手动顺序只决定桶内次序。
 *
 * 数据源行 = {id, lastActiveMs}（aui threadItems[].custom.lastModifiedMs，
 * runtime.tsx refreshThreads 写入；缺 0）。cwd/createdMs/messageCount 来自
 * pi SessionMeta 的同键投影（工作区分组/created 排序/未读水位用；缺省
 * 按无数据处理——createdMs 缺省 0、cwd 缺省归 Home 桶）。
 */

export interface SessionRowMeta {
  readonly id: string
  readonly lastActiveMs: number
  /** 会话标题（排序键 title 用；缺省行按 'New Chat' 兜底名参与，与
   *  matchesTitleSearch 同约定——不改 recencyCompare 的键）。 */
  readonly title?: string
  /** 会话文件路径（pi SessionMeta.path；导出/用量缓存键用）。 */
  readonly path?: string
  /** 会话工作区（pi SessionMeta.cwd = header.cwd；工作区分组键）。 */
  readonly cwd?: string
  /** 创建时刻 ms（pi header.timestamp 的 Date.parse；排序键 created 用）。 */
  readonly createdMs?: number
  /** 消息条数（pi SessionMeta.messageCount；未读水位/用量过期键用）。 */
  readonly messageCount?: number
}

/** 最后活跃降序（同毫秒按 id 稳定排序——避免每次渲染顺序抖动） */
export const recencyCompare = (a: SessionRowMeta, b: SessionRowMeta): number =>
  b.lastActiveMs - a.lastActiveMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 置顶键清理：只留仍存在的会话（去重保序——数组序=展示序，hermes 语义）。 */
export function prunePins(
  pinned: readonly string[],
  existingIds: readonly string[],
): string[] {
  const alive = new Set(existingIds)
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of pinned) {
    if (!alive.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 置顶切换（hermes pinSession/unpinSession）：已置顶移除；未置顶追加到尾。 */
export function togglePinId(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]
}

/** 手动顺序清理：剔除已消失的会话与非有限序号（形状非法不回写）。 */
export function pruneOrder(
  order: Readonly<Record<string, number>>,
  existingIds: readonly string[],
): Record<string, number> {
  const alive = new Set(existingIds)
  const out: Record<string, number> = {}
  for (const [id, rank] of Object.entries(order)) {
    if (!alive.has(id) || !Number.isFinite(rank)) continue
    out[id] = rank
  }
  return out
}

/**
 * 把不在 `order` 里的 id 折回新近序列（hermes order.ts
 * mergeFreshByPosition 逐语义）：已知 id 按序号升序居中；比第一个已知 id
 * 更新的（基线里在其之前的）置顶，其余沉尾。`order` 内重复序号按 id 稳定。
 */
export function reconcileOrder(
  recencyIds: readonly string[],
  order: Readonly<Record<string, number>>,
): string[] {
  const current = [...new Set(recencyIds)]
  if (current.length === 0) return []

  const ranked = Object.entries(order)
    .filter(([id, rank]) => Number.isFinite(rank) && current.includes(id))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id)
  const keptIds = [...new Set(ranked)]

  if (keptIds.length === 0) return current

  const kept = new Set(keptIds)
  const firstKept = current.findIndex((id) => kept.has(id))
  const newer: string[] = []
  const older: string[] = []
  current.forEach((id, index) => {
    if (kept.has(id)) return
    if (firstKept >= 0 && index < firstKept) newer.push(id)
    else older.push(id)
  })

  return [...newer, ...keptIds, ...older]
}

/** 序列内移动：`id` 移到 `beforeId` 之前（null = 尾部）；id 不在序列原样返回。 */
export function moveBefore(
  ids: readonly string[],
  id: string,
  beforeId: string | null,
): string[] {
  if (!ids.includes(id)) return [...ids]
  const rest = ids.filter((x) => x !== id)
  if (beforeId === null) return [...rest, id]
  const at = rest.indexOf(beforeId)
  if (at < 0) return [...rest, id]
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** 序列 → 序号表（0 起）。 */
export function orderMapFromIds(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  ids.forEach((id, index) => {
    out[id] = index
  })
  return out
}

/**
 * 把新的可见 id 顺序拼回全量序列（hermes order.ts mergeVisibleReorder
 * 逐语义）——折叠桶里没渲染的 id 原地不动，拖拽不得毁它们的排序。
 */
export function mergeVisibleReorder(
  allIds: readonly string[],
  nextVisibleIds: readonly string[],
): string[] {
  if (nextVisibleIds.length === allIds.length) return [...nextVisibleIds]
  const visible = new Set(nextVisibleIds)
  let i = 0
  return allIds.map((id) => (visible.has(id) ? (nextVisibleIds[i++] ?? id) : id))
}

/**
 * 非置顶组拖拽落点提交（hermes persistSessionOrder 语义：可见序 → 全量序
 * → 持久化）：
 * - `allIds` = 全量非置顶展示序（reconcileOrder(新近基线, order)——含被
 *   折叠桶藏起来的行）；
 * - `visibleIds` = 当前渲染的会话行 id（日期组按组序展开后）；
 * - 落点 `beforeId`（null = 尾部）先改可见序，再拼回全量序存成序号表。
 * 折叠桶藏行不因此丢排序（mergeVisibleReorder 保位）。
 */
export function commitRecentMove(
  allIds: readonly string[],
  visibleIds: readonly string[],
  sessionId: string,
  beforeId: string | null,
): Record<string, number> {
  const nextVisible = moveBefore(visibleIds, sessionId, beforeId)
  return orderMapFromIds(mergeVisibleReorder(allIds, nextVisible))
}
