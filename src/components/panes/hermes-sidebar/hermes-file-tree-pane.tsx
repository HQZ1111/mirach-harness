/**
 * 文件树窗格（右栏 files，flex-layout 注册的 `files` 类型组件）。
 *
 * 2026-10-01：树本体换成 ZCode workspace-file-tree 的移植
 * （../workspace-file-tree/，本文件只做 harness 数据面适配）：
 *   - 根 = fs_git_root(cwd)；cwd 不在仓库内时 fs_git_root 返回 null（明确语义
 *     非 error），此时按 cwd 本身浏览——目录读取失败仍走错误态，不静默。
 *   - 单击文件 → preview-opener 既有通道（flex-layout 注入的预览页签）。
 *   - 选择文件夹 = @tauri-apps/plugin-dialog（旧窗格 2026-09-29 功能沿用）。
 *   - 纯浏览器直开（无 Tauri fs 命令）显示提示。
 */
import { useCallback, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'

import { fsGitRoot } from '@/lib/fs'
import { inTauri } from '@/lib/tauri-window'
import { LoaderCircle } from 'lucide-react'
import { WorkspaceFileTree } from '@/components/panes/workspace-file-tree/WorkspaceFileTree'
import { openFilePreview } from './preview-opener'

/** 会话/项目 cwd 概念未接线前的缺省浏览起点（与旧窗格一致）。 */
const DEFAULT_CWD = 'G:/mirach-harness'

export function HermesFileTreePane() {
  const [cwd, setCwd] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)

  const resolveRoot = useCallback(async (dir: string) => {
    setResolveError(null)
    try {
      const gitRoot = await fsGitRoot(dir)
      // null = dir 不在 git 仓库内（fs_git_root 的明确返回值）：按 cwd 本身浏览。
      setRoot(gitRoot ?? dir)
    } catch (error) {
      console.error('[FileTreePane] fs_git_root 失败', error)
      setResolveError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    if (!inTauri) return
    setCwd(DEFAULT_CWD)
    void resolveRoot(DEFAULT_CWD)
  }, [inTauri, resolveRoot])

  const pickFolder = useCallback(async () => {
    const dir = await open({ directory: true })
    if (typeof dir === 'string' && dir) {
      setCwd(dir)
      setRoot(null)
      void resolveRoot(dir)
    }
  }, [resolveRoot])

  if (!inTauri) {
    return (
      <div className="pane-placeholder">
        <h2>文件树</h2>
        <p>需要 Tauri 环境（fs 命令）。</p>
      </div>
    )
  }

  if (resolveError) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-(--surface) px-4 text-center">
        <div className="text-(--filetree-row-font-size) font-medium text-(--text-2)">
          解析根目录失败
        </div>
        <div className="max-w-full break-words text-xs text-(--text-3)">{resolveError}</div>
        <button
          type="button"
          className="rounded-md border border-(--stroke) px-3 py-1 text-xs text-(--text-2) hover:bg-(--hover-wash)"
          onClick={() => {
            if (cwd) void resolveRoot(cwd)
          }}
        >
          重试
        </button>
      </div>
    )
  }

  if (root === null) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-(--surface) text-(--text-2)">
        <LoaderCircle className="size-4 animate-spin" aria-label="加载中" />
      </div>
    )
  }

  return (
    <WorkspaceFileTree
      workspacePath={root}
      onOpenFile={openFilePreview}
      onPickFolder={() => void pickFolder()}
    />
  )
}
