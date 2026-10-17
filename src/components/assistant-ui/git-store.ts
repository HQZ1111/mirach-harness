/**
 * Git 变更统计桥（活动面板「环境」分区数据面，docs/engine-gaps.md G6）：
 * 宿主跑 `git diff --numstat HEAD` + `git status --porcelain` 汇总。
 *
 * **语义诚实**：这是**工作区当前状态**（相对 HEAD 的未提交变更），不是
 * "本会话改动"——用户手动改的文件也算（pi 无 taskChangeSummary 概念）。
 *
 * - 拉取面：`refresh(workspacePath)` → `fs_git_diff_stat` IPC。
 * - 非仓库 → `isRepository:false`（面板隐藏该分区，不报错）。
 * - zustand vanilla 模式，照抄 checkpoint-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

export interface GitDiffStat {
  isRepository: boolean
  root: string
  branch: string | null
  added: number
  removed: number
  changedFiles: number
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const asBool = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null

/** 严格解析 fs_git_diff_stat 返回；非法 → console.error + null（不渲染）。 */
export function parseGitDiffStat(raw: unknown): GitDiffStat | null {
  if (typeof raw !== 'object' || raw === null) {
    console.error('[git] fs_git_diff_stat 返回形状非法——丢弃', raw)
    return null
  }
  const r = raw as Record<string, unknown>
  const isRepository = asBool(r.isRepository)
  const root = asString(r.root)
  const added = asNumber(r.added)
  const removed = asNumber(r.removed)
  const changedFiles = asNumber(r.changedFiles)
  if (
    isRepository === null ||
    root === null ||
    added === null ||
    removed === null ||
    changedFiles === null
  ) {
    console.error('[git] fs_git_diff_stat 字段缺失/非法——丢弃', raw)
    return null
  }
  return {
    isRepository,
    root,
    branch: asString(r.branch),
    added,
    removed,
    changedFiles,
  }
}

interface GitBridgeState {
  /** 变更统计；null = 未拉取/非仓库/失败（分区隐藏） */
  stat: GitDiffStat | null
  refresh: (workspacePath: string | null) => Promise<void>
  resetProjection: () => void
}

export const gitBridge = createStore<GitBridgeState>((set) => ({
  stat: null,
  refresh: async (workspacePath) => {
    if (workspacePath === null || workspacePath.trim() === '') {
      // 无工作区 = 无 git 可查（诚实空态，非错误）
      set({ stat: null })
      return
    }
    try {
      const raw = await invoke<unknown>('fs_git_diff_stat', { path: workspacePath })
      const parsed = parseGitDiffStat(raw)
      set({ stat: parsed })
    } catch (e) {
      console.error('[git] 变更统计拉取失败——清投影', e)
      set({ stat: null })
    }
  },
  resetProjection: () => set({ stat: null }),
}))

export const useGitBridge = () => useStore(gitBridge)
