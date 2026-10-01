/**
 * 会话侧栏排序纯函数（置顶 + 手动顺序）。
 *
 * hermes 对照（apps/desktop/src/app/chat/sidebar/order.ts + store/session.ts）：
 * - hermes 置顶 = 后端 sessions.pinned keep 标志 + localStorage 手挑顺序；
 *   pi 无 pin 字段 → harness 全本地化（键见 session-manage-store.ts），
 *   置顶组内按最后活跃降序展示（任务定稿，非 hermes 的手挑 pin 顺序）。
 * - hermes 手动顺序折回 = mergeFreshByPosition（order.ts）：不在持久化顺序
 *   里的 id 按"相对第一个已排 id 的新近位置"折回——新会话不沉底、翻页的
 *   旧会话不跳顶。此处逐语义照抄（order 是 id→序号表，非 id 数组）。
 *
 * 数据源行 = {id, lastActiveMs}（aui threadItems[].custom.lastModifiedMs，
 * runtime.tsx refreshThreads 写入；缺 0）。
 */

export interface SessionRowMeta {
  readonly id: string
  readonly lastActiveMs: number
}

/** 最后活跃降序（同毫秒按 id 稳定排序——避免每次渲染顺序抖动） */
export const recencyCompare = (a: SessionRowMeta, b: SessionRowMeta): number =>
  b.lastActiveMs - a.lastActiveMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 置顶键清理：只留仍存在的会话（去重保序）——会话不存在于列表时清理键。 */
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

/** 置顶切换：已置顶移除；未置顶追加到尾。 */
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
 * 组合展示序：置顶组（pinned ∩ rows，按最后活跃降序——组内不跟手动顺序）+
 * 非置顶组（reconcileOrder 折手动顺序）。置顶组永远在非置顶组之上（调用方
 * 按返回的两段各自渲染，pinnedIds 在前）。
 */
export function orderedSessionIds(
  rows: readonly SessionRowMeta[],
  pinned: readonly string[],
  order: Readonly<Record<string, number>>,
): { pinnedIds: string[]; unpinnedIds: string[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const pinnedIds = prunePins(pinned, rows.map((r) => r.id))
    .map((id) => byId.get(id))
    .filter((r): r is SessionRowMeta => r !== undefined)
    .sort(recencyCompare)
    .map((r) => r.id)

  const pinnedSet = new Set(pinnedIds)
  const unpinnedRows = rows.filter((r) => !pinnedSet.has(r.id))
  const baseline = [...unpinnedRows].sort(recencyCompare).map((r) => r.id)
  const unpinnedIds = reconcileOrder(baseline, order)

  return { pinnedIds, unpinnedIds }
}

/**
 * 拖拽落点提交：给定当前行快照 + 现有顺序，算出移动后的序号表（全量重排
 * 0..n-1，顺带把此前靠折回定位的 id 收编进表）。仅非置顶行可排（置顶组
 * 固定活跃降序）——`sessionId` 已置顶（或不在非置顶序列里）时原样返回
 * 现有表，不产生写入。
 */
export function orderMapAfterMove(
  rows: readonly SessionRowMeta[],
  pinned: readonly string[],
  order: Readonly<Record<string, number>>,
  sessionId: string,
  beforeId: string | null,
): Record<string, number> {
  const { unpinnedIds } = orderedSessionIds(rows, pinned, order)
  if (!unpinnedIds.includes(sessionId)) return { ...order }
  return orderMapFromIds(moveBefore(unpinnedIds, sessionId, beforeId))
}
