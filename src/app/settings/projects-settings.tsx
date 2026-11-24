/**
 * 设置页 · 项目（2026-11-15 落地，2026-11-22 按 ZCode 数据与统计 → 项目管理
 * 全量对齐：未使用检测 + 搜索/过滤/排序 + 多选批量移除）。
 *
 * ZCode 源码对位（packages/ui/src/project-sidebar/ProjectManagement.tsx +
 * project-management-view.ts）：
 * - 未使用检测：missing（根目录缺失）/ empty（无会话且创建 > 7 天）/ idle
 *   （最近活动 > 90 天）；**置顶项目不参与**；
 * - 顶部建议卡（三类计数 + 「审阅 N 个项目」→ 切到「未使用」并预选）；
 * - 搜索（名称 / 根目录）+ 过滤（全部 / 未使用）+ 排序（最近活动 / 名称 /
 *   会话数 /（宿主保留）自定义顺序）；
 * - 行：项目 / 会话数 / 最近活动 / 未使用原因徽标；
 * - 多选 + 全选 + 「移除选中」批量软删；回收站恢复。
 *
 * 宿主数据面：
 * - 项目注册表 = Rust `pi_projects_list/save/delete/restore/reorder`；
 * - 会话数 / 最近活动 = `pi_sessions_index` 按 projectId 聚合（与归档页同源）；
 * - 根目录缺失 = 新 IPC `fs_paths_exist`（只读探测，ZCode primaryRootStatus
 *   的宿主等价物）；探测失败不伪造「存在」，如实按缺失提示。
 *
 * ZCode 的「设备」列与远程项目入口（remote host / entry removal）在宿主
 * 无对应栈——不渲染（不造假）。
 *
 * **彻底删除缺口（不造假）**：Rust 只有软删（`deletedAt`）与恢复，没有
 * purge 命令；回收站的「彻底删除」保留为禁用位并注明缺什么。
 *
 * 失败可见（铁律 12）：注册表/索引/探测失败各自红条 + console.error；
 * 批量移除逐条失败汇总，不把部分成功说成全部成功。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog'
import {
  ChevronRight,
  Clock,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderX,
  MessageCircleOff,
  MoreHorizontal,
  Pencil,
  Pin,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'

import {
  sessionCatalog,
  useSessionManage,
  type PiProject,
  type SessionsIndexResult,
  type SessionsIndexSession,
} from '@/components/panes/session-manage/session-catalog'
import { requestSessionListRefresh } from '@/components/panes/session-manage/session-refresh-bridge'

/** 根目录多行文本 → 数组（逐行 trim 去空；去重/规范化在 Rust）。 */
const splitRoots = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

export type ProjectSort = 'lastActive' | 'name' | 'sessions'
export type ProjectFilter = 'all' | 'unused'
export type ProjectUnusedReason = 'missing' | 'empty' | 'idle'

const SORT_LABELS: Record<ProjectSort, string> = {
  lastActive: '最近活动',
  name: '名称',
  sessions: '会话数',
}

const DAY_MS = 86_400_000
/** 空项目宽限期（ZCode EMPTY_GRACE_DAYS）。 */
const EMPTY_GRACE_DAYS = 7
/** 闲置判定阈值（ZCode IDLE_DAYS）。 */
const IDLE_DAYS = 90

/** 项目管理表列（ZCode PROJECT_MANAGEMENT_GRID：项目 / 设备 / 会话数 / 最近活动 / 操作）。 */
const PROJECT_GRID = '1rem minmax(0,1fr) 8rem 4.75rem 7rem 1.5rem'

/** 项目维度会话统计（会话数 + 最近活动；`projectId: null` 不计入）。 */
export interface ProjectSessionStat {
  sessions: number
  lastActiveAt: number | null
}

export function projectSessionStats(
  sessions: readonly SessionsIndexSession[],
): Map<string, ProjectSessionStat> {
  const stats = new Map<string, ProjectSessionStat>()
  for (const session of sessions) {
    if (session.projectId === null) continue
    const current = stats.get(session.projectId) ?? { sessions: 0, lastActiveAt: null }
    current.sessions += 1
    if (session.lastModified > 0) {
      current.lastActiveAt = Math.max(current.lastActiveAt ?? 0, session.lastModified)
    }
    stats.set(session.projectId, current)
  }
  return stats
}

/**
 * 未使用原因（ZCode `unusedReason` 的宿主口径）：
 * - 置顶项目不参与（用户明确要保留）；
 * - missing：有根目录但全部不存在（根目录探测不可用/无根目录时不判）；
 * - empty：无会话，且创建超过 7 天宽限期；
 * - idle：最近活动超过 90 天。
 */
export function projectUnusedReason(input: {
  project: PiProject
  stat: ProjectSessionStat | undefined
  /** 该项目的根目录是否至少存在一个；undefined = 未探测/无根目录。 */
  rootsAvailable: boolean | undefined
  now: number
}): ProjectUnusedReason | null {
  const { project, stat, rootsAvailable, now } = input
  if (project.deletedAt !== undefined || project.pinned) return null
  if (rootsAvailable === false) return 'missing'
  const sessions = stat?.sessions ?? 0
  if (sessions === 0) {
    return project.createdAt > 0 && now - project.createdAt > EMPTY_GRACE_DAYS * DAY_MS
      ? 'empty'
      : null
  }
  const lastActiveAt = stat?.lastActiveAt ?? null
  if (lastActiveAt !== null && now - lastActiveAt > IDLE_DAYS * DAY_MS) return 'idle'
  return null
}

/** 搜索命中：项目名或任一根目录（大小写不敏感子串）。 */
export const projectMatchesQuery = (project: PiProject, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  if (project.name.toLowerCase().includes(q)) return true
  return project.roots.some((root) => root.toLowerCase().includes(q))
}

export interface ProjectRow {
  project: PiProject
  sessions: number | null
  lastActiveAt: number | null
  reason: ProjectUnusedReason | null
}

/** 过滤 + 排序（纯函数，可单测）。 */
export function selectProjectRows(
  rows: readonly ProjectRow[],
  options: { query: string; filter: ProjectFilter; sort: ProjectSort },
): ProjectRow[] {
  const filtered = rows
    .filter((row) => options.filter === 'all' || row.reason !== null)
    .filter((row) => projectMatchesQuery(row.project, options.query))
  const list = [...filtered]
  const byName = (a: ProjectRow, b: ProjectRow) =>
    a.project.name.localeCompare(b.project.name, 'zh-Hans-CN') ||
    (a.project.id < b.project.id ? -1 : 1)
  switch (options.sort) {
    case 'name':
      return list.sort(byName)
    case 'sessions':
      return list.sort(
        (a, b) => (b.sessions ?? -1) - (a.sessions ?? -1) || byName(a, b),
      )
    case 'lastActive':
      return list.sort(
        (a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || byName(a, b),
      )
  }
}

const REASON_LABELS: Record<ProjectUnusedReason, string> = {
  missing: '文件夹不存在',
  empty: '没有会话',
  idle: '未使用',
}

/** ZCode 的相对时间（分钟/小时/昨天/天/月/年，numeric:auto）。 */
function formatRelativeTime(ms: number | null): string {
  if (ms === null || ms <= 0) return '—'
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * DAY_MS],
    ['month', 30 * DAY_MS],
    ['day', DAY_MS],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ]
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (abs >= size || unit === 'minute') {
      return formatter.format(Math.round(diff / size), unit)
    }
  }
  return formatter.format(0, 'minute')
}

function idleMonths(days: number): number {
  return Math.max(1, Math.floor(days / 30))
}

export function ProjectsSettingsSection({
  headerLabel = '项目',
}: {
  /** 节标题。null = 不画（宿主外壳已有固定节标题，如 G 的 set-inset-head）。 */
  headerLabel?: string | null
} = {}) {
  const projects = useSessionManage((s) => s.projects)
  const projectsLoaded = useSessionManage((s) => s.projectsLoaded)
  const projectsError = useSessionManage((s) => s.projectsError)
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<ProjectSort>('lastActive')
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionRetry, setActionRetry] = useState<(() => void) | null>(null)
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // 会话统计（pi_sessions_index 聚合）+ 根目录探测（fs_paths_exist）
  const [stats, setStats] = useState<Map<string, ProjectSessionStat> | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsNonce, setStatsNonce] = useState(0)
  const [rootsExist, setRootsExist] = useState<Map<string, boolean>>(new Map())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = useState(50)
  const [recycleLimit, setRecycleLimit] = useState(10)
  const [pendingRemove, setPendingRemove] = useState<readonly PiProject[] | null>(null)
  // 行内编辑（名字 + 根目录整表）；null = 全部不在编辑态
  const [editing, setEditing] = useState<{ id: string; name: string; rootsText: string } | null>(
    null,
  )

  const refresh = useCallback(() => {
    void sessionCatalog
      .getState()
      .loadProjects(true)
      .catch(() => {
        // projectsError 已由 store 置上（页面顶部红条可见）
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const activeProjects = useMemo(
    () => projects.filter((project) => project.deletedAt === undefined),
    [projects],
  )
  const deletedProjects = useMemo(
    () => projects.filter((project) => project.deletedAt !== undefined),
    [projects],
  )

  /** 会话统计 + 根目录存在性（两路都失败可见；不伪造事实）。 */
  useEffect(() => {
    let cancelled = false
    const roots = [...new Set(activeProjects.flatMap((project) => project.roots))]
    setStatsLoading(true)
    void (async () => {
      try {
        try {
          const index = await invoke<SessionsIndexResult>('pi_sessions_index')
          if (!cancelled) {
            setStats(projectSessionStats(index.sessions))
            setStatsError(null)
          }
        } catch (e) {
          console.error('[projects-settings] 会话索引读取失败（pi_sessions_index）', e)
          if (!cancelled) {
            setStats(null)
            setStatsError(`会话统计读取失败：${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (roots.length === 0) {
          if (!cancelled) setRootsExist(new Map())
          return
        }
        try {
          const exist = await invoke<boolean[]>('fs_paths_exist', { paths: roots })
          if (!cancelled) {
            setRootsExist(new Map(roots.map((root, i) => [root, exist[i] === true])))
          }
        } catch (e) {
          console.error('[projects-settings] 根目录探测失败（fs_paths_exist）', e)
          if (!cancelled) {
            setRootsExist(new Map())
            setStatsError((prev) =>
              prev === null
                ? `根目录探测失败：${e instanceof Error ? e.message : String(e)}`
                : `${prev}；根目录探测失败`,
            )
          }
        }
      } finally {
        if (!cancelled) setStatsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProjects, statsNonce])

  const now = useMemo(() => Date.now(), [projects, stats])

  const rows: ProjectRow[] = useMemo(
    () =>
      activeProjects.map((project) => {
        const stat = stats?.get(project.id)
        const rootsAvailable =
          project.roots.length === 0 || rootsExist.size === 0
            ? undefined
            : project.roots.some((root) => rootsExist.get(root) === true)
        return {
          project,
          sessions: stats === null ? null : (stat?.sessions ?? 0),
          lastActiveAt: stat?.lastActiveAt ?? null,
          reason: statsLoading ? null : projectUnusedReason({ project, stat, rootsAvailable, now }),
        }
      }),
    [activeProjects, stats, rootsExist, now, statsLoading],
  )
  const unused = useMemo(() => {
    const count = (reason: ProjectUnusedReason) =>
      rows.filter((row) => row.reason === reason).length
    const summary = {
      missing: count('missing'),
      empty: count('empty'),
      idle: count('idle'),
    }
    return { total: summary.missing + summary.empty + summary.idle, ...summary }
  }, [rows])
  const visible = useMemo(
    () => selectProjectRows(rows, { query, filter, sort: sortMode }),
    [rows, query, filter, sortMode],
  )
  const visibleIds = useMemo(() => visible.map((row) => row.project.id), [visible])
  const selectedProjects = useMemo(
    () => visible.filter((row) => selected.has(row.project.id)).map((row) => row.project),
    [visible, selected],
  )
  const allSelected = visible.length > 0 && selectedProjects.length === visible.length

  async function run(
    id: string,
    label: string,
    fn: () => Promise<unknown>,
    done: string,
    undo?: () => void,
  ): Promise<void> {
    setBusyId(id)
    setActionError(null)
    setActionRetry(null)
    setNotice(null)
    try {
      await fn()
      setNotice({ text: done, undo })
      requestSessionListRefresh()
    } catch (e) {
      console.error(`[projects-settings] ${label}失败`, e)
      setActionError(`${label}失败：${e instanceof Error ? e.message : String(e)}`)
      setActionRetry(() => () => void run(id, label, fn, done, undo))
    } finally {
      setBusyId(null)
    }
  }

  const saveEdit = (project: PiProject) => {
    if (editing === null || editing.id !== project.id) return
    const name = editing.name.trim()
    if (name === '') {
      setActionError('项目名不能为空（Rust 侧同样拒绝空名）')
      setActionRetry(null)
      return
    }
    return run(
      project.id,
      '保存项目',
      async () => {
        await sessionCatalog.getState().saveProject({
          id: project.id,
          name,
          roots: splitRoots(editing.rootsText),
        })
        setEditing(null)
      },
      `已保存「${name}」`,
    )
  }

  const removeProject = (project: PiProject) => {
    const undo = () => {
      void run(project.id, '恢复项目', () => sessionCatalog.getState().restoreProject(project.id), `已恢复「${project.name}」`)
    }
    return run(
      project.id,
      '移除项目',
      () => sessionCatalog.getState().deleteProject(project.id),
      `已移除「${project.name}」`,
      undo,
    )
  }

  /** 批量软删（ZCode 多选移除的宿主口径：逐条失败汇总，不吞）。 */
  async function removeBatch(targets: readonly PiProject[]): Promise<void> {
    if (targets.length === 0) return
    setBusyId('batch')
    setActionError(null)
    setActionRetry(null)
    setNotice(null)
    const removed: PiProject[] = []
    const failed: PiProject[] = []
    const failures: string[] = []
    for (const project of targets) {
      try {
        await sessionCatalog.getState().deleteProject(project.id)
        removed.push(project)
      } catch (e) {
        console.error(`[projects-settings] 移除项目失败（${project.name}）`, e)
        failed.push(project)
        failures.push(`${project.name}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (removed.length > 0) {
      requestSessionListRefresh()
      setSelected((prev) => new Set([...prev].filter((id) => !removed.some((p) => p.id === id))))
    }
    if (removed.length > 0) {
      setNotice({
        text: `已移除 ${removed.length} 个项目`,
        undo: () => {
          void (async () => {
            for (const project of removed) {
              try {
                await sessionCatalog.getState().restoreProject(project.id)
              } catch (e) {
                console.error(`[projects-settings] 撤销移除失败（${project.name}）`, e)
                setActionError(`撤销移除失败（${project.name}）：${e instanceof Error ? e.message : String(e)}`)
              }
            }
            requestSessionListRefresh()
          })()
        },
      })
    }
    if (failures.length > 0) {
      setActionError(`移除 ${failures.length} 个项目失败：${failures[0]}`)
      setActionRetry(() => () => void removeBatch(failed))
    }
    setPendingRemove(null)
    setBusyId(null)
  }

  const restoreProject = (project: PiProject) =>
    run(
      project.id,
      '恢复项目',
      () => sessionCatalog.getState().restoreProject(project.id),
      `已恢复「${project.name}」`,
    )

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** 目录选择（ZCode ProjectEditor 的浏览钮）：追加一个根目录到草稿文本。 */
  const browseRoot = useCallback(
    async (append: (root: string) => void) => {
      try {
        const picked = await openDirectoryDialog({
          directory: true,
          multiple: false,
          title: '选择项目根目录',
        })
        if (typeof picked !== 'string' || picked.length === 0) return
        append(picked.replace(/\\/g, '/'))
      } catch (e) {
        console.error('[projects-settings] 目录选择失败', e)
        setActionError(`目录选择失败：${e instanceof Error ? e.message : String(e)}`)
        setActionRetry(null)
      }
    },
    [],
  )

  const reviewUnused = () => {
    setFilter('unused')
    setQuery('')
    setSortMode('lastActive')
    setSelected(new Set(rows.filter((row) => row.reason !== null).map((row) => row.project.id)))
  }

  const resetView = () => {
    setSelected(new Set())
    setLimit(50)
  }

  const editingProject =
    editing === null ? undefined : activeProjects.find((project) => project.id === editing.id)

  const selectedSessionTotal = selectedProjects.reduce((sum, project) => {
    const row = rows.find((candidate) => candidate.project.id === project.id)
    return sum + (row?.sessions ?? 0)
  }, 0)

  return (
    <section className="set-section">
      {headerLabel !== null && (
        <header className="set-section-head">
          <h3 className="set-section-title">{headerLabel}</h3>
        </header>
      )}
      <p className="set-hint">
        移除项目只会把它从侧栏和项目选择器中拿掉。会话仍保留在最近和搜索中，磁盘上的文件不受影响。
      </p>

      {projectsError !== null && (
        <div className="set-err set-err-row" role="alert">
          <TriangleAlert aria-hidden className="size-[var(--size-icon-md)] shrink-0" />
          <span style={{ flex: '1 1 0', minWidth: 0 }}>无法加载项目：{projectsError}</span>
          <button className="set-btn" onClick={refresh} type="button">
            重试
          </button>
        </div>
      )}
      {statsError !== null && (
        <div className="set-err set-err-row" role="alert">
          <TriangleAlert aria-hidden className="size-[var(--size-icon-md)] shrink-0" />
          <span style={{ flex: '1 1 0', minWidth: 0 }}>{statsError}</span>
          <button className="set-btn" onClick={() => setStatsNonce((n) => n + 1)} type="button">
            重试
          </button>
        </div>
      )}
      {actionError !== null && (
        <div className="set-err set-err-row" role="alert">
          <TriangleAlert aria-hidden className="size-[var(--size-icon-md)] shrink-0" />
          <span style={{ flex: '1 1 0', minWidth: 0 }}>{actionError}</span>
          {actionRetry !== null && (
            <button className="set-btn" onClick={actionRetry} type="button">
              重试
            </button>
          )}
          <button
            aria-label="关闭"
            className="set-btn"
            onClick={() => {
              setActionError(null)
              setActionRetry(null)
            }}
            type="button"
          >
            <X className="size-[var(--size-icon-md)]" />
          </button>
        </div>
      )}
      {notice !== null && (
        <span className="set-saved">
          {notice.text}
          {notice.undo !== undefined && (
            <button className="set-btn" onClick={notice.undo} style={{ marginLeft: 8 }} type="button">
              撤销
            </button>
          )}
        </span>
      )}

      {filter === 'all' && unused.total > 0 && projectsLoaded && !statsLoading && (
        <div className="set-acct-card">
          <div className="set-acct-card-body" style={{ gap: 8 }}>
            <div className="set-actions" style={{ justifyContent: 'space-between' }}>
              <div>
                <span className="set-acct-field-label">{unused.total} 个项目疑似不再使用</span>
                <div className="set-actions" style={{ marginTop: 4 }}>
                  {unused.missing > 0 && (
                    <span className="set-row-source" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <FolderX aria-hidden className="size-3.5" /> {unused.missing} 个文件夹不存在
                    </span>
                  )}
                  {unused.empty > 0 && (
                    <span className="set-row-source" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MessageCircleOff aria-hidden className="size-3.5" /> {unused.empty} 个没有会话
                    </span>
                  )}
                  {unused.idle > 0 && (
                    <span className="set-row-source" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Clock aria-hidden className="size-3.5" /> {unused.idle} 个超过 90 天未使用
                    </span>
                  )}
                </div>
              </div>
              <button className="set-btn" onClick={reviewUnused} type="button">
                复核 {unused.total} 个
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) 12rem auto' }}>
        <div className="relative" style={{ minWidth: 0 }}>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="搜索项目、文件夹或设备"
            className="set-input"
            onChange={(e) => {
              setQuery(e.target.value)
              resetView()
            }}
            placeholder="搜索项目、文件夹或设备"
            style={{ paddingLeft: 30, paddingRight: query === '' ? undefined : 28 }}
            value={query}
          />
          {query !== '' && (
            <button
              aria-label="清除搜索"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setQuery('')
                resetView()
              }}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <select
          aria-label="显示"
          className="set-select"
          onChange={(e) => {
            setFilter(e.target.value as ProjectFilter)
            resetView()
          }}
          value={filter}
        >
          <option value="all">全部项目</option>
          <option value="unused">疑似不再使用 · {unused.total}</option>
        </select>
        <div className="set-actions" style={{ gap: 6 }}>
          <span className="set-row-source">排序</span>
          <select
            aria-label="排序"
            className="set-select"
            onChange={(e) => setSortMode(e.target.value as ProjectSort)}
            value={sortMode}
          >
            {(Object.keys(SORT_LABELS) as ProjectSort[]).map((mode) => (
              <option key={mode} value={mode}>
                {SORT_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!projectsLoaded && projectsError === null && (
        <p className="py-8 text-sm text-muted-foreground" role="status">
          正在加载项目…
        </p>
      )}

      {projectsLoaded && activeProjects.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">还没有项目</p>
      )}

      {projectsLoaded && activeProjects.length > 0 && visible.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {filter === 'unused' && query.trim() === ''
            ? '目前没有疑似不再使用的项目'
            : '没有匹配的项目'}
        </p>
      )}

      {!statsLoading && visible.length > 0 && (
        <div className="set-table set-project-table">
          <div
            className="set-table-head set-project-table-head"
            style={{ '--project-grid': PROJECT_GRID } as CSSProperties}
          >
            <input
              aria-label="全选"
              checked={allSelected}
              disabled={busyId !== null}
              onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
              ref={(el) => {
                if (el !== null) {
                  el.indeterminate = !allSelected && selectedProjects.length > 0
                }
              }}
              type="checkbox"
            />
            <span className="set-table-cell set-project-select-label">
              <span className="set-project-only-mobile">全选</span>
              <span className="set-project-only-md">项目</span>
            </span>
            <span className="set-table-cell set-project-col-md">设备</span>
            <span className="set-table-cell set-project-col-md" style={{ textAlign: 'right' }}>会话</span>
            <span className="set-table-cell set-project-col-md" style={{ textAlign: 'right' }}>最近活动</span>
            <span className="set-project-col-md" />
          </div>
          {visible.slice(0, limit).map((row) => {
            const project = row.project
            const primaryRoot = project.roots[0] ?? ''
            const extraRoots = project.roots.slice(1)
            const idleDays =
              row.reason === 'idle' && row.lastActiveAt !== null
                ? (now - row.lastActiveAt) / DAY_MS
                : 0
            return (
              <div
                className="set-table-row set-project-table-row group"
                key={project.id}
                style={{ '--project-grid': PROJECT_GRID } as CSSProperties}
              >
                <input
                  aria-label={`选择 ${project.name}`}
                  checked={selected.has(project.id)}
                  disabled={busyId !== null}
                  onChange={() => toggleSelected(project.id)}
                  type="checkbox"
                />
                <div style={{ minWidth: 0 }}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
                    {project.roots.length > 1 ? (
                      <FolderOpen aria-hidden className="hidden size-[var(--size-icon-md)] shrink-0 text-muted-foreground md:block" />
                    ) : (
                      <Folder aria-hidden className="hidden size-[var(--size-icon-md)] shrink-0 text-muted-foreground md:block" />
                    )}
                    <span className="min-w-0 truncate font-medium" title={project.name}>
                      {project.name}
                    </span>
                    {project.pinned === true && (
                      <Pin
                        aria-label="已置顶"
                        className="size-[var(--size-icon-sm)] shrink-0 text-muted-foreground"
                      />
                    )}
                    {row.reason !== null && (
                      <span
                        className={
                          row.reason === 'missing'
                            ? 'set-row-miss'
                            : 'set-row-source'
                        }
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                      >
                        {row.reason === 'missing' && <FolderX aria-hidden className="size-[var(--size-icon-sm)]" />}
                        {row.reason === 'empty' && <MessageCircleOff aria-hidden className="size-[var(--size-icon-sm)]" />}
                        {row.reason === 'idle' && <Clock aria-hidden className="size-[var(--size-icon-sm)]" />}
                        {row.reason === 'idle'
                          ? `${idleMonths(idleDays)} 个月未使用`
                          : REASON_LABELS[row.reason]}
                      </span>
                    )}
                  </div>
                  <div className="set-table-sub">
                    {primaryRoot !== '' ? (
                      <span className="font-mono" title={primaryRoot}>
                        {primaryRoot}
                      </span>
                    ) : null}
                    {extraRoots.length > 0 && (
                      <TooltipProvider delayDuration={0}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              aria-label={`另外 ${extraRoots.length} 个目录`}
                              className="set-project-roots-tag"
                              type="button"
                            >
                              +{extraRoots.length}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent align="start" side="bottom" sideOffset={6}>
                            <span className="flex flex-col gap-0.5 font-mono">
                              {extraRoots.map((root) => (
                                <span className="break-all" key={root}>
                                  {root}
                                </span>
                              ))}
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                  <span className="set-project-mobile-meta">
                    <span>此电脑</span>
                    <span aria-hidden>·</span>
                    <span>
                      {row.sessions === null ? '设备离线' : `${row.sessions} 个会话`}
                    </span>
                    {row.sessions !== null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {row.lastActiveAt === null
                            ? '从未使用'
                            : formatRelativeTime(row.lastActiveAt)}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <span className="set-table-cell set-project-col-md">此电脑</span>
                <span className="set-table-cell set-project-col-md" style={{ textAlign: 'right' }}>
                  {row.sessions === null ? '—' : row.sessions}
                </span>
                <span className="set-table-cell set-project-col-md" style={{ textAlign: 'right' }}>
                  {stats === null
                    ? '—'
                    : row.lastActiveAt === null
                      ? '从未使用'
                      : formatRelativeTime(row.lastActiveAt)}
                </span>
                <div className="set-project-col-md">
                  <ContextMenu anchor="trigger">
                    <ContextMenuTrigger>
                      <button
                        aria-label={`${project.name} 的操作`}
                        className="set-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                        disabled={busyId !== null}
                        type="button"
                      >
                        <MoreHorizontal className="size-[var(--size-icon-md)]" />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => {
                          setEditing({
                            id: project.id,
                            name: project.name,
                            rootsText: project.roots.join('\n'),
                          })
                          setActionError(null)
                          setActionRetry(null)
                        }}
                      >
                        <Pencil className="size-3.5" /> 编辑项目
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => setPendingRemove([project])}
                        tone="destructive"
                      >
                        <FolderMinus className="size-3.5" /> 移除…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              </div>
            )
          })}
          {visible.length > limit && (
            <div className="set-actions" style={{ justifyContent: 'center' }}>
              <button className="set-btn" onClick={() => setLimit((n) => n + 50)} type="button">
                再显示 {Math.min(50, visible.length - limit)} 个
              </button>
            </div>
          )}
        </div>
      )}

      {deletedProjects.length > 0 && (
        <details className="group">
          <summary className="set-row set-removed-head" style={{ cursor: 'pointer' }}>
            <FolderMinus aria-hidden className="size-[var(--size-icon-md)]" />
            <span className="set-row-provider">已移除的项目</span>
            <span className="set-row-source">{deletedProjects.length} 个项目</span>
            <ChevronRight
              aria-hidden
              className="size-[var(--size-icon-sm)] text-muted-foreground transition-transform group-open:rotate-90"
            />
          </summary>
          <div className="set-removed-table">
            {deletedProjects.slice(0, recycleLimit).map((project) => (
              <div className="set-removed-row" key={project.id}>
                <div className="set-removed-text">
                  <span className="set-row-provider" title={project.name}>
                    {project.name}
                  </span>
                  {project.roots[0] !== undefined && project.roots[0] !== '' && (
                    <span className="set-row-env font-mono" title={project.roots[0]}>
                      {project.roots[0]}
                    </span>
                  )}
                </div>
                <span className="set-row-source set-removed-when">
                  {project.deletedAt !== undefined
                    ? `${formatRelativeTime(project.deletedAt)}移除`
                    : ''}
                </span>
                <button
                  className="set-btn"
                  disabled={busyId !== null}
                  onClick={() => void restoreProject(project)}
                  type="button"
                >
                  <RotateCcw className="inline size-3.5" /> 恢复
                </button>
              </div>
            ))}
            {deletedProjects.length > recycleLimit && (
              <div className="set-actions" style={{ justifyContent: 'center' }}>
                <button
                  className="set-btn"
                  onClick={() => setRecycleLimit((n) => n + 50)}
                  type="button"
                >
                  再显示 {Math.min(50, deletedProjects.length - recycleLimit)} 个
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {selectedProjects.length > 0 && (
        <div
          className="set-actions"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--stroke)',
            borderRadius: 'var(--radius-control)',
            bottom: 16,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: '8px 12px',
            position: 'sticky',
            zIndex: 5,
          }}
        >
          <span className="set-acct-field-label">已选 {selectedProjects.length} 个</span>
          <span className="set-row-source">共 {visible.length} 个</span>
          <button className="set-btn" onClick={() => setSelected(new Set())} type="button">
            清除
          </button>
          <span style={{ flex: '1 1 auto' }} />
          <button
            className="set-btn set-btn-destructive"
            disabled={busyId !== null}
            onClick={() => setPendingRemove(selectedProjects)}
            type="button"
          >
            <FolderMinus className="inline size-3.5" /> 移除 {selectedProjects.length} 个项目
          </button>
        </div>
      )}

      <ConfirmDialog
        busyLabel="正在移除…"
        confirmLabel={
          pendingRemove === null ? '移除' : `移除 ${pendingRemove.length} 个项目`
        }
        description={
          pendingRemove === null
            ? undefined
            : `${pendingRemove.length === 1 ? '它会' : '它们会'}从侧栏和项目选择器中移除，其中的会话（${selectedSessionTotal} 个）仍保留在最近和搜索中，磁盘上的文件夹不受影响。本机项目之后可在本页的「已移除的项目」中恢复。`
        }
        destructive
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove !== null) {
            return removeBatch(pendingRemove)
          }
        }}
        open={pendingRemove !== null}
        title={pendingRemove === null ? '移除项目？' : `移除 ${pendingRemove.length} 个项目？`}
      >
        <div className="set-rows">
          {(pendingRemove ?? []).map((project) => (
            <div className="set-row" key={project.id}>
              <span className="set-row-provider">{project.name}</span>
              <span className="set-row-source">此电脑</span>
            </div>
          ))}
        </div>
      </ConfirmDialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑项目</DialogTitle>
          </DialogHeader>
          {editing !== null && editingProject !== undefined && (
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-sm">
                名称
                <input
                  className="set-input"
                  disabled={busyId !== null}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  value={editing.name}
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                根目录（每行一个）
                <textarea
                  className="set-textarea"
                  disabled={busyId !== null}
                  onChange={(e) => setEditing({ ...editing, rootsText: e.target.value })}
                  rows={3}
                  value={editing.rootsText}
                />
              </label>
              <div>
                <button
                  className="set-btn"
                  disabled={busyId !== null}
                  onClick={() =>
                    void browseRoot((root) =>
                      setEditing((prev) =>
                        prev === null
                          ? prev
                          : {
                              ...prev,
                              rootsText:
                                prev.rootsText.trim() === ''
                                  ? root
                                  : `${prev.rootsText}\n${root}`,
                            },
                      ),
                    )
                  }
                  type="button"
                >
                  浏览…
                </button>
              </div>
            </div>
          )}
          <DialogFooter>
            <button className="set-btn" onClick={() => setEditing(null)} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary"
              disabled={busyId !== null || editingProject === undefined}
              onClick={() => {
                if (editingProject !== undefined) void saveEdit(editingProject)
              }}
              type="button"
            >
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
