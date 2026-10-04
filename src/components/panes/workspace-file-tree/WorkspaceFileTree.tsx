/* eslint-disable max-lines -- WorkspaceFileTree 需要集中编排数据、虚拟列表、吸顶和头部操作。 */
/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx 拷贝
 * （2026-10-01）。整段移除（无对应服务，取舍见报告）：返回钮（ZCode 全页树；
 * harness 是停靠窗格无"返回"）、文件搜索（需全仓索引服务；对已加载行做假过滤
 * 会误导，故连输入框一起不接）、Git changedOnly、Ellipsis 菜单（打开方式/
 * 资源管理器）、revealPath/activePreviewPath 联动。
 * harness 适配：①cwd 显示=标题（叶名）+ 完整路径行；②保留旧窗格的用户功能
 * ——选择文件夹（@tauri-apps/plugin-dialog，经 onPickFolder 由宿主解析根）与
 * 折叠全部（ChevronsDownUp，同旧窗格）；③非阻塞根错误从 toast 改为可见错误条
 * （工程无 toast；错误不可静默）。
 * 虚拟化用工程内 useFileTreeVirtualizer（固定行高等价替换）。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AlertCircle, ChevronsDownUp, FolderSearch, RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getPathLeaf,
  getWorkspaceFileDirectoryChildDepth,
  type WorkspaceFileTreeRow,
} from "@/components/panes/workspace-file-tree/model";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/components/panes/workspace-file-tree/constants";
import { useWorkspaceFileTreeData } from "@/components/panes/workspace-file-tree/useFileTreeData";
import { useWorkspaceFileTreeStickyFolders } from "@/components/panes/workspace-file-tree/useFileTreeStickyFolders";
import { useFileTreeVirtualizer } from "@/components/panes/workspace-file-tree/useFileTreeVirtualizer";
import {
  WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
  WorkspaceFileTreeList,
} from "@/components/panes/workspace-file-tree/WorkspaceFileTreeList";
import { WorkspaceFileTreeStickyFolders } from "@/components/panes/workspace-file-tree/WorkspaceFileTreeStickyFolders";

export interface WorkspaceFileTreeProps {
  /** 浏览根（fs_git_root 解析结果，或 cwd 本身）。变更即整体重建。 */
  workspacePath: string;
  /** 标题覆盖（默认 = 路径叶名）。 */
  workspaceName?: string;
  /** 单击文件（非目录）→ 预览通道（preview-opener）。 */
  onOpenFile?: (filePath: string, fileName: string) => void;
  /** 选择文件夹（宿主弹原生目录选择并换根；未提供则不渲染该钮）。 */
  onPickFolder?: () => void;
}

export function WorkspaceFileTree({
  workspacePath,
  workspaceName,
  onOpenFile,
  onPickFolder,
}: WorkspaceFileTreeProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
  const [hasScrollableFileTree, setHasScrollableFileTree] = useState(false);
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);
  const treeData = useWorkspaceFileTreeData({
    workspacePath,
  });
  const visibleRows = treeData.rows;
  const rowVirtualizer = useFileTreeVirtualizer({
    count: visibleRows.length,
    rowHeight: WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
    scrollElementRef: scrollRef,
  });

  useEffect(() => {
    setSelectedPath(null);
  }, [workspacePath]);

  const rootLoading = treeData.loadingDirectoryPaths.has(workspacePath);
  const rootLoaded = treeData.loadedDirectoryPaths.has(workspacePath);
  const rootError = treeData.errorByDirectory.get(workspacePath) ?? null;
  const blockingRootError = rootLoaded ? null : rootError;
  const showInitialLoading = !rootLoaded && !blockingRootError;

  const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showScrollBottomMask) {
      return undefined;
    }
    return {
      WebkitMaskImage:
        "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showScrollBottomMask]);
  const scrollContainerStyle = useMemo<CSSProperties>(
    () => ({ ...scrollMaskStyle, overflowAnchor: "none" }),
    [scrollMaskStyle],
  );

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode) {
      return;
    }
    const contentNode = scrollNode.firstElementChild;
    const updateScrollMask = () => {
      // 虚拟列表的 scrollOffset 需要经过 React 重渲染，拖拽滚动条时
      // mask 会落后一帧。原生 scroll 回调直接更新 CSS 变量，与浏览器滚动同步绘制。
      listRef.current?.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollNode.scrollTop}px`,
      );
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;
      setHasScrollableFileTree(hasOverflow);
      setShowScrollBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateScrollMask();
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }
    scrollNode.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootError, rootLoaded, rootLoading, visibleRows.length]);

  const handleRefresh = useCallback(() => {
    void treeData.refreshLoadedDirectories();
  }, [treeData]);
  const refreshInProgress = rootLoading || treeData.refreshingLoadedDirectories;

  const handleToggleDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(row.path)) {
          for (const path of row.compactedPaths ?? [row.path]) {
            next.delete(path);
          }
          return next;
        }
        next.add(row.path);
        return next;
      });
      if (!row.expanded) {
        // compact folders 的 row.depth 是压缩后的视觉深度，不能用于写入新加载节点。
        // 使用物理路径深度后，flatten 阶段再扣除 compact offset，子内容才不会与父目录同级。
        void treeData.loadDirectory(
          row.path,
          getWorkspaceFileDirectoryChildDepth(workspacePath, row.path),
        );
      }
    },
    [treeData, workspacePath],
  );
  const handleOpenPreview = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type === "directory") {
        handleToggleDirectory(row);
        return;
      }
      onOpenFile?.(row.path, row.name);
    },
    [handleToggleDirectory, onOpenFile],
  );
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleOpenPreview(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded) {
          handleToggleDirectory(row);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        handleToggleDirectory(row);
      }
    },
    [handleOpenPreview, handleToggleDirectory],
  );

  const virtualItems = rowVirtualizer.virtualItems;
  const scrollOffset = rowVirtualizer.scrollOffset;
  const stickyFolderItems = useWorkspaceFileTreeStickyFolders({
    rows: visibleRows,
    scrollOffset,
    enabled: hasScrollableFileTree,
  });
  const handleRevealStickyFolderRow = useCallback(
    (item: { index: number }) => rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );
  const workspaceTitle = workspaceName?.trim() || getPathLeaf(workspacePath) || workspacePath;

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-(--surface) text-(--text)"
      data-testid="workspace-file-tree-panel"
    >
      <div className="flex shrink-0 items-center px-2 pb-1.5 pt-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            className="min-w-0 truncate py-0.5 text-(--filetree-row-font-size) font-medium text-(color:--brand)"
            title={workspacePath}
          >
            {workspaceTitle}
          </h3>
          <span className="min-w-0 truncate text-xs text-(--text-3)" title={workspacePath}>
            {workspacePath}
          </span>
        </div>
        {onPickFolder ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-(--text-2) hover:bg-(--hover-wash) hover:text-(--text)"
            aria-label="选择文件夹"
            title="选择文件夹"
            onClick={onPickFolder}
          >
            <FolderSearch className="size-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-(--text-2) hover:bg-(--hover-wash) hover:text-(--text)"
          aria-label="折叠全部文件夹"
          title="折叠全部文件夹"
          disabled={treeData.rows.length === 0}
          onClick={() => treeData.setExpandedPaths(new Set())}
        >
          <ChevronsDownUp className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="workspace-file-tree-refresh-button"
          className="text-(--text-2) hover:bg-(--hover-wash) hover:text-(--text)"
          aria-label="刷新"
          title="刷新"
          disabled={treeData.refreshingLoadedDirectories}
          onClick={handleRefresh}
        >
          <RefreshCw className={cn("size-4", refreshInProgress && "animate-spin")} />
        </Button>
      </div>
      {rootLoaded && rootError ? (
        <div
          className="flex shrink-0 items-center gap-1.5 border-y border-(--stroke) bg-destructive/10 px-3 py-1.5 text-xs text-(--text-2)"
          role="alert"
        >
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate" title={rootError.message}>
            刷新失败（{rootError.message}）· 点右侧重试
          </span>
          <button
            type="button"
            aria-label="重试"
            className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-(--hover-wash)"
            onClick={handleRefresh}
          >
            <RotateCcw className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-auto px-2"
          style={scrollContainerStyle}
        >
          <WorkspaceFileTreeStickyFolders
            items={stickyFolderItems}
            selectedPath={selectedPath}
            workspacePath={workspacePath}
            onSelect={setSelectedPath}
            onToggleDirectory={handleToggleDirectory}
            onRevealRow={handleRevealStickyFolderRow}
            onOpenPreview={handleOpenPreview}
            onKeyDown={handleRowKeyDown}
          />
          <WorkspaceFileTreeList
            rootError={blockingRootError}
            showInitialLoading={showInitialLoading}
            rows={visibleRows}
            virtualItems={virtualItems}
            listRef={handleListRef}
            stickyFolderCount={stickyFolderItems.length}
            totalSize={rowVirtualizer.getTotalSize()}
            emptyTitle="目录为空"
            workspaceTitle={workspaceTitle}
            workspacePath={workspacePath}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onToggleDirectory={handleToggleDirectory}
            onOpenPreview={handleOpenPreview}
            onKeyDown={handleRowKeyDown}
          />
        </div>
      </div>
    </section>
  );
}
