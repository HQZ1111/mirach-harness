/**
 * 工作区 = 项目 的自动登记（2026-11-23，用户："工作区不是项目吗？"）。
 *
 * ZCode 选用文件夹 = 新建项目（ProjectEditor 先选目录再 saveProject），
 * 宿主此前只建会话、不落项目注册表 → 项目页一直 0。这里补两件事：
 *
 * 1. `ensureWorkspaceProjects`：启动时按会话索引里的 distinct cwd 补齐项目
 *    （已有项目根覆盖的 cwd 跳过；软删项目的根也算覆盖，不把用户移除的项目
 *    每次启动复活）。
 * 2. `ensureProjectForWorkspace`：新建工作区会话前同步登记项目（同根已有
 *    活跃项目则复用；同根项目在回收站则恢复，避免重复条目）。
 *
 * 路径覆盖判定与 Rust `session_index::path_key` 同口径：分隔符统一为 `\`、
 * 去尾分隔符、Windows 大小写不敏感。
 */
import { invoke } from '@tauri-apps/api/core'

import type {
  PiProject,
  SessionsIndexSession,
} from '@/components/panes/session-manage/session-catalog'

const normalizePathKey = (path: string): string => {
  let key = path.trim().replace(/\//g, '\\')
  if (key.length > 3) key = key.replace(/\\+$/, '')
  return key.toLowerCase()
}

/** cwd 是否落在项目根内（同根或子目录）。 */
const pathWithin = (root: string, cwd: string): boolean => {
  const key = normalizePathKey(root)
  const target = normalizePathKey(cwd)
  if (key === '' || target === '') return false
  return target === key || target.startsWith(`${key}\\`)
}

/** 项目名 = 目录最后一段（`G:\mirach-harness` → `mirach-harness`）。 */
export function workspaceProjectName(cwd: string): string {
  const parts = cwd
    .trim()
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
  return parts.at(-1) ?? cwd
}

export interface WorkspaceProjectPlan {
  cwd: string
  name: string
}

/**
 * 纯规划：返回需要登记为项目的 cwd（去重、按传入顺序）。
 * `projects` 应包含软删条目（软删根也算覆盖，见模块头）。
 */
export function planWorkspaceProjects(
  sessions: readonly Pick<SessionsIndexSession, 'cwd'>[],
  projects: readonly Pick<PiProject, 'roots'>[],
): WorkspaceProjectPlan[] {
  const roots = projects.flatMap((project) => project.roots)
  const seen = new Set<string>()
  const plan: WorkspaceProjectPlan[] = []
  for (const session of sessions) {
    const cwd = session.cwd.trim()
    if (cwd === '') continue
    const key = normalizePathKey(cwd)
    if (seen.has(key)) continue
    seen.add(key)
    if (roots.some((root) => pathWithin(root, cwd))) continue
    plan.push({ cwd, name: workspaceProjectName(cwd) })
  }
  return plan
}

/** 启动补登记；返回新建的项目数。失败传播给调用方（console 可见）。 */
export async function ensureWorkspaceProjects(
  sessions: readonly Pick<SessionsIndexSession, 'cwd'>[],
): Promise<number> {
  const projects = await invoke<PiProject[]>('pi_projects_list', { includeDeleted: true })
  const plan = planWorkspaceProjects(sessions, projects)
  for (const entry of plan) {
    await invoke('pi_projects_save', {
      project: { name: entry.name, roots: [entry.cwd] },
    })
  }
  return plan.length
}

/**
 * 新建工作区会话前的项目登记。同根活跃项目 → 复用；同根软删项目 → 恢复；
 * 都没有 → 新建。返回项目 id。
 */
export async function ensureProjectForWorkspace(cwd: string): Promise<string> {
  const projects = await invoke<PiProject[]>('pi_projects_list', { includeDeleted: true })
  const exact = projects.find((project) =>
    project.roots.some((root) => normalizePathKey(root) === normalizePathKey(cwd)),
  )
  if (exact !== undefined) {
    if (exact.deletedAt === undefined) return exact.id
    const restored = await invoke<PiProject>('pi_projects_restore', { id: exact.id })
    return restored.id
  }
  const saved = await invoke<PiProject>('pi_projects_save', {
    project: { name: workspaceProjectName(cwd), roots: [cwd] },
  })
  return saved.id
}
