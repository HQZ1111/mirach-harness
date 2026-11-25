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
 * 会话区分组（侧栏选项旋钮；用户截图钉死菜单——分组子菜单四项）：
 * - date：日历桶分隔线（groupEntriesByRecency，hermes 同名）；
 * - project：按工作区分组（groupEntriesByWorkspace——pi SessionMeta.cwd
 *   直投影；hermes grouping='project' 的项目树在此简化为 cwd 分组，组
 *   标签 = pathLeaf(cwd)，无 cwd 归 Home 桶「主页」zh 原文）；
 * - status：按状态桶分组（groupEntriesByStatus——五桶各一组头，带状态
 *   色点文案，hermes date/status 桶共用 listGroupIds 折叠面）；
 * - gateway：按环境（配置档案）分组（groupEntriesByProfile——hermes
 *   grouping='profile'，2026-11-25 跨环境聚合后本地 bot 真的多环境了；
 *   组头 = bot 头像 + 显示名，本体组 = 品牌 logo +「Mirach」）。
 *
 * 排序（hermes sidebar-sort.ts 的 rank 语义）：updated → 无排名（recency
 * 即到达序）；created → 创建时间降序；status → 状态 rank 升序
 * （needs-input > working > unread > draft > idle）；tokens → 词元数降序
 * （session-usage 懒拉，未拉到按 0 沉底）；manual → reconcileOrder 折回。
 * 排名只动桶内（date）或作用整表（status/project）。
 */
import {
  groupEntriesByRecency,
  hideCollapsedGroupRows,
  orderRowsWithinGroups,
  type SessionListRow,
} from './session-date-groups'
import {
  STATUS_BUCKET_LABELS,
  STATUS_RANK,
  type SessionStatusBucket,
} from './session-status'
import {
  prunePins,
  recencyCompare,
  reconcileOrder,
  type SessionRowMeta,
} from './session-order'
import { rankIdsByOrdering, type OrderAux, type SidebarGroupingMode, type SidebarOrderingMode } from './sidebar-view'

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
  /** 'date' = 日历桶分隔线；'project' = 按工作区分组；'status' = 按状态
   *  桶分组；'gateway' = 按环境（配置档案）分组（hermes 分组子菜单四值
   *  同构）。 */
  readonly grouping?: SidebarGroupingMode
  /** 'updated' = 新近；'created' = 创建时间降序；'status' = 状态 rank 升序；
   *  'tokens' = 词元数降序（组内应用）；'manual' = 拖拽声明序（hermes
   *  manualOrderIds 语义）。 */
  readonly ordering?: SidebarOrderingMode
  /** status/tokens 排序键的辅助面（rankIdsByOrdering 的 aux——status 五桶
   *  判定 + session-usage 缓存；updated/created/manual 键不消费）。 */
  readonly aux?: OrderAux
  /** 项目注册表（project 分组的标签与组序来源）。缺省 = 兼容旧行为：
   *  按 cwd 分组（项目表还没拉到时不得把「没加载」显示成「没有项目」）。 */
  readonly projects?: readonly ProjectGroupRef[]
  /** 环境清单（gateway 分组的组名/头像/组序来源 = bot 花名册）。缺省 =
   *  按记录里的 profile 名字直示（名字/无头像，稳定序）。 */
  readonly profiles?: readonly ProfileGroupRef[]
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

/** 项目注册表在展示层的投影（只取分组/标签需要的字段——不把 Rust 类型
 *  拉进纯函数模块，避免 catalog ↔ display 的循环依赖）。 */
export interface ProjectGroupRef {
  readonly id: string
  readonly name: string
  readonly pinned?: boolean
  readonly order?: number
  /** 软删条目仍可命中（显式归属保留）——标签追加「（已删除）」。 */
  readonly deletedAt?: number
}

/** 项目分组标签：注册表名 ?? 未知 id 直示 ?? 主页（无归属）。
 *  「未知项目」不静默归并到主页——否则软删/幽灵映射的行会被误读成
 *  「本来就没项目」。 */
export function projectGroupLabel(
  projectId: string | undefined,
  projects: readonly ProjectGroupRef[],
): string {
  if (projectId === undefined) return '主页'
  const project = projects.find((p) => p.id === projectId)
  if (project === undefined) return `未知项目 ${projectId.slice(0, 8)}`
  return project.deletedAt === undefined ? project.name : `${project.name}（已删除）`
}

/** 注册表的展示序：置顶项目在前，其余按 order/createdAt/id（与
 *  session-catalog.sortProjects 同序 + pinned 分面）。泛型保持调用方的
 *  完整条目类型（侧栏用 ProjectGroupRef、弹层用 PiProject）。 */
export function projectsForDisplay<T extends ProjectGroupRef>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    const pin = Number(b.pinned === true) - Number(a.pinned === true)
    if (pin !== 0) return pin
    return (
      (a.order ?? 0) - (b.order ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
  })
}

/**
 * 按项目分组（settings/会话管理 P0 定稿：**组 = projectId**，cwd 桶只
 * 兼容旧数据/未归属行）。
 *
 * 组序：
 * 1. 注册表里的项目（置顶优先、再按 order）——即使组内为空也不出组头；
 * 2. 索引给了未知 projectId 的行（幽灵/软删前映射）：首现序，标签直示 id；
 * 3. 没有 projectId 但有 cwd 的行：按 cwd 桶（旧数据兼容）；
 * 4. 既无 projectId 也无 cwd：主页桶（恒殿后）。
 *
 * 组内保持传入序（排序键已由 buildSessionDisplay 应用）。分隔线 key =
 * `pj:<id>` / `w:<cwd>`，折叠语义与日期桶一致（折叠表不复用旧键名，
 * 因此不会与 cwd 分组的折叠态串台）。
 */
export function groupEntriesByProject(
  entries: readonly { readonly id: string; readonly projectId?: string; readonly cwd?: string }[],
  projects: readonly ProjectGroupRef[],
): SessionListRow[] {
  const registered = projectsForDisplay(projects)
  const projectRank = new Map<string, number>()
  registered.forEach((project, index) => projectRank.set(project.id, index))

  interface Bucket {
    key: string
    label: string
    rank: readonly [number, number]
    ids: string[]
  }
  const buckets: Bucket[] = []
  const index = new Map<string, Bucket>()
  let unknownSeq = 0
  let cwdSeq = 0

  for (const entry of entries) {
    let key: string
    let label: string
    let rank: readonly [number, number]
    const registeredRank =
      entry.projectId === undefined ? undefined : projectRank.get(entry.projectId)
    if (registeredRank !== undefined) {
      key = `pj:${entry.projectId}`
      label = projectGroupLabel(entry.projectId, registered)
      rank = [0, registeredRank]
    } else if (entry.projectId !== undefined) {
      key = `pj:${entry.projectId}`
      label = projectGroupLabel(entry.projectId, registered)
      rank = [1, unknownSeq]
    } else if (entry.cwd !== undefined && entry.cwd !== '') {
      key = `w:${entry.cwd}`
      label = pathLeaf(entry.cwd)
      rank = [2, cwdSeq]
    } else {
      key = 'w:'
      label = '主页'
      rank = [3, 0]
    }
    let bucket = index.get(key)
    if (bucket === undefined) {
      bucket = { key, label, rank, ids: [] }
      index.set(key, bucket)
      buckets.push(bucket)
      if (rank[0] === 1) unknownSeq += 1
      else if (rank[0] === 2) cwdSeq += 1
    }
    bucket.ids.push(entry.id)
  }

  buckets.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])

  const rows: SessionListRow[] = []
  for (const bucket of buckets) {
    rows.push({ key: bucket.key, kind: 'divider', label: bucket.label, variant: 'project' })
    for (const id of bucket.ids) rows.push({ id, kind: 'session' })
  }
  return rows
}

/**
 * 环境（配置档案）清单在展示层的投影（gateway 分组的组名/头像/组序）。
 * 本体环境不进这张表——组头固定「Mirach」+ 品牌 logo（渲染层常量）。
 */
export interface ProfileGroupRef {
  /** 环境名（`pi_sessions_index.profile` 的原值）。 */
  readonly name: string
  /** 组头显示名（bot 显示名）。 */
  readonly label: string
  /** 头像 URL（bot.image）；缺省 = 渲染层回落品牌 logo。 */
  readonly image?: string
}

/** 本体环境组头文案（hermes defaultProfile「Hermes（默认）」的宿主对偶；
 *  「Mirach」与左栏底栏/环境菜单的默认项同词）。 */
export const DEFAULT_PROFILE_GROUP_LABEL = 'Mirach'

/**
 * 按环境（配置档案）分组（hermes grouping='profile'，2026-11-25）：
 * 组 = `pi_sessions_index.profile` 桶（undefined = 本体，恒第一组）。
 * 具名组序 = 传入的 profiles 花名册序（bot 行序）；名单外的孤儿环境按名字
 * 排序殿后（名字直示，不改写——环境被删但会话文件仍在时如实显示）。
 * 折叠键 = `gw:<name>`（本体 `gw:`）。组内保持排序键给定的相对序。
 */
export function groupEntriesByProfile(
  entries: readonly { readonly id: string; readonly profile?: string }[],
  profiles: readonly ProfileGroupRef[],
): SessionListRow[] {
  const order = new Map<string, number>()
  const refs = new Map<string, ProfileGroupRef>()
  profiles.forEach((ref, index) => {
    order.set(ref.name, index)
    refs.set(ref.name, ref)
  })

  interface Bucket {
    readonly key: string
    readonly name: string | undefined
    readonly label: string
    readonly image?: string
    readonly rank: readonly [number, number | string]
    readonly ids: string[]
  }
  const buckets: Bucket[] = []
  const index = new Map<string, Bucket>()

  for (const entry of entries) {
    const name = entry.profile === undefined || entry.profile === '' ? undefined : entry.profile
    const key = `gw:${name ?? ''}`
    let bucket = index.get(key)
    if (bucket === undefined) {
      const ref = name === undefined ? undefined : refs.get(name)
      const rank: readonly [number, number | string] =
        name === undefined
          ? [0, 0]
          : order.has(name)
            ? [1, order.get(name)!]
            : [2, name]
      bucket = {
        key,
        name,
        label: name === undefined ? DEFAULT_PROFILE_GROUP_LABEL : ref?.label ?? name,
        ...(ref?.image ? { image: ref.image } : {}),
        rank,
        ids: [],
      }
      index.set(key, bucket)
      buckets.push(bucket)
    }
    bucket.ids.push(entry.id)
  }

  buckets.sort((a, b) => {
    if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0]
    if (a.rank[0] === 2) return String(a.rank[1]).localeCompare(String(b.rank[1]))
    return Number(a.rank[1]) - Number(b.rank[1])
  })

  const rows: SessionListRow[] = []
  for (const bucket of buckets) {
    rows.push({
      key: bucket.key,
      kind: 'divider',
      label: bucket.label,
      variant: 'gateway',
      ...(bucket.image ? { image: bucket.image } : {}),
    })
    for (const id of bucket.ids) rows.push({ id, kind: 'session' })
  }
  return rows
}

/**
 * 按状态桶分组（hermes grouping='status' 的 pi 数据面：五桶各一组头—— * 需要 input/运行中/未读/草稿/空闲，状态排序 rank 的同序决定组序 =
 * needs-input 最前、idle 殿后；桶内保持排序键给定的相对序）。每组一条
 * 状态分隔线（variant:'status'，label = 中文名 + 色点名由渲染层定）。
 * 非空桶才出组头（无运行中会话不出「运行中」行）。
 */
export function groupEntriesByStatus(
  entries: readonly { readonly id: string; readonly bucket: SessionStatusBucket }[],
): SessionListRow[] {
  // 组序 = 状态 rank（hermes STATUS_RANK：needs-input 0 → idle 4）。
  const orderByRank = (['needs-input', 'working', 'unread', 'draft', 'idle'] as const)
    .slice()
    .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])

  const buckets = new Map<SessionStatusBucket, string[]>()
  for (const entry of entries) {
    let ids = buckets.get(entry.bucket)
    if (!ids) {
      ids = []
      buckets.set(entry.bucket, ids)
    }
    ids.push(entry.id)
  }

  const rows: SessionListRow[] = []
  for (const bucket of orderByRank) {
    const ids = buckets.get(bucket)
    if (!ids || ids.length === 0) continue
    rows.push({
      key: `s:${bucket}`,
      kind: 'divider',
      label: STATUS_BUCKET_LABELS[bucket],
      variant: 'status',
    })
    for (const id of ids) {
      rows.push({ id, kind: 'session' })
    }
  }

  return rows
}

/**
 * 常态分组投影（含侧栏选项管线，hermes index.tsx + sessions-section.tsx
 * flatRows 同构）：
 * 1. 会话区全集按新近排序（日历桶成员由 recency 钉死——排序键不改桶；
 *    status/project 分组直接吃排序后的序）；
 * 2. 排名序 = updated→无 / created→创建时间降序 / status→状态 rank 升序 /
 *    tokens→词元数降序 / manual→reconcileOrder（hermes manualOrderIds =
 *    agentOrderManual ? agentOrderIds : sortOrderIds；排序键排名只在组内
 *    应用 orderRowsWithinGroups——date 桶；status/project 无日期桶界，
 *    排名即整表序。status/tokens 键需要 opts.aux 的辅助面，缺 = throw）；
 * 3. 分组 = date→groupEntriesByRecency / project→groupEntriesByWorkspace /
 *    status→groupEntriesByStatus；
 * 4. 折叠 = 分隔线保留、其下行隐藏。
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
  // created = 创建时间降序；status = 状态 rank 升序；tokens = 词元数降序；
  // updated = 无排名（recency 即到达序）。
  const rankIds =
    ordering === 'manual'
      ? reconcileOrder(unpinned.map((m) => m.id), order)
      : ordering === 'created'
        ? rankIdsByOrdering(unpinned, 'created')
        : ordering === 'status' || ordering === 'tokens'
          ? rankIdsByOrdering(unpinned, ordering, opts.view?.aux)
          : []
  const allUnpinnedIds = rankIds.length > 0 ? rankIds : unpinned.map((m) => m.id)
  const byId = new Map(unpinned.map((m) => [m.id, m] as const))
  // 排名序展开成行输入（status/project 直接吃排名序；date 桶成员由 recency
  // 钉死——groupEntriesByRecency 要求 ms 降序输入，排名稍后在桶内应用）。
  const toEntry = (id: string): SessionRowMeta => byId.get(id) ?? ({ id, lastActiveMs: 0 })
  const rankedEntries = allUnpinnedIds.map(toEntry)
  // 状态桶组输入（id → bucket，仅 grouping='status' 构建——桶面必须覆盖
  // 全部行，缺失 = 接线 bug，throw 可见（禁止兜底）；其余分组不消费桶面）。
  const statusEntries = (): { readonly id: string; readonly bucket: SessionStatusBucket }[] => {
    const buckets = opts.view?.aux?.statusBuckets
    return rankedEntries.map((m) => {
      const bucket = buckets?.get(m.id)
      if (bucket === undefined) {
        throw new Error(`[session-display] status 分组的行缺状态桶（${m.id}）——statusBuckets 必须覆盖全部行`)
      }
      return { id: m.id, bucket }
    })
  }

  const grouped =
    grouping === 'status'
      ? groupEntriesByStatus(statusEntries())
      : grouping === 'project'
        ? opts.view?.projects !== undefined
          ? groupEntriesByProject(rankedEntries, opts.view.projects)
          : groupEntriesByWorkspace(rankedEntries)
        : grouping === 'gateway'
          ? groupEntriesByProfile(rankedEntries, opts.view?.profiles ?? [])
          : groupEntriesByRecency(
              unpinned.map((m) => ({ id: m.id, ms: m.lastActiveMs })),
              opts,
            )
  // 排名序在日期桶内应用（hermes：日历组留在新近给的位置，排序只动桶内；
  // 状态/工作区分组无日期桶界——分组本身由排名序的 partition 保留）。
  const ordered =
    grouping === 'date' ? orderRowsWithinGroups(grouped, allUnpinnedIds) : grouped
  // 折叠键 = 分隔线桶 key（'today'/'yesterday'/'this-week'/'m-2026-8'… 或
  // 工作区 'w:<cwd>'）；未标名头部（第一条分隔线之前）永不折叠。
  const visible = hideCollapsedGroupRows(ordered, (key) => !isHidden(collapsed, key))
  // fork 谱系缩进：只沿**本次可见**的父行链走；父行被归档/筛掉则回顶层。
  const depths = branchDepths(visible, byId)
  const rows = visible.map((row) =>
    row.kind === 'session' && (depths.get(row.id) ?? 0) > 0
      ? { ...row, depth: depths.get(row.id) }
      : row,
  )

  return { pinnedIds, rows, allUnpinnedIds }
}

/** 分支会话在侧栏的缩进层级（hermes session-branch-tree 的 branch stem 对偶）：
 * 沿 `parentSessionId` 链在可见行集合内回溯；`seen` 与封顶 8 防环。 */
function branchDepths(
  rows: readonly SessionListRow[],
  metas: ReadonlyMap<string, SessionRowMeta>,
): Map<string, number> {
  const visible = new Set(
    rows.filter((r): r is Extract<SessionListRow, { kind: 'session' }> => r.kind === 'session').map((r) => r.id),
  )
  const depth = new Map<string, number>()
  for (const id of visible) {
    let current = metas.get(id)?.parentSessionId
    let level = 0
    const seen = new Set<string>([id])
    while (current !== undefined && visible.has(current) && !seen.has(current) && level < 8) {
      seen.add(current)
      level += 1
      current = metas.get(current)?.parentSessionId
    }
    depth.set(id, level)
  }

  return depth
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
