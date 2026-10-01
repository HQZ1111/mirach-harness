import type { CSSProperties } from "react";

/* ZCode packages/ui/src/workspace-file-tree/hierarchyGuides.ts 逐字拷贝。
 * 线色引用 tailwind.css 的 --color-border（shadcn 主题令牌，两工程同在）；
 * 0.75rem 层级步进与行缩进 pl 计算式联动，勿单独改动。 */

const WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND =
  "repeating-linear-gradient(to right, transparent 0 calc(0.375rem - 1px), var(--color-border) calc(0.375rem - 1px) 0.375rem, transparent 0.375rem 0.75rem)";

export function getWorkspaceFileTreeHierarchyGuideStyle(depth: number): CSSProperties | null {
  if (depth <= 0) {
    return null;
  }

  return {
    width: `calc(${depth} * 0.75rem)`,
    backgroundImage: WORKSPACE_FILE_TREE_HIERARCHY_GUIDE_BACKGROUND,
  };
}
