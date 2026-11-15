"use client";

/**
 * 工具族父组（ZCode `Explore` / `Execute` / `Changes` 三组的宿主版）。
 *
 * 结构照抄 ZCode `renderers/{explore,execute-group,changes-group}.tsx`：
 * 父行 = 图标 + 族名 + `·` + 摘要；展开后是带左导线的子工具列表（子项保持
 * 各自完整渲染，可独立展开）。摘要逻辑在 `tool-grouping.ts` 的纯函数里
 * （有单测）。子项失败**不**把父级标成失败——父级是阶段容器。
 */
import { useMemo, useState, type FC, type PropsWithChildren } from "react";
import {
  ChevronRightIcon,
  FilePenIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  buildFamilySummary,
  type FamilyChildTool,
  type ToolFamily,
} from "@/components/assistant-ui/tool-grouping";
import { QueuedSummaryContent } from "./queued-summary-content";

const FAMILY_META: Record<
  Exclude<ToolFamily, "other">,
  { label: string; icon: FC<{ className?: string }> }
> = {
  explore: { label: "查阅", icon: SearchIcon },
  execute: { label: "终端", icon: SquareTerminalIcon },
  changes: { label: "更改", icon: FilePenIcon },
};

export type ToolFamilyGroupProps = PropsWithChildren<{
  family: Exclude<ToolFamily, "other">;
  indices: readonly number[];
  /** 组内是否仍有运行中的子工具（宿主没有 segment，退化用子状态）。 */
  running: boolean;
}>;

export const ToolFamilyGroup: FC<ToolFamilyGroupProps> = ({
  family,
  indices,
  running,
  children,
}) => {
  const parts = useAuiState((s) => s.message.parts);
  // ZCode ConsecutiveSummaryGroup：**收起且进行中**才滚动显示最新子动作；
  // 展开或已结束显示统计（`open ? statistics : …`）。展开时统计用「完成态」
  // 口径（N 个命令 / N 个文件）——进行中展开看到的是「已进行到哪」，
  // 不是进行中的单条动作。
  const [open, setOpen] = useState(false);

  const tools = useMemo(() => {
    const out: FamilyChildTool[] = [];
    for (const index of indices) {
      const part = parts[index];
      if (part?.type !== "tool-call") continue;
      out.push({
        toolName: part.toolName,
        args: part.args,
        statusType: part.status?.type,
      });
    }
    return out;
  }, [parts, indices]);

  const summary = useMemo(
    () => buildFamilySummary(family, tools, running && !open),
    [family, tools, running, open],
  );

  const meta = FAMILY_META[family];

  return (
    <Collapsible
      data-slot="tool-family-group"
      data-family={family}
      data-group-running={running ? "1" : "0"}
      open={open}
      onOpenChange={setOpen}
      className="aui-tool-family-group group/family w-full"
    >
      <CollapsibleTrigger
        data-slot="tool-family-trigger"
        className="aui-tool-family-trigger group/trigger flex w-fit max-w-full origin-left items-center gap-2 self-start text-sm transition-[color] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <meta.icon className="text-muted-foreground group-hover/trigger:text-foreground size-[var(--size-icon-md)] shrink-0" />
        <span
          data-slot="tool-family-label"
          className={cn(
            "shrink-0 font-normal whitespace-nowrap",
            running && !open
              ? "shimmer motion-reduce:animate-none"
              : "text-muted-foreground",
          )}
        >
          {meta.label}
        </span>
        <span className="text-muted-foreground/60 shrink-0">·</span>
        <span className="text-muted-foreground/80 min-w-0 flex-1 overflow-hidden text-start whitespace-nowrap">
          <QueuedSummaryContent
            contentKey={summary.key}
            contentRefreshVersion={summary.text}
            primaryText={
              <span className="inline-block min-w-max">{summary.text}</span>
            }
            enabled={running && !open}
          />
        </span>
        <ChevronRightIcon
          aria-hidden
          className="text-muted-foreground/60 size-[var(--size-icon-md)] shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/trigger:opacity-100 group-data-open/trigger:rotate-90 group-data-open/trigger:opacity-100 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="tool-family-content"
        className={cn(
          "aui-tool-family-content overflow-hidden outline-none",
          "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        )}
      >
        {/* ZCode：父组内容 = 左导线 + 子工具列表；组内子项**不重复画图标**
            （`[&_[data-summary-leading-icon]]:hidden`），内容限高可滚
            （`max-h-[calc(16lh+30*var(--spacing))]` → 16 行 + 间距）。 */}
        <div
          data-slot="tool-family-children"
          className={cn(
            "border-border/60 mt-2 ml-2 flex max-h-[calc(16lh+7.5rem)] flex-col gap-2 overflow-y-auto border-l pl-4",
            "[&_[data-summary-leading-icon]]:hidden",
          )}
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
