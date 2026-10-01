/**
 * 会话侧栏管理 store（置顶 + 手动顺序 + 行拖拽信号）。zustand vanilla
 * （createStore + useStore 订阅，照抄 branch-store / connection-store 模式）。
 *
 * 持久化（任务定稿键）：
 * - mirach.harness.sessions.pinned.v1 = sessionId 数组（置顶组）
 * - mirach.harness.sessions.order.v1 = Record<sessionId, 序号>（非置顶手动序）
 * - mirach.harness.session-groups.v1 = Record<组id, 是否折叠>（置顶/最近
 *   分组标题的折叠态；缺省 = 展开）
 *
 * 禁止兜底：读到的持久化形状非法 console.error 可见并从空态起（不冒充旧
 * 数据）；写入失败 console.error（不装成功）。prune 只在列表非空时清理
 * ——首帧 threads=[] 是"未加载"不是"已删光"，不得借机毁持久化。
 */
import { createStore, useStore } from 'zustand'

import { pruneOrder, prunePins, togglePinId } from './session-order'

export const PINNED_KEY = 'mirach.harness.sessions.pinned.v1'
export const ORDER_KEY = 'mirach.harness.sessions.order.v1'
export const GROUPS_KEY = 'mirach.harness.session-groups.v1'

/** 分组 id（侧栏两组渲染：置顶组 + 最近组）。 */
export type SessionGroupId = 'pinned' | 'recent'

const safeGetItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[session-manage] localStorage 读取失败（${key}）`, e)
    return null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[session-manage] localStorage 写入失败（${key}）——置顶/顺序不持久`, e)
  }
}

/** 严格解析置顶数组：非字符串数组 → console.error + 空组。 */
export const parsePinned = (raw: string | null): string[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-manage] ${PINNED_KEY} JSON 解析失败——从空置顶组起`, e)
    return []
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    console.error(`[session-manage] ${PINNED_KEY} 形状非法（应为 string[]）——从空置顶组起`, parsed)
    return []
  }
  return [...new Set(parsed as string[])]
}

/** 严格解析序号表：Record<string, 有限数> 之外 → console.error + 空表。 */
export const parseOrder = (raw: string | null): Record<string, number> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-manage] ${ORDER_KEY} JSON 解析失败——从空顺序起`, e)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[session-manage] ${ORDER_KEY} 形状非法（应为 Record<string, number>）——从空顺序起`, parsed)
    return {}
  }
  const out: Record<string, number> = {}
  for (const [id, rank] of Object.entries(parsed)) {
    if (typeof rank !== 'number' || !Number.isFinite(rank)) {
      console.error(`[session-manage] ${ORDER_KEY} 条目 ${id} 序号非法——跳过`, rank)
      continue
    }
    out[id] = rank
  }
  return out
}

/** 严格解析分组折叠表：Record<string, boolean> 之外 → console.error + 空表；
 * 非布尔条目逐条报错跳过（其余保留）。 */
export const parseGroups = (raw: string | null): Record<string, boolean> => {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[session-manage] ${GROUPS_KEY} JSON 解析失败——从全展开起`, e)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`[session-manage] ${GROUPS_KEY} 形状非法（应为 Record<string, boolean>）——从全展开起`, parsed)
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [id, collapsed] of Object.entries(parsed)) {
    if (typeof collapsed !== 'boolean') {
      console.error(`[session-manage] ${GROUPS_KEY} 条目 ${id} 折叠态非法（应为 boolean）——跳过`, collapsed)
      continue
    }
    out[id] = collapsed
  }
  return out
}

/** 行拖拽的落点信号：列表插入符（beforeId = 目标行 id，null = 尾部）或主会话页签。 */
export interface SessionDragState {
  readonly sessionId: string
  readonly target:
    | { readonly kind: 'list'; readonly beforeId: string | null }
    | { readonly kind: 'main-tab' }
}

interface SessionManageState {
  pinned: readonly string[]
  order: Readonly<Record<string, number>>
  /** 分组折叠态（组 id → 是否折叠；缺省 = 展开）。 */
  groupsCollapsed: Readonly<Record<string, boolean>>
  drag: SessionDragState | null
  togglePin(id: string): void
  setOrder(map: Readonly<Record<string, number>>): void
  /** 分组折叠切换（写通 GROUPS_KEY）。 */
  setGroupCollapsed(id: SessionGroupId, collapsed: boolean): void
  setDrag(drag: SessionDragState | null): void
  /** 清理已消失会话的键（列表非空才清，见文件头）。 */
  prune(existingIds: readonly string[]): void
}

const loadPinned = (): string[] => parsePinned(safeGetItem(PINNED_KEY))
const loadOrder = (): Record<string, number> => parseOrder(safeGetItem(ORDER_KEY))
const loadGroups = (): Record<string, boolean> => parseGroups(safeGetItem(GROUPS_KEY))

export const sessionManageStore = createStore<SessionManageState>((set, get) => ({
  pinned: loadPinned(),
  order: loadOrder(),
  groupsCollapsed: loadGroups(),
  drag: null,
  togglePin: (id) => {
    const next = togglePinId(get().pinned, id)
    set({ pinned: next })
    safeSetItem(PINNED_KEY, JSON.stringify(next))
  },
  setOrder: (map) => {
    set({ order: map })
    safeSetItem(ORDER_KEY, JSON.stringify(map))
  },
  setGroupCollapsed: (id, collapsed) => {
    const next = { ...get().groupsCollapsed, [id]: collapsed }
    set({ groupsCollapsed: next })
    safeSetItem(GROUPS_KEY, JSON.stringify(next))
  },
  setDrag: (drag) => set({ drag }),
  prune: (existingIds) => {
    if (existingIds.length === 0) return
    const s = get()
    const nextPins = prunePins(s.pinned, existingIds)
    const nextOrder = pruneOrder(s.order, existingIds)
    const pinsChanged = nextPins.length !== s.pinned.length
    const orderChanged = Object.keys(nextOrder).length !== Object.keys(s.order).length
    if (!pinsChanged && !orderChanged) return
    set({ pinned: nextPins, order: nextOrder })
    if (pinsChanged) safeSetItem(PINNED_KEY, JSON.stringify(nextPins))
    if (orderChanged) safeSetItem(ORDER_KEY, JSON.stringify(nextOrder))
  },
}))

/** React 订阅（组件层用；事件回调/拖拽机器用 sessionManageStore.getState()）。 */
export const useSessionManage = <T,>(selector: (s: SessionManageState) => T): T =>
  useStore(sessionManageStore, selector)
