"use client";

/**
 * 连续摘要组（ZCode `ToolCallBlocks/ToolSummaryRow.tsx::ConsecutiveSummaryGroup`
 * 的宿主移植，2026-11-15）。
 *
 * ## 形态（用户提供的 ZCode 截图逐项对应）
 *
 * ```
 * ✎ 已查阅 20 项，已执行 134 命令，已修改 4 文件        ← 组头：图标 + 统计 + hover 才出的 chevron
 *   │ 已执行 Check configured session dir              ← 子行：左侧竖导线、隐藏行首图标、gap-2
 *   │ 思考 持续了几秒
 *   │ 已写入 cdp-eval2.mjs +43
 * ```
 *
 * - **组头**：`flex w-fit gap-2`；图标槽 `size-4`；统计文本 `truncate`（title
 *   给全文）；chevron `opacity-0 group-hover:opacity-100`，展开时 `rotate-90`。
 * - **组内容**：`mt-2 max-h-[calc(16lh+30*var(--spacing))] overflow-y-auto`；
 *   内层 `ml-2 pl-4` + `before:` 竖导线（不占布局：8px + 16px 与组头文字对齐）；
 *   `[&_[data-summary-leading-icon]]:hidden` 隐藏子行行首图标（组头已有代表
 *   图标）；`gap-2` 行间距。
 * - **三种组头内容**（ZCode 条件完全一致）：
 *   1. 展开 或 组已闭合 → 图标 + 统计（纯 change 组收起时显示文件折叠摘要）；
 *   2. 收起 + 运行中 → `QueuedSummaryContent` 滚动当前项摘要（300ms 过渡 /
 *      500ms 停留，宿主已有）；
 *   3. 展开 + 运行中 + 无活动项（工具间隙）→ 统计文本扫光。
 *
 * 纯展示组件；统计/活动项/图标的选择全在 `work-summary.ts` 的纯函数里。
 */
import { useId, useState, type FC, type ReactNode } from "react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { QueuedSummaryContent } from "./queued-summary-content";

export interface ConsecutiveSummaryGroupProps {
  /** 组头统计（`已查阅 20 项，已执行 134 命令，已修改 4 文件`）。 */
  statistics: string;
  /** 代表图标（ZCode 取原工具 renderer 的图标；宿主按类别给 lucide 图标）。 */
  statisticsIcon?: ReactNode;
  /** 收起态的替代内容（纯 change 组的文件折叠摘要）。 */
  collapsedStatistics?: ReactNode;
  /** 该组是整轮尾组且轮仍在跑（ZCode `tailRowId === lastRowId && taskRunning`）。 */
  groupRunning: boolean;
  /** 当前活动项（收起态滚动的摘要节点）的内容 key——变化才翻滚。 */
  activeKey?: string;
  /** 当前活动项的摘要节点（活动项缺省 = 组内最后一项，ZCode `current = active ?? last`）。 */
  activeSummary?: ReactNode;
  children: ReactNode;
}

export const ConsecutiveSummaryGroup: FC<ConsecutiveSummaryGroupProps> = ({
  statistics,
  statisticsIcon,
  collapsedStatistics,
  groupRunning,
  activeKey,
  activeSummary,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const hasActiveItem = activeSummary !== undefined;
  // 收起 + 运行中：组头换成当前项摘要的滚动队列
  const rolling = !open && groupRunning && hasActiveItem;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="min-w-0"
      data-consecutive-summary-group
      data-group-running={groupRunning ? "1" : "0"}
    >
      <CollapsibleTrigger asChild>
        {/* 块级 flex（不是 inline-flex）：inline 的基线空隙会把统计组头抬高 */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-controls={contentId}
          aria-label={statistics}
          data-summary-group-trigger
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setOpen((value) => !value);
          }}
          className="summary-hover-text group/tool-summary flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rolling ? (
            <div className="pointer-events-none flex min-w-0 items-center">
              <QueuedSummaryContent
                contentKey={activeKey ?? ""}
                primaryText={activeSummary}
                enabled={groupRunning}
              />
            </div>
          ) : (
            <>
              <span
                data-summary-group-icon
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover/tool-summary:text-foreground [&_svg]:size-4 [&_svg]:text-current"
              >
                {statisticsIcon ?? <BrainIcon className="size-4" />}
              </span>
              <span
                data-summary-group-statistics
                title={statistics}
                className={cn(
                  "min-w-0 truncate text-muted-foreground",
                  groupRunning &&
                    !hasActiveItem &&
                    "shimmer motion-reduce:animate-none",
                )}
              >
                {open ? statistics : (collapsedStatistics ?? statistics)}
              </span>
            </>
          )}
          <ChevronRightIcon
            data-summary-chevron
            aria-hidden
            className={cn(
              // 合并写法：twMerge 会把 `transition-transform` + `transition-opacity`
              // 判为冲突只留后者（ZCode 原文是两条 class 在非 Tailwind 环境）
              "size-4 shrink-0 text-muted-foreground/60 opacity-0 transition-[opacity,transform] group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100",
              open && "rotate-90",
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        id={contentId}
        data-slot="aui_summary-group-content"
        className={cn(
          "overflow-hidden outline-none",
          "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        )}
      >
        <div
          data-summary-group-scroll
          // ZCode 原值：16 行 + 30 个 spacing（15 行内容 + 边距），超出滚动
          className="mt-2 max-h-[calc(16lh+30*var(--spacing))] overflow-y-auto text-sm"
        >
          <div
            data-conversation-work-items="group"
            // 实体边框 + 14px 内距只有 23px，子文字会偏左；导线不占布局，
            // 8px + 16px 与组头文字严格对齐（ZCode 注释原话）。
            className="relative ml-2 flex flex-col gap-2 pl-4 before:absolute before:inset-y-0 before:left-0 before:border-l before:border-border [&_[data-summary-leading-icon]]:hidden [&_[data-reasoning-content]>div>div]:pt-1"
          >
            {children}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** 纯 change 组的折叠摘要（ZCode `CollapsedChangeSummary` 的单文件形态）：
 * `已修改 <文件名> +N`。多文件/有未解析路径时返回 undefined，调用方回落到
 * 统计文本。 */
export const CollapsedChangeLabel: FC<{
  label: string;
  fileName: string;
  additions: number;
  removed: number;
}> = ({ label, fileName, additions, removed }) => (
  <span className="inline-flex min-w-0 items-center gap-1.5">
    <span className="shrink-0">{label}</span>
    <span className="min-w-0 truncate text-foreground">{fileName}</span>
    {additions > 0 ? (
      <span className="shrink-0 font-mono text-xs text-emerald-600 tabular-nums dark:text-emerald-400">
        +{additions}
      </span>
    ) : null}
    {removed > 0 ? (
      <span className="shrink-0 font-mono text-xs text-red-600 tabular-nums dark:text-red-400">
        −{removed}
      </span>
    ) : null}
  </span>
);
