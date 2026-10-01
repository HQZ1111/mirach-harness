/* fs_list → 文件树数据面的适配层（harness 侧新增，ZCode 对应物是
 * fileService.readdir({ includeHidden: true })）。
 * 排序/隐藏集过滤都在 Rust fs.rs 完成（目录优先 + 名称字典序），这里只做
 * 形状映射与错误传播：fs_list 的 error 字段是错误码（非 throw），必须显式
 * 转成 Error 抛出——禁止把失败吞成空目录假装成功。 */
import { fsList, type FsEntry } from "@/lib/fs";
import type { WorkspaceFileTreeNode } from "@/components/panes/workspace-file-tree/model";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  type: "directory" | "file";
  isSymbolicLink?: boolean;
}

export function fsEntryToWorkspaceFileEntry(entry: FsEntry): WorkspaceFileEntry {
  return {
    path: entry.path,
    name: entry.name,
    type: entry.isDirectory ? "directory" : "file",
    ...(entry.isSymlink === true ? { isSymbolicLink: true } : {}),
  };
}

/** `hermes:fs:readDir` 的等价物：失败抛 Error（错误码来自 fs.rs error_code）。 */
export async function listWorkspaceDirectory(path: string): Promise<WorkspaceFileEntry[]> {
  const result = await fsList(path);
  if (result.error) {
    throw new Error(result.error);
  }
  return result.entries.map(fsEntryToWorkspaceFileEntry);
}
