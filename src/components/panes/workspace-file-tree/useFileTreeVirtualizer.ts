/* @tanstack/react-virtual 的等价替换（2026-10-01）。
 * ZCode 的 WorkspaceFileTree 依赖 useVirtualizer，但工程钉版不引新 npm 依赖，
 * 且本树行高固定（WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX，28px）——
 * 固定行高的虚拟化只需一段区间计算 + 滚动同步。对齐 ZCode 用到的 API 面：
 * getVirtualItems / getTotalSize / scrollToIndex(align: start|center|auto|end) /
 * scrollOffset。区间计算抽成纯函数供 vitest 直测。 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

export interface FileTreeVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface FileTreeVirtualRange {
  startIndex: number;
  endIndex: number;
  totalSize: number;
}

export function computeFileTreeVirtualRange(params: {
  count: number;
  rowHeight: number;
  overscan: number;
  scrollOffset: number;
  viewportHeight: number;
}): FileTreeVirtualRange {
  const { count, rowHeight, overscan, scrollOffset, viewportHeight } = params;
  if (count <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: -1, totalSize: 0 };
  }
  // 可见区间 = 与视口 [scrollOffset, scrollOffset+viewportHeight) 相交的行
  // （@tanstack/react-virtual 同语义），向两侧各扩 overscan 行。
  const firstVisible = Math.min(count - 1, Math.max(0, Math.floor(scrollOffset / rowHeight)));
  const lastVisible =
    viewportHeight > 0
      ? Math.ceil((scrollOffset + viewportHeight) / rowHeight) - 1
      : firstVisible; // 视口未量得高度（挂载首帧）：至少渲染首行 + overscan
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(count - 1, Math.max(lastVisible, firstVisible) + overscan);
  return { startIndex, endIndex, totalSize: count * rowHeight };
}

export function useFileTreeVirtualizer({
  count,
  rowHeight,
  overscan,
  scrollElementRef,
}: {
  count: number;
  rowHeight: number;
  overscan: number;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    const sync = () => {
      setScrollOffset(element.scrollTop);
      setViewportHeight(element.clientHeight);
    };
    sync();
    element.addEventListener("scroll", sync, { passive: true });
    // 视口尺寸变化（窗格拖宽/窗口 resize）要重算可见行窗口。
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(element);
    return () => {
      element.removeEventListener("scroll", sync);
      resizeObserver.disconnect();
    };
  }, [scrollElementRef]);

  const range = computeFileTreeVirtualRange({
    count,
    rowHeight,
    overscan,
    scrollOffset,
    viewportHeight,
  });

  const getVirtualItems = useCallback((): FileTreeVirtualItem[] => {
    const items: FileTreeVirtualItem[] = [];
    for (let index = range.startIndex; index <= range.endIndex; index += 1) {
      items.push({ index, start: index * rowHeight, size: rowHeight });
    }
    return items;
  }, [range.endIndex, range.startIndex, rowHeight]);

  const scrollToIndex = useCallback(
    (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => {
      const element = scrollElementRef.current;
      if (!element || count <= 0) {
        return;
      }
      const clampedIndex = Math.min(Math.max(0, index), count - 1);
      const rowStart = clampedIndex * rowHeight;
      const viewport = element.clientHeight;
      const align = options?.align ?? "auto";
      let top: number;
      if (align === "start") {
        top = rowStart;
      } else if (align === "center") {
        top = rowStart - (viewport - rowHeight) / 2;
      } else if (align === "end") {
        top = rowStart - viewport + rowHeight;
      } else {
        const viewTop = element.scrollTop;
        const viewBottom = viewTop + viewport;
        if (rowStart < viewTop) {
          top = rowStart;
        } else if (rowStart + rowHeight > viewBottom) {
          top = rowStart - viewport + rowHeight;
        } else {
          return;
        }
      }
      element.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    },
    [count, rowHeight, scrollElementRef],
  );

  const virtualItems = useMemo(() => getVirtualItems(), [getVirtualItems]);

  return {
    virtualItems,
    getTotalSize: () => range.totalSize,
    scrollToIndex,
    scrollOffset,
  };
}
