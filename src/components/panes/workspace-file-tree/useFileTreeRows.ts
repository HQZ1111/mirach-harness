/* ZCode packages/ui/src/workspace-file-tree/useWorkspaceFileTreeRows.ts 拷贝
 * （2026-10-01）。Git-only 行补全（addDeletedGitStatusRowsToWorkspaceFileTree）
 * 随 git 状态机一起未接——children 直接进 flatten。 */
import { useMemo } from "react";
import {
  flattenWorkspaceFileTreeRows,
  type WorkspaceFileTreeNode,
} from "@/components/panes/workspace-file-tree/model";

export function useWorkspaceFileTreeRows({
  workspacePath,
  childrenByDirectory,
  expandedPaths,
  loadedDirectoryPaths,
  loadingDirectoryPaths,
  errorByDirectory,
}: {
  workspacePath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  expandedPaths: Set<string>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  errorByDirectory: Map<string, Error>;
}) {
  return useMemo(() => {
    return flattenWorkspaceFileTreeRows({
      rootPath: workspacePath,
      childrenByDirectory,
      expandedPaths,
      loadedDirectoryPaths,
      loadingDirectoryPaths,
      errorByDirectory,
      flattenEmptyDirectories: true,
    });
  }, [
    childrenByDirectory,
    errorByDirectory,
    expandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    workspacePath,
  ]);
}
