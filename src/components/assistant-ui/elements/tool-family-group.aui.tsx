"use client";

/**
 * 工具族父组（ZCode `Explore` / `Execute` / `Changes` 三组的宿主版）。
 *
 * 结构照抄 ZCode `renderers/{explore,execute-group,changes-group}.tsx`：
 * 父行 = 图标 + 族名 + `·` + 摘要；展开后是带左导线的子工具列表（子项保持
 * 各自完整渲染，可独立展开）。摘要逻辑在 `tool-grouping.ts` 的纯函数里
 * （有单测）。子项失败**不**把父级标成失败——父级是阶段容器。
 */
import { useMemo, type FC, type PropsWithChildren } from "react";
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

  const summary = useMemo(() => {
    const tools: FamilyChildTool[] = [];
    for (const index of indices) {
      const part = parts[index];
      if (part?.type !== "tool-call") continue;
      tools.push({
        toolName: part.toolName,
        args: part.args,
        statusType: part.status?.type,
      });
    }
    return buildFamilySummary(family, tools, running);
  }, [family, parts, indices, running]);

  const meta = FAMILY_META[family];

  return (
    <Collapsible
      data-slot="tool-family-group"
      data-family={family}
      className="aui-tool-family-group group/family w-full"
    >
      <CollapsibleTrigger
        data-slot="tool-family-trigger"
        className="aui-tool-family-trigger group/trigger flex w-fit max-w-full origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]"
      >
        <meta.icon className="size-[var(--size-icon-md)] shrink-0 opacity-60" />
        <span
          data-slot="tool-family-label"
          className={cn(
            "shrink-0 font-medium whitespace-nowrap",
            running
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
            enabled={running}
          />
        </span>
        <ChevronRightIcon className="size-[var(--size-icon-md)] shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/trigger:opacity-100 group-data-open/trigger:rotate-90 group-data-open/trigger:opacity-100 motion-reduce:transition-none" />
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
        {/* ZCode：父组内容 = 左导线 + 子工具列表；子项不重复画图标。 */}
        <div className="border-border/60 mt-1 ms-2 flex flex-col gap-1 border-l ps-3.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
