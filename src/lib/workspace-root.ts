/**
 * 工作区根（文件树 / 审查面板 / 后续项目面共用的单一真相）。
 *
 * 背景（2026-11-26 用户："现在面板栏的审查页也是假的"）：文件树此前用
 * 硬编码 `G:/mirach-harness`，审查面板却绑活动会话 cwd（本机会话多为
 * `C:/Users/<user>`，不是仓库）→ 审查恒空。现在两边同源：
 * - 文件树解析出根（fs_git_root 优先，否则所选目录）时写这里；
 * - 审查面板订阅这里作为 repoCwd；
 * - 用户在文件树里换目录 = 审查跟着换。
 *
 * 默认值 = 宿主工程目录（与旧文件树缺省一致）；持久化到 localStorage，
 * 重启保留用户最后一次选择的目录。
 */
import { createStore, useStore } from 'zustand'

export const WORKSPACE_ROOT_KEY = 'mirach.harness.workspaceRoot.v1'
export const DEFAULT_WORKSPACE_ROOT = 'G:/mirach-harness'

function readInitial(): string {
  try {
    const raw = localStorage.getItem(WORKSPACE_ROOT_KEY)
    return raw && raw.trim() ? raw : DEFAULT_WORKSPACE_ROOT
  } catch (e) {
    console.error('[workspace-root] 读取失败——用默认工程目录', e)
    return DEFAULT_WORKSPACE_ROOT
  }
}

export const workspaceRootStore = createStore<{ root: string }>(() => ({
  root: readInitial(),
}))

export const useWorkspaceRoot = (): string => useStore(workspaceRootStore, (s) => s.root)

export function setWorkspaceRoot(root: string): void {
  const next = root.trim()
  if (!next) return
  workspaceRootStore.setState({ root: next })
  try {
    localStorage.setItem(WORKSPACE_ROOT_KEY, next)
  } catch (e) {
    console.error('[workspace-root] 持久化失败（本次会话内有效）', e)
  }
}
