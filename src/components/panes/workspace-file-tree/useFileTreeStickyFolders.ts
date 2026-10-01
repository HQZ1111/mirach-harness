/* ZCode packages/ui/src/workspace-file-tree/useWorkspaceFileTreeStickyFolders.ts 拷贝
 * （2026-10-01）。两处等价适配：①计算抽成 computeFileTreeStickyFolders 纯函数供
 * vitest 直测；②去掉了只作 memo 依赖用的 virtualItems/scrollDirection 入参——
 * 行高固定下 scrollOffset 变化即覆盖全部重算时机。 */
import { useMemo } from "react";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/components/panes/workspace-file-tree/constants";
import type { WorkspaceFileTreeRow } from "@/components/panes/workspace-file-tree/model";

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export function computeFileTreeStickyFolders({
  rows,
  scrollOffset,
  enabled = true,
}: {
  rows: WorkspaceFileTreeRow[];
  scrollOffset: number;
  enabled?: boolean;
}): WorkspaceFileTreeStickyFolderItem[] {
  if (!enabled) {
    return [];
  }
  if (rows.length === 0 || scrollOffset <= 0.5) {
    return [];
  }

  let stickyItems: WorkspaceFileTreeStickyFolderItem[] = [];
  for (let iteration = 0; iteration <= rows.length; iteration += 1) {
    const probeOffset =
      scrollOffset + stickyItems.length * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
    const probeIndex = Math.min(
      rows.length - 1,
      Math.floor(probeOffset / WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX),
    );
    const probeRow = rows[probeIndex];
    if (!probeRow) {
      return [];
    }

    const ancestorItems: WorkspaceFileTreeStickyFolderItem[] = [];
    const canStickProbeRow = probeRow.type === "directory" && probeRow.expanded;
    let stickyDepth = canStickProbeRow ? probeRow.depth : probeRow.depth - 1;
    for (
      let index = canStickProbeRow ? probeIndex : probeIndex - 1;
      index >= 0 && stickyDepth >= 0;
      index -= 1
    ) {
      const row = rows[index];
      if (!row || row.type !== "directory" || !row.expanded) {
        continue;
      }
      if (row.depth === stickyDepth) {
        ancestorItems.push({ row, index });
        stickyDepth = row.depth - 1;
      }
    }
    ancestorItems.reverse();

    const nextStickyItems = ancestorItems.filter((item, stickyIndex) => {
      const rowStart = item.index * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      const stickyBoundary = scrollOffset + stickyIndex * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
      return rowStart <= stickyBoundary + 0.5;
    });
    if (nextStickyItems.length === stickyItems.length) {
      return nextStickyItems;
    }
    stickyItems = nextStickyItems;
  }
  return stickyItems;
}

export function useWorkspaceFileTreeStickyFolders({
  rows,
  scrollOffset,
  enabled,
}: {
  rows: WorkspaceFileTreeRow[];
  scrollOffset: number;
  enabled: boolean;
}) {
  const stickyFolderItems = useMemo<WorkspaceFileTreeStickyFolderItem[]>(() => {
    // 每一层 sticky 行都会把下一层触发线向下推 28px；如果所有层级
    // 都只和 scrollTop 比较，子目录会晚吸顶。通过探测 sticky stack 下方的行，
    // 让计算触发线与 CSS top 使用相同的累计偏移。
    return computeFileTreeStickyFolders({
      rows,
      scrollOffset,
      enabled,
    });
  }, [enabled, rows, scrollOffset]);

  // 吸顶行以前会从虚拟列表迁出并改写 scrollTop，鼠标拖拽滚动条时
  // 会与浏览器的原生拖拽位置竞争。现在原行保留，CSS sticky 只负责视觉覆盖。
  return stickyFolderItems;
}
