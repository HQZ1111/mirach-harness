"use client";

/**
 * 连续摘要组（ZCode `ToolCallBlocks/ToolSummaryRow.tsx::ConsecutiveSummaryGroup`
 * 的宿主移植，2026-11-15；2026-11-15 复核：这是**内层**组头）。
 *
 * ## 两层结构里的位置
 *
 * - 外层（每 turn 一个）：`work-segment.aui.tsx` 的 `WorkSegmentGroup`，
 *   只有状态/时长，运行中不建头；
 * - 内层（每个连续摘要运行段一个）：本组件，统计只在这里。
 *   `work-parts.aui.tsx::SummaryRunView` 按 `buildWorkSummaryItems` 的
 *   `rows` 分段建组；<2 行直接平铺；正文/子代理/未归类工具是边界。
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
 *   1. 展开 或 组已闭合 → 图标 + 统计（纯 change 组收起时显示文件折叠摘要，
 *      单文件 chip 可点 → 代码查看器）；
 *   2. 收起 + 运行中（仅整轮尾组）→ `QueuedSummaryContent` 滚动当前项摘要
 *      （300ms 过渡 / 500ms 停留，宿主已有）；
 *   3. 展开 + 运行中 + 无活动项（工具间隙）→ 统计文本扫光。
 *
 * 纯展示组件；统计/活动项/图标的选择全在 `work-summary.ts` 的纯函数里。
 */
import { useEffect, useId, useRef, useState, type FC, type ReactNode } from "react";
import { useScrollLock } from "@assistant-ui/react";
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
  /** 初始展开态。ZCode 默认收起；宿主在**非运行态**默认展开——否则组内
   *  思考/正文全被收起藏掉（用户 2026-11-15："思考也不见了"），而运行态
   *  仍保持收起，让尾组头滚动当前项。 */
  defaultOpen?: boolean;
  /** 该组是整轮尾组且轮仍在跑（ZCode `tailRowId === lastRowId && taskRunning`）。 */
  groupRunning: boolean;
  /** 组内是否有**活动项**（流式思考 / 运行中工具）。ZCode 的
   *  `getActiveAssistantSummaryItem(...) !== undefined`：展开 + 运行 + 无活动项
   *  时统计文本扫光（工具间隙），与"有活动项"是两种不同形态——不能用
   *  `activeSummary` 是否存在代替（收起头始终有 `current = active ?? last`）。 */
  hasActiveItem?: boolean;
  /** 当前活动项（收起态滚动的摘要节点）的内容 key——变化才翻滚。 */
  activeKey?: string;
  /** 当前活动项的内容版本（同一 key 内流式更新/状态变化原位刷新）。 */
  activeRefreshVersion?: unknown;
  /** 当前活动项的摘要节点（活动项缺省 = 组内最后一项，ZCode `current = active ?? last`）。 */
  activeSummary?: ReactNode;
  children: ReactNode;
}

export const ConsecutiveSummaryGroup: FC<ConsecutiveSummaryGroupProps> = ({
  statistics,
  statisticsIcon,
  collapsedStatistics,
  defaultOpen = false,
  groupRunning,
  hasActiveItem,
  activeKey,
  activeRefreshVersion,
  activeSummary,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const prevDefaultOpenRef = useRef(defaultOpen);
  // 折叠/展开时锁住 thread viewport：内容高度变化会让自动跟随滚动跳一下，
  // 和动画叠在一起就是"闪烁一下"。与 reasoning 的 disclosure 同一机制。
  const lockScroll = useScrollLock(rootRef, 240);
  // 运行中展开、完成后收起（ZCode 实测：流式时组头 + 行都在，收尾后只剩
  // 一行总统计）。不能只靠初始 state——同一实例跨 running→completed 时
  // 必须跟随一次，否则会停在上一种形态。
  useEffect(() => {
    // 只有 defaultOpen 真的翻转（运行结束自动收起）才锁滚动；初次挂载不锁，
    // 否则会话水合时每个组都会锁 240ms，把自动滚动卡住。
    if (prevDefaultOpenRef.current !== defaultOpen) {
      prevDefaultOpenRef.current = defaultOpen;
      lockScroll();
    }
    setOpen(defaultOpen);
  }, [defaultOpen, lockScroll]);
  // 收起动画期间先保留统计文本，动画结束后再切“滚动当前项”。否则点收起
  // 的同一帧里 header 从统计瞬间换成滚动内容，看起来会闪一下（用户实报）。
  const [rollingReady, setRollingReady] = useState(!open);
  useEffect(() => {
    if (open) {
      setRollingReady(false);
      return;
    }
    // 折叠内容动画 = 0.2s（tw-animate-css collapsible-up 默认）；留 40ms
    // 余量再切滚动头，避免动画尾帧与头内容交换撞在一起（闪烁）。
    const timer = window.setTimeout(() => setRollingReady(true), 240);
    return () => window.clearTimeout(timer);
  }, [open]);
  const contentId = useId();
  // ZCode：`current = active ?? last`——收起头永远有可滚动内容，故滚动与否
  // 只由「尾组 + 收起」决定；`hasActiveItem` 只控制展开态的统计扫光。
  const rolling =
    rollingReady && !open && groupRunning && activeSummary !== undefined;
  const activePresent = hasActiveItem ?? (activeSummary !== undefined);

  return (
    <div ref={rootRef} className="min-w-0">
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        lockScroll();
        setOpen(next);
      }}
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
            lockScroll();
            setOpen((value) => !value);
          }}
          className="summary-hover-text group/tool-summary flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rolling ? (
            <div
              className="pointer-events-none flex min-w-0 items-center [&_button]:pointer-events-none"
              inert
            >
              <QueuedSummaryContent
                contentKey={activeKey ?? ""}
                contentRefreshVersion={activeRefreshVersion}
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
                    !activePresent &&
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
    </div>
  );
};

/** 纯 change 组的折叠摘要（ZCode `CollapsedChangeSummary` 的单文件形态）：
 * `已修改 <文件名> +N`。多文件/有未解析路径时返回 undefined，调用方回落到
 * 统计文本。
 *
 * `onOpen`（2026-11-15 补）：文件 chip 可点，打开代码查看器面板
 * （`openFileFromToolPath` → preview 面板）；缺省保持纯文本。 */
export const CollapsedChangeLabel: FC<{
  label: string;
  fileName: string;
  additions: number;
  removed: number;
  onOpen?: () => void;
}> = ({ label, fileName, additions, removed, onOpen }) => {
  const body = (
    <>
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
    </>
  );
  if (!onOpen) {
    return <span className="inline-flex min-w-0 items-center gap-1.5">{body}</span>;
  }
  return (
    <button
      type="button"
      data-slot="aui_collapsed-change"
      onClick={(event) => {
        // 组头本身也是 trigger；点文件 chip 只开文件，不展开/收起组。
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className="hover:text-foreground inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors"
      title={`打开 ${fileName}`}
    >
      {body}
    </button>
  );
};
