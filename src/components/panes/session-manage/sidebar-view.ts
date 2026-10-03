/**
 * 侧栏选项 store（hermes filter-menu 体系的数据面旋钮：分组 / 排序 /
 * 显示 rowMeta / 状态筛选 / 已归档开关 + 手动序旗标）。zustand vanilla
 * （createStore + useStore 订阅，照抄 session-manage-store 模式）。
 *
 * hermes 真实结构对照（apps/desktop/src/app/chat/sidebar/filter-menu.tsx +
 * store/layout.ts + store/session-dot-state.ts + store/sidebar-sort.ts，
 * file:line 见交接报告）：用户五张截图钉死的菜单 1-14 项——
 * - grouping：hermes SIDEBAR_GROUPING_ORDER = ['date','project','status',
 *   'profile']（layout.ts:255），菜单第 1 项「分组 ▸」子菜单 = 更新时间/
 *   项目/状态/网关与配置（'profile' 的菜单标签 = 网关与配置，zh
 *   gatewayGroups.grouping）。harness 类型同构四值；**网关与配置在 pi 数据
 *   面无语义（单配置档案、SessionMeta 无 provider）→ 菜单项 disabled 不发
 *   （任务定稿"不做+disabled"）**；持久化里出现 → 非法回默认。
 * - ordering：hermes updated/created/status/tokens/cost/manual
 *   （layout.ts:260 + sidebar-sort.ts rankBy）。**菜单四值 = updated/
 *   created/status/tokens（无标题字母序、无手动、无成本——用户截图）**；
 *   manual = 拖拽声明：hermes $sidebarOrdering = manual ? 'manual' :
 *   sortKey（layout.ts:390-393），菜单不再展示「手动」项但拖拽即启用
 *   拖拽序语义照旧（claimManual）；选任意排序键 = 退出 manual 并清掉保存
 *   的手动序（layout.ts:668-680）。status/tokens 排序键 = 本地可接
 *   （hermes rankBy 'status' = sessionStatusRank、'tokens' =
 *   -(input+output)，sidebar-sort.ts:25-29）：状态 rank 用五桶判定
 *   （session-status.ts），词元数用 session-usage 懒拉缓存（未拉到的行按
 *   0 参与沉底、拉取到达后上浮——懒拉与排序键混用的既定语义）。
 * - rowMeta（Show 子菜单，hermes $sidebarRowMeta layout.ts:319）：菜单 =
 *   更新时间/词元数 + PR/配置档案 disabled（pi 无 gh、单配置档案——用户
 *   截图钉死，无成本）。数据面 = tokens/updated 两值；cost 从白名单剔除
 *   （旧持久化条目 console.error 可见后丢弃）。
 * - statusFilter（Filters>Status，第 7 项）：hermes 是五桶 checkbox 多选
 *   （needs-input/working/unread/draft/idle，layout.ts:352 持久化 +
 *   session-dot-state.ts:84 SessionStatusBucket）。pi 前端全可判定
 *   （needsInput=审批卡挂起 / working=isRunning / unread=水位 /
 *   draft=messageCount 0 / idle=其余，session-status.ts）→ 五桶多选接入；
 *   空数组 = 不过滤（hermes persistentAtom 初值 []），随 hermes 持久化。
 * - showArchived（hermes $sidebarShowArchived）：客户端归档的显示开关。
 * - 「全部配置档案」（第 10 项，hermes $showAllProfiles store/profile.ts）：
 *   pi 单 profile → checkbox 显示且恒 ✓（诚实，disabled 不可取消）——原
 *   showAll（显示所有会话）旋钮整体删除（任务定稿改名对齐）。
 * - 密度：hermes 无此选项（工程旋钮）——comfortable（现行几何）/ compact
 *   （行盒与分隔线上距收紧，令牌见 panes.css --tl-*）；菜单不再展示该
 *   项，store 保留（localStorage 仍可用）。
 *
 * 持久化（工程命名 mirach.harness.sidebar.*.v1）：
 * - grouping.v1 / ordering.v1（只存排序键，'manual' 不是持久键——
 *   manual.v1 才是）/ rowMeta.v1 / showArchived.v1 / density.v1 /
 *   manual.v1 / statusFilter.v1（五桶数组，hermes 同款持久）。
 * - 迁移（loadInitialManual）：manual.v1 缺失且 sessions.order.v1 非空
 *   → manual=true——本特性上线前拖拽序无条件生效，非空 order 表即
 *   "手动序曾在生效"；一次性推导不回写（此后写入的 false 恒优先）。
 *
 * 禁止兜底：非法持久化形状 console.error 可见并回默认值（不冒充旧数据）；
 * 排序键缺必需的辅助面（status 无 statusBuckets / tokens 无 tokenTotals）
 * 直接 throw（菜单在配齐辅助面前不发这两个键——发出来了即接线 bug）。
 */
import { createStore, useStore } from 'zustand'

import {
  sessionStatusRank,
  type SessionStatusBucket,
} from './session-status'
import { sessionCatalog } from './session-catalog'

export const SIDEBAR_GROUPING_KEY = 'mirach.harness.sidebar.grouping.v1'
export const SIDEBAR_ORDERING_KEY = 'mirach.harness.sidebar.ordering.v1'
export const SIDEBAR_ROWMETA_KEY = 'mirach.harness.sidebar.rowMeta.v1'
export const SIDEBAR_SHOW_ARCHIVED_KEY = 'mirach.harness.sidebar.showArchived.v1'
export const SIDEBAR_DENSITY_KEY = 'mirach.harness.sidebar.density.v1'
export const SIDEBAR_MANUAL_KEY = 'mirach.harness.sidebar.manual.v1'
export const SIDEBAR_INBOX_KEY = 'mirach.harness.sidebar.inbox.v1'
export const SIDEBAR_STATUS_FILTER_KEY = 'mirach.harness.sidebar.statusFilter.v1'
export const SIDEBAR_PROJECT_FILTER_KEY = 'mirach.harness.sidebar.projectFilter.v1'

/** 分组模式（会话区；hermes SIDEBAR_GROUPING_ORDER 四值同构）：
 *  date = 日历桶分隔线（默认）；project = 按工作区（cwd）分组；
 *  status = 按状态桶分组；gateway = 网关与配置（pi 单配置档案——菜单
 *  disabled，持久化中出现按非法回默认）。 */
export type SidebarGroupingMode = 'date' | 'gateway' | 'project' | 'status'
/** 排序键（菜单四值 = 持久键；manual 不是持久键——拖拽声明态走 manual 旗标）。 */
export type SidebarSortKey = 'created' | 'status' | 'tokens' | 'updated'
/** 排序全模式（排序键 + 拖拽声明 manual——展示管线消费的有效序）。 */
export type SidebarOrderingMode = SidebarSortKey | 'manual'
/** 行密度（工程旋钮，hermes 无此选项）。 */
export type SidebarDensityMode = 'compact' | 'comfortable'
/** 行尾可选项（hermes SidebarRowMeta 的 pi 数据面子集：updated = 行龄 /
 *  tokens = 词元数；PR/配置档案/成本在 pi 无数据面，菜单禁用不设）。 */
export type SidebarRowMeta = 'tokens' | 'updated'
/** 状态筛选（hermes $sidebarStatusFilter 同构：空 = 不过滤，非空 = 只显示
 *  命中桶的行）。 */
export type SidebarStatusFilter = readonly SessionStatusBucket[]

// ── hermes 常量同构：默认值声明一处，reset/-customized 判定共用不漂移 ──
export const SIDEBAR_DEFAULT_GROUPING: SidebarGroupingMode = 'date'
export const SIDEBAR_DEFAULT_ORDERING: SidebarSortKey = 'updated'
/** hermes SIDEBAR_DEFAULT_ROW_META = ['preview','updated']——preview 卡片
 *  专属，一行行形态的默认 = ['updated']。 */
export const SIDEBAR_DEFAULT_ROW_META: readonly SidebarRowMeta[] = ['updated']
export const SIDEBAR_DEFAULT_DENSITY: SidebarDensityMode = 'comfortable'
export const SIDEBAR_SHOW_ARCHIVED_DEFAULT = false
/** hermes $sidebarStatusFilter 初值 []（layout.ts:352——空 = 不过滤）。 */
export const SIDEBAR_DEFAULT_STATUS_FILTER: SidebarStatusFilter = []

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
  if (raw === 'date' || raw === 'project' || raw === 'status') return raw
  console.error(
    `[sidebar-view] ${SIDEBAR_GROUPING_KEY} 形状非法（应为 date|project|status；gateway 在 pi 数据面无语义）——回默认`,
    raw,
  )
  return SIDEBAR_DEFAULT_GROUPING
}

export const parseOrdering = (raw: string | null): SidebarSortKey => {
  if (raw === null) return SIDEBAR_DEFAULT_ORDERING
  if (raw === 'updated' || raw === 'created' || raw === 'status' || raw === 'tokens') return raw
  console.error(
    `[sidebar-view] ${SIDEBAR_ORDERING_KEY} 形状非法（应为 updated|created|status|tokens）——回默认`,
    raw,
  )
  return SIDEBAR_DEFAULT_ORDERING
}

/** rowMeta 白名单过滤（hermes listOf(ROW_META) 逐语义：非法条目剔除——
 *  部分合法的列表保留合法部分，整串非法 JSON 才回默认）。cost/pr/profile
 *  自任务定稿起无数据面，出现即报错剔除。 */
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
    if (item === 'tokens' || item === 'updated') {
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

/** Inbox style（hermes「收件箱样式」：卡片行形态——标题+时间+消息数行）。 */
export const parseInbox = (raw: string | null): boolean => {
  if (raw === null) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[sidebar-view] ${SIDEBAR_INBOX_KEY} 形状非法（应为 true|false）——回默认`, raw)
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

/** 状态筛选解析（hermes $sidebarStatusFilter 的 string[] 持久化：桶白名单
 *  过滤 + 去重保序；整串非法 JSON 回空）。 */
export const parseStatusFilter = (raw: string | null): SidebarStatusFilter => {
  if (raw === null) return [...SIDEBAR_DEFAULT_STATUS_FILTER]
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[sidebar-view] ${SIDEBAR_STATUS_FILTER_KEY} JSON 解析失败——回默认`, e)
    return [...SIDEBAR_DEFAULT_STATUS_FILTER]
  }
  if (!Array.isArray(parsed)) {
    console.error(`[sidebar-view] ${SIDEBAR_STATUS_FILTER_KEY} 形状非法（应为 SessionStatusBucket[]）——回默认`, parsed)
    return [...SIDEBAR_DEFAULT_STATUS_FILTER]
  }
  const buckets: SessionStatusBucket[] = []
  for (const item of parsed) {
    if (item === 'needs-input' || item === 'working' || item === 'unread' || item === 'draft' || item === 'idle') {
      if (!buckets.includes(item)) buckets.push(item)
    } else {
      console.error(`[sidebar-view] ${SIDEBAR_STATUS_FILTER_KEY} 条目非法——剔除`, item)
    }
  }
  return buckets
}

/**
 * 手动序旗标初始化（含迁移，纯函数供单测）：manual.v1 缺失时看手动序表
 * （catalog.manualOrder——旧 sessions.order.v1 已迁入统一键）——非空即
 * "手动序曾在生效"（本特性上线前拖拽序无条件生效的旧语义）；旗标存在则
 * 以旗标为准。
 */
export function loadInitialManual(
  manualRaw: string | null,
  orderRecord: Record<string, unknown>,
): boolean {
  if (manualRaw !== null) return parseManual(manualRaw)
  return Object.keys(orderRecord).length > 0
}

// ── 排序纯函数（hermes store/sidebar-sort.ts 的 $sidebarSessionRankIds
//    同构：updated → 空排名，recency 即到达序；created → started_at 降序
//    （rankBy 'created' = -started_at）；status → sessionStatusRank 升序
//    （sidebar-sort.ts:25-27）；tokens → -(input+output) 降序
//    （sidebar-sort.ts:28-29）。tie = recency（hermes 依赖 [...sessions]
//    的新近基准序 + 稳定 sort；此处显式补二级键）────────────────────────

/** 行的参与排序名（空/缺省标题按 'New Chat'，与 matchesTitleSearch 同约定）。 */
export const sessionSortTitle = (title: string | undefined): string =>
  title && title.length > 0 ? title : 'New Chat'

const idCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** 创建时间降序（hermes rankBy 'created'：-started_at——同毫秒按 id 定序）。 */
export const createdCompare = (
  a: { id: string; createdMs?: number },
  b: { id: string; createdMs?: number },
): number => (b.createdMs ?? 0) - (a.createdMs ?? 0) || idCompare(a.id, b.id)

/** 排序的行输入（createdMs 供 created 键；lastActiveMs 供 status/tokens
 *  的 tie-recency——全量 metas 自带）。 */
export interface SortRowInput {
  readonly id: string
  readonly createdMs?: number
  readonly lastActiveMs?: number
}

/** 排序键的辅助面（status/tokens 键必需；缺 = 接线 bug，throw 可见）。 */
export interface OrderAux {
  /** id → 状态桶（session-status.ts 判定结果）。 */
  readonly statusBuckets?: ReadonlyMap<string, SessionStatusBucket>
  /** id → 词元总数（session-usage 缓存的 totalTokens）。 */
  readonly tokenTotals?: ReadonlyMap<string, number>
}

const bucketOfRanked = (buckets: ReadonlyMap<string, SessionStatusBucket>, id: string): SessionStatusBucket => {
  const bucket = buckets.get(id)
  if (bucket === undefined) {
    throw new Error(`[sidebar-view] status 排序的行缺状态桶（${id}）——statusBuckets 必须覆盖全部行`)
  }
  return bucket
}

/**
 * 排序键 → 全量排名 id 序（hermes：排名在各面上"组内应用"——日期桶由
 * recency 钉死，排序只动桶内；空数组 = 不排名）。
 * - updated：[]（recency 即到达序，hermes sidebar-sort.ts:48-50 注释同款）
 * - created：创建时间降序（createdCompare）
 * - status：状态 rank 升序（needs-input > working > unread > draft > idle），
 *   tie 按新近降序（hermes 稳定 sort 的新近基准序）
 * - tokens：词元数降序，未拉到用量的行按 0 沉底（session-usage 懒拉——
 *   拉取到达后排序自然上浮），tie 按新近降序
 */
export function rankIdsByOrdering(
  metas: readonly SortRowInput[],
  ordering: SidebarSortKey,
  aux?: OrderAux,
): string[] {
  if (ordering === 'updated') return []

  if (ordering === 'created') {
    return [...metas].sort(createdCompare).map((m) => m.id)
  }

  // 二级键 = 新近降序（hermes 的排序在新近基准序上做稳定 sort 的同构）。
  const recencyTie = (a: SortRowInput, b: SortRowInput): number =>
    (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || idCompare(a.id, b.id)

  if (ordering === 'status') {
    const buckets = aux?.statusBuckets
    if (!buckets) {
      throw new Error('[sidebar-view] status 排序需要 aux.statusBuckets（五桶判定面）')
    }
    return [...metas].sort(
      (a, b) =>
        sessionStatusRank(bucketOfRanked(buckets, a.id)) -
          sessionStatusRank(bucketOfRanked(buckets, b.id)) || recencyTie(a, b),
    ).map((m) => m.id)
  }

  const totals = aux?.tokenTotals
  if (!totals) {
    throw new Error('[sidebar-view] tokens 排序需要 aux.tokenTotals（session-usage 缓存面）')
  }
  return [...metas].sort(
    (a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || recencyTie(a, b),
  ).map((m) => m.id)
}

// ── 状态筛选纯函数（hermes Filters>Status：五桶多选，空 = 不过滤）────────

/**
 * 状态筛选（hermes Filters>Status 的 pi 等价；纯函数供单测）：
 * - 空筛选：行面原样放行（不过滤——hermes persistentAtom 初值 []）。
 * - 非空：只留命中桶的行（bucketOf 由调用方注入——运行态/未读/草稿的
 *   判定面在 thread-list，不耦合进纯函数）。
 */
export function filterByStatus<T>(
  metas: readonly T[],
  filter: SidebarStatusFilter,
  bucketOf: (m: T) => SessionStatusBucket,
): T[] {
  if (filter.length === 0) return [...metas]
  const set = new Set(filter)
  return metas.filter((m) => set.has(bucketOf(m)))
}

// ── 视图状态 store ───────────────────────────────────────────────────────

interface SidebarViewState {
  grouping: SidebarGroupingMode
  /** 持久排序键（'manual' 不落这里——effectiveOrdering 组合 manual 旗标）。 */
  ordering: SidebarSortKey
  /** 拖拽声明的手动序（hermes $sidebarSessionOrderManual）。 */
  manual: boolean
  /** 行尾可选项（hermes $sidebarRowMeta：updated = 行龄 / tokens = 词元数）。 */
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
  /** Inbox style（hermes「收件箱样式」：卡片行形态开关）。 */
  inboxStyle: boolean
  setInboxStyle(on: boolean): void
  /** 项目过滤（hermes Filters>Project 的 pi 等价：null=全部，字符串=仅该 cwd）。 */
  projectFilter: string | null
  setProjectFilter(cwd: string | null): void
  /** 状态筛选（hermes $sidebarStatusFilter 同构：五桶多选，空 = 不过滤）。
   *  持久化（hermes 同款——桶语义跨刷新稳定）。 */
  statusFilter: SidebarStatusFilter
  toggleStatusBucket(bucket: SessionStatusBucket): void
  /** hermes resetSidebarView 逐语义：全部旋钮回默认 + 清保存的手动序
   *  （不动日期桶折叠态——hermes 的节点开合表同样不在 reset 面）。 */
  resetView(): void
}

const loadManual = (): boolean => {
  // manual.v1 缺失时看统一持久化的 manualOrder（旧 order 键已迁移进 catalog）
  if (safeGetItem(SIDEBAR_MANUAL_KEY) !== null) return parseManual(safeGetItem(SIDEBAR_MANUAL_KEY))
  return loadInitialManual(null, sessionCatalog.getState().manualOrder)
}

export const sidebarViewStore = createStore<SidebarViewState>((set, get) => ({
  grouping: parseGrouping(safeGetItem(SIDEBAR_GROUPING_KEY)),
  ordering: parseOrdering(safeGetItem(SIDEBAR_ORDERING_KEY)),
  manual: loadManual(),
  rowMeta: parseRowMeta(safeGetItem(SIDEBAR_ROWMETA_KEY)),
  showArchived: parseShowArchived(safeGetItem(SIDEBAR_SHOW_ARCHIVED_KEY)),
  density: parseDensity(safeGetItem(SIDEBAR_DENSITY_KEY)),
  inboxStyle: parseInbox(safeGetItem(SIDEBAR_INBOX_KEY)),
  projectFilter: parseProjectFilter(safeGetItem(SIDEBAR_PROJECT_FILTER_KEY)),
  statusFilter: parseStatusFilter(safeGetItem(SIDEBAR_STATUS_FILTER_KEY)),
  setGrouping: (grouping) => {
    set({ grouping })
    safeSetItem(SIDEBAR_GROUPING_KEY, grouping)
  },
  setOrdering: (ordering) => {
    set({ ordering, manual: false })
    safeSetItem(SIDEBAR_ORDERING_KEY, ordering)
    safeSetItem(SIDEBAR_MANUAL_KEY, 'false')
    sessionCatalog.getState().setManualOrder({})
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
  setProjectFilter: (projectFilter) => {
    set({ projectFilter })
    safeSetItem(SIDEBAR_PROJECT_FILTER_KEY, JSON.stringify(projectFilter))
  },
  toggleStatusBucket: (bucket) => {
    const current = get().statusFilter
    const next = current.includes(bucket)
      ? current.filter((b) => b !== bucket)
      : [...current, bucket]
    set({ statusFilter: next })
    safeSetItem(SIDEBAR_STATUS_FILTER_KEY, JSON.stringify(next))
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
      projectFilter: null,
      statusFilter: [...SIDEBAR_DEFAULT_STATUS_FILTER],
    })
    safeSetItem(SIDEBAR_GROUPING_KEY, SIDEBAR_DEFAULT_GROUPING)
    safeSetItem(SIDEBAR_ORDERING_KEY, SIDEBAR_DEFAULT_ORDERING)
    safeSetItem(SIDEBAR_MANUAL_KEY, 'false')
    safeSetItem(SIDEBAR_ROWMETA_KEY, JSON.stringify([...SIDEBAR_DEFAULT_ROW_META]))
    safeSetItem(SIDEBAR_SHOW_ARCHIVED_KEY, String(SIDEBAR_SHOW_ARCHIVED_DEFAULT))
    safeSetItem(SIDEBAR_DENSITY_KEY, SIDEBAR_DEFAULT_DENSITY)
    safeSetItem(SIDEBAR_INBOX_KEY, 'false')
    safeSetItem(SIDEBAR_STATUS_FILTER_KEY, '[]')
    safeSetItem(SIDEBAR_PROJECT_FILTER_KEY, 'null')
    sessionCatalog.getState().setManualOrder({})
  },
}))

/** React 订阅（组件层用；动作回调用 sidebarViewStore.getState()）。 */
export const useSidebarView = <T,>(selector: (s: SidebarViewState) => T): T =>
  useStore(sidebarViewStore, selector)

/** 菜单口径的当前排序（hermes $sidebarOrdering 同构：manual 压过排序键）。
 *  manual 激活时菜单不再展示「手动」项——radio 组无命中项（hermes
 *  filter-menu.tsx:207-213 的 Manual 条目自任务定稿起不再渲染）。 */
export const effectiveOrdering = (s: Pick<SidebarViewState, 'ordering' | 'manual'>): SidebarOrderingMode =>
  s.manual ? 'manual' : s.ordering

/**
 * 「重置为默认」是否值得提供（hermes $sidebarViewCustomized 同构：任何
 * 旋钮离开出厂值即为 true——hermes resetSidebarView 一并复位 rowMeta
 * （layout.ts:732），故 customized 面同含 rowMeta；showArchived/状态筛选
 * 是过滤器非视图旋钮，与 hermes filtersActive 的分面一致不进 reset）。
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
