/**
 * 本地文件系统桥（Tauri fs 命令的前端封装，主工程 desktop-fs.ts 同形）。
 * 条件导入由调用方保证——纯浏览器直开时本模块不被引用。
 */

import { invoke } from '@tauri-apps/api/core'

export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  /** 入口本身是符号链接/junction（fs.rs symlink_metadata 探测；文件树自动展开链用） */
  isSymlink?: boolean
}

export interface FsListResult {
  entries: FsEntry[]
  error?: string
}

/** 列目录：目录排前、名称字典序、噪声集（node_modules/.git 等）已过滤 */
export function fsList(path: string): Promise<FsListResult> {
  return invoke<FsListResult>('fs_list', { path })
}

/** 读文件为 data URL（≤16MB；文本文件可自行解码） */
export function fsReadDataUrl(path: string): Promise<string> {
  return invoke<string>('fs_read_data_url', { path })
}

/** git 仓库根目录（非仓库返回 null） */
export function fsGitRoot(path: string): Promise<string | null> {
  return invoke<string | null>('fs_git_root', { path })
}
