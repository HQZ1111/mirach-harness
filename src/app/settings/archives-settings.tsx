/**
 * 设置页 · 归档会话（settings/会话管理 P0，2026-11-15）。
 *
 * 数据面 = `pi_sessions_index({ archived: true })`（Rust 按 session-meta 的
 * archived 表过滤，跨项目根扫描）。归档/恢复本身是客户端归档维度的语义
 * （sessionCatalog.archived，写穿 session-meta.json——Rust 侧同一份表）。
 *
 * 行为：
 * - 按项目分组（projectId → 项目名；cwd 桶仅兼容旧数据/未归属）；
 * - 单条/批量恢复（撤 archived 标记 + 重拉列表）；
 * - 批量删除（`pi_delete_session` 逐个删除文件）。**当前打开的会话跳过**
 *   并明确告知（删除活跃会话需要 runtime 先 discard 并清轮次态，设置页
 *   不能替它做——不假装删成功）。
 *
 * 失败可见：索引失败保留上次列表 + 红条；逐条删除的部分失败汇总显示
 * （成功 N / 失败 M + 首条原因），不把部分成功说成全部成功。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RotateCcw, Trash2 } from 'lucide-react'

import {
  sessionCatalog,
  useSessionArchive,
  useSessionManage,
  type SessionsIndexResult,
  type SessionsIndexRoot,
  type SessionsIndexSession,
  type SessionsIndexSkipped,
} from '@/components/panes/session-manage/session-catalog'
import { requestSessionListRefresh } from '@/components/panes/session-manage/session-refresh-bridge'
import {
  projectGroupLabel,
  projectsForDisplay,
  type ProjectGroupRef,
} from '@/components/panes/session-manage/session-display'

export interface ArchiveGroup {
  key: string
  label: string
  sessions: SessionsIndexSession[]
}

/**
 * 归档会话按项目分组。组序与侧栏 project 分组一致：注册表项目（置顶优先）
 * → 未知 projectId（首现序）→ 无归属（主页，殿后）。空组不出。
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
  let home: Bucket | null = null

  for (const session of sessions) {
    let bucket: Bucket | undefined
    if (session.projectId !== null) {
      const key = `pj:${session.projectId}`
      bucket = index.get(key)
      if (bucket === undefined) {
        const known = rank.get(session.projectId)
        bucket = {
          key,
          label: projectGroupLabel(session.projectId, registered),
          order: known === undefined ? [1, unknownSeq++] : [0, known],
          sessions: [],
        }
        index.set(key, bucket)
        buckets.push(bucket)
      }
    } else {
      if (home === null) {
        home = { key: 'w:', label: '主页', order: [2, 0], sessions: [] }
        buckets.push(home)
      }
      bucket = home
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

const formatMs = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleString() : '未知时间'

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
  const [skipped, setSkipped] = useState<SessionsIndexSkipped[]>([])
  const [roots, setRoots] = useState<SessionsIndexRoot[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await invoke<SessionsIndexResult>('pi_sessions_index', { archived: true })
      setSessions(result.sessions)
      setSkipped(result.skipped)
      setRoots(result.roots)
      sessionCatalog.getState().applySessionIndex(result, null)
      setSelected((prev) => {
        const alive = new Set(result.sessions.map((s) => s.id))
        return new Set([...prev].filter((id) => alive.has(id)))
      })
    } catch (e) {
      console.error('[archives-settings] 归档会话索引读取失败（pi_sessions_index）', e)
      // 保留上次成功的列表（不把失败画成空态）；错误条可见。
      setLoadError(String(e))
      sessionCatalog.getState().applySessionIndex(null, String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (projectsLoaded) return
    void sessionCatalog
      .getState()
      .loadProjects(true)
      .catch(() => {
        // projectsError 在 store 上（侧栏/项目页可见）；本页分组时退回
        // 「未知项目」标签，不静默归并。
      })
  }, [projectsLoaded])

  const groups = useMemo(() => groupSessionsByProject(sessions, projects), [projects, sessions])
  const allIds = useMemo(() => sessions.map((s) => s.id), [sessions])
  const selectedIds = useMemo(() => allIds.filter((id) => selected.has(id)), [allIds, selected])

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 恢复：撤 archived 标记。本地归档表没有该 id 时明确报错（不 toggle
   *  成「归档」——元数据未水合时 toggle 会反向）。 */
  const restore = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return
      setBusy(true)
      setActionError(null)
      setNotice(null)
      const state = sessionCatalog.getState()
      const missing = ids.filter((id) => !state.archived.includes(id))
      if (missing.length > 0) {
        setBusy(false)
        setActionError(
          `本地归档表里没有 ${missing.length} 个会话（${missing[0]}…）——session-meta 可能尚未水合，未做任何修改`,
        )
        return
      }
      for (const id of ids) state.toggleArchive(id)
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)))
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      setNotice(`已恢复 ${ids.length} 个会话`)
      requestSessionListRefresh()
      setBusy(false)
    },
    [],
  )

  const deleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return
    setBusy(true)
    setActionError(null)
    setNotice(null)
    const byId = new Map(sessions.map((s) => [s.id, s] as const))
    const activeId = sessionCatalog.getState().activeId
    const targets: SessionsIndexSession[] = []
    let skippedActive = 0
    for (const id of selectedIds) {
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
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))))
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
    const parts: string[] = []
    if (deleted.length > 0) parts.push(`已删除 ${deleted.length} 个会话`)
    if (skippedActive > 0) parts.push(`跳过当前打开的会话 ${skippedActive} 个（请先在会话栏删除）`)
    if (failures.length > 0) parts.push(`失败 ${failures.length} 个：${failures[0]}`)
    if (parts.length > 0) setNotice(parts.join('；'))
    setConfirmDelete(false)
    setBusy(false)
  }, [selectedIds, sessions])

  return (
    <section className="set-section">
      {headerLabel !== null && (
        <header className="set-section-head">
          <h3 className="set-section-title">{headerLabel}</h3>
        </header>
      )}
      <p className="set-hint">
        归档表来自 session-metadata（跨工作区扫描）。恢复 = 撤销归档标记；删除 =
        删除会话文件（不可撤销）。当前打开的会话不能在此删除（需要运行时先
        discard，设置页不接管对话区）。
      </p>

      {loadError !== null && <div className="set-err">归档索引读取失败：{loadError}</div>}
      {actionError !== null && <div className="set-err">{actionError}</div>}
      {notice !== null && <span className="set-saved">{notice}</span>}

      <div className="set-actions">
        <button className="set-btn" disabled={busy} onClick={() => void load()} type="button">
          刷新
        </button>
        <button
          className="set-btn"
          disabled={busy || selectedIds.length === 0}
          onClick={() => void restore(selectedIds)}
          type="button"
        >
          <RotateCcw className="inline size-3.5" /> 恢复所选（{selectedIds.length}）
        </button>
        {confirmDelete ? (
          <>
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => void deleteSelected()}
              type="button"
            >
              确认删除 {selectedIds.length} 个会话（不可恢复）
            </button>
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
              type="button"
            >
              取消
            </button>
          </>
        ) : (
          <button
            className="set-btn"
            disabled={busy || selectedIds.length === 0}
            onClick={() => setConfirmDelete(true)}
            type="button"
          >
            <Trash2 className="inline size-3.5" /> 删除所选
          </button>
        )}
        <button
          className="set-btn"
          disabled={busy || sessions.length === 0}
          onClick={() => setSelected(new Set(allIds))}
          type="button"
        >
          全选
        </button>
        <button
          className="set-btn"
          disabled={busy || selected.size === 0}
          onClick={() => setSelected(new Set())}
          type="button"
        >
          清空选择
        </button>
      </div>

      {loading && sessions.length === 0 && <span className="set-file-missing">加载中…</span>}
      {!loading && loadError === null && sessions.length === 0 && (
        <span className="set-file-missing">没有归档会话。</span>
      )}

      {groups.map((group) => (
        <div className="set-rows" key={group.key}>
          <div className="set-row">
            <span className="set-row-provider">{group.label}</span>
            <span className="set-row-source">{group.sessions.length} 个会话</span>
          </div>
          {group.sessions.map((session) => (
            <div className="set-row" key={session.id}>
              <input
                aria-label={`选择 ${session.name ?? session.id}`}
                checked={selected.has(session.id)}
                disabled={busy}
                onChange={() => toggleSelected(session.id)}
                type="checkbox"
              />
              <span className="set-row-provider">{session.name ?? session.id}</span>
              <span className="set-row-source">{formatMs(session.lastModified)}</span>
              <span className="set-row-env" title={session.cwd}>
                {session.cwd || '（无 cwd）'}
              </span>
              {session.id === activeId && (
                <span className="set-row-miss">当前会话</span>
              )}
              <div className="set-actions">
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
                  恢复
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}

      <details>
        <summary className="set-hint">
          扫描诊断（{roots.length} 个根 · 跳过 {skipped.length} 条）
        </summary>
        <div className="set-rows">
          {roots.map((root) => (
            <div className="set-row" key={root.path}>
              <span className="set-row-provider">{root.kind}</span>
              <span className="set-row-env">{root.path}</span>
              <span className="set-row-miss">
                {root.error !== null
                  ? `错误：${root.error}`
                  : root.exists
                    ? '已扫描'
                    : '不存在（跳过）'}
              </span>
            </div>
          ))}
          {skipped.map((item) => (
            <div className="set-row" key={`${item.root}:${item.path}`}>
              <span className="set-row-provider">跳过</span>
              <span className="set-row-env">{item.path}</span>
              <span className="set-row-miss">{item.reason}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}
