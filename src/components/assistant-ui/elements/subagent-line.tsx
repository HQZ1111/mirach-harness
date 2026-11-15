"use client";

/**
 * 子代理单行摘要（ZCode `ToolCallBlocks/renderers/agent.tsx` 单行形态的
 * 宿主版，2026-11-03；2026-11-15 接详情面板）。
 *
 * ZCode 的单行 = bot 图标 + "SubAgent" 标签 + agent 名 + 描述 + 状态，
 * **不可展开**——详情统一走侧栏子会话面板。宿主 2026-11-15 补了
 * 「子代理」详情页（`panes/subagent-detail-pane.tsx`，展示 task/role/
 * status/输出/名册进度；rpi 子代理是进程内 ChildAgent，没有可切换的
 * 子会话），故整行改为激活动作，不再用展开正文当唯一详情面。
 */
import { useMemo, type FC } from "react";
import { BotIcon } from "lucide-react";
import { openSubagentDetail } from "@/components/panes/subagent-detail-opener";
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
  // 名 + 任务摘要 + 状态词；整行可点 → 子代理详情页（输出/进度/报告）。
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
      canToggle={false}
      title={task || name}
      onActivate={() =>
        openSubagentDetail({
          name,
          task: task || undefined,
          status: running === true ? 'running' : isError === true ? 'failed' : 'completed',
          running: running === true,
          output: outputText || undefined,
        })
      }
      activateLabel={task ? `打开子代理详情：${task}` : `打开子代理详情：${name}`}
    />
  );
};
