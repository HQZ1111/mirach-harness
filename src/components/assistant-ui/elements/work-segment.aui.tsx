"use client";

/**
 * 工作段外壳（ZCode `ConversationWorkSegmentFlow` 外层收纳 +
 * `AssistantHistoryStatus` 的宿主版，2026-11-03；2026-11-15 按 ZCode 源码
 * 事实恢复为**两层结构的外层**）。
 *
 * ## 折叠的是什么
 *
 * 一个 turn 的**中间工作**：最后一条非空 assistant 正文之前的全部部件
 * （思考、工具、以及中间正文），正文留在折叠区外。切分在
 * `work-segment.ts::splitWorkParts`，规格来自 ZCode
 * `conversationTurnWorkSegments.ts`（`assistantHistoryRows` /
 * `assistantFollowingRows`）。
 *
 * ## 外层只有一个头，且**只有状态/时长**
 *
 * ZCode `AssistantHistoryStatus`（`ConversationTurnGroup.tsx:540-630`）：
 * - `shouldShowHistoryStatus = !turnRunning && workStatus && state !== "running"`
 *   → **运行中不建外层头**；`open = turnRunning || defaultOpen || historyOpen`
 *   → 运行中过程项始终展开，运行反馈只由轮尾 ChatLoading 承担（不出现
 *   第二个「工作中」）；
 * - 完成后：`已停止` / `已工作 {duration}` / `已处理`，`border-b pb-2`，
 *   位置在所有过程项上面；
 * - **统计不在这里**——统计属于内层连续摘要组的组头
 *   （`ConsecutiveSummaryGroup`，见 `summary-group.aui.tsx`）。
 *
 * 开合：没有最终正文 → 展开且不可收起；其余完成后默认收起，点击展开。
 */
import { useState, type FC, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  formatWorkDuration,
  workSegmentLabel,
  type WorkSegmentStatus,
} from "@/components/assistant-ui/work-segment";

export interface WorkSegmentGroupProps {
  status: WorkSegmentStatus;
  /** 折叠区外没有正文（= 强制展开且不可收起）。 */
  defaultOpen: boolean;
  /** 轮仍在跑：**不建外层头**，内容恒开。 */
  running: boolean;
  children: ReactNode;
}

export const WorkSegmentGroup: FC<WorkSegmentGroupProps> = ({
  status,
  defaultOpen,
  running,
  children,
}) => {
  const [userOpen, setUserOpen] = useState(false);
  const duration =
    status.durationMs !== undefined ? formatWorkDuration(status.durationMs) : null;
  const label = workSegmentLabel(status, duration);

  // running：外层头不渲染（ZCode shouldShowHistoryStatus），内容恒开；
  // 运行中的「工作中 + orbs + 计时」只有轮尾 ChatLoading 一处。
  if (running) {
    return (
      <div data-slot="aui_work-segment" data-work-state="running">
        {children}
      </div>
    );
  }

  const labelNode = (
    <span
      className={cn(
        "min-w-0 truncate",
        status.state === "interrupted" && "text-amber-600 dark:text-amber-400",
      )}
    >
      {label}
    </span>
  );

  const headerClassName =
    "group/history-message text-muted-foreground focus-visible:ring-ring inline-flex max-w-full items-center gap-2 text-left text-sm outline-none focus-visible:ring-2";

  // 没有最终正文：常开、不可收起（ZCode 的 assistantHistoryDefaultOpen 分支
  // 给 onOpenChange=undefined，头部退化成 span）。这里不能渲染
  // CollapsibleTrigger——没有 Collapsible 上下文时 Radix 直接抛错。
  if (defaultOpen) {
    return (
      <div data-slot="aui_work-segment" data-work-state={status.state}>
        <div className="border-border/50 flex w-full flex-wrap items-center gap-2 border-b pb-2">
          <div className={headerClassName} data-history-open="true">
            {labelNode}
          </div>
        </div>
        {/* ZCode ConversationAssistantWorkItems 的 history 容器：pt-5（20px），
            配合头部 pb-2 得到 28px 的「已工作」头→内容间距。 */}
        <div data-slot="aui_work-segment-content" className="pt-5">
          {children}
        </div>
      </div>
    );
  }

  return (
    <Collapsible
      data-slot="aui_work-segment"
      data-work-state={status.state}
      open={userOpen}
      onOpenChange={setUserOpen}
      className="flex w-full flex-col"
    >
      <div className="border-border/50 flex w-full flex-wrap items-center gap-2 border-b pb-2">
        <CollapsibleTrigger
          data-slot="aui_work-segment-trigger"
          data-history-open={String(userOpen)}
          className={headerClassName}
        >
          {labelNode}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              // ZCode 实测（9444）：chevron 16×16（size-4 在 16px 根字号下）、
              // foreground-subtlest/70、展开 rotate-90。本工程 size-4 = 15px。
              "size-[16px] shrink-0 text-muted-foreground/50 opacity-70 transition-transform",
              userOpen ? "rotate-90" : "rotate-0",
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent
        data-slot="aui_work-segment-content"
        className={cn(
          "overflow-hidden outline-none",
          "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        )}
      >
        <div className="pt-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};
