"use client";

/**
 * 工作段折叠（ZCode `ConversationWorkSegmentFlow` + `AssistantHistoryStatus`
 * 的宿主版，2026-11-03；2026-11-15 改为「一个 turn 一个工作段」）。
 *
 * ## 折叠的是什么
 *
 * 一个 turn 的**中间工作**：最后一条非空 assistant 正文之前的全部部件
 * （思考、工具、以及中间正文），正文留在折叠区外。切分在
 * `work-segment.ts::splitWorkParts`，规格来自 ZCode
 * `conversationTurnWorkSegments.ts`（`assistantHistoryRows` /
 * `assistantFollowingRows`）。
 *
 * ## 状态字与开合规则（ZCode `AssistantHistoryStatus` 同款，纯函数在
 * `work-segment.ts`，逐条单测）
 *
 * - running → **头部不渲染**、内容展开（运行反馈在轮尾 loading 位）；
 * - completed 带时长 → `已工作 N 分 M 秒`；无时长 → `已处理`；
 * - interrupted → `已停止`；
 * - **没有最终正文**（折叠区外空着）→ 默认展开且不可收起；
 * - 有最终正文 → 默认收起，头部带 chevron（hover/点击展开）。
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
  /** 折叠区外没有正文（= 全折叠且默认展开，且不可收起）。 */
  defaultOpen: boolean;
  /** 轮仍在跑（头部不渲染）。 */
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

  // running：头部不渲染（ZCode shouldShowHistoryStatus），内容恒开
  if (running) {
    return (
      <div data-slot="aui_work-segment" data-work-state="running">
        {children}
      </div>
    );
  }

  const header = (
    <div className="border-border/50 flex w-full flex-wrap items-center gap-2 border-b pb-2">
      <CollapsibleTrigger
        data-slot="aui_work-segment-trigger"
        data-history-open={String(defaultOpen || userOpen)}
        disabled={defaultOpen}
        className="group/history-message text-muted-foreground focus-visible:ring-ring inline-flex max-w-full items-center gap-2 text-left text-sm outline-none focus-visible:ring-2"
      >
        <span
          className={cn(
            "min-w-0 truncate",
            status.state === "interrupted" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {label}
        </span>
        {defaultOpen ? null : (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 opacity-70 transition-transform",
              userOpen ? "rotate-90" : "rotate-0",
            )}
          />
        )}
      </CollapsibleTrigger>
    </div>
  );

  // 没有最终正文：常开、不可收起（ZCode 的 assistantHistoryDefaultOpen 分支
  // 给 onOpenChange=undefined，头部退化成 span）。
  if (defaultOpen) {
    return (
      <div data-slot="aui_work-segment" data-work-state={status.state}>
        {header}
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
      {header}
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
