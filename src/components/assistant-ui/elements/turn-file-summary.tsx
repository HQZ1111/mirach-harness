"use client";

/**
 * 轮尾文件变更汇总（ZCode `ConversationFileSummaryPanel` 的宿主版，
 * 2026-11-03）。
 *
 * ZCode 原文形态（`ConversationFileSummaryPanel.tsx:238-284` 折叠头）：
 * ```
 * <div className="flex h-10 items-center justify-between gap-3 px-2 hover:bg-hover">
 *   <button>
 *     <ChevronRightIcon className={open ? "rotate-90" : "rotate-0"} />
 *     <span className="truncate font-medium">{filesChangedLabel}</span>
 *     <span className="shrink-0 tabular-nums">
 *       <span className="text-diff-added">+{additions}</span> <span className="text-diff-removed">-{deletions}</span>
 *     </span>
 * ```
 * 展开体 = 逐文件行（文件名 + +/- 计数）。
 *
 * ## 与 ZCode 的两处有意差异
 *
 * 1. **无撤销按钮**：ZCode 的 rewind 走它的 file-rewind 协议面；pi 没有
 *    文件级回滚（宿主的回滚是 checkpoint/rewind 整轮语义，不在这里）。
 *    不渲染假按钮。
 * 2. **行数可能缺**：`write` 工具无 diff（tools.rs 实锤），该文件不计
 *    +/- 但计文件数；全部无 diff 时头部不显示 +/- 段。**不造 0。**
 *
 * 数据面 = `turn-file-changes.ts` 纯函数（从本 turn 的 tool-call 部件现场
 * 聚合，有 11 条单测）。挂点 = 轮尾 assistant 消息的操作条**之前**
 * （ZCode 的明确排序理由：summary 在 bar 前面，读起来 summary 才是本轮
 * 收尾）。
 */
import { useMemo, useState, type FC } from "react";
import { FileDiffIcon } from "lucide-react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  summarizeFileChangeTotals,
  summarizeTurnFileChanges,
} from "@/components/assistant-ui/turn-file-changes";

export const TurnFileSummary: FC = () => {
  const aui = useAui();
  // **selector 必须返回原始值**（useAuiState 契约：返回新数组/对象 = 每帧
  // 都"变了" → 无限重渲染，AGENTS.md 已有这条教训）。这里返回本 turn 的
  // 工具签名串：工具名 + 状态 + 结果是否落地。结果落地（status 迁移 +
  // result 出现）签名才变 → useMemo 重算聚合。真正的部件数组经
  // getState() 现取。
  const turnToolSig = useAuiState((s) => {
    const msgs = s.thread.messages;
    let sig = "";
    for (let i = s.message.index; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role === "user") break;
      for (const p of m.parts) {
        if (p.type !== "tool-call") continue;
        sig += `${p.toolName ?? ""}|${p.status?.type ?? ""}|${p.result === undefined ? "u" : "r"};`;
      }
    }
    return sig;
  });

  const parts = useMemo(() => {
    void turnToolSig; // 签名变化 = turn 的工具集合变了 → 重算
    const msgs = aui.thread.getState().messages;
    const idx = aui.message.getState().index;
    const collected: {
      type: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
    }[] = [];
    for (let i = idx; i >= 0; i--) {
      const m = msgs[i];
      if (!m) break;
      if (m.role === "user") break;
      for (const p of m.parts) {
        if (p.type === "tool-call") {
          collected.push({
            type: p.type,
            toolName: p.toolName,
            args: p.args,
            result: p.result,
          });
        }
      }
    }
    return collected;
  }, [aui, turnToolSig]);

  const changes = useMemo(() => summarizeTurnFileChanges(parts), [parts]);
  const totals = useMemo(() => summarizeFileChangeTotals(changes), [changes]);
  const [open, setOpen] = useState(false);

  if (totals.files === 0) return null;

  return (
    <Collapsible
      data-slot="aui_turn-file-summary"
      data-file-count={totals.files}
      open={open}
      onOpenChange={setOpen}
      className="mt-[20px] w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <CollapsibleTrigger
        data-slot="aui_turn-file-summary-trigger"
        className="hover:bg-(--hover-wash) flex h-[40px] w-full min-w-0 items-center gap-2 px-2 text-left text-[14px] transition-colors"
      >
        {/* ZCode 实测（9444）：卡片头 40 高、bg-card、左侧 file-diff 图标
            （不是 chevron）、14px 文本、+/- 与标题同一行。 */}
        <FileDiffIcon
          aria-hidden
          className="text-muted-foreground size-[14px] shrink-0"
        />
        <span className="text-foreground min-w-0 truncate font-medium">
          {totals.files} 个文件已更改
        </span>
        {totals.additions !== null || totals.deletions !== null ? (
          <span className="ms-auto shrink-0 tabular-nums">
            {totals.additions !== null && (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{totals.additions}
              </span>
            )}
            {totals.additions !== null && totals.deletions !== null && " "}
            {totals.deletions !== null && (
              <span className="text-rose-600 dark:text-rose-400">-{totals.deletions}</span>
            )}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="aui_turn-file-summary-content"
        className={cn(
          "overflow-hidden outline-none",
          "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        )}
      >
        <div className="border-border/70 grid w-full border-t">
          {changes.map((c) => (
            <div
              key={c.path}
              data-slot="aui_turn-file-summary-row"
              data-path={c.path}
              className="bg-muted/20 flex w-full items-center gap-2 px-2.5 py-1.5 text-xs"
            >
              <span className="text-foreground min-w-0 truncate font-mono" title={c.path}>
                {c.path}
              </span>
              <span className="text-muted-foreground/60 ms-auto shrink-0">
                {c.toolNames.join(" · ")}
              </span>
              <span className="w-20 shrink-0 text-end font-mono tabular-nums">
                {c.additions !== null && (
                  <span className="text-emerald-600 dark:text-emerald-400">+{c.additions}</span>
                )}
                {c.additions !== null && c.deletions !== null && " "}
                {c.deletions !== null && (
                  <span className="text-rose-600 dark:text-rose-400">-{c.deletions}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
