"use client";

/**
 * 工作段折叠（ZCode `ConversationWorkSegmentFlow` + `AssistantHistoryStatus`
 * 的宿主版，2026-11-03）。
 *
 * ## 为什么折叠 `group-chainOfThought`
 *
 * 宿主的分组器把 reasoning 与工具调用全部挂在 `group-chainOfThought` 下，
 * 正文 text 不分组——**这个分组就是宿主的工作段**。折叠它 = 折叠中间工作，
 * 正文自然在折叠区外，与 ZCode 的 flowItems（assistantHistory 折叠、
 * assistantText 在外）同构，且**不需要复刻分组树**（`buildGroupTree` 非包
 * 导出，AGENTS.md 明令禁止复刻）。
 *
 * ## 状态字与开合规则（ZCode 同款，纯函数在 work-segment.ts，20 条单测）
 *
 * - running → **头部不渲染**、内容展开（运行反馈在轮尾 loading 位）；
 * - completed → 头部 `已工作 N 秒`（无计时 = `已处理`），默认收起；
 * - interrupted → `已停止`；
 * - 工作段之后没有正文（本轮再无 assistant 文本）→ 默认展开。
 * - 用户手点后以用户为准（ZCode 的 historyOpen）；running 中不允许收。
 */
import { useMemo, useState, type FC, type PropsWithChildren } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  formatWorkDuration,
  resolveWorkSegmentStatus,
  turnHasTextAfter,
  workSegmentDefaultOpen,
  workSegmentLabel,
  type WorkPartLike,
} from "@/components/assistant-ui/work-segment";

export type WorkSegmentGroupProps = PropsWithChildren<{
  /** 该分组的 parts 下标（GroupPart.indices） */
  indices: readonly number[];
}>;

export const WorkSegmentGroup: FC<WorkSegmentGroupProps> = ({ indices, children }) => {
  // **selector 只取原始值**（useAuiState 契约）：status / hasTextAfter 都
  // 返回 boolean，不分配数组。`turnHasTextAfter` 直接吃 MessageState 数组
  // （结构兼容 WorkPartLike），覆盖"组后正文"的两种位置：本消息后续
  // parts、本轮后续 assistant 消息的正文（跨消息——工具在上一条、最终
  // 回答在下一条是常态）。
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const hasTextAfter = useAuiState((s) =>
    turnHasTextAfter(s.thread.messages, s.message.index, afterIndexOf(indices)),
  );
  const [userOpen, setUserOpen] = useState(false);

  const status = useMemo(
    () => resolveWorkSegmentStatus(parts as readonly WorkPartLike[], indices),
    [parts, indices],
  );
  const open = running || workSegmentDefaultOpen(hasTextAfter, running) || userOpen;
  const duration =
    status.durationMs !== undefined ? formatWorkDuration(status.durationMs) : null;

  // running：头部不渲染（ZCode shouldShowHistoryStatus），内容恒开
  if (running) {
    return <div data-slot="aui_work-segment">{children}</div>;
  }

  return (
    <Collapsible
      data-slot="aui_work-segment"
      data-work-state={status.state}
      open={open}
      onOpenChange={setUserOpen}
      className="flex w-full flex-col"
    >
      <div className="border-border/50 flex w-full flex-wrap items-center gap-2 border-b pb-1.5">
        <CollapsibleTrigger
          data-slot="aui_work-segment-trigger"
          className="text-muted-foreground focus-visible:ring-ring inline-flex max-w-full items-center gap-2 rounded text-left text-sm outline-none focus-visible:ring-2"
        >
          <span
            className={cn(
              "min-w-0 truncate",
              status.state === "interrupted" && "text-amber-600 dark:text-amber-400",
            )}
          >
            {workSegmentLabel(status, duration)}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "text-muted-foreground/70 size-[var(--size-icon-sm)] shrink-0 opacity-70 transition-transform",
              open ? "rotate-90" : "rotate-0",
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
        <div className="pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/** 组内最大下标（组已按邻接合并，indices 连续）——"组之后"的起点。 */
function afterIndexOf(indices: readonly number[]): number {
  return indices.length ? Math.max(...indices) : -1;
}
