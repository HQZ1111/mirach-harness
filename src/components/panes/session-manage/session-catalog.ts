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
import { invoke } from '@tauri-apps/api/core'
import { inTauri } from '@/lib/tauri-window'
import { createStore, useStore } from 'zustand'

import { pruneOrder, prunePins, togglePinId } from './session-order'

// ── 持久化键 ──────────────────────────────────────────────────────────────

/** 旧 localStorage 键（迁移源——真相已上移 Rust 层 session-meta.json）。 */
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

/** sessionProjects 形状（Rust HashMap<String,String>；非字符串条目剔除
 *  并可见报错——不冒充旧数据）。 */
export const parseStringRecord = (value: unknown, label: string): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.error(`[session-catalog] ${label} 形状非法（应为 Record<string, string>）——从空态起`, value)
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, projectId] of Object.entries(value)) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      console.error(`[session-catalog] ${label} 条目 ${key} 非法——跳过`, projectId)
      continue
    }
    out[key] = projectId
  }
  return out
}

/** projects 注册表形状校验（Rust `Project`；未知/缺字段条目剔除并可见报错）。 */
export const parseProjects = (value: unknown): PiProject[] => {
  if (!Array.isArray(value)) {
    console.error('[session-catalog] projects 形状非法（应为 Project[]）——从空态起', value)
    return []
  }
  const out: PiProject[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      console.error('[session-catalog] projects 条目非法——跳过', raw)
      continue
    }
    const rec = raw as Record<string, unknown>
    const { id, name, roots, pinned, order, createdAt, deletedAt } = rec
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      !Array.isArray(roots) ||
      roots.some((root) => typeof root !== 'string') ||
      typeof pinned !== 'boolean' ||
      typeof order !== 'number' ||
      typeof createdAt !== 'number' ||
      (deletedAt !== undefined && typeof deletedAt !== 'number')
    ) {
      console.error('[session-catalog] projects 条目字段不符（Project）——跳过', raw)
      continue
    }
    out.push({
      id,
      name,
      roots: roots as string[],
      pinned,
      order,
      createdAt,
      ...(deletedAt === undefined ? {} : { deletedAt }),
    })
  }
  return out
}

/** 注册表展示序：order → createdAt → id（Rust projects_sorted 同公式；
 *  `pinned` 是展示分面，不参与基础排序）。 */
export const sortProjects = (projects: readonly PiProject[]): PiProject[] =>
  [...projects].sort(
    (a, b) =>
      a.order - b.order ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

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
  /** 项目归属（`pi_sessions_index` 的 projectId：显式映射优先、否则 cwd
   *  落在项目根内推断）。undefined = 无归属（侧栏归「主页」桶）。 */
  projectId?: string
  /** 会话所属环境（`pi_sessions_index` 的 profile：null = 本体）。侧栏
   *  「网关与配置」分组/筛选的身份标签（2026-11-25 跨环境聚合）。 */
  profile?: string
  /** 父会话 id（fork 谱系；索引的 parentSessionId）。 */
  parentSessionId?: string
  /** 该会话被哪个扫描根发现（诊断字段，UI 可不用）。 */
  sourceRoot?: string
  source?: SessionsIndexSession['source']
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
    /** `null` = 索引明确说「无项目归属」（清除旧值）；缺键 = 该来源不提供
     *  这一维（保留先前的值——pi_list_sessions 的老形状即如此）。 */
    projectId?: unknown
    /** 会话所属环境（null/缺键 = 本体）——与 projectId 同为索引补充维。 */
    profile?: unknown
    parentSessionId?: unknown
    sourceRoot?: unknown
    source?: unknown
  }
}

/** 未读判定的行输入（pi SessionMeta 投影：threadItems[].custom）。 */
export interface UnreadRowInput {
  readonly id: string
  readonly messageCount: number
}

// ── 项目注册表 / 跨根会话索引（2026-11-15 P0 数据面）──────────────────────
//
// Rust 侧真相（`src-tauri/src/session_meta.rs` + `session_index.rs`）：
// - `pi_projects_*` 是项目注册表的唯一写面（原子读-改-写）；
// - `sessionProjects`（会话 → 项目显式归属）随 `session_meta_set` 全量
//   携带——**没有单独的「设置某会话归属」命令**，见 assignSessionProject
//   的写后回读校验（旧 Rust 会忽略该字段，此时明确报错而不是假装持久化）；
// - `pi_sessions_index` 一次扫描配置 sessionDir + 各项目根 + 当前 cwd，
//   返回跨工作区会话与坏文件/根的诊断。

/** 项目注册表条目（Rust `Project` 的 wire 形状）。 */
export interface PiProject {
  id: string
  name: string
  roots: string[]
  pinned: boolean
  order: number
  createdAt: number
  /** 软删时间戳（None 缺省 = 活跃）。 */
  deletedAt?: number
}

/** `pi_projects_save` 入参（id 缺省 = 新建，由宿主生成 uuid）。 */
export interface PiProjectInput {
  id?: string
  name: string
  roots: string[]
  pinned?: boolean
  order?: number
}

/** `pi_sessions_index` 的单条会话（跨根索引 wire 形状）。 */
export interface SessionsIndexSession {
  id: string
  path: string
  cwd: string
  name: string | null
  messageCount: number
  /** Unix 毫秒（与 pi_list_sessions.lastModifiedMs 同源）。 */
  lastModified: number
  /** header.createdAt 的 Unix 毫秒（0 = 旧会话文件没有创建时间）。 */
  createdAt: number
  parentSessionId: string | null
  /** 显式 sessionProjects 优先，否则按 cwd 落在项目根内推断；null = 无归属。 */
  projectId: string | null
  /** 会话所属环境（null = 本体；具名环境 = `profiles/<name>/sessions` 根）。 */
  profile: string | null
  sourceRoot: string
  source: 'sessionDir' | 'projectRoot' | 'workspace' | 'profile'
}

/** 被跳过的会话文件 / 扫描问题（诊断可见，不静默丢）。 */
export interface SessionsIndexSkipped {
  path: string
  root: string
  reason: string
}

/** 一个扫描根的报告。 */
export interface SessionsIndexRoot {
  path: string
  kind: 'sessionDir' | 'projectRoot' | 'workspace' | 'profile'
  /** 根所属环境（null = 本体）。 */
  profile: string | null
  exists: boolean
  error: string | null
}

export interface SessionsIndexResult {
  /** Rust `IndexScan.sessions`（session_index.rs；2026-11-15 统一为 sessions，
   *  与模块头 doc 一致）。 */
  sessions: SessionsIndexSession[]
  skipped: SessionsIndexSkipped[]
  roots: SessionsIndexRoot[]
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
  /** 页签条隐藏开关（region → hidden；「切换标签」的持久化选择——boot
   * sync 依此区分「用户主动隐藏」与「竖轨残留 false」，后者才修）。 */
  // ── 项目注册表（Rust session-meta.json 的 projects 切片投影） ──
  projects: PiProject[]
  /** 至少成功拉过一次 `pi_projects_list`（未拉过时侧栏退回 cwd 分组——
   *  不拿空表冒充「没有项目」）。 */
  projectsLoaded: boolean
  projectsError: string | null
  /** 会话 → 项目显式归属（Rust sessionProjects 切片；随 session-meta 水合，
   *  经 session_meta_set 全量写穿）。 */
  sessionProjects: Record<string, string>
  /** 最近一次成功的跨根索引（设置页/归档页复用，免重复扫描）。 */
  sessionsIndex: SessionsIndexResult | null
  /** 最近一次索引失败原因（NULL = 没失败过；失败时列表回退
   *  pi_list_sessions，错误在此可见）。 */
  sessionsIndexError: string | null
  // ── 目录动作（runtime 唯一写入） ──
  ingest(rows: readonly SessionCatalogRow[], activeId: string | null): void
  setActive(id: string | null): void
  setDerivedTitle(id: string, title: string | undefined): void
  setPendingCwd(cwd: string | null): void
  /** 跨根索引结果落地（sessionsIndex/sessionsIndexError 诊断面）。 */
  applySessionIndex(result: SessionsIndexResult | null, error: string | null): void
  // ── 管理动作（原三 store 语义迁入） ──
  togglePin(id: string): void
  setPinnedOrder(ids: readonly string[]): void
  setManualOrder(map: Readonly<Record<string, number>>): void
  toggleArchive(id: string): void
  /** 显式归档/取消归档（自动归档调度器用：并发窗口里 toggle 会把刚归档
   *  的会话再切回来；显式值幂等）。 */
  setArchived(id: string, archived: boolean): void
  ackSession(id: string, messageCount: number): void
  markSessionUnread(id: string): void
  ackAll(rows: readonly UnreadRowInput[]): void
  setGroupCollapsed(id: string, collapsed: boolean): void
  prune(existingIds: readonly string[]): void
  // ── 项目动作（IPC 薄封装；失败置 projectsError 并 throw——不静默） ──
  loadProjects(includeDeleted?: boolean): Promise<PiProject[]>
  saveProject(input: PiProjectInput): Promise<PiProject>
  deleteProject(id: string): Promise<PiProject>
  restoreProject(id: string): Promise<PiProject>
  reorderProjects(ids: readonly string[]): Promise<PiProject[]>
  /** 会话归属：写穿 session_meta_set 的 sessionProjects 并回读校验。 */
  assignSessionProject(sessionId: string, projectId: string | null): Promise<void>
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

/** `session_meta_get` 的 wire 形状（Rust SessionMetaStore 全量字段；
 *  projects/sessionProjects 在旧版 Rust 里缺键——缺键按「该切片不提供」
 *  处理，不冒充「没有项目 / 没有归属」）。 */
interface SessionMetaWire extends Partial<PersistedSessions> {
  projects?: PiProject[]
  sessionProjects?: Record<string, string>
}

/** 旧 localStorage 键 → 统一形状合成（hydrate 迁移源；**只读不回写**）。 */
const loadLegacyLocal = (): PersistedSessions => ({
  pinned: parseStringArray(safeGetItem(LEGACY_PINNED_KEY), '旧 pinned'),
  manualOrder: parseNumberRecord(safeGetItem(LEGACY_ORDER_KEY), '旧 order'),
  archived: parseStringArray(safeGetItem(LEGACY_ARCHIVED_KEY), '旧 archived'),
  seen: parseNumberRecord(safeGetItem(LEGACY_SEEN_KEY), '旧 seenCounts'),
  markers: parseStringArray(safeGetItem(LEGACY_MARKERS_KEY), '旧 unreadMarkers'),
  groupsCollapsed: parseBooleanRecord(safeGetItem(LEGACY_GROUPS_KEY), '旧 session-groups'),
})

const hasData = (p: PersistedSessions): boolean =>
  p.pinned.length > 0 ||
  p.archived.length > 0 ||
  p.markers.length > 0 ||
  Object.keys(p.manualOrder).length > 0 ||
  Object.keys(p.seen).length > 0 ||
  Object.keys(p.groupsCollapsed).length > 0

/** 生产级持久化 = **Rust 层 session-meta.json**（app_data_dir，原子写——
 *  hermes 后端 session 索引模式的宿主实现）。写穿防抖 250ms（catalog
 *  动作高频时合并）；Tauri 不可用（纯浏览器/vitest）时静默跳过——目录
 *  水合失败则保持空态，错误经 invoke 的 reject 路径可见（铁律 12）。
 *  **projects 不随此写**：项目注册表只有 `pi_projects_*` 一个写面（Rust
 *  侧 merge_compat 在字段缺省时保留旧值）；sessionProjects 在 meta 水合
 *  之后才随写（水合前发空表会抹掉已有归属）。 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** session_meta_get 已成功返回过——此后 sessionProjects 是可信的本地投影，
 *  可以随写；之前一律缺省（Rust 侧保留旧值）。 */
let metaHydrated = false

const persistNow = (s: SessionCatalogState): void => {
  void invoke('session_meta_set', { store: sessionMetaPayload(s, metaHydrated) }).catch((e) =>
    console.error('[session-catalog] session-meta.json 写穿失败', e),
  )
}

/** `session_meta_set` 的 wire 载荷（管理维度 + 可选 sessionProjects）。
 *  projects 从不随此写——那是 `pi_projects_*` 的写面。 */
const sessionMetaPayload = (
  s: SessionCatalogState,
  includeSessionProjects: boolean,
): Record<string, unknown> => {
  const store: Record<string, unknown> = {
    pinned: [...s.pinned],
    manualOrder: { ...s.manualOrder },
    archived: [...s.archived],
    seen: { ...s.seen },
    markers: [...s.markers],
    groupsCollapsed: { ...s.groupsCollapsed },
  }
  if (includeSessionProjects) store.sessionProjects = { ...s.sessionProjects }
  return store
}

const persist = (s: SessionCatalogState): void => {
  if (!inTauri) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow(s)
  }, 250)
}

/** 启动水合（runtime 挂载 effect 调用一次）：Rust store → 管理维度。
 *  **迁移链**：Rust 文件为空（首启）且旧 localStorage 有数据 → 以旧数据
 *  灌入并写穿 Rust（旧键此后只读，不删除——回滚安全）。
 *  同时水合项目注册表与 sessionProjects（G 侧同一文件；旧 Rust 缺键 =
 *  两个切片都保持空态，projectsLoaded 仍为 false——侧栏因此退回 cwd 分组，
 *  不把「不支持」显示成「没有项目」）。 */
export async function hydrateSessionMeta(): Promise<void> {
  if (!inTauri) return
  const remote = await invoke<SessionMetaWire>('session_meta_get')
  const remoteStore: PersistedSessions = {
    pinned: remote.pinned ?? [],
    manualOrder: remote.manualOrder ?? {},
    archived: remote.archived ?? [],
    seen: remote.seen ?? {},
    markers: remote.markers ?? [],
    groupsCollapsed: remote.groupsCollapsed ?? {},
  }
  const projectSlices: Partial<SessionCatalogState> = {}
  if (remote.projects !== undefined) {
    projectSlices.projects = parseProjects(remote.projects)
    projectSlices.projectsLoaded = true
  }
  if (remote.sessionProjects !== undefined) {
    projectSlices.sessionProjects = parseStringRecord(remote.sessionProjects, 'sessionProjects')
  }
  // 水合成功后 sessionProjects 才是可信投影（此后写穿可携带）。
  metaHydrated = true
  if (hasData(remoteStore)) {
    sessionCatalog.setState({ ...remoteStore, ...projectSlices })
    return
  }
  const legacy = loadLegacyLocal()
  if (hasData(legacy)) {
    sessionCatalog.setState({ ...legacy, ...projectSlices })
    persistNow(sessionCatalog.getState())
    return
  }
  if (Object.keys(projectSlices).length > 0) sessionCatalog.setState(projectSlices)
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

// ── 跨根索引合并（pi_list_sessions 为基线 + pi_sessions_index 补齐）────────
//
// 两个来源正交：旧命令只扫当前 cwd 的会话根（顺序按 lastModified 降序、
// 带 header.timestamp 字符串），新命令扫全部登记根（带 projectId /
// parentSessionId / source 诊断）。合并纪律：
// - 基线行序原样保留（侧栏序不因多来源而抖）；
// - 同 id 由索引覆盖 path/cwd/name/count/lastModified/projectId/谱系/来源；
//   索引没有的 `timestamp`（创建时刻）保留基线值；
// - 索引独有（其它工作区）的行按 lastModified 降序追加在基线之后。

const indexRowCustom = (session: SessionsIndexSession): NonNullable<SessionCatalogRow['custom']> => ({
  path: session.path,
  cwd: session.cwd,
  messageCount: session.messageCount,
  lastModifiedMs: session.lastModified,
  // null = 索引明确「无归属」（ingest 会清掉旧值）；缺键语义不同，见类型注。
  projectId: session.projectId,
  // null = 本体环境（索引补充维；旧 Rust 缺键时 ingest 保留先前值）。
  profile: session.profile,
  parentSessionId: session.parentSessionId,
  sourceRoot: session.sourceRoot,
  source: session.source,
})

export function mergeSessionRows(
  base: readonly SessionCatalogRow[],
  index: readonly SessionsIndexSession[],
): SessionCatalogRow[] {
  const byId = new Map<string, SessionCatalogRow>()
  const order: string[] = []
  for (const row of base) {
    if (byId.has(row.id)) {
      console.error(`[session-catalog] pi_list_sessions 返回重复 id（${row.id}）——保留首条`)
      continue
    }
    byId.set(row.id, row)
    order.push(row.id)
  }
  const appended: { row: SessionCatalogRow; ms: number }[] = []
  for (const session of index) {
    const existing = byId.get(session.id)
    if (existing) {
      byId.set(session.id, {
        ...existing,
        title: session.name ?? existing.title,
        custom: { ...existing.custom, ...indexRowCustom(session) },
      })
    } else {
      appended.push({
        row: { id: session.id, title: session.name ?? undefined, custom: indexRowCustom(session) },
        ms: session.lastModified,
      })
    }
  }
  appended.sort((a, b) => b.ms - a.ms || (a.row.id < b.row.id ? -1 : 1))
  return [...order.map((id) => byId.get(id)!), ...appended.map((a) => a.row)]
}

/** 会话 → 项目归属（显式 sessionProjects 压过索引推断——两者一致时同解，
 *  刚改完归属、索引还没刷新时显式值才是新真相）。 */
export const sessionProjectId = (
  entry: SessionCatalogEntry | undefined,
  sessionProjects: Readonly<Record<string, string>>,
): string | undefined =>
  entry === undefined ? undefined : (sessionProjects[entry.id] ?? entry.projectId)

/** 项目 id → 条目（未知 id 返回 undefined——调用方自行决定如何显示）。 */
export const findProject = (
  projects: readonly PiProject[],
  id: string | undefined,
): PiProject | undefined => (id === undefined ? undefined : projects.find((p) => p.id === id))

// ── store ────────────────────────────────────────────────────────────────

// 管理维度初值 = 空态（真相在 Rust session-meta.json，runtime 挂载时
// hydrateSessionMeta() 水合；localStorage 只作迁移源）。

export const sessionCatalog = createStore<SessionCatalogState>((set, get) => ({
  entries: {},
  piOrder: [],
  activeId: null,
  pendingCwd: null,
  pinned: [],
  manualOrder: {},
  archived: [],
  seen: {},
  markers: [],
  groupsCollapsed: {},
  projects: [],
  projectsLoaded: false,
  projectsError: null,
  sessionProjects: {},
  sessionsIndex: null,
  sessionsIndexError: null,

  ingest: (rows, activeId) => {
    const prev = get().entries
    const entries: Record<string, SessionCatalogEntry> = {}
    const piOrder: string[] = []
    const seen = { ...get().seen }
    let seenChanged = false
    for (const row of rows) {
      const prior = prev[row.id]
      // projectId 三态：null = 索引明确无归属（清旧值）；缺键 = 该来源不
      // 提供这一维（保留先前的推断，pi_list_sessions 的老形状即如此）。
      const rawProject = row.custom?.projectId
      const projectId =
        rawProject === null ? undefined : strOrUndef(rawProject) ?? prior?.projectId
      // profile 三态同 projectId：null = 本体环境（清旧值）；缺键 = 该来源
      // 不提供这一维（pi_list_sessions 基线只带活动环境，保留索引补的值）。
      const rawProfile = row.custom?.profile
      const profile =
        rawProfile === null ? undefined : strOrUndef(rawProfile) ?? prior?.profile
      entries[row.id] = {
        id: row.id,
        path: strOrUndef(row.custom?.path) ?? prior?.path,
        piName: strOrUndef(row.title),
        derivedTitle: prior?.derivedTitle,
        cwd: strOrUndef(row.custom?.cwd),
        messageCount: numOrUndef(row.custom?.messageCount),
        lastModifiedMs: numOrUndef(row.custom?.lastModifiedMs),
        createdMs: numOrUndef(row.custom?.timestamp),
        projectId,
        profile,
        parentSessionId: strOrUndef(row.custom?.parentSessionId),
        sourceRoot: strOrUndef(row.custom?.sourceRoot),
        source: (() => {
          const source = row.custom?.source
          return source === 'sessionDir' ||
            source === 'projectRoot' ||
            source === 'workspace' ||
            source === 'profile'
            ? source
            : prior?.source
        })(),
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

  applySessionIndex: (result, error) => set({ sessionsIndex: result, sessionsIndexError: error }),

  // ── 项目动作（Rust 是真相；失败置 projectsError 并 throw） ──
  loadProjects: async (includeDeleted = false) => {
    try {
      const list = await invoke<PiProject[]>('pi_projects_list', { includeDeleted })
      const projects = sortProjects(parseProjects(list))
      set({ projects, projectsLoaded: true, projectsError: null })
      return projects
    } catch (e) {
      console.error('[session-catalog] 项目列表读取失败（pi_projects_list）', e)
      set({ projectsError: String(e) })
      throw e
    }
  },
  saveProject: async (input) => {
    try {
      const raw = await invoke<PiProject>('pi_projects_save', { project: input })
      const project = parseProjects([raw])[0]
      if (project === undefined) throw new Error('pi_projects_save 返回的项目形状非法')
      const existing = get().projects
      const next = existing.some((p) => p.id === project.id)
        ? existing.map((p) => (p.id === project.id ? project : p))
        : [...existing, project]
      set({ projects: sortProjects(next), projectsLoaded: true, projectsError: null })
      return project
    } catch (e) {
      console.error('[session-catalog] 项目保存失败（pi_projects_save）', e)
      set({ projectsError: String(e) })
      throw e
    }
  },
  deleteProject: async (id) => {
    try {
      const raw = await invoke<PiProject>('pi_projects_delete', { id })
      const project = parseProjects([raw])[0]
      if (project === undefined) throw new Error('pi_projects_delete 返回的项目形状非法')
      set({
        projects: sortProjects(get().projects.map((p) => (p.id === project.id ? project : p))),
        projectsError: null,
      })
      return project
    } catch (e) {
      console.error('[session-catalog] 项目移除失败（pi_projects_delete）', e)
      set({ projectsError: String(e) })
      throw e
    }
  },
  restoreProject: async (id) => {
    try {
      const raw = await invoke<PiProject>('pi_projects_restore', { id })
      const project = parseProjects([raw])[0]
      if (project === undefined) throw new Error('pi_projects_restore 返回的项目形状非法')
      set({
        projects: sortProjects(get().projects.map((p) => (p.id === project.id ? project : p))),
        projectsError: null,
      })
      return project
    } catch (e) {
      console.error('[session-catalog] 项目恢复失败（pi_projects_restore）', e)
      set({ projectsError: String(e) })
      throw e
    }
  },
  reorderProjects: async (ids) => {
    try {
      const raw = await invoke<PiProject[]>('pi_projects_reorder', { ids: [...ids] })
      const returned = parseProjects(raw)
      // 命令只返回活跃项目；已软删的条目保留本地副本（回收站视图不丢）。
      const byId = new Map(returned.map((p) => [p.id, p] as const))
      const merged: PiProject[] = []
      for (const project of get().projects) {
        const updated = byId.get(project.id)
        if (updated !== undefined) {
          merged.push(updated)
          byId.delete(project.id)
        } else if (project.deletedAt !== undefined) {
          merged.push(project)
        }
      }
      for (const project of byId.values()) merged.push(project)
      const projects = sortProjects(merged)
      set({ projects, projectsLoaded: true, projectsError: null })
      return projects
    } catch (e) {
      console.error('[session-catalog] 项目排序失败（pi_projects_reorder）', e)
      set({ projectsError: String(e) })
      throw e
    }
  },
  assignSessionProject: async (sessionId, projectId) => {
    const prevMap = get().sessionProjects
    const prevEntry = get().entries[sessionId]
    const nextMap = { ...prevMap }
    if (projectId === null) delete nextMap[sessionId]
    else nextMap[sessionId] = projectId
    const entriesAfter =
      prevEntry === undefined
        ? get().entries
        : { ...get().entries, [sessionId]: { ...prevEntry, projectId: projectId ?? undefined } }
    set({ sessionProjects: nextMap, entries: entriesAfter })
    try {
      if (!inTauri) throw new Error('不在 Tauri 运行时，无法持久化会话归属')
      if (!metaHydrated) throw new Error('session-meta 尚未水合完成，无法写入会话归属')
      // 归属没有专用命令：随 session_meta_set 全量携带 sessionProjects。
      // 写前取消防抖中的旧载荷，避免旧表覆盖这次改动。
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      await invoke('session_meta_set', {
        store: sessionMetaPayload(get(), true),
      })
      // 写后回读校验（旧 Rust 的 SessionMetaStore 没有 sessionProjects 字段，
      // serde 会静默忽略——这里必须让它变成可见错误，而不是假装已保存）。
      const remote = await invoke<SessionMetaWire>('session_meta_get')
      const persisted =
        remote.sessionProjects === undefined
          ? null
          : parseStringRecord(remote.sessionProjects, 'sessionProjects')
      const ok =
        persisted !== null &&
        (projectId === null ? persisted[sessionId] === undefined : persisted[sessionId] === projectId)
      if (!ok) {
        throw new Error(
          '会话归属未落到 Rust：session_meta_set 的 sessionProjects 切片被忽略（运行中的 Rust 未实现该字段）',
        )
      }
      set({ projectsError: null })
    } catch (e) {
      console.error('[session-catalog] 会话归属写入失败——回滚本地投影', e)
      set({
        sessionProjects: prevMap,
        entries:
          prevEntry === undefined
            ? get().entries
            : { ...get().entries, [sessionId]: prevEntry },
      })
      throw e
    }
  },

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
  setArchived: (id, archived) => {
    const has = get().archived.includes(id)
    if (has === archived) return
    const next = archived
      ? [...get().archived, id]
      : get().archived.filter((x) => x !== id)
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
    // 归属映射同样随会话消亡（Rust 侧残留映射无害，但界面不再有该行）。
    const sessionProjects: Record<string, string> = {}
    for (const [id, projectId] of Object.entries(s.sessionProjects)) {
      if (alive.has(id)) sessionProjects[id] = projectId
    }
    if (
      pinned.length === s.pinned.length &&
      Object.keys(manualOrder).length === Object.keys(s.manualOrder).length &&
      archived.length === s.archived.length &&
      markers.length === s.markers.length &&
      Object.keys(seen).length === Object.keys(s.seen).length &&
      Object.keys(sessionProjects).length === Object.keys(s.sessionProjects).length
    ) {
      return
    }
    set({ pinned, manualOrder, archived, markers, seen, sessionProjects })
    persist({ ...get(), pinned, manualOrder, archived, markers, seen, sessionProjects })
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
