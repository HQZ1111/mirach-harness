/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTreeList.tsx 拷贝
 * （2026-10-01）。Git 状态 props 整段移除（无 git 数据源）；文案 zh 直写
 * （工程无 i18n）。吸顶遮罩通过原生 scroll 事件同步的 CSS 变量只裁视口顶部
 * 吸顶高度，不改变列表布局与滚动范围。 */
import type { CSSProperties, KeyboardEvent, RefCallback } from "react";
import { AlertCircle, Files, LoaderCircle } from "lucide-react";

import {
  areWorkspaceFilePathsEqual,
  type WorkspaceFileTreeRow,
} from "@/components/panes/workspace-file-tree/model";
import { WorkspaceFileTreeNotice } from "@/components/panes/workspace-file-tree/WorkspaceFileTreeNotice";
import { WorkspaceFileTreeRowView } from "@/components/panes/workspace-file-tree/WorkspaceFileTreeRowView";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/components/panes/workspace-file-tree/constants";
import type { FileTreeVirtualItem } from "@/components/panes/workspace-file-tree/useFileTreeVirtualizer";

export const WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY = "--workspace-file-tree-mask-offset";

function getWorkspaceFileTreeListMaskStyle({
  stickyFolderCount,
}: {
  stickyFolderCount: number;
}): CSSProperties | undefined {
  if (stickyFolderCount === 0) {
    return undefined;
  }
  const hiddenHeight = stickyFolderCount * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
  // sticky 与虚拟列表是滚动容器内的兄弟节点，列表原行仍会从 sticky 下方经过。
  // 遮罩通过原生 scroll 事件同步 CSS 变量，只隐藏视口顶部的吸顶高度，不改变列表布局和滚动范围。
  const maskImage = `linear-gradient(to bottom, transparent 0 ${hiddenHeight}px, black ${hiddenHeight}px)`;
  const maskPosition = `0 var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY})`;
  const maskSize = `100% calc(100% - var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY}))`;
  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskPosition: maskPosition,
    maskPosition,
    WebkitMaskSize: maskSize,
    maskSize,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

export function WorkspaceFileTreeList({
  rootError,
  showInitialLoading,
  rows,
  virtualItems,
  listRef,
  stickyFolderCount,
  totalSize,
  emptyTitle,
  workspaceTitle,
  workspacePath,
  selectedPath,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onKeyDown,
}: {
  rootError: Error | null;
  showInitialLoading: boolean;
  rows: WorkspaceFileTreeRow[];
  virtualItems: FileTreeVirtualItem[];
  listRef: RefCallback<HTMLDivElement>;
  stickyFolderCount: number;
  totalSize: number;
  emptyTitle: string;
  workspaceTitle: string;
  workspacePath: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  if (rootError) {
    return (
      <WorkspaceFileTreeNotice
        icon={<AlertCircle className="size-4" />}
        title="读取失败"
        description={rootError.message}
      />
    );
  }
  if (showInitialLoading) {
    return (
      <WorkspaceFileTreeNotice
        icon={<LoaderCircle className="size-4 animate-spin" />}
        title="加载中…"
      />
    );
  }
  if (rows.length === 0) {
    return <WorkspaceFileTreeNotice icon={<Files className="size-4" />} title={emptyTitle} />;
  }
  const renderRow = (row: WorkspaceFileTreeRow, style: CSSProperties) => (
    <WorkspaceFileTreeRowView
      key={row.path}
      row={row}
      selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}
      workspacePath={workspacePath}
      style={style}
      onSelect={onSelect}
      onToggleDirectory={onToggleDirectory}
      onOpenPreview={onOpenPreview}
      onKeyDown={onKeyDown}
    />
  );
  const listStyle: CSSProperties & Record<typeof WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY, string> =
    {
      [WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY]: "0px",
      height: `${totalSize}px`,
      ...getWorkspaceFileTreeListMaskStyle({ stickyFolderCount }),
    };
  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={listStyle}
      role="tree"
      aria-label={workspaceTitle}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) {
          return null;
        }
        return renderRow(row, {
          height: `${virtualItem.size}px`,
          transform: `translateY(${virtualItem.start}px)`,
        });
      })}
    </div>
  );
}
