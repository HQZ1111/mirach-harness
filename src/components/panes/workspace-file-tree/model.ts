/* eslint-disable max-lines -- 文件树模型集中维护路径、排序与行展开（行扁平化）。 */
/* ZCode packages/ui/src/workspace-file-tree/model.ts 拷贝（2026-10-01）。
 * 取舍：Git 状态机（buildWorkspaceFileGitStatusByPath/getWorkspaceDirectoryGitStatuses/
 * addDeletedGitStatusRowsToWorkspaceFileTree/changedOnly 过滤）整体未随——harness
 * 无 git 服务（fs.rs 只有 fs_list/fs_git_root/fs_read_data_url），状态装饰无数据源；
 * deleted 虚拟行随之不存在。路径/深度/扁平化（含空目录链压缩）与搜索过滤为逐行拷贝。 */

export interface WorkspaceFileTreeNode {
  path: string;
  name: string;
  type: "directory" | "file";
  depth: number;
  isSymbolicLink?: boolean;
}

export interface WorkspaceFileTreeRow extends WorkspaceFileTreeNode {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  compactedPaths?: string[];
}

function normalizeForRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/* ZCode @/lib/path.ts 的 getPathLeaf（Windows 反斜杠同视作分隔符）。 */
export function getPathLeaf(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getWorkspaceFileRelativePath(workspacePath: string, filePath: string): string {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);

  if (normalizedWorkspacePath === normalizedFilePath) {
    return ".";
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(workspacePrefix)) {
    return normalizedFilePath.slice(workspacePrefix.length);
  }

  return getPathLeaf(filePath);
}

export function areWorkspaceFilePathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizeForRelativePath(leftPath) === normalizeForRelativePath(rightPath);
}

export function isWorkspaceFilePathInside(workspacePath: string, filePath: string): boolean {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

export function getWorkspaceFileAncestorDirectories(
  workspacePath: string,
  filePath: string,
): string[] {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedFilePath = normalizeForRelativePath(filePath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;

  if (
    !isWorkspaceFilePathInside(workspacePath, filePath) ||
    normalizedFilePath === normalizedWorkspacePath
  ) {
    return [];
  }

  const relativePath = normalizedFilePath.slice(workspacePrefix.length);
  const relativeSegments = relativePath.split("/").filter(Boolean);
  if (relativeSegments.length <= 1) {
    return [];
  }

  const separator = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  const basePath = workspacePath.replace(/[\\/]+$/, "");
  const ancestorSegments = relativeSegments.slice(0, -1);
  const ancestors: string[] = [];
  let currentPath = basePath;

  for (const segment of ancestorSegments) {
    currentPath = `${currentPath}${separator}${segment}`;
    ancestors.push(currentPath);
  }

  return ancestors;
}

export function getWorkspaceFileDirectoryChildDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedDirectoryPath = normalizeForRelativePath(directoryPath);

  if (
    normalizedDirectoryPath === normalizedWorkspacePath ||
    !isWorkspaceFilePathInside(workspacePath, directoryPath)
  ) {
    return 0;
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  return normalizedDirectoryPath.slice(workspacePrefix.length).split("/").filter(Boolean).length;
}

export function getWorkspaceFileParentDirectory(
  workspacePath: string,
  directoryPath: string,
): string | null {
  const normalizedWorkspacePath = normalizeForRelativePath(workspacePath);
  const normalizedDirectoryPath = normalizeForRelativePath(directoryPath);

  if (
    normalizedDirectoryPath === normalizedWorkspacePath ||
    !isWorkspaceFilePathInside(workspacePath, directoryPath)
  ) {
    return null;
  }

  const workspacePrefix = `${normalizedWorkspacePath}/`;
  const relativeSegments = normalizedDirectoryPath
    .slice(workspacePrefix.length)
    .split("/")
    .filter(Boolean);
  const parentSegments = relativeSegments.slice(0, -1);
  if (parentSegments.length === 0) {
    return workspacePath.replace(/[\\/]+$/, "");
  }

  const separator = directoryPath.includes("\\") && !directoryPath.includes("/") ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${parentSegments.join(separator)}`;
}

export function isWorkspaceFileTreeAutoFlattenableDirectory(
  node: Pick<WorkspaceFileTreeNode, "type" | "isSymbolicLink"> | undefined,
): node is WorkspaceFileTreeNode {
  // 软链接目录可以展示并手动进入，但不能参与空目录链自动展开；
  // self/parent symlink 会让路径字符串去重失效，持续加载 linked-dir/linked-dir/...。
  return node?.type === "directory" && node.isSymbolicLink !== true;
}

function normalizeWorkspaceFileTreeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function filterWorkspaceFileTreeRows(params: {
  rows: WorkspaceFileTreeRow[];
  searchQuery: string;
}): WorkspaceFileTreeRow[] {
  const normalizedSearchQuery = normalizeWorkspaceFileTreeSearchQuery(params.searchQuery);

  if (!normalizedSearchQuery) {
    return params.rows;
  }

  const matchedRows = params.rows.filter((row) =>
    row.name.toLocaleLowerCase().includes(normalizedSearchQuery),
  );
  if (matchedRows.length === 0) {
    return [];
  }

  const matchedPathSet = new Set(matchedRows.map((row) => row.path));
  const matchedDirectoryPaths = matchedRows
    .filter((row) => row.type === "directory")
    .map((row) => row.path);

  return params.rows.filter((row) => {
    if (matchedPathSet.has(row.path)) {
      return true;
    }

    if (
      row.type === "directory" &&
      matchedRows.some((matchedRow) => isWorkspaceFilePathInside(row.path, matchedRow.path))
    ) {
      return true;
    }

    return matchedDirectoryPaths.some((directoryPath) =>
      isWorkspaceFilePathInside(directoryPath, row.path),
    );
  });
}

export function flattenWorkspaceFileTreeRows(params: {
  rootPath: string;
  childrenByDirectory: Map<string, WorkspaceFileTreeNode[]>;
  expandedPaths: Set<string>;
  loadedDirectoryPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  errorByDirectory: Map<string, Error>;
  flattenEmptyDirectories?: boolean;
}): WorkspaceFileTreeRow[] {
  const rows: WorkspaceFileTreeRow[] = [];

  function compactDirectoryNode(node: WorkspaceFileTreeNode): {
    node: WorkspaceFileTreeNode;
    compactedPaths?: string[];
    childDepthOffset: number;
  } {
    if (!params.flattenEmptyDirectories || !isWorkspaceFileTreeAutoFlattenableDirectory(node)) {
      return { node, childDepthOffset: 0 };
    }

    const compactedNodes = [node];
    let currentNode = node;

    while (
      params.loadedDirectoryPaths.has(currentNode.path) &&
      !params.loadingDirectoryPaths.has(currentNode.path) &&
      !params.errorByDirectory.has(currentNode.path)
    ) {
      const children = params.childrenByDirectory.get(currentNode.path) ?? [];
      if (children.length !== 1 || !isWorkspaceFileTreeAutoFlattenableDirectory(children[0])) {
        break;
      }

      currentNode = children[0];
      compactedNodes.push(currentNode);
    }

    if (compactedNodes.length === 1) {
      return { node, childDepthOffset: 0 };
    }

    return {
      node: {
        ...currentNode,
        depth: node.depth,
        name: compactedNodes.map((compactedNode) => compactedNode.name).join("/"),
      },
      compactedPaths: compactedNodes.map((compactedNode) => compactedNode.path),
      childDepthOffset: currentNode.depth - node.depth,
    };
  }

  function visit(directoryPath: string, depthOffset = 0) {
    const children = params.childrenByDirectory.get(directoryPath) ?? [];
    for (const child of children) {
      const compacted = compactDirectoryNode({
        ...child,
        depth: child.depth - depthOffset,
      });
      const representedPaths = compacted.compactedPaths ?? [compacted.node.path];
      const expanded = representedPaths.some((path) => params.expandedPaths.has(path));
      rows.push({
        ...compacted.node,
        expanded,
        loaded: params.loadedDirectoryPaths.has(compacted.node.path),
        loading: params.loadingDirectoryPaths.has(compacted.node.path),
        error: params.errorByDirectory.get(compacted.node.path) ?? null,
        ...(compacted.compactedPaths ? { compactedPaths: compacted.compactedPaths } : {}),
      });

      if (compacted.node.type === "directory" && expanded) {
        visit(compacted.node.path, depthOffset + compacted.childDepthOffset);
      }
    }
  }

  visit(params.rootPath);
  return rows;
}
