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
import { useMemo, type FC } from "react";
import { BotIcon } from "lucide-react";
import { ToolSummary } from "./tool-summary.aui";

export interface SubagentLineProps {
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
  /** 工具实例 id（摘要行展开记忆的键）。 */
  toolId?: string;
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

export const SubagentLine: FC<SubagentLineProps> = ({ args, result, isError, running, toolId }) => {
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

  // 摘要行外壳统一走 ToolSummary（ZCode ToolLayout）：类别词「子代理」+ agent
  // 名 + 任务摘要 + 状态词；详情（工具输出）按需展开。
  return (
    <ToolSummary
      toolId={toolId ?? 'subagent'}
      toolName="subagent"
      icon={<BotIcon />}
      kindLabel="子代理"
      primaryText={`${name}${count > 1 ? ` ×${count}` : ''}`}
      secondaryText={task || undefined}
      statusLabel={isError ? '执行失败' : undefined}
      failed={isError === true}
      statusTooltip={isError ? outputText || undefined : undefined}
      running={running === true}
      canToggle={outputText.length > 0}
      title={task || name}
      content={
        <div className="border-border/60 ms-2 border-l ps-3.5">
          <pre className="text-muted-foreground max-h-80 overflow-auto py-1 font-mono text-xs whitespace-pre-wrap">
            {outputText}
          </pre>
        </div>
      }
    />
  );
};
