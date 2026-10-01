/* eslint-disable max-lines -- 文件树数据 hook 需要集中维护目录加载与刷新竞态。 */
/* ZCode packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts 拷贝
 * （2026-10-01）。数据面适配：fileService.readdir → fs-adapter 的
 * listWorkspaceDirectory（fs_list，失败抛 Error=错误码）。整段移除（无对应
 * IPC/服务，取舍见报告）：Git 状态加载（gitService）、目录 watcher
 * （fileWatcherService，手动刷新钮 + 重挂载刷新是既定范围）。保留：workspace
 * 代际/请求序号双防竞态、目录级失效与 subtree 裁剪、空目录链静默预加载、
 * 手动刷新的并发队列 + 15s 超时。 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
  WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY,
} from "@/components/panes/workspace-file-tree/constants";
import { replaceSetValue, toError } from "@/components/panes/workspace-file-tree/helpers";
import {
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  isWorkspaceFileTreeAutoFlattenableDirectory,
  isWorkspaceFilePathInside,
  type WorkspaceFileTreeNode,
} from "@/components/panes/workspace-file-tree/model";
import { listWorkspaceDirectory } from "@/components/panes/workspace-file-tree/fs-adapter";
import { getWorkspaceFileTreeRefreshDirectoryPaths } from "@/components/panes/workspace-file-tree/refreshDirectories";
import { useWorkspaceFileTreeRows } from "@/components/panes/workspace-file-tree/useFileTreeRows";

type WorkspaceFileTreeDirectoryLoadResult = "loaded" | "stale" | "failed";

function createWorkspaceFileTreeTimeoutError(label: string, timeoutMs: number) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function withWorkspaceFileTreeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createWorkspaceFileTreeTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function useWorkspaceFileTreeData({
  workspacePath,
}: {
  workspacePath: string;
}) {
  const workspaceGenerationRef = useRef(0);
  const requestVersionRef = useRef(0);
  const directoryRequestVersionRef = useRef<Map<string, number>>(new Map());
  const refreshBatchVersionRef = useRef(0);
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set());
  const loadedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Map<string, WorkspaceFileTreeNode[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(new Set());
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set());
  const [errorByDirectory, setErrorByDirectory] = useState<Map<string, Error>>(new Map());
  const [refreshingLoadedDirectories, setRefreshingLoadedDirectories] = useState(false);
  const refreshingLoadedDirectoriesRef = useRef(false);

  useEffect(() => {
    loadingDirectoryPathsRef.current = loadingDirectoryPaths;
  }, [loadingDirectoryPaths]);

  useEffect(() => {
    loadedDirectoryPathsRef.current = loadedDirectoryPaths;
  }, [loadedDirectoryPaths]);

  const setDirectoryLoading = useCallback((path: string, loading: boolean) => {
    const next = replaceSetValue(loadingDirectoryPathsRef.current, path, loading);
    loadingDirectoryPathsRef.current = next;
    setLoadingDirectoryPaths(next);
  }, []);

  const setDirectoryLoaded = useCallback((path: string, loaded: boolean) => {
    const next = replaceSetValue(loadedDirectoryPathsRef.current, path, loaded);
    loadedDirectoryPathsRef.current = next;
    setLoadedDirectoryPaths(next);
  }, []);

  const invalidateDirectoryRequest = useCallback((directoryPath: string) => {
    directoryRequestVersionRef.current.set(
      directoryPath,
      (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1,
    );
  }, []);

  const cancelRefreshBatch = useCallback(() => {
    refreshBatchVersionRef.current += 1;
  }, []);

  const pruneDirectorySubtree = useCallback(
    (directoryPath: string) => {
      for (const path of directoryRequestVersionRef.current.keys()) {
        if (isWorkspaceFilePathInside(directoryPath, path)) {
          // 目录被裁剪时不能删除请求序号，否则同路径重建会复用旧序号，让删除前的旧请求重新生效。
          invalidateDirectoryRequest(path);
        }
      }
      setChildrenByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });
      setExpandedPaths((current) => {
        const next = new Set(
          [...current].filter((path) => !isWorkspaceFilePathInside(directoryPath, path)),
        );
        return next;
      });
      setErrorByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });

      const nextLoaded = new Set(
        [...loadedDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadedDirectoryPathsRef.current = nextLoaded;
      setLoadedDirectoryPaths(nextLoaded);

      const nextLoading = new Set(
        [...loadingDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadingDirectoryPathsRef.current = nextLoading;
      setLoadingDirectoryPaths(nextLoading);
    },
    [invalidateDirectoryRequest],
  );

  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      childDepth: number,
      options?: {
        force?: boolean;
        silent?: boolean;
        workspaceGeneration?: number;
      },
    ): Promise<WorkspaceFileTreeDirectoryLoadResult> => {
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const expectedWorkspaceGeneration =
        options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== expectedWorkspaceGeneration) {
        return "stale";
      }
      if (
        !force &&
        (loadingDirectoryPathsRef.current.has(directoryPath) ||
          loadedDirectoryPathsRef.current.has(directoryPath))
      ) {
        return "loaded";
      }

      const requestVersion = requestVersionRef.current;
      // 手动刷新可能并发读取同一目录，目录级序号避免旧快照晚返回后覆盖新文件树。
      const directoryRequestVersion =
        (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1;
      directoryRequestVersionRef.current.set(directoryPath, directoryRequestVersion);
      const isCurrentDirectoryRequest = () =>
        workspaceGenerationRef.current === expectedWorkspaceGeneration &&
        requestVersionRef.current === requestVersion &&
        directoryRequestVersionRef.current.get(directoryPath) === directoryRequestVersion;
      if (!silent) {
        setDirectoryLoading(directoryPath, true);
      }
      setErrorByDirectory((current) => {
        const next = new Map(current);
        next.delete(directoryPath);
        return next;
      });

      try {
        const entries = await listWorkspaceDirectory(directoryPath);
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }

        setChildrenByDirectory((current) => {
          const next = new Map(current);
          next.set(
            directoryPath,
            entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              type: entry.type,
              isSymbolicLink: entry.isSymbolicLink === true,
              depth: childDepth,
            })),
          );
          return next;
        });
        setDirectoryLoaded(directoryPath, true);

        if (entries.length === 1 && isWorkspaceFileTreeAutoFlattenableDirectory(entries[0])) {
          // 修复：flatten empty directories 只沿普通单子目录链预加载，避免软链接目录循环递归。
          void loadDirectory(entries[0].path, childDepth + 1, {
            silent: true,
            workspaceGeneration: expectedWorkspaceGeneration,
          });
        }
        return "loaded";
      } catch (error) {
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }
        const nextError = toError(error);
        console.warn("[WorkspaceFileTree] 读取目录失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
        return "failed";
      } finally {
        if (isCurrentDirectoryRequest()) {
          setDirectoryLoading(directoryPath, false);
        }
      }
    },
    [setDirectoryLoaded, setDirectoryLoading],
  );

  const refreshDirectoryManually = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // 手动刷新里的 readdir 失败通常是权限或临时 I/O 错误；
      // 失败不等价于目录被删除，不能复用 watcher 的 subtree 裁剪逻辑（已随
      // watcher 移除），否则会清空旧树和错误状态。
      try {
        await withWorkspaceFileTreeTimeout(
          loadDirectory(
            directoryPath,
            getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
            { force: true, silent: true, workspaceGeneration },
          ),
          WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
          `workspace file tree refresh ${directoryPath}`,
        );
      } catch (error) {
        if (workspaceGenerationRef.current !== workspaceGeneration) {
          return;
        }
        invalidateDirectoryRequest(directoryPath);
        const nextError = toError(error);
        console.warn("[WorkspaceFileTree] 手动刷新目录超时或失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
      }
    },
    [invalidateDirectoryRequest, loadDirectory, workspacePath],
  );

  const refreshDirectoryPaths = useCallback(
    async (
      directoryPaths: string[],
      workspaceGeneration: number,
      refreshBatchVersion: number,
      refreshDirectory: (directoryPath: string, workspaceGeneration: number) => Promise<void>,
    ) => {
      const queue = [...new Set(directoryPaths)];
      const workerCount = Math.min(WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY, queue.length);
      const runWorker = async () => {
        while (
          queue.length > 0 &&
          workspaceGenerationRef.current === workspaceGeneration &&
          refreshBatchVersionRef.current === refreshBatchVersion
        ) {
          const directoryPath = queue.shift();
          if (directoryPath) {
            await refreshDirectory(directoryPath, workspaceGeneration);
          }
        }
      };

      await Promise.allSettled(Array.from({ length: workerCount }, runWorker));
    },
    [],
  );

  const refreshLoadedDirectories = useCallback(async () => {
    if (refreshingLoadedDirectoriesRef.current) {
      return;
    }
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current + 1;
    refreshBatchVersionRef.current = refreshBatchVersion;
    refreshingLoadedDirectoriesRef.current = true;
    setRefreshingLoadedDirectories(true);
    const directoryPaths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath,
      expandedPaths,
      loadedDirectoryPaths: loadedDirectoryPathsRef.current,
    });
    // 手动刷新文件树过去只重读 workspace 根目录，已加载子目录仍沿用旧 children 缓存；
    // 外部新增/重命名文件发生在这些子目录时，旧路径会继续显示，新文件也不会出现。
    // 这里刷新所有已加载或已展开目录，不做全仓递归扫描，避免大仓库刷新成本失控。
    try {
      await refreshDirectoryPaths(
        directoryPaths,
        workspaceGeneration,
        refreshBatchVersion,
        refreshDirectoryManually,
      );
    } finally {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        refreshingLoadedDirectoriesRef.current = false;
        setRefreshingLoadedDirectories(false);
      }
    }
  }, [expandedPaths, refreshDirectoryManually, refreshDirectoryPaths, workspacePath]);

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    const workspaceGeneration = workspaceGenerationRef.current;
    requestVersionRef.current += 1;
    cancelRefreshBatch();
    directoryRequestVersionRef.current = new Map();
    loadingDirectoryPathsRef.current = new Set();
    loadedDirectoryPathsRef.current = new Set();
    setChildrenByDirectory(new Map());
    setExpandedPaths(new Set());
    setLoadedDirectoryPaths(new Set());
    setLoadingDirectoryPaths(new Set());
    setErrorByDirectory(new Map());
    refreshingLoadedDirectoriesRef.current = false;
    setRefreshingLoadedDirectories(false);
    void loadDirectory(workspacePath, 0, {
      force: true,
      workspaceGeneration,
    });
    return () => {
      cancelRefreshBatch();
    };
  }, [cancelRefreshBatch, loadDirectory, workspacePath]);

  const rows = useWorkspaceFileTreeRows({
    workspacePath,
    childrenByDirectory,
    expandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
  });

  return {
    rows,
    setExpandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    refreshingLoadedDirectories,
    loadDirectory,
    refreshLoadedDirectories,
  };
}
