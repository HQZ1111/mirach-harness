/**
 * 设置页 · 归档管理（2026-11-15 落地，2026-11-22 按 ZCode 数据与统计 →
 * 归档管理全量对齐：自动归档偏好 + 搜索/排序/项目过滤 + 分组操作）。
 *
 * ZCode 源码对位：
 * - `settingsPageHelpers.tsx:68` TaskAutoArchiveSettings（两行：自动归档
 *   开关 + 归档保留时长 3/7/14/30 天）；
 * - `project-sidebar/ArchiveManagement.tsx`（标题 + 删除全部/筛选结果 +
 *   搜索 + 排序 + 项目过滤 + 分组卡）；
 * - `project-sidebar/ArchiveGroupCard.tsx`（可折叠组 / N 个会话 / 组操作
 *   全部取消归档·全部删除 / 行删除 + 取消归档 / 每页 50 条「显示更多」）；
 * - `project-sidebar/useArchiveManagement.ts`（删除前确认、成功/失败/跳过
 *   计数、逐条失败详情）。
 *
 * 宿主适配（不造假）：
 * - 自动归档 = app-prefs（`taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays`）
 *   + lib/auto-archive 调度器（启动首轮 + 每 5 分钟 + 设置变更补扫；
 *   置顶/当前会话不归档）；
 * - 「创建时间」= 会话 header.createdAt（pi_sessions_index 透出）；旧文件
 *   没有该字段时按 0 参与排序（排最后），不伪造时间；
 * - 「永久删除」= 宿主删除会话文件（`pi_delete_session`，不可恢复）；
 *   当前打开的会话跳过并计入「跳过」；ZCode 的分享保留/分叉预检在宿主
 *   无对应栈（无分享服务、无子会话删除预览），不做假预览；
 * - 组内行没有「已发布分享链接」概念（宿主无分享服务），删除不做分享保留
 *   提示。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRight, Folder, MoreHorizontal, Search, Trash2, TriangleAlert, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'

import {
  hydrateSessionMeta,
  sessionCatalog,
  useSessionArchive,
  useSessionManage,
  type SessionsIndexResult,
  type SessionsIndexSession,
} from '@/components/panes/session-manage/session-catalog'
import { requestSessionListRefresh } from '@/components/panes/session-manage/session-refresh-bridge'
import {
  projectsForDisplay,
  type ProjectGroupRef,
} from '@/components/panes/session-manage/session-display'
import { Switch } from '@/components/ui/switch'
import { updateAppPrefs, loadAppPrefs, type AppPrefs } from '@/lib/app-prefs'

export interface ArchiveGroup {
  key: string
  label: string
  sessions: SessionsIndexSession[]
}

/** 归档分组标签（ZCode ArchiveManagement.name 同口径）：
 *  - 无项目 = 「未归类」；
 *  - 注册表里已软删 = 「名 · 已移除」；
 *  - 注册表里找不到 = 「已移除项目」。 */
export function archiveGroupLabel(
  projectId: string | null,
  projects: readonly ProjectGroupRef[],
): string {
  if (projectId === null) return '未归类'
  const project = projects.find((candidate) => candidate.id === projectId)
  if (project === undefined) return '已移除项目'
  return project.deletedAt === undefined ? project.name : `${project.name} · 已移除`
}

/**
 * 归档会话按项目分组。组序与侧栏 project 分组一致：注册表项目（置顶优先）
 * → 未知 projectId（首现序）→ 无归属（殿后）。空组不出。
 */
export function groupSessionsByProject(
  sessions: readonly SessionsIndexSession[],
  projects: readonly ProjectGroupRef[],
): ArchiveGroup[] {
  const registered = projectsForDisplay(projects)
  const rank = new Map<string, number>()
  registered.forEach((project, index) => rank.set(project.id, index))

  interface Bucket {
    key: string
    label: string
    order: readonly [number, number]
    sessions: SessionsIndexSession[]
  }
  const buckets: Bucket[] = []
  const index = new Map<string, Bucket>()
  let unknownSeq = 0
  let unclassified: Bucket | null = null

  for (const session of sessions) {
    let bucket: Bucket | undefined
    if (session.projectId !== null) {
      const key = `pj:${session.projectId}`
      bucket = index.get(key)
      if (bucket === undefined) {
        const known = rank.get(session.projectId)
        bucket = {
          key,
          label: archiveGroupLabel(session.projectId, registered),
          order: known === undefined ? [1, unknownSeq++] : [0, known],
          sessions: [],
        }
        index.set(key, bucket)
        buckets.push(bucket)
      }
    } else {
      if (unclassified === null) {
        unclassified = { key: 'w:', label: '未归类', order: [2, 0], sessions: [] }
        buckets.push(unclassified)
      }
      bucket = unclassified
    }
    bucket.sessions.push(session)
  }

  buckets.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    sessions: bucket.sessions,
  }))
}

export type ArchiveSort = 'updated' | 'created'

/** 搜索命中：会话名或 cwd（大小写不敏感子串）——ZCode archives.search 同口径。 */
export function archiveQueryMatches(session: SessionsIndexSession, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return (
    (session.name ?? session.id).toLowerCase().includes(q) ||
    session.cwd.toLowerCase().includes(q)
  )
}

/** 过滤 + 排序（纯函数，可单测）：项目过滤按分组 key（`pj:<id>` / `w:`）。 */
export function selectArchiveSessions(
  sessions: readonly SessionsIndexSession[],
  options: { query: string; projectKey: string; sort: ArchiveSort },
): SessionsIndexSession[] {
  const filtered = sessions.filter(
    (session) =>
      (options.projectKey === 'all' ||
        (session.projectId === null ? 'w:' : `pj:${session.projectId}`) === options.projectKey) &&
      archiveQueryMatches(session, options.query),
  )
  const list = [...filtered]
  if (options.sort === 'created') {
    return list.sort((a, b) => b.createdAt - a.createdAt || b.lastModified - a.lastModified)
  }
  return list.sort((a, b) => b.lastModified - a.lastModified)
}

/** ZCode ArchiveGroupCard 的 Intl 时间（yyyy MMM d HH:mm）。 */
const formatArchiveTime = (ms: number): string =>
  ms > 0
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(ms)
    : ''

/** 自动归档行（与 settings-overlay 的 SetPrefRow 同构；本地实现避免循环 import）。 */
function PrefRow({
  label,
  desc,
  children,
}: {
  label: string
  desc: string
  children: ReactNode
}) {
  return (
    <div className="set-acct-field">
      <div className="set-acct-field-text" style={{ flex: '1 1 0' }}>
        <span className="set-acct-field-label">{label}</span>
        <p className="set-acct-field-desc">{desc}</p>
      </div>
      <div className="set-acct-field-control">{children}</div>
    </div>
  )
}

const AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const

interface PendingDelete {
  ids: readonly string[]
  names: readonly string[]
}

interface ArchiveResult {
  succeeded: number
  failed: number
  skipped: number
  details: string[]
}

export function ArchivesSettingsSection({
  headerLabel = '归档会话',
}: {
  /** 节标题。null = 不画（宿主外壳已有固定节标题，如 G 的 set-inset-head）。 */
  headerLabel?: string | null
} = {}) {
  const archived = useSessionArchive((s) => s.archived)
  const projects = useSessionManage((s) => s.projects)
  const projectsLoaded = useSessionManage((s) => s.projectsLoaded)
  const activeId = useSessionManage((s) => s.activeId)
  const [sessions, setSessions] = useState<SessionsIndexSession[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ArchiveResult | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // 归档管理视图（ZCode ArchiveManagement 同款三件套）
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ArchiveSort>('updated')
  const [projectKey, setProjectKey] = useState<string>('all')
  // 自动归档偏好（app-prefs 真相；null = 载入中）
  const [prefs, setPrefs] = useState<AppPrefs | null>(null)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [prefsSaved, setPrefsSaved] = useState<string | null>(null)
  const [groupLimits, setGroupLimits] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await invoke<SessionsIndexResult>('pi_sessions_index', { archived: true })
      setSessions(next.sessions)
      sessionCatalog.getState().applySessionIndex(next, null)
    } catch (e) {
      console.error('[archives-settings] 归档会话索引读取失败（pi_sessions_index）', e)
      // 保留上次成功的列表（不把失败画成空态）；错误条可见。
      setLoadError(e instanceof Error ? e.message : String(e))
      sessionCatalog.getState().applySessionIndex(null, String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 设置窗是独立 webview：主窗 runtime.tsx 的 hydrateSessionMeta 不在这个
  // 进程里跑。归档/取消归档的本地投影（archived 表）来自 session-meta，
  // 不水合时行按钮会按 `archived.includes(id)` 恒 disabled——点了没反应。
  // 水合失败必须可见（规矩 11：不静默降级）。
  useEffect(() => {
    void hydrateSessionMeta().catch((e) => {
      console.error('[archives-settings] session-meta 水合失败（归档操作不可用）', e)
      setActionError(`session-meta 水合失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }, [])

  useEffect(() => {
    void loadAppPrefs()
      .then((next) => setPrefs(next))
      .catch((e) => {
        console.error('[archives-settings] 自动归档偏好读取失败', e)
        setPrefsError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  useEffect(() => {
    if (projectsLoaded) return
    void sessionCatalog
      .getState()
      .loadProjects(true)
      .catch(() => {
        // projectsError 在 store 上（侧栏/项目页可见）；本页分组时退回
        // 「已移除项目」标签，不静默归并。
      })
  }, [projectsLoaded])

  const allGroups = useMemo(() => groupSessionsByProject(sessions, projects), [projects, sessions])
  const visibleSessions = useMemo(
    () => selectArchiveSessions(sessions, { query, projectKey, sort }),
    [sessions, query, projectKey, sort],
  )
  const groups = useMemo(() => {
    const filtered = groupSessionsByProject(visibleSessions, projects)
    for (const group of filtered) {
      group.sessions = [...group.sessions]
      if (sort === 'created') {
        group.sessions.sort(
          (a, b) => b.createdAt - a.createdAt || b.lastModified - a.lastModified,
        )
      } else {
        group.sessions.sort((a, b) => b.lastModified - a.lastModified)
      }
    }
    return filtered
  }, [visibleSessions, projects, sort])
  const visibleIds = useMemo(() => visibleSessions.map((s) => s.id), [visibleSessions])
  const filtering = query.trim() !== '' || projectKey !== 'all'

  /** 恢复：撤 archived 标记。本地归档表没有该 id 时明确报错（不 toggle
   *  成「归档」——元数据未水合时 toggle 会反向）。 */
  const restore = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      setBusy(true)
      setActionError(null)
      setResult(null)
      const state = sessionCatalog.getState()
      const missing = ids.filter((id) => !state.archived.includes(id))
      if (missing.length > 0) {
        setBusy(false)
        setResult({ succeeded: 0, failed: 0, skipped: missing.length, details: [] })
        setActionError(
          `本地归档表里没有 ${missing.length} 个会话（${missing[0]}…）——session-meta 可能尚未水合，未做任何修改`,
        )
        return
      }
      for (const id of ids) state.setArchived(id, false)
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)))
      setResult({ succeeded: ids.length, failed: 0, skipped: 0, details: [] })
      requestSessionListRefresh()
      setBusy(false)
    },
    [],
  )

  const deleteIds = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      setBusy(true)
      setActionError(null)
      setResult(null)
      const byId = new Map(sessions.map((s) => [s.id, s] as const))
      const activeId = sessionCatalog.getState().activeId
      const targets: SessionsIndexSession[] = []
      let skippedActive = 0
      for (const id of ids) {
        const row = byId.get(id)
        if (row === undefined) continue
        if (id === activeId) {
          skippedActive += 1
          continue
        }
        targets.push(row)
      }
      const deleted: string[] = []
      const failures: string[] = []
      for (const row of targets) {
        try {
          await invoke('pi_delete_session', { path: row.path })
          deleted.push(row.id)
        } catch (e) {
          console.error(`[archives-settings] 删除会话失败（${row.path}）`, e)
          failures.push(`${row.id}（${row.path}）：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (deleted.length > 0) {
        const gone = new Set(deleted)
        setSessions((prev) => prev.filter((s) => !gone.has(s.id)))
        // 管理维度同步（pinned/archived/markers/seen/sessionProjects 都不留死键）。
        // **只在 catalog 已灌过目录（piOrder 非空）时做**：prune 的语义是
        // 「不在存活集里的一律剔除」，拿本页的归档子集当存活集会误删其它
        // 会话的管理键；目录未灌时死键留到下次 refreshThreads 的 prune。
        const catalogIds = sessionCatalog.getState().piOrder
        if (catalogIds.length > 0) {
          sessionCatalog.getState().prune(catalogIds.filter((id) => !gone.has(id)))
        }
        requestSessionListRefresh()
      }
      setResult({
        succeeded: deleted.length,
        failed: failures.length,
        skipped: skippedActive,
        details: failures,
      })
      setPendingDelete(null)
      setBusy(false)
    },
    [sessions],
  )

  const savePrefs = useCallback((patch: Partial<AppPrefs>, saved: string) => {
    setPrefsError(null)
    setPrefsSaved(null)
    void updateAppPrefs(patch)
      .then((next) => {
        setPrefs(next)
        setPrefsSaved(saved)
      })
      .catch((e) => {
        console.error('[archives-settings] 自动归档偏好写入失败', patch, e)
        setPrefsError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return (
    <section className="set-section">
      {headerLabel !== null && (
        <header className="set-section-head">
          <h3 className="set-section-title">{headerLabel}</h3>
        </header>
      )}

      {/* ── 自动归档旧会话（ZCode TaskAutoArchiveSettings 逐字文案）── */}
      <div className="set-acct-card">
        <div className="set-acct-card-body">
          <PrefRow
            label="自动归档旧会话"
            desc="定时扫描，将最后活动时间超过保留期的会话自动归档；置顶和运行中的会话不受影响。"
          >
            <Switch
              aria-label="自动归档旧会话"
              checked={prefs?.taskAutoArchiveEnabled === true}
              disabled={prefs === null}
              onCheckedChange={(checked) =>
                savePrefs({ taskAutoArchiveEnabled: checked }, '已保存：自动归档设置已更新')
              }
            />
          </PrefRow>
          <PrefRow
            label="归档保留时长"
            desc="会话最后更新时间早于该时长后，才会进入自动归档候选。"
          >
            <select
              aria-label="归档保留时长"
              className="set-select"
              disabled={prefs === null}
              onChange={(e) =>
                savePrefs(
                  { taskAutoArchiveOlderThanDays: Number(e.target.value) },
                  '已保存：归档保留时长已更新',
                )
              }
              value={String(prefs?.taskAutoArchiveOlderThanDays ?? 30)}
            >
              {AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {days} 天后归档
                </option>
              ))}
            </select>
          </PrefRow>
        </div>
      </div>
      {prefsError !== null && <div className="set-err">自动归档偏好：{prefsError}</div>}
      {prefsSaved !== null && <span className="set-saved">{prefsSaved}</span>}

      {loadError !== null && (
        <div className="set-err set-err-row" role="alert">
          <TriangleAlert aria-hidden className="size-[var(--size-icon-md)] shrink-0" />
          <span style={{ flex: '1 1 0', minWidth: 0 }}>
            无法读取归档会话：{loadError}
          </span>
          <button className="set-btn" onClick={() => void load()} type="button">
            重试
          </button>
        </div>
      )}
      {actionError !== null && (
        <div className="set-err set-err-row" role="alert">
          <TriangleAlert aria-hidden className="size-[var(--size-icon-md)] shrink-0" />
          <span style={{ flex: '1 1 0', minWidth: 0 }}>{actionError}</span>
          <button
            aria-label="关闭"
            className="set-btn"
            onClick={() => setActionError(null)}
            type="button"
          >
            <X className="size-[var(--size-icon-md)]" />
          </button>
        </div>
      )}

      {/* ── 已归档的会话（ZCode ArchiveManagement：标题行 + 搜索/排序/项目过滤）── */}
      <div className="set-actions" style={{ justifyContent: 'space-between' }}>
        <h4 className="set-sub-title" style={{ margin: 0 }}>
          已归档的会话
        </h4>
        <button
          className="set-btn set-btn-destructive"
          disabled={busy || loading || loadError !== null || visibleIds.length === 0}
          onClick={() =>
            setPendingDelete({
              ids: visibleIds,
              names: visibleSessions.map((session) => session.name ?? session.id),
            })
          }
          style={{ whiteSpace: 'nowrap' }}
          type="button"
        >
          <Trash2 className="inline size-3.5" />{' '}
          {filtering ? '永久删除筛选结果' : '全部永久删除'}
        </button>
      </div>

      <div className="set-archive-filters">
        <div className="relative" style={{ minWidth: 0 }}>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="搜索已归档会话"
            className="set-input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索已归档会话"
            style={{ paddingLeft: 30, paddingRight: query === '' ? undefined : 28 }}
            value={query}
          />
          {query !== '' && (
            <button
              aria-label="清除搜索"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery('')}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="set-actions" style={{ gap: 6 }}>
          <span className="set-row-source">排序方式</span>
          <select
            aria-label="排序方式"
            className="set-select"
            onChange={(e) => setSort(e.target.value as ArchiveSort)}
            value={sort}
          >
            <option value="updated">更新时间</option>
            <option value="created">创建时间</option>
          </select>
        </div>
        <select
          aria-label="项目"
          className="set-select"
          onChange={(e) => setProjectKey(e.target.value)}
          value={projectKey}
        >
          <option value="all">所有项目</option>
          {allGroups.map((group) => (
            <option key={group.key} value={group.key}>
              {group.label}
            </option>
          ))}
        </select>
      </div>

      {busy && (
        <p className="set-hint" role="status">
          正在处理…
        </p>
      )}
      {result !== null && (
        <p
          className={result.failed > 0 || result.skipped > 0 ? 'set-err' : 'set-hint'}
          role={result.failed > 0 ? 'alert' : 'status'}
        >
          成功 {result.succeeded} 项，失败 {result.failed} 项，跳过 {result.skipped} 项
          {result.details.map((detail, index) => (
            <span className="block break-words" key={index}>
              {detail}
            </span>
          ))}
        </p>
      )}

      {loading && (
        <p className="py-8 text-sm text-muted-foreground" role="status">
          正在加载归档会话…
        </p>
      )}
      {!loading && loadError === null && groups.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {allGroups.length > 0 ? '没有匹配的归档会话' : '暂无已归档会话'}
        </p>
      )}

      {!loading &&
        groups.map((group) => {
          const limit = groupLimits[group.key] ?? 50
          const shown = group.sessions.slice(0, limit)
          return (
            <details className="group" key={group.key}>
              <summary className="set-row set-archive-group-head" style={{ cursor: 'pointer' }}>
                <Folder aria-hidden className="size-[var(--size-icon-sm)]" />
                <span className="set-row-provider" title={group.label}>
                  {group.label}
                </span>
                <ChevronRight
                  aria-hidden
                  className="size-[var(--size-icon-sm)] text-muted-foreground transition-transform group-open:rotate-90"
                />
                <span className="set-row-source">{group.sessions.length} 个会话</span>
                <div
                  className="set-actions"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                >
                  <ContextMenu anchor="trigger">
                    <ContextMenuTrigger>
                      <button
                        aria-label={`${group.label}的归档操作`}
                        className="set-btn"
                        disabled={busy}
                        type="button"
                      >
                        <MoreHorizontal className="size-[var(--size-icon-md)]" />
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => void restore(group.sessions.map((s) => s.id))}>
                        全部取消归档
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() =>
                          setPendingDelete({
                            ids: group.sessions.map((s) => s.id),
                            names: group.sessions.map((s) => s.name ?? s.id),
                          })
                        }
                        tone="destructive"
                      >
                        全部删除
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              </summary>
              <div className="set-archive-rows">
                {shown.map((session) => (
                  <div className="set-archive-row" key={session.id}>
                    <div className="set-archive-text">
                      <span className="set-archive-title" title={session.name ?? session.id}>
                        {session.name ?? session.id}
                      </span>
                      <time
                        className="set-row-source"
                        dateTime={new Date(
                          sort === 'created' ? session.createdAt : session.lastModified,
                        ).toISOString()}
                      >
                        {formatArchiveTime(
                          sort === 'created' ? session.createdAt : session.lastModified,
                        )}
                      </time>
                    </div>
                    {session.id === activeId && <span className="set-row-miss">当前会话</span>}
                    <div className="set-actions">
                      <button
                        aria-label={`永久删除“${session.name ?? session.id}”`}
                        className="set-btn"
                        disabled={busy}
                        onClick={() =>
                          setPendingDelete({
                            ids: [session.id],
                            names: [session.name ?? session.id],
                          })
                        }
                        title="永久删除（不可恢复）"
                        type="button"
                      >
                        <Trash2 className="inline size-3.5" />
                      </button>
                      <button
                        className="set-btn"
                        disabled={busy || !archived.includes(session.id)}
                        onClick={() => void restore([session.id])}
                        title={
                          archived.includes(session.id)
                            ? '撤销归档'
                            : '本地归档表没有该会话（session-meta 未水合）'
                        }
                        type="button"
                      >
                        取消归档
                      </button>
                    </div>
                  </div>
                ))}
                {group.sessions.length > limit && (
                  <div className="set-actions" style={{ justifyContent: 'center' }}>
                    <button
                      className="set-btn"
                      onClick={() =>
                        setGroupLimits((prev) => ({ ...prev, [group.key]: limit + 50 }))
                      }
                      type="button"
                    >
                      显示更多
                    </button>
                  </div>
                )}
              </div>
            </details>
          )
        })}

      <ConfirmDialog
        busyLabel="正在处理…"
        confirmLabel={
          pendingDelete === null ? '永久删除' : `永久删除 ${pendingDelete.ids.length} 个会话`
        }
        description={
          pendingDelete === null
            ? undefined
            : '会话记录将从当前设备或所属远端永久删除，无法在应用中恢复。请确认以下范围。当前打开的会话会跳过并计入结果。'
        }
        destructive
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) {
            return deleteIds(pendingDelete.ids)
          }
        }}
        open={pendingDelete !== null}
        title={
          pendingDelete === null
            ? '永久删除归档会话？'
            : `永久删除这 ${pendingDelete.ids.length} 个归档会话？`
        }
      >
        <div className="set-rows">
          {(pendingDelete?.names ?? []).map((name, index) => (
            <div className="set-row" key={`${name}:${index}`}>
              <span className="set-row-provider" title={name}>
                {name}
              </span>
            </div>
          ))}
        </div>
      </ConfirmDialog>
    </section>
  )
}
