/**
 * 侧栏选项 store（hermes filter-menu 体系的数据面旋钮：分组 / 排序 /
 * 显示 rowMeta / 已归档开关 / 密度 + 手动序旗标）。zustand vanilla
 * （createStore + useStore 订阅，照抄 session-manage-store 模式）。
 *
 * hermes 对照（apps/desktop/src/app/chat/sidebar/filter-menu.tsx +
 * store/layout.ts，file:line 见交接报告）：
 * - grouping：hermes SIDEBAR_GROUPING_ORDER = ['date','project','status',
 *   'profile']（layout.ts:255）；pi 无多配置档/状态桶 → 数据面 date +
 *   project（**按工作区分组：SessionMeta.cwd 是 pi header.cwd 的直投影，
 *   树状项目视图简化为 cwd 分组**）；'none'（平铺）为任务定稿补的选项
 *   （hermes 内部 grouping='none' 形态存在但菜单未开放）。
 * - ordering：hermes updated/created/status/tokens/cost/manual
 *   （layout.ts:260）；pi 会话元数据带 lastActiveMs + timestamp（created）
 *   + 标题 → updated + created + title；status/tokens/cost 排序键需要
 *   pi 无的 live 状态/每行用量入排序（tokens/cost 有 rowMeta 展示面但
 *   不做排序键——排序键是全表 rank，用量是懒拉缓存，混用会出现排序
 *   忽隐忽现）。manual = 拖拽声明：hermes $sidebarOrdering = manual ?
 *   'manual' : sortKey（layout.ts:390-393），菜单仅在 manual 激活时列出
 *   Manual 项（filter-menu.tsx:207-213），选任意排序键 = 退出 manual
 *   **并清掉保存的手动序**（layout.ts:668-680 setSidebarOrdering）。
 * - rowMeta（Show 子菜单，hermes $sidebarRowMeta layout.ts:319，默认
 *   ['preview','updated']）：pi 数据面支持 updated（行龄）/tokens/cost
 *   （pi stats 每文件聚合，懒拉）；preview 是卡片行专属（无 preview
 *   数据面）、pr/profile 无数据 → 不设。默认 ['updated']（hermes 默认
 *   里 preview 是 card-only，一行行形态只剩 updated）。
 * - showArchived（hermes $sidebarShowArchived）：客户端归档的显示开关。
 * - 密度：hermes 无此选项（任务定稿新增）——comfortable（现行几何）/
 *   compact（行盒与分隔线上距收紧，令牌见 panes.css --tl-*）。
 *
 * 持久化（工程命名 mirach.harness.sidebar.*.v1）：
 * - grouping.v1 / ordering.v1（只存排序键，'manual' 不是持久键——
 *   manual.v1 才是）/ rowMeta.v1 / showArchived.v1 / density.v1 /
 *   manual.v1。
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
export const SIDEBAR_ROWMETA_KEY = 'mirach.harness.sidebar.rowMeta.v1'
export const SIDEBAR_SHOW_ARCHIVED_KEY = 'mirach.harness.sidebar.showArchived.v1'
export const SIDEBAR_DENSITY_KEY = 'mirach.harness.sidebar.density.v1'
export const SIDEBAR_MANUAL_KEY = 'mirach.harness.sidebar.manual.v1'
export const SIDEBAR_INBOX_KEY = 'mirach.harness.sidebar.inbox.v1'
export const SIDEBAR_SHOW_ALL_KEY = 'mirach.harness.sidebar.showAll.v1'
export const SIDEBAR_PROJECT_FILTER_KEY = 'mirach.harness.sidebar.projectFilter.v1'

/** 分组模式（会话区）：date = 日历桶分隔线（默认）；project = 按工作区
 *  （cwd）分组；none = 平铺。 */
export type SidebarGroupingMode = 'date' | 'none' | 'project'
/** 排序键（manual 不是持久键——拖拽声明态走 manual 旗标）。 */
export type SidebarSortKey = 'title' | 'updated' | 'created'
/** 菜单口径的排序模式（hermes SidebarOrdering 同构：manual 为拖拽声明）。 */
export type SidebarOrderingMode = SidebarSortKey | 'manual'
/** 行密度（任务定稿，hermes 无此选项）。 */
export type SidebarDensityMode = 'compact' | 'comfortable'
/** 行尾可选项（hermes SidebarRowMeta 的数据面子集：updated = 行龄）。 */
export type SidebarRowMeta = 'cost' | 'tokens' | 'updated'

// ── hermes 常量同构：默认值声明一处，reset/-customized 判定共用不漂移 ──
export const SIDEBAR_DEFAULT_GROUPING: SidebarGroupingMode = 'date'
export const SIDEBAR_DEFAULT_ORDERING: SidebarSortKey = 'updated'
/** hermes SIDEBAR_DEFAULT_ROW_META = ['preview','updated']——preview 卡片
 *  专属，一行行形态的默认 = ['updated']。 */
export const SIDEBAR_DEFAULT_ROW_META: readonly SidebarRowMeta[] = ['updated']
export const SIDEBAR_DEFAULT_DENSITY: SidebarDensityMode = 'comfortable'
export const SIDEBAR_SHOW_ARCHIVED_DEFAULT = false

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
  if (raw === 'date' || raw === 'none' || raw === 'project') return raw
  console.error(`[sidebar-view] ${SIDEBAR_GROUPING_KEY} 形状非法（应为 date|project|none）——回默认`, raw)
  return SIDEBAR_DEFAULT_GROUPING
}

export const parseOrdering = (raw: string | null): SidebarSortKey => {
  if (raw === null) return SIDEBAR_DEFAULT_ORDERING
  if (raw === 'updated' || raw === 'title' || raw === 'created') return raw
  console.error(`[sidebar-view] ${SIDEBAR_ORDERING_KEY} 形状非法（应为 updated|created|title）——回默认`, raw)
  return SIDEBAR_DEFAULT_ORDERING
}

/** rowMeta 白名单过滤（hermes listOf(ROW_META) 逐语义：非法条目剔除——
 *  部分合法的列表保留合法部分，整串非法 JSON 才回默认）。 */
export const parseRowMeta = (raw: string | null): SidebarRowMeta[] => {
  if (raw === null) return [...SIDEBAR_DEFAULT_ROW_META]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[sidebar-view] ${SIDEBAR_ROWMETA_KEY} JSON 解析失败——回默认`, e)
    return [...SIDEBAR_DEFAULT_ROW_META]
  }
  if (!Array.isArray(parsed)) {
    console.error(`[sidebar-view] ${SIDEBAR_ROWMETA_KEY} 形状非法（应为 string[]）——回默认`, parsed)
    return [...SIDEBAR_DEFAULT_ROW_META]
  }
  const valid: SidebarRowMeta[] = []
  for (const item of parsed) {
    if (item === 'tokens' || item === 'cost' || item === 'updated') {
      if (!valid.includes(item)) valid.push(item)
    } else {
      console.error(`[sidebar-view] ${SIDEBAR_ROWMETA_KEY} 条目非法——剔除`, item)
    }
  }
  return valid
}

export const parseShowArchived = (raw: string | null): boolean => {
  if (raw === null) return SIDEBAR_SHOW_ARCHIVED_DEFAULT
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[sidebar-view] ${SIDEBAR_SHOW_ARCHIVED_KEY} 形状非法（应为 true|false）——回默认`, raw)
  return SIDEBAR_SHOW_ARCHIVED_DEFAULT
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

/** Inbox style（hermes $inboxStyle：卡片行形态——标题+行龄+消息数三行）。 */
export const parseInbox = (raw: string | null): boolean => {
  if (raw === null) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[sidebar-view] ${SIDEBAR_INBOX_KEY} 形状非法（应为 true|false）——回默认`, raw)
  return false
}

/** 显示所有会话（hermes 同名项：临时旁路过滤面——已归档+项目过滤全放行）。 */
export const parseShowAll = (raw: string | null): boolean => {
  if (raw === null) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[sidebar-view] ${SIDEBAR_SHOW_ALL_KEY} 形状非法（应为 true|false）——回默认`, raw)
  return false
}

/** 项目过滤（null=全部；字符串=仅该 cwd。JSON 形状严格）。 */
export const parseProjectFilter = (raw: string | null): string | null => {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed === 'string') return parsed
    console.error(`[sidebar-view] ${SIDEBAR_PROJECT_FILTER_KEY} 形状非法（应为 null|string）——回默认`, parsed)
    return null
  } catch (e) {
    console.error(`[sidebar-view] ${SIDEBAR_PROJECT_FILTER_KEY} JSON 解析失败——回默认`, e)
    return null
  }
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
//    同构：updated → 空排名，recency 即到达序；created → started_at 降序
//    （rankBy 'created' = -started_at）；title → 标题字母序）──────────────

/** 行的参与排序名（空/缺省标题按 'New Chat'，与 matchesTitleSearch 同约定）。 */
export const sessionSortTitle = (title: string | undefined): string => (title && title.length > 0 ? title : 'New Chat')

const idCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// base 敏感度 = 大小写/声调不敏感（中英文混合标题的字母序）；numeric 让
// 内嵌数字按数值排（'会话 2' < '会话 10'）。同标题按 id 定序。
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 标题字母序比较（base 敏感度 Collator；同标题按 id 定序——渲染顺序稳定）。 */
export const titleCompare = (a: { id: string; title?: string }, b: { id: string; title?: string }): number =>
  titleCollator.compare(sessionSortTitle(a.title), sessionSortTitle(b.title)) || idCompare(a.id, b.id)

/** 创建时间降序（hermes rankBy 'created'：-started_at——同毫秒按 id 定序）。 */
export const createdCompare = (
  a: { id: string; createdMs?: number },
  b: { id: string; createdMs?: number },
): number => (b.createdMs ?? 0) - (a.createdMs ?? 0) || idCompare(a.id, b.id)

/** 排序的行输入（createdMs 供 created 键；title 供 title 键）。 */
export interface SortRowInput {
  readonly id: string
  readonly title?: string
  readonly createdMs?: number
}

/**
 * 排序键 → 全量排名 id 序（hermes：排名在各面上"组内应用"——日期桶由
 * recency 钉死，排序只动桶内；空数组 = 不排名）。
 * - updated：[]（recency 即到达序，hermes sidebar-sort.ts:48-50 注释同款）
 * - created：创建时间降序（createdCompare）
 * - title：标题字母序（titleCompare）
 */
export function rankIdsByOrdering(metas: readonly SortRowInput[], ordering: SidebarSortKey): string[] {
  if (ordering === 'updated') return []
  const sorted = [...metas].sort(ordering === 'created' ? createdCompare : titleCompare)
  return sorted.map((m) => m.id)
}

// ── 视图状态 store ───────────────────────────────────────────────────────

interface SidebarViewState {
  grouping: SidebarGroupingMode
  /** 持久排序键（'manual' 不落这里——effectiveOrdering 组合 manual 旗标）。 */
  ordering: SidebarSortKey
  /** 拖拽声明的手动序（hermes $sidebarSessionOrderManual）。 */
  manual: boolean
  /** 行尾可选项（hermes $sidebarRowMeta：updated = 行龄 / tokens / cost）。 */
  rowMeta: readonly SidebarRowMeta[]
  /** 客户端归档行的显示开关（hermes $sidebarShowArchived）。 */
  showArchived: boolean
  density: SidebarDensityMode
  setGrouping(grouping: SidebarGroupingMode): void
  /** 选排序键 = 退出手动序并清掉保存的手动序（hermes setSidebarOrdering
   *  逐语义：排序键是离开手挑序的唯一出口，旗标与序号表必须同弃）。 */
  setOrdering(ordering: SidebarSortKey): void
  /** 拖拽提交声明手动序（hermes setSidebarSessionOrderManual(true)；
   *  仅会话区拖拽调用——置顶区有自己的序，不涉排序键）。 */
  claimManual(): void
  /** 行尾可选项切换（hermes toggleSidebarRowMeta = toggleIn）。 */
  toggleRowMeta(meta: SidebarRowMeta): void
  setShowArchived(show: boolean): void
  setDensity(density: SidebarDensityMode): void
  /** Inbox style（hermes $inboxStyle：卡片行形态开关）。 */
  inboxStyle: boolean
  setInboxStyle(on: boolean): void
  /** 显示所有会话（hermes 同名项：临时旁路已归档/项目过滤）。 */
  showAll: boolean
  setShowAll(on: boolean): void
  /** 项目过滤（hermes Filters>Project 的 pi 等价：null=全部，字符串=仅该 cwd）。 */
  projectFilter: string | null
  setProjectFilter(cwd: string | null): void
  /** hermes resetSidebarView 逐语义：全部旋钮回默认 + 清保存的手动序
   *  （不动日期桶折叠态——hermes 的节点开合表同样不在 reset 面）。 */
  resetView(): void
}

const loadManual = (): boolean => loadInitialManual(safeGetItem(SIDEBAR_MANUAL_KEY), safeGetItem(ORDER_KEY))

export const sidebarViewStore = createStore<SidebarViewState>((set, get) => ({
  grouping: parseGrouping(safeGetItem(SIDEBAR_GROUPING_KEY)),
  ordering: parseOrdering(safeGetItem(SIDEBAR_ORDERING_KEY)),
  manual: loadManual(),
  rowMeta: parseRowMeta(safeGetItem(SIDEBAR_ROWMETA_KEY)),
  showArchived: parseShowArchived(safeGetItem(SIDEBAR_SHOW_ARCHIVED_KEY)),
  density: parseDensity(safeGetItem(SIDEBAR_DENSITY_KEY)),
  inboxStyle: parseInbox(safeGetItem(SIDEBAR_INBOX_KEY)),
  showAll: parseShowAll(safeGetItem(SIDEBAR_SHOW_ALL_KEY)),
  projectFilter: parseProjectFilter(safeGetItem(SIDEBAR_PROJECT_FILTER_KEY)),
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
  toggleRowMeta: (meta) => {
    const current = get().rowMeta
    const next = current.includes(meta)
      ? current.filter((m) => m !== meta)
      : [...current, meta]
    set({ rowMeta: next })
    safeSetItem(SIDEBAR_ROWMETA_KEY, JSON.stringify(next))
  },
  setShowArchived: (showArchived) => {
    set({ showArchived })
    safeSetItem(SIDEBAR_SHOW_ARCHIVED_KEY, showArchived ? 'true' : 'false')
  },
  setDensity: (density) => {
    set({ density })
    safeSetItem(SIDEBAR_DENSITY_KEY, density)
  },
  setInboxStyle: (inboxStyle) => {
    set({ inboxStyle })
    safeSetItem(SIDEBAR_INBOX_KEY, inboxStyle ? 'true' : 'false')
  },
  setShowAll: (showAll) => {
    set({ showAll })
    safeSetItem(SIDEBAR_SHOW_ALL_KEY, showAll ? 'true' : 'false')
  },
  setProjectFilter: (projectFilter) => {
    set({ projectFilter })
    safeSetItem(SIDEBAR_PROJECT_FILTER_KEY, JSON.stringify(projectFilter))
  },
  resetView: () => {
    set({
      grouping: SIDEBAR_DEFAULT_GROUPING,
      ordering: SIDEBAR_DEFAULT_ORDERING,
      manual: false,
      rowMeta: [...SIDEBAR_DEFAULT_ROW_META],
      showArchived: SIDEBAR_SHOW_ARCHIVED_DEFAULT,
      density: SIDEBAR_DEFAULT_DENSITY,
      inboxStyle: false,
      showAll: false,
      projectFilter: null,
    })
    safeSetItem(SIDEBAR_GROUPING_KEY, SIDEBAR_DEFAULT_GROUPING)
    safeSetItem(SIDEBAR_ORDERING_KEY, SIDEBAR_DEFAULT_ORDERING)
    safeSetItem(SIDEBAR_MANUAL_KEY, 'false')
    safeSetItem(SIDEBAR_ROWMETA_KEY, JSON.stringify([...SIDEBAR_DEFAULT_ROW_META]))
    safeSetItem(SIDEBAR_SHOW_ARCHIVED_KEY, String(SIDEBAR_SHOW_ARCHIVED_DEFAULT))
    safeSetItem(SIDEBAR_DENSITY_KEY, SIDEBAR_DEFAULT_DENSITY)
    safeSetItem(SIDEBAR_INBOX_KEY, 'false')
    safeSetItem(SIDEBAR_SHOW_ALL_KEY, 'false')
    safeSetItem(SIDEBAR_PROJECT_FILTER_KEY, 'null')
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
 * 旋钮离开出厂值即为 true——hermes resetSidebarView 一并复位 rowMeta
 * （layout.ts:732），故 customized 面同含 rowMeta；showArchived 是过滤器
 * 非视图旋钮，与 hermes filtersActive 的分面一致不进 reset）。
 */
export function isSidebarViewCustomized(s: SidebarViewState): boolean {
  return (
    s.grouping !== SIDEBAR_DEFAULT_GROUPING ||
    effectiveOrdering(s) !== SIDEBAR_DEFAULT_ORDERING ||
    !rowMetaEquals(s.rowMeta, SIDEBAR_DEFAULT_ROW_META) ||
    s.density !== SIDEBAR_DEFAULT_DENSITY
  )
}

const rowMetaEquals = (a: readonly SidebarRowMeta[], b: readonly SidebarRowMeta[]): boolean =>
  a.length === b.length && b.every((m) => a.includes(m))
