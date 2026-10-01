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
 *   会话区（分组分隔线 + 手挑序在桶内应用 + 桶折叠）。
 *
 * 会话区分组（侧栏选项旋钮）：
 * - date：日历桶分隔线（groupEntriesByRecency，hermes 同名）；
 * - project：按工作区分组（groupEntriesByWorkspace——pi SessionMeta.cwd
 *   直投影；hermes grouping='project' 的项目树在此简化为 cwd 分组，组
 *   标签 = pathLeaf(cwd)，无 cwd 归 Home 桶「主页」zh 原文）；
 * - none：平铺（hermes grouping='none' 内部形态）。
 *
 * 排序（hermes sidebar-sort.ts 的 rank 语义）：updated → 无排名（recency
 * 即到达序）；created → 创建时间降序；title → 标题字母序；manual →
 * reconcileOrder 折回。排名只动桶内（date）或作用整表（none/project）。
 */
import {
  groupEntriesByRecency,
  hideCollapsedGroupRows,
  orderRowsWithinGroups,
  toSessionRows,
  type SessionListRow,
} from './session-date-groups'
import {
  prunePins,
  recencyCompare,
  reconcileOrder,
  type SessionRowMeta,
} from './session-order'
import { rankIdsByOrdering, type SidebarGroupingMode, type SidebarOrderingMode } from './sidebar-view'

export interface SessionDisplayState {
  /** 置顶区行（pinned 数组序＝展示序，hermes pinSession 追加语义） */
  pinnedIds: string[]
  /** 会话区行（含分组分隔线；已应用桶内手动序与折叠） */
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

/** 侧栏选项（视图模式）：缺省 = date + updated（出厂形态）。 */
export interface SessionViewMode {
  /** 'date' = 日历桶分隔线；'project' = 按工作区分组；'none' = 平铺。 */
  readonly grouping?: SidebarGroupingMode
  /** 'updated' = 新近；'created' = 创建时间降序；'title' = 标题字母序
   *  （组内应用）；'manual' = 拖拽声明序（hermes manualOrderIds 语义）。 */
  readonly ordering?: SidebarOrderingMode
}

// ── hermes lib/display-path.ts：路径显示格式化（组标签用 pathLeaf）────────

/** 规整分隔符并去掉尾斜杠（hermes normalizeDisplayPath 逐语义；根/盘根除外）。 */
export function normalizeDisplayPath(raw: string): string {
  let path = (raw || '').trim().replace(/\\/g, '/')

  if (!path) {
    return ''
  }

  // 合并重复斜杠，但保留 UNC `//server/...` 的前导双斜杠。
  if (path.startsWith('//')) {
    path = `//${path.slice(2).replace(/\/{2,}/g, '/')}`
  } else {
    path = path.replace(/\/{2,}/g, '/')
  }

  // 去尾斜杠（裸 `/` 或 `C:/` 除外）。
  if (path.length > 1 && path.endsWith('/') && !/^[A-Za-z]:\/$/.test(path)) {
    path = path.replace(/\/+$/, '')
  }

  return path
}

/** 紧凑标签的末段（hermes pathLeaf 逐语义：盘根原样、`/`、`~` 原样）。 */
export function pathLeaf(raw: null | string | undefined): string {
  const path = normalizeDisplayPath(raw || '')

  if (!path || path === '/' || path === '~') {
    return path
  }

  // `C:/` 盘根
  if (/^[A-Za-z]:\/$/.test(path) || /^[A-Za-z]:$/.test(path)) {
    return path.endsWith('/') ? path : `${path}/`
  }

  const leaf = path.split('/').filter(Boolean).pop()

  return leaf || path
}

/** 工作区分组标签：cwd 末段；无 cwd 归 Home 桶（hermes
 *  t.sidebar.projects.home =「主页」——"the same synthetic Home the project
 *  views use for workspace-less chats"）。 */
export function workspaceGroupLabel(cwd: string | undefined): string {
  return pathLeaf(cwd) || '主页'
}

/**
 * 按工作区分组（hermes grouping='project' 的 cwd 投影）：组 = cwd 桶
 * （同 cwd 的行**全部收进同一组**——不管全局排序里它们隔多远，hermes
 * project lane 语义；组内保持排序键给定的相对序），组序 = 组内首行的
 * 排序出现序（pi 无项目实体，cwd 即分组键）；每组一条工作区分隔线
 * （variant:'project'）。空 cwd 归同一 Home 桶。
 */
export function groupEntriesByWorkspace(
  entries: readonly { readonly id: string; readonly cwd?: string }[],
): SessionListRow[] {
  const groups: { readonly key: string; readonly cwd?: string; ids: string[] }[] = []
  const indexOf = new Map<string, number>()

  for (const entry of entries) {
    const key = `w:${entry.cwd ?? ''}`
    let at = indexOf.get(key)

    if (at === undefined) {
      at = groups.length
      indexOf.set(key, at)
      groups.push({ key, cwd: entry.cwd, ids: [] })
    }

    groups[at]!.ids.push(entry.id)
  }

  const rows: SessionListRow[] = []

  for (const group of groups) {
    rows.push({ key: group.key, kind: 'divider', label: workspaceGroupLabel(group.cwd), variant: 'project' })
    for (const id of group.ids) {
      rows.push({ id, kind: 'session' })
    }
  }

  return rows
}

/**
 * 常态分组投影（含侧栏选项管线，hermes index.tsx + sessions-section.tsx
 * flatRows 同构）：
 * 1. 会话区全集按新近排序（日历桶成员由 recency 钉死——排序键不改桶；
 *    project/none 分组直接吃排序后的序）；
 * 2. 排名序 = updated→无 / created→创建时间降序 / title→标题字母序 /
 *    manual→reconcileOrder（hermes manualOrderIds = agentOrderManual ?
 *    agentOrderIds : sortOrderIds；排序键排名只在组内应用
 *    orderRowsWithinGroups——date 桶；project/none 无桶界，排名即整表序）；
 * 3. 分组 = date→groupEntriesByRecency / project→groupEntriesByWorkspace /
 *    none→toSessionRows；
 * 4. 折叠 = 分隔线保留、其下行隐藏（平铺无分隔线则天然无折叠面）。
 * ordering='updated' 时忽略 order 表（hermes：非 manual 旗标的保存序
 * 不生效——排序键/默认态都不读它）。
 */
export function buildSessionDisplay(
  metas: readonly SessionRowMeta[],
  pinned: readonly string[],
  order: Readonly<Record<string, number>>,
  collapsed: Readonly<Record<string, boolean>>,
  opts: {
    nowMs?: number
    weekStartsOn?: number
    view?: SessionViewMode
  } = {},
): SessionDisplayState {
  const grouping = opts.view?.grouping ?? 'date'
  const ordering = opts.view?.ordering ?? 'updated'
  const pinnedIds = prunePins(pinned, metas.map((m) => m.id))
  const pinnedSet = new Set(pinnedIds)
  const unpinned = metas.filter((m) => !pinnedSet.has(m.id)).sort(recencyCompare)
  // 排名序：manual = 持久化手动序折回（mergeFreshByPosition 语义）；
  // created = 创建时间降序；title = 标题字母序；updated = 无排名
  // （recency 即到达序）。
  const rankIds =
    ordering === 'manual'
      ? reconcileOrder(unpinned.map((m) => m.id), order)
      : ordering === 'title'
        ? rankIdsByOrdering(unpinned, 'title')
        : ordering === 'created'
          ? rankIdsByOrdering(unpinned, 'created')
          : []
  const allUnpinnedIds = rankIds.length > 0 ? rankIds : unpinned.map((m) => m.id)
  const byId = new Map(unpinned.map((m) => [m.id, m] as const))
  // 排名序展开成行输入（project/none 直接吃排名序；date 桶成员由 recency
  // 钉死——groupEntriesByRecency 要求 ms 降序输入，排名稍后在桶内应用）。
  const toEntry = (id: string): SessionRowMeta => byId.get(id) ?? ({ id, lastActiveMs: 0 })
  const rankedEntries = allUnpinnedIds.map(toEntry)

  const grouped =
    grouping === 'none'
      ? toSessionRows(rankedEntries.map((m) => ({ id: m.id, ms: m.lastActiveMs })))
      : grouping === 'project'
        ? groupEntriesByWorkspace(rankedEntries)
        : groupEntriesByRecency(
            unpinned.map((m) => ({ id: m.id, ms: m.lastActiveMs })),
            opts,
          )
  // 排名序在日期桶内应用（hermes：日历组留在新近给的位置，排序只动桶内；
  // 平铺/工作区分组无日期桶界——工作区分组本身由排名序的 partition 保留）。
  const ordered =
    grouping === 'date' ? orderRowsWithinGroups(grouped, allUnpinnedIds) : grouped
  // 折叠键 = 分隔线桶 key（'today'/'yesterday'/'this-week'/'m-2026-8'… 或
  // 工作区 'w:<cwd>'）；未标名头部（第一条分隔线之前）永不折叠。
  const visible = hideCollapsedGroupRows(ordered, (key) => !isHidden(collapsed, key))

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
