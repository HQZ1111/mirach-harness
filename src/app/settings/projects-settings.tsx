/**
 * 设置页 · 项目（settings/会话管理 P0，2026-11-15）。
 *
 * 数据面 = Rust 项目注册表（`pi_projects_list/save/delete/restore/reorder`）：
 * 项目列表/搜索/排序/置顶/重命名/根目录增删/移除（软删）与恢复/彻底删除。
 *
 * **彻底删除缺口（不造假）**：Rust 只有软删（`deletedAt`）与恢复，没有
 * purge 命令，也没有「物理删除注册表条目」的 IPC。此页把按钮画出来但
 * disabled + 明确说明缺什么——不拿软删冒充彻底删除，也不走
 * `session_meta_set` 私改 projects 切片（Rust 注释明说 pi_projects_* 是
 * 唯一写面）。
 *
 * 失败可见（铁律 12）：拉取失败显示 store.projectsError；每个动作失败
 * 内联红条（.set-err）+ console.error，不吞、不假成功。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, ArrowDown, ArrowUp, Pin, PinOff, Plus, Trash2 } from 'lucide-react'

import {
  sessionCatalog,
  sortProjects,
  useSessionManage,
  type PiProject,
} from '@/components/panes/session-manage/session-catalog'
import { requestSessionListRefresh } from '@/components/panes/session-manage/session-refresh-bridge'

/** 根目录多行文本 → 数组（逐行 trim 去空；去重/规范化在 Rust）。 */
const splitRoots = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

type SortMode = 'created' | 'name' | 'pinned' | 'registry'

const SORT_LABELS: Record<SortMode, string> = {
  registry: '自定义顺序（Rust order）',
  pinned: '置顶优先',
  name: '名称',
  created: '创建时间（新→旧）',
}

/** 搜索命中：项目名或任一根目录（大小写不敏感子串）。 */
export const projectMatchesQuery = (project: PiProject, query: string): boolean => {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  if (project.name.toLowerCase().includes(q)) return true
  return project.roots.some((root) => root.toLowerCase().includes(q))
}

/** 视图排序（只影响展示；写回 Rust 的 order 只在「自定义顺序」下可拖）。 */
export function sortProjectsForView(
  projects: readonly PiProject[],
  mode: SortMode,
): PiProject[] {
  const list = mode === 'registry' ? sortProjects(projects) : [...projects]
  if (mode === 'name') {
    return list.sort(
      (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || (a.id < b.id ? -1 : 1),
    )
  }
  if (mode === 'created') return list.sort((a, b) => b.createdAt - a.createdAt)
  if (mode === 'pinned') {
    return list.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.order - b.order ||
        a.createdAt - b.createdAt,
    )
  }
  return list
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
  const [sortMode, setSortMode] = useState<SortMode>('registry')
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // 行内编辑（名字 + 根目录整表）；null = 全部不在编辑态
  const [editing, setEditing] = useState<{ id: string; name: string; rootsText: string } | null>(
    null,
  )
  // 移除的二次确认（内联两步，不另造弹层）
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  // 新建表单
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRootsText, setNewRootsText] = useState('')

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
  const visible = useMemo(
    () =>
      sortProjectsForView(
        activeProjects.filter((project) => projectMatchesQuery(project, query)),
        sortMode,
      ),
    [activeProjects, query, sortMode],
  )
  // 拖排按钮只在「自定义顺序 + 未搜索」时可用——否则上下移的顺序与用户
  // 看到的列表不一致（Rust 的重排是局部 id 序，未列出的项目顺延）。
  const canReorder = sortMode === 'registry' && query.trim() === ''

  const run = useCallback(
    async (id: string, label: string, fn: () => Promise<unknown>, done: string) => {
      setBusyId(id)
      setActionError(null)
      setNotice(null)
      try {
        await fn()
        setNotice(done)
        requestSessionListRefresh()
      } catch (e) {
        console.error(`[projects-settings] ${label}失败`, e)
        setActionError(`${label}失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusyId(null)
      }
    },
    [],
  )

  const togglePin = (project: PiProject) =>
    run(
      project.id,
      project.pinned ? '取消置顶' : '置顶',
      () =>
        sessionCatalog.getState().saveProject({
          id: project.id,
          name: project.name,
          roots: project.roots,
          pinned: !project.pinned,
        }),
      project.pinned ? `已取消置顶「${project.name}」` : `已置顶「${project.name}」`,
    )

  const moveProject = (project: PiProject, delta: -1 | 1) => {
    const ordered = sortProjects(activeProjects).map((p) => p.id)
    const at = ordered.indexOf(project.id)
    const to = at + delta
    if (at < 0 || to < 0 || to >= ordered.length) return
    const next = [...ordered]
    next[at] = ordered[to]!
    next[to] = ordered[at]!
    return run(
      project.id,
      '调整顺序',
      () => sessionCatalog.getState().reorderProjects(next),
      `已移动「${project.name}」`,
    )
  }

  const saveEdit = (project: PiProject) => {
    if (editing === null || editing.id !== project.id) return
    const name = editing.name.trim()
    if (name === '') {
      setActionError('项目名不能为空（Rust 侧同样拒绝空名）')
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

  const removeProject = (project: PiProject) =>
    run(
      project.id,
      '移除项目',
      async () => {
        await sessionCatalog.getState().deleteProject(project.id)
        setConfirmRemove(null)
      },
      `已移除「${project.name}」（可在回收站恢复）`,
    )

  const restoreProject = (project: PiProject) =>
    run(
      project.id,
      '恢复项目',
      () => sessionCatalog.getState().restoreProject(project.id),
      `已恢复「${project.name}」`,
    )

  const createProject = () => {
    const name = newName.trim()
    if (name === '') {
      setActionError('项目名不能为空（Rust 侧同样拒绝空名）')
      return
    }
    return run(
      'new',
      '新建项目',
      async () => {
        await sessionCatalog.getState().saveProject({
          name,
          roots: splitRoots(newRootsText),
        })
        setCreating(false)
        setNewName('')
        setNewRootsText('')
      },
      `已新建「${name}」`,
    )
  }

  return (
    <section className="set-section">
      {headerLabel !== null && (
        <header className="set-section-head">
          <h3 className="set-section-title">{headerLabel}</h3>
        </header>
      )}
      <p className="set-hint">
        项目 = 一组工作区根（Rust 项目注册表）。会话按显式归属
        （sessionProjects）优先、否则按 cwd 落在项目根内归组；侧栏「分组 ›
        项目」按这里的分组显示。移除是软删（回收站可恢复），会话归属不会丢。
      </p>

      {projectsError !== null && <div className="set-err">项目列表读取失败：{projectsError}</div>}
      {actionError !== null && <div className="set-err">{actionError}</div>}
      {notice !== null && <span className="set-saved">{notice}</span>}

      <div className="set-actions">
        <input
          aria-label="搜索项目"
          className="set-input"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索项目 / 根目录…"
          value={query}
        />
        <select
          aria-label="项目排序"
          className="set-select"
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          value={sortMode}
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SORT_LABELS[mode]}
            </option>
          ))}
        </select>
        <button className="set-btn" disabled={busyId !== null} onClick={refresh} type="button">
          刷新
        </button>
        <button
          className="set-btn set-btn-primary"
          disabled={busyId !== null}
          onClick={() => {
            setCreating((v) => !v)
            setActionError(null)
          }}
          type="button"
        >
          <Plus className="inline size-3.5" /> 新建项目
        </button>
      </div>

      {creating && (
        <div className="set-rows">
          <div className="set-row">
            <div className="set-field" style={{ flex: '1 1 100%' }}>
              <span className="set-field-label">项目名</span>
              <div className="set-field-control">
                <input
                  className="set-input"
                  disabled={busyId !== null}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如 mirach"
                  value={newName}
                />
              </div>
            </div>
            <div className="set-field" style={{ flex: '1 1 100%' }}>
              <span className="set-field-label">根目录</span>
              <div className="set-field-control">
                <textarea
                  className="set-textarea"
                  disabled={busyId !== null}
                  onChange={(e) => setNewRootsText(e.target.value)}
                  placeholder={'每行一个根目录，例如\nC:\\work\\mirach'}
                  rows={2}
                  value={newRootsText}
                />
              </div>
            </div>
            <div className="set-actions">
              <button
                className="set-btn set-btn-primary"
                disabled={busyId !== null}
                onClick={() => void createProject()}
                type="button"
              >
                创建
              </button>
              <button
                className="set-btn"
                disabled={busyId !== null}
                onClick={() => {
                  setCreating(false)
                  setActionError(null)
                }}
                type="button"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {!projectsLoaded && projectsError === null && (
        <span className="set-file-missing">加载中…</span>
      )}

      {!canReorder && (
        <span className="set-hint">
          「上移/下移」只在「自定义顺序」且未搜索时可用——搜索/其它排序下移动会写出与
          所见不一致的 order。
        </span>
      )}

      <div className="set-rows">
        {visible.length === 0 && projectsLoaded && (
          <span className="set-file-missing">
            {query.trim() === '' ? '还没有项目——用「新建项目」建一个。' : `没有项目匹配“${query}”。`}
          </span>
        )}
        {visible.map((project) => {
          const isEditing = editing?.id === project.id
          const busy = busyId === project.id
          return (
            <div className="set-row" key={project.id}>
              {isEditing ? (
                <>
                  <div className="set-field" style={{ flex: '1 1 100%' }}>
                    <span className="set-field-label">名称</span>
                    <div className="set-field-control">
                      <input
                        className="set-input"
                        disabled={busy}
                        onChange={(e) =>
                          setEditing((prev) =>
                            prev === null ? prev : { ...prev, name: e.target.value },
                          )
                        }
                        value={editing.name}
                      />
                    </div>
                  </div>
                  <div className="set-field" style={{ flex: '1 1 100%' }}>
                    <span className="set-field-label">根目录</span>
                    <div className="set-field-control">
                      <textarea
                        className="set-textarea"
                        disabled={busy}
                        onChange={(e) =>
                          setEditing((prev) =>
                            prev === null ? prev : { ...prev, rootsText: e.target.value },
                          )
                        }
                        placeholder="每行一个根目录"
                        rows={3}
                        value={editing.rootsText}
                      />
                      <span className="set-field-note">
                        清空某行 = 删该根目录；保存即整表替换（Rust normalize_roots 去重）。
                      </span>
                    </div>
                  </div>
                  <div className="set-actions">
                    <button
                      className="set-btn set-btn-primary"
                      disabled={busy}
                      onClick={() => void saveEdit(project)}
                      type="button"
                    >
                      保存
                    </button>
                    <button
                      className="set-btn"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null)
                        setActionError(null)
                      }}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="set-row-provider">{project.name}</span>
                  {project.pinned && <span className="set-row-ok">已置顶</span>}
                  <span className="set-row-source">
                    {project.roots.length === 0
                      ? '无根目录（只用于显式归属）'
                      : `${project.roots.length} 个根`}
                  </span>
                  <span className="set-row-env" style={{ flex: '1 1 100%' }}>
                    {project.roots.length > 0 ? project.roots.join(' · ') : '—'}
                  </span>
                  <div className="set-actions">
                    <button
                      aria-label={project.pinned ? '取消置顶' : '置顶'}
                      className="set-btn"
                      disabled={busy}
                      onClick={() => void togglePin(project)}
                      title={project.pinned ? '取消置顶' : '置顶'}
                      type="button"
                    >
                      {project.pinned ? (
                        <PinOff className="inline size-3.5" />
                      ) : (
                        <Pin className="inline size-3.5" />
                      )}
                    </button>
                    <button
                      aria-label="上移"
                      className="set-btn"
                      disabled={busy || !canReorder}
                      onClick={() => void moveProject(project, -1)}
                      title={canReorder ? '上移' : '仅自定义顺序下可移'}
                      type="button"
                    >
                      <ArrowUp className="inline size-3.5" />
                    </button>
                    <button
                      aria-label="下移"
                      className="set-btn"
                      disabled={busy || !canReorder}
                      onClick={() => void moveProject(project, 1)}
                      title={canReorder ? '下移' : '仅自定义顺序下可移'}
                      type="button"
                    >
                      <ArrowDown className="inline size-3.5" />
                    </button>
                    <button
                      className="set-btn"
                      disabled={busy}
                      onClick={() => {
                        setEditing({
                          id: project.id,
                          name: project.name,
                          rootsText: project.roots.join('\n'),
                        })
                        setActionError(null)
                      }}
                      type="button"
                    >
                      编辑
                    </button>
                    {confirmRemove === project.id ? (
                      <>
                        <button
                          className="set-btn"
                          disabled={busy}
                          onClick={() => void removeProject(project)}
                          type="button"
                        >
                          确认移除
                        </button>
                        <button
                          className="set-btn"
                          disabled={busy}
                          onClick={() => setConfirmRemove(null)}
                          type="button"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="set-btn"
                        disabled={busy}
                        onClick={() => setConfirmRemove(project.id)}
                        type="button"
                      >
                        <Trash2 className="inline size-3.5" /> 移除
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* 回收站是同一滚动容器里的第二段——不用 .set-section-head（sticky
          top:0 会与页首标题在滚动时重叠），用普通小节标题。 */}
      <h3 className="set-section-title" style={{ margin: '16px 0 0' }}>
        回收站
      </h3>
      <p className="set-hint">
        移除的项目在这里；恢复后回到注册表。**彻底删除缺 IPC**：Rust 只有软删
        （pi_projects_delete）与恢复（pi_projects_restore），没有物理删除命令；
        按钮保留为禁用位，等上游补 `pi_projects_purge` 后再接。
      </p>
      <div className="set-rows">
        {deletedProjects.length === 0 && (
          <span className="set-file-missing">回收站为空。</span>
        )}
        {deletedProjects.map((project) => {
          const busy = busyId === project.id
          return (
            <div className="set-row" key={project.id}>
              <span className="set-row-provider">{project.name}</span>
              <span className="set-row-source">
                {project.deletedAt !== undefined
                  ? `移除于 ${new Date(project.deletedAt).toLocaleString()}`
                  : ''}
              </span>
              <span className="set-row-env">{project.roots.join(' · ') || '—'}</span>
              <div className="set-actions">
                <button
                  className="set-btn"
                  disabled={busy}
                  onClick={() => void restoreProject(project)}
                  type="button"
                >
                  <ArchiveRestore className="inline size-3.5" /> 恢复
                </button>
                <button
                  className="set-btn"
                  disabled
                  title="缺 IPC：无 pi_projects_purge（当前只支持软删/恢复）"
                  type="button"
                >
                  彻底删除
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
