/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx 拷贝
 * （2026-10-01）。Git 状态 props 整段移除。 */
import type { KeyboardEvent } from "react";

import {
  areWorkspaceFilePathsEqual,
  type WorkspaceFileTreeRow,
} from "@/components/panes/workspace-file-tree/model";
import { WorkspaceFileTreeRowView } from "@/components/panes/workspace-file-tree/WorkspaceFileTreeRowView";
import type { WorkspaceFileTreeStickyFolderItem } from "@/components/panes/workspace-file-tree/useFileTreeStickyFolders";

export function WorkspaceFileTreeStickyFolders({
  items,
  selectedPath,
  workspacePath,
  onSelect,
  onToggleDirectory,
  onRevealRow,
  onOpenPreview,
  onKeyDown,
}: {
  items: WorkspaceFileTreeStickyFolderItem[];
  selectedPath: string | null;
  workspacePath: string;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onRevealRow: (item: WorkspaceFileTreeStickyFolderItem) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1">
      <div className="pointer-events-auto overflow-hidden rounded-lg bg-(--surface)">
        {items.map((item) => {
          const row = item.row;
          const handleToggle = (nextRow: WorkspaceFileTreeRow) => {
            onToggleDirectory(nextRow);
            if (nextRow.expanded) {
              requestAnimationFrame(() => onRevealRow(item));
            }
          };
          return (
            <WorkspaceFileTreeRowView
              key={row.path}
              layout="static"
              row={row}
              selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}
              workspacePath={workspacePath}
              style={{}}
              onSelect={onSelect}
              onToggleDirectory={handleToggle}
              onOpenPreview={onOpenPreview}
              onKeyDown={onKeyDown}
            />
          );
        })}
      </div>
    </div>
  );
}
