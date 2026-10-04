/* eslint-disable max-lines -- 文件树行集中管理缩进、引导线、上下文菜单与键盘交互。 */
/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx 拷贝
 * （2026-10-01）。整段移除（无对应服务/数据源，取舍见报告）：Git 状态装饰与
 * ControlHintTooltip、拖拽进会话（workspaceFileDrag/mentionMarkdown）、打开方式
 * （installedEditors/platform）、资源管理器 reveal、HTML in-browser。保留：层级
 * 引导线、缩进公式、chevron 旋转、loading/error 指示、键盘（Enter/←/→ 由父级
 * 处理）、role=treeitem/aria-expanded/tabIndex、右键菜单（可支持的三项：打开/
 * 复制绝对路径/复制相对路径）。文件图标 = FileTypeBadge（hermes FileGlyph 迁入）。 */
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { ContextMenu } from "radix-ui";

const ContextMenuRoot = ContextMenu.Root
const ContextMenuTrigger = ContextMenu.Trigger
const ContextMenuPortal = ContextMenu.Portal
const ContextMenuContent = ContextMenu.Content
const ContextMenuItem = ContextMenu.Item

import { cn } from "@/lib/utils";
import {
  getWorkspaceFileRelativePath,
  type WorkspaceFileTreeRow,
} from "@/components/panes/workspace-file-tree/model";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "@/components/panes/workspace-file-tree/hierarchyGuides";
import { WorkspaceFileTreeRowName } from "@/components/panes/workspace-file-tree/WorkspaceFileTreeRowName";
import { FileTypeBadge } from "@/components/panes/workspace-file-tree/FileTypeBadge";

export function WorkspaceFileTreeRowView({
  layout = "absolute",
  row,
  selected,
  workspacePath,
  style,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onKeyDown,
}: {
  layout?: "absolute" | "static";
  row: WorkspaceFileTreeRow;
  selected: boolean;
  workspacePath: string;
  style: CSSProperties;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  const relativePath = getWorkspaceFileRelativePath(workspacePath, row.path);
  const isDirectory = row.type === "directory";
  const rowStyle = {
    ...style,
    "--workspace-file-tree-depth": row.depth,
  } as CSSProperties;
  const hierarchyGuideStyle = getWorkspaceFileTreeHierarchyGuideStyle(row.depth);

  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    onSelect(row.path);
    if (event.detail > 1) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    // 文件树单击文件之前只更新选中态，必须双击才打开预览。
    // 这里让文件和目录都保持"单击执行主要动作"：目录展开，文件预览。
    onOpenPreview(row);
  };
  const handleOpenPrimary = () => {
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    onOpenPreview(row);
  };
  const handleCopyAbsolutePath = async () => {
    try {
      await navigator.clipboard.writeText(row.path);
    } catch (error) {
      // 复制失败必须可见（禁止静默降级）——console.error 交给诊断面。
      console.error("[WorkspaceFileTree] 复制绝对路径失败", {
        path: row.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const handleCopyRelativePath = async () => {
    try {
      await navigator.clipboard.writeText(relativePath);
    } catch (error) {
      console.error("[WorkspaceFileTree] 复制相对路径失败", {
        path: row.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const rowElement = (
    <div
      role="treeitem"
      aria-expanded={isDirectory ? row.expanded : undefined}
      tabIndex={0}
      className={cn(
        "group/file-tree-row relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg border pr-2 py-1 text-left text-(--filetree-row-font-size) text-(--text) outline-none transition-[background-color,border-color,box-shadow]",
        "cursor-pointer",
        "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
        selected
          ? "border-(--fl-accent) bg-transparent hover:bg-(--hover-wash)"
          : "border-transparent hover:bg-(--hover-wash)",
        "focus-visible:border-(--fl-accent)",
      )}
      title={relativePath}
      onClick={handleRowClick}
      onContextMenu={() => onSelect(row.path)}
      onKeyDown={onKeyDown ? (event) => onKeyDown(event, row) : undefined}
    >
      {/* 引导线上下各延伸 1px；12px 层级步进让最后一条线与当前层级图标之间稳定保留 4px。 */}
      {hierarchyGuideStyle ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-y-px left-2.5"
          data-workspace-file-tree-hierarchy-guides={row.depth}
          style={hierarchyGuideStyle}
        />
      ) : null}
      {isDirectory ? (
        <span className="flex size-4 shrink-0 items-center justify-center text-(--text-2)">
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 text-(--text-3) transition-transform",
              row.expanded && "rotate-90",
            )}
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {isDirectory ? null : <FileTypeBadge name={row.name} />}
        <WorkspaceFileTreeRowName
          name={row.name}
          className="min-w-0 flex-1 truncate"
          slashClassName="mx-1 text-(--text-4)"
        />
      </span>
      {row.loading ? (
        <LoaderCircle className="ml-2 size-3 shrink-0 animate-spin text-(--text-4)" />
      ) : row.error ? (
        <AlertCircle className="ml-2 size-3 shrink-0 text-destructive" />
      ) : null}
    </div>
  );

  return (
    <div
      // harness 适配（用户 2026-10-04）：ZCode 原版 wrapper 是 px-1——行卡片
      // 比头部地址行（px-2）多缩 4px，"地址行与文件行到边缘的间距"不一致；
      // 改 px-0 让行卡片与地址行同宽对齐（内容缩进公式不动）。
      className={cn(layout === "absolute" ? "absolute left-0 top-0 w-full" : "w-full")}
      style={rowStyle}
    >
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent className="z-50 w-52 rounded-lg border border-(--stroke) bg-(--surface) p-1 shadow-(--shadow-pop)">
            <ContextMenuItem
              className="cursor-pointer rounded-md px-2 py-1.5 text-(--filetree-row-font-size) text-(--text) outline-none data-[highlighted]:bg-(--hover-wash)"
              onSelect={handleOpenPrimary}
            >
              打开
            </ContextMenuItem>
            <ContextMenuItem
              className="cursor-pointer rounded-md px-2 py-1.5 text-(--filetree-row-font-size) text-(--text) outline-none data-[highlighted]:bg-(--hover-wash)"
              onSelect={() => void handleCopyAbsolutePath()}
            >
              复制绝对路径
            </ContextMenuItem>
            <ContextMenuItem
              className="cursor-pointer rounded-md px-2 py-1.5 text-(--filetree-row-font-size) text-(--text) outline-none data-[highlighted]:bg-(--hover-wash)"
              onSelect={() => void handleCopyRelativePath()}
            >
              复制相对路径
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenuRoot>
    </div>
  );
}
