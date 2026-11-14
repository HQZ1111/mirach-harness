/**
 * 宿主版 git 审查桥 —— hermes 桌面端 `lib/desktop-git.ts`（114 行）的对应物。
 *
 * 上游两种传输共用一个门面：本地 Electron IPC（`window.hermesDesktop.git`）
 * 与远端网关 REST 镜像（`/api/git/*`）。宿主只有一个传输（Tauri IPC →
 * `fs_git_*`，Rust 侧用 git 子进程实现同一语义），所以这里直接给出**同名
 * 同形状**的对象——调用点（store/review.ts、审查面板）照抄上游不用改。
 *
 * 与上游的差异：
 * - 上游 `review.list/diff` 带 scope + baseRef；宿主 Rust 侧同样支持（见
 *   fs.rs 的 review_list_ranged / branch_base）。
 * - 上游 `prList`（按分支批量查 PR，transcript 徽章用）宿主没有消费面
 *   （没有多会话分支徽章），不提供。
 * - 上游 `scanRepos`（本地磁盘爬仓库）宿主没有该功能，不提供。
 */

import { invoke } from '@tauri-apps/api/core'

import type { ReviewFile, ReviewPr, ShipInfo } from '@/components/panes/review-store'

export interface ReviewListResult {
  files: ReviewFile[]
  base: string | null
}

export interface CommitContext {
  diff: string
  recent: string
}

export interface HostGitReview {
  list: (repoPath: string, scope: string, baseRef: string | null) => Promise<ReviewListResult>
  diff: (
    repoPath: string,
    filePath: string,
    scope: string,
    baseRef: string | null,
    staged: boolean,
  ) => Promise<string>
  stage: (repoPath: string, filePath: string | null) => Promise<void>
  unstage: (repoPath: string, filePath: string | null) => Promise<void>
  revert: (repoPath: string, filePath: string | null) => Promise<void>
  revParse: (repoPath: string, ref: string) => Promise<string | null>
  commit: (repoPath: string, message: string, push: boolean) => Promise<void>
  commitContext: (repoPath: string) => Promise<CommitContext>
  push: (repoPath: string) => Promise<void>
  shipInfo: (repoPath: string) => Promise<ShipInfo>
  createPr: (repoPath: string) => Promise<{ url: string }>
}

const hostGitReview: HostGitReview = {
  list: (repoPath, scope, baseRef) =>
    invoke<ReviewListResult>('fs_git_review_list', { path: repoPath, scope, baseRef }),

  diff: async (repoPath, filePath, scope, baseRef, staged) =>
    invoke<string>('fs_git_review_diff', { path: repoPath, file: filePath, scope, baseRef, staged }),

  stage: (repoPath, filePath) => invoke('fs_git_stage', { path: repoPath, file: filePath }),
  unstage: (repoPath, filePath) => invoke('fs_git_unstage', { path: repoPath, file: filePath }),
  revert: (repoPath, filePath) => invoke('fs_git_revert', { path: repoPath, file: filePath }),

  revParse: (repoPath, ref) => invoke<string | null>('fs_git_rev_parse', { path: repoPath, refName: ref }),
  commit: (repoPath, message, push) => invoke('fs_git_commit', { path: repoPath, message, push }),
  commitContext: (repoPath) => invoke<CommitContext>('fs_git_commit_context', { path: repoPath }),
  push: (repoPath) => invoke('fs_git_push', { path: repoPath }),
  shipInfo: (repoPath) => invoke<ShipInfo>('fs_git_ship_info', { path: repoPath }),
  createPr: (repoPath) => invoke<{ url: string }>('fs_git_create_pr', { path: repoPath }),
}

/** 门面（上游 `desktopGit()` 同签名：拿不到桥返回 undefined）。 */
export function desktopGit(): { review: HostGitReview } | undefined {
  return { review: hostGitReview }
}

export type { ReviewFile, ReviewPr, ShipInfo }
