"use client";

/**
 * 子代理单行摘要（ZCode `ToolCallBlocks/renderers/agent.tsx` 单行形态的
 * 宿主版，2026-11-03）。
 *
 * ZCode 的单行 = bot 图标 + "SubAgent" 标签 + agent 名 + 描述 + 状态，
 * **不可展开**——详情统一走它的侧栏子会话面板。宿主没有子会话侧栏
 * （下钻面不存在，不放假入口），所以本组件 = ZCode 的单行 + **可展开看
 * 工具输出**（宿主唯一详情面）。pi 的 `subagent` 工具输入是
 * `{agent, task}` 单委托或 `{tasks[]|chain[]}` 多任务（subagents.rs:544）。
 */
import { useMemo, useState, type FC } from "react";
import { ChevronRightIcon, BotIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface SubagentLineProps {
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
}

/** 单行主文本（ZCode getAgentPrimaryText 的宿主口径：agent 名 + 任务摘要）。
 * 纯函数，可单测。 */
export function subagentLineText(args: Record<string, unknown> | undefined): {
  name: string;
  task: string;
  count: number;
} {
  const name =
    typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : '';
  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  const list = Array.isArray(args?.tasks) ? args.tasks : Array.isArray(args?.chain) ? args.chain : [];
  const count = Math.max(list.length, 1);
  return { name: name || '子代理', task, count };
}

export const SubagentLine: FC<SubagentLineProps> = ({ args, result, isError, running }) => {
  const [open, setOpen] = useState(false);
  const { name, task, count } = useMemo(() => subagentLineText(args), [args]);
  const outputText = useMemo(() => {
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    try {
      const content = (result as { content?: unknown }).content;
      if (Array.isArray(content)) {
        return content
          .map((b) =>
            typeof b === 'string'
              ? b
              : typeof (b as { text?: unknown })?.text === 'string'
                ? (b as { text: string }).text
                : '',
          )
          .join('');
      }
      return JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      return String(result);
    }
  }, [result]);

  return (
    <Collapsible
      data-slot="aui_subagent-line"
      data-state={isError ? 'error' : running ? 'running' : 'done'}
      open={open}
      onOpenChange={setOpen}
      className="w-full"
    >
      <CollapsibleTrigger
        data-slot="aui_subagent-trigger"
        className="group/trigger flex w-fit max-w-full items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]"
      >
        <BotIcon className="text-muted-foreground size-[var(--size-icon-md)] shrink-0 opacity-60" />
        <span className="text-muted-foreground shrink-0 font-medium whitespace-nowrap">子代理</span>
        <span
          className={cn(
            'shrink-0 font-mono text-xs',
            running ? 'shimmer motion-reduce:animate-none' : 'text-foreground/80',
          )}
        >
          {name}
          {count > 1 ? ` ×${count}` : ''}
        </span>
        {task ? (
          <>
            <span className="text-muted-foreground/60 shrink-0">·</span>
            <span className="text-muted-foreground/80 min-w-0 flex-1 truncate text-start">
              {task}
            </span>
          </>
        ) : null}
        {isError ? <span className="shrink-0 text-xs text-red-500">失败</span> : null}
        {!running && !isError && outputText ? (
          <ChevronRightIcon className="text-muted-foreground/70 size-[var(--size-icon-sm)] shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/trigger:opacity-100 group-data-open/trigger:rotate-90 group-data-open/trigger:opacity-100 motion-reduce:transition-none" />
        ) : null}
      </CollapsibleTrigger>
      {!running && outputText ? (
        <CollapsibleContent
          data-slot="aui_subagent-content"
          className={cn(
            'overflow-hidden outline-none',
            'group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
            'data-closed:animate-collapsible-up data-open:animate-collapsible-down',
            'data-closed:fill-mode-forwards data-closed:pointer-events-none',
          )}
        >
          <div className="border-border/60 mt-1 ms-2 border-l ps-3.5">
            <pre className="text-muted-foreground max-h-80 overflow-auto py-1 font-mono text-xs whitespace-pre-wrap">
              {outputText}
            </pre>
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
};
