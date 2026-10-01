/**
 * 侧栏选项 store（hermes filter-menu 体系的数据面旋钮：分组 / 排序 /
 * 密度 + 手动序旗标）。zustand vanilla（createStore + useStore 订阅，
 * 照抄 session-manage-store 模式）。
 *
 * hermes 对照（apps/desktop/src/app/chat/sidebar/filter-menu.tsx +
 * store/layout.ts，file:line 见交接报告）：
 * - grouping：hermes SIDEBAR_GROUPING_ORDER = ['date','project','status',
 *   'profile']（layout.ts:255）；pi 无项目树/多配置档/状态桶 → 数据面仅剩
 *   date；'none'（平铺）为任务定稿补的选项（hermes 内部 grouping='none'
 *   形态存在但菜单未开放）。
 * - ordering：hermes updated/created/status/tokens/cost/manual
 *   （layout.ts:260）；pi 会话元数据只有 lastActiveMs + 标题（runtime
 *   custom 不带 created/token/cost）→ updated + title（任务定稿）。
 *   manual = 拖拽声明：hermes $sidebarOrdering = manual ? 'manual' :
 *   sortKey（layout.ts:390-393），菜单仅在 manual 激活时列出 Manual 项
 *   （filter-menu.tsx:207-213），选任意排序键 = 退出 manual **并清掉保存
 *   的手动序**（layout.ts:668-680 setSidebarOrdering）。
 * - 密度：hermes 无此选项（任务定稿新增）——comfortable（现行几何）/
 *   compact（行盒与分隔线上距收紧，令牌见 panes.css --tl-*）。
 *
 * 持久化（工程命名 mirach.harness.sidebar.*.v1）：
 * - grouping.v1 / ordering.v1（只存排序键，'manual' 不是持久键——
 *   manual.v1 才是）/ density.v1 / manual.v1。
 * - 迁移（loadInitialManual）：manual.v1 缺失且 sessions.order.v1 非空
 *   → manual=true——本特性上线前拖拽序无条件生效，非空 order 表即
 *   "手动序曾在生效"；一次性推导不回写（此后写入的 false 恒优先）。
 *
 * 禁止兜底：非法持久化形状 console.error 可见并回默认值（不冒充旧数据）。
 */
import { createStore, useStore } from 'zustand'

import { ORDER_KEY, parseOrder, sessionManageStore } from './session-manage-store'

export const SIDEBAR_GROUPING_KEY = 'mirach.harness.sidebar.grouping.v1'
export const SIDEBAR_ORDERING_KEY = 'mirach.harness.sidebar.ordering.v1'
export const SIDEBAR_DENSITY_KEY = 'mirach.harness.sidebar.density.v1'
export const SIDEBAR_MANUAL_KEY = 'mirach.harness.sidebar.manual.v1'

/** 分组模式（会话区）：date = 日历桶分隔线（默认）；none = 平铺。 */
export type SidebarGroupingMode = 'date' | 'none'
/** 排序键（manual 不是持久键——拖拽声明态走 manual 旗标）。 */
export type SidebarSortKey = 'title' | 'updated'
/** 菜单口径的排序模式（hermes SidebarOrdering 同构：manual 为拖拽声明）。 */
export type SidebarOrderingMode = SidebarSortKey | 'manual'
/** 行密度（任务定稿，hermes 无此选项）。 */
export type SidebarDensityMode = 'compact' | 'comfortable'

// ── hermes 常量同构：默认值声明一处，reset/-customized 判定共用不漂移 ──
export const SIDEBAR_DEFAULT_GROUPING: SidebarGroupingMode = 'date'
export const SIDEBAR_DEFAULT_ORDERING: SidebarSortKey = 'updated'
export const SIDEBAR_DEFAULT_DENSITY: SidebarDensityMode = 'comfortable'

const safeGetItem = (key: string): string | null => {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (e) {
    console.error(`[sidebar-view] localStorage 读取失败（${key}）`, e)
    return null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[sidebar-view] localStorage 写入失败（${key}）——选项不持久`, e)
  }
}

// ── 严格解析（形状非法 console.error + 默认值，不冒充旧数据）────────────

export const parseGrouping = (raw: string | null): SidebarGroupingMode => {
  if (raw === null) return SIDEBAR_DEFAULT_GROUPING
  if (raw === 'date' || raw === 'none') return raw
  console.error(`[sidebar-view] ${SIDEBAR_GROUPING_KEY} 形状非法（应为 date|none）——回默认`, raw)
  return SIDEBAR_DEFAULT_GROUPING
}

export const parseOrdering = (raw: string | null): SidebarSortKey => {
  if (raw === null) return SIDEBAR_DEFAULT_ORDERING
  if (raw === 'updated' || raw === 'title') return raw
  console.error(`[sidebar-view] ${SIDEBAR_ORDERING_KEY} 形状非法（应为 updated|title）——回默认`, raw)
  return SIDEBAR_DEFAULT_ORDERING
}

export const parseDensity = (raw: string | null): SidebarDensityMode => {
  if (raw === null) return SIDEBAR_DEFAULT_DENSITY
  if (raw === 'comfortable' || raw === 'compact') return raw
  console.error(`[sidebar-view] ${SIDEBAR_DENSITY_KEY} 形状非法（应为 comfortable|compact）——回默认`, raw)
  return SIDEBAR_DEFAULT_DENSITY
}

/** 手动序旗标（'true'/'false' 之外的形状报错回 false）。 */
export const parseManual = (raw: string | null): boolean => {
  if (raw === null) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[sidebar-view] ${SIDEBAR_MANUAL_KEY} 形状非法（应为 true|false）——回默认`, raw)
  return false
}

/**
 * 手动序旗标初始化（含迁移，纯函数供单测）：manual.v1 缺失时看
 * sessions.order.v1——非空即"手动序曾在生效"（本特性上线前拖拽序无条件
 * 生效的旧语义）；旗标存在则以旗标为准。
 */
export function loadInitialManual(manualRaw: string | null, orderRaw: string | null): boolean {
  if (manualRaw !== null) return parseManual(manualRaw)
  return Object.keys(parseOrder(orderRaw)).length > 0
}

// ── 排序纯函数（hermes store/sidebar-sort.ts 的 $sidebarSessionRankIds
//    同构：updated → 空排名，recency 即到达序；title → 标题字母序）──────

/** 行的参与排序名（空/缺省标题按 'New Chat'，与 matchesTitleSearch 同约定）。 */
export const sessionSortTitle = (title: string | undefined): string => (title && title.length > 0 ? title : 'New Chat')

const idCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// base 敏感度 = 大小写/声调不敏感（中英文混合标题的字母序）；numeric 让
// 内嵌数字按数值排（'会话 2' < '会话 10'）。同标题按 id 定序。
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 标题字母序比较（base 敏感度 Collator；同标题按 id 定序——渲染顺序稳定）。 */
export const titleCompare = (a: { id: string; title?: string }, b: { id: string; title?: string }): number =>
  titleCollator.compare(sessionSortTitle(a.title), sessionSortTitle(b.title)) || idCompare(a.id, b.id)

/**
 * 排序键 → 全量排名 id 序（hermes：排名在各面上"组内应用"——日期桶由
 * recency 钉死，排序只动桶内；空数组 = 不排名）。
 * - updated：[]（recency 即到达序，hermes sidebar-sort.ts:48-50 注释同款）
 * - title：标题字母序（titleCompare）
 */
export function rankIdsByOrdering(metas: readonly { id: string; title?: string }[], ordering: SidebarSortKey): string[] {
  if (ordering === 'updated') return []
  return [...metas].sort(titleCompare).map((m) => m.id)
}

// ── 视图状态 store ───────────────────────────────────────────────────────

interface SidebarViewState {
  grouping: SidebarGroupingMode
  /** 持久排序键（'manual' 不落这里——effectiveOrdering 组合 manual 旗标）。 */
  ordering: SidebarSortKey
  /** 拖拽声明的手动序（hermes $sidebarSessionOrderManual）。 */
  manual: boolean
  density: SidebarDensityMode
  setGrouping(grouping: SidebarGroupingMode): void
  /** 选排序键 = 退出手动序并清掉保存的手动序（hermes setSidebarOrdering
   *  逐语义：排序键是离开手挑序的唯一出口，旗标与序号表必须同弃）。 */
  setOrdering(ordering: SidebarSortKey): void
  /** 拖拽提交声明手动序（hermes setSidebarSessionOrderManual(true)；
   *  仅会话区拖拽调用——置顶区有自己的序，不涉排序键）。 */
  claimManual(): void
  setDensity(density: SidebarDensityMode): void
  /** hermes resetSidebarView 逐语义：全部旋钮回默认 + 清保存的手动序
   *  （不动日期桶折叠态——hermes 的节点开合表同样不在 reset 面）。 */
  resetView(): void
}

const loadManual = (): boolean => loadInitialManual(safeGetItem(SIDEBAR_MANUAL_KEY), safeGetItem(ORDER_KEY))

export const sidebarViewStore = createStore<SidebarViewState>((set, get) => ({
  grouping: parseGrouping(safeGetItem(SIDEBAR_GROUPING_KEY)),
  ordering: parseOrdering(safeGetItem(SIDEBAR_ORDERING_KEY)),
  manual: loadManual(),
  density: parseDensity(safeGetItem(SIDEBAR_DENSITY_KEY)),
  setGrouping: (grouping) => {
    set({ grouping })
    safeSetItem(SIDEBAR_GROUPING_KEY, grouping)
  },
  setOrdering: (ordering) => {
    set({ ordering, manual: false })
    safeSetItem(SIDEBAR_ORDERING_KEY, ordering)
    safeSetItem(SIDEBAR_MANUAL_KEY, 'false')
    sessionManageStore.getState().setOrder({})
  },
  claimManual: () => {
    if (get().manual) return
    set({ manual: true })
    safeSetItem(SIDEBAR_MANUAL_KEY, 'true')
  },
  setDensity: (density) => {
    set({ density })
    safeSetItem(SIDEBAR_DENSITY_KEY, density)
  },
  resetView: () => {
    set({ grouping: SIDEBAR_DEFAULT_GROUPING, ordering: SIDEBAR_DEFAULT_ORDERING, manual: false, density: SIDEBAR_DEFAULT_DENSITY })
    safeSetItem(SIDEBAR_GROUPING_KEY, SIDEBAR_DEFAULT_GROUPING)
    safeSetItem(SIDEBAR_ORDERING_KEY, SIDEBAR_DEFAULT_ORDERING)
    safeSetItem(SIDEBAR_MANUAL_KEY, 'false')
    safeSetItem(SIDEBAR_DENSITY_KEY, SIDEBAR_DEFAULT_DENSITY)
    sessionManageStore.getState().setOrder({})
  },
}))

/** React 订阅（组件层用；动作回调用 sidebarViewStore.getState()）。 */
export const useSidebarView = <T,>(selector: (s: SidebarViewState) => T): T => useStore(sidebarViewStore, selector)

/** 菜单口径的当前排序（hermes $sidebarOrdering 同构：manual 压过排序键）。 */
export const effectiveOrdering = (s: Pick<SidebarViewState, 'ordering' | 'manual'>): SidebarOrderingMode =>
  s.manual ? 'manual' : s.ordering

/**
 * 「重置为默认」是否值得提供（hermes $sidebarViewCustomized 同构：任何
 * 旋钮离开出厂值即为 true；比 filtersActive 宽——后者只看藏行的过滤器，
 * 我们无过滤数据面，恒 false 不设）。
 */
export function isSidebarViewCustomized(s: SidebarViewState): boolean {
  return (
    s.grouping !== SIDEBAR_DEFAULT_GROUPING ||
    effectiveOrdering(s) !== SIDEBAR_DEFAULT_ORDERING ||
    s.density !== SIDEBAR_DEFAULT_DENSITY
  )
}
