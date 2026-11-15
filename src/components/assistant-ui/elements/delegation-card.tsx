"use client";

/**
 * 子代理内联卡（ZCode 风格的对话区委托卡，2026-11-15）。
 *
 * 数据来源 = 工具结果里的 **rpi-delegation** JSON（rpi-subagents 的
 * `delegate_task`，orchestrator 的 `subagent` / `dispatch` 同类结果）：
 * 工具结果是 ToolOutput，真正的 payload 在 `content[0].text` 里、需要二次
 * JSON.parse（实测形状，见 docs/HANDOFF.md 之前的实证）：
 *
 * ```json
 * {"kind":"rpi-delegation","task":"…","role":"worker","maxTurns":2,
 *  "timeoutSeconds":300,"childId":"…","sessionId":"…","status":"completed",
 *  "turns":1,"turnLimited":false,"report":"2"}
 * ```
 *
 * **只解析真实 JSON**：形状不吻合（无 kind / 非对象 / parse 失败）时
 * `parseDelegationResult` 返回 null，调用方照常渲染通用工具卡——不编造
 * 字段、不假装有 report。
 *
 * 「查看子会话」只在**当前会话目录里有这个 sessionId** 时出现（本机
 * switchToThread 的入口要求 path 来自会话目录，子会话不在目录里就打不开
 * ——那就不放按钮，只显示 sessionId 文本，见注释）。
 */
import { useState, type FC } from "react";
import { useStore } from "zustand";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  sessionCatalog,
} from "@/components/panes/session-manage/session-catalog";
import { switchSessionThreadBridge } from "@/components/panes/session-manage/session-tab-bridge";
import { openSubagentDetail } from "@/components/panes/subagent-detail-opener";

export interface DelegationResult {
  kind: string;
  task: string | null;
  role: string | null;
  status: string | null;
  turns: number | null;
  maxTurns: number | null;
  turnLimited: boolean;
  timeoutSeconds: number | null;
  report: string | null;
  sessionId: string | null;
  childId: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** ToolOutput（`{content: blocks}`）→ 文本；其余形状原样返回 null。 */
function toolOutputText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  return content
    .map((b) =>
      typeof b === "string"
        ? b
        : typeof (b as { text?: unknown })?.text === "string"
          ? (b as { text: string }).text
          : "",
    )
    .join("");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 严格解析委托结果。命中条件（二者之一）：
 * 1. `kind` 是字符串且以 `-delegation` 结尾（rpi-delegation 及同类前缀）；
 * 2. 没有 kind 但 `childId`/`sessionId` + `status` 同时存在（orchestrator
 *    的近似形状）——要求 `report` 或 `task` 至少一个字符串，避免把无关的
 *    JSON 误判成委托。
 */
export function parseDelegationResult(result: unknown): DelegationResult | null {
  const text = toolOutputText(result);
  let object: Record<string, unknown> | null = text !== null ? parseJsonObject(text) : null;
  // ToolOutput 之外的直接对象（水合路径可能已经把 payload 解析好）
  if (
    object === null &&
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    !Array.isArray((result as { content?: unknown }).content)
  ) {
    object = result as Record<string, unknown>;
  }
  if (object === null) return null;

  const kind = str(object.kind);
  const isDelegationKind = kind !== null && /-delegation$/.test(kind);
  const hasIdentity =
    (str(object.childId) !== null || str(object.sessionId) !== null) &&
    str(object.status) !== null &&
    (str(object.report) !== null || str(object.task) !== null);
  if (!isDelegationKind && !hasIdentity) return null;

  return {
    kind: kind ?? "rpi-delegation",
    task: str(object.task),
    role: str(object.role),
    status: str(object.status),
    turns: num(object.turns),
    maxTurns: num(object.maxTurns),
    turnLimited: object.turnLimited === true,
    timeoutSeconds: num(object.timeoutSeconds),
    report: str(object.report),
    sessionId: str(object.sessionId),
    childId: str(object.childId),
  };
}

/** 状态文案：已知状态给中文，未知原样显示（不猜测）。 */
const STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  starting: "启动中",
  completed: "已完成",
  done: "已完成",
  failed: "失败",
  error: "失败",
  timeout: "超时",
  timedOut: "超时",
  cancelled: "已取消",
  killed: "已终止",
};

const statusText = (status: string): string => STATUS_TEXT[status] ?? status;

const STATUS_TONE: Record<string, string> = {
  completed: "text-emerald-600 dark:text-emerald-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-rose-600 dark:text-rose-400",
  error: "text-rose-600 dark:text-rose-400",
  timeout: "text-amber-600 dark:text-amber-400",
  timedOut: "text-amber-600 dark:text-amber-400",
  cancelled: "text-foreground/45",
  killed: "text-foreground/45",
};

export interface DelegationCardProps {
  result: DelegationResult;
  /** 工具调用仍在运行（结果可能只是部分/尚未落定）。 */
  running?: boolean;
}

export const DelegationCard: FC<DelegationCardProps> = ({ result, running }) => {
  const [open, setOpen] = useState(true);
  const sessionId = result.sessionId;
  // 只有会话目录里真有这个线程时才能打开（switchToThread 需要 catalog 的
  // path）。子会话不在目录里 → 不渲染按钮，只显示 id 文本。
  const sessionKnown = useStore(sessionCatalog, (s) =>
    sessionId !== null ? s.entries[sessionId] !== undefined : false,
  );

  const status = result.status;
  const isRunning = running === true || status === "running" || status === "starting";
  const hasReport = result.report !== null && result.report.length > 0;

  return (
    <article
      data-slot="aui_delegation-card"
      data-status={status ?? (isRunning ? "running" : "completed")}
      data-turn-limited={result.turnLimited ? "true" : undefined}
      className="border-border/60 bg-card/40 w-full max-w-none rounded-2xl border px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="bg-foreground/[0.06] flex size-6 shrink-0 items-center justify-center rounded-md">
          <BotIcon className="text-muted-foreground size-[var(--size-icon-sm)] opacity-80" />
        </span>
        <span className="text-foreground shrink-0 text-[13px] font-medium">子代理</span>
        {result.role !== null ? (
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{result.role}</span>
        ) : null}
        <span
          data-slot="aui_delegation-status"
          className={cn(
            "ml-auto shrink-0 text-[11px]",
            isRunning
              ? "shimmer motion-reduce:animate-none text-foreground/70"
              : (STATUS_TONE[status ?? ""] ?? "text-foreground/55"),
          )}
        >
          {isRunning ? "运行中" : status !== null ? statusText(status) : ""}
        </span>
      </div>

      {result.task !== null ? (
        <p className="text-foreground/80 mt-1.5 line-clamp-3 text-[13px] leading-5">{result.task}</p>
      ) : null}

      <div className="text-muted-foreground/70 mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        {result.turns !== null ? (
          <span className="tabular-nums">
            轮次 {result.turns}
            {result.maxTurns !== null ? `/${result.maxTurns}` : ""}
          </span>
        ) : null}
        {result.turnLimited ? (
          <span className="text-amber-600 dark:text-amber-400">达到轮次上限</span>
        ) : null}
        {result.timeoutSeconds !== null ? (
          <span className="tabular-nums">时限 {result.timeoutSeconds}s</span>
        ) : null}
        {sessionId !== null ? (
          <span className="truncate font-mono" title={sessionId}>
            会话 {sessionId}
          </span>
        ) : null}
      </div>

      {hasReport ? (
        <Collapsible
          data-slot="aui_delegation-report"
          open={open}
          onOpenChange={setOpen}
          className="mt-1.5 border-t border-foreground/[0.06] pt-1.5"
        >
          <CollapsibleTrigger
            data-slot="aui_delegation-report-trigger"
            className="text-foreground/55 hover:text-foreground/80 flex w-fit max-w-full items-center gap-1 text-[12px] transition-colors"
          >
            <ChevronRightIcon
              className={cn(
                "size-[var(--size-icon-sm)] shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            子代理报告
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="text-foreground/75 mt-1 max-h-80 overflow-auto font-mono text-[11px] leading-4 whitespace-pre-wrap break-words">
              {result.report}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          data-slot="aui_delegation-detail"
          onClick={() =>
            openSubagentDetail({
              name: "子代理",
              ...(result.role !== null ? { role: result.role } : {}),
              ...(result.task !== null ? { task: result.task } : {}),
              ...(result.status !== null ? { status: result.status } : {}),
              running: isRunning,
              ...(result.report !== null ? { report: result.report } : {}),
              turns: result.turns,
              maxTurns: result.maxTurns,
              turnLimited: result.turnLimited,
              timeoutSeconds: result.timeoutSeconds,
              childId: result.childId,
              sessionId: result.sessionId,
            })
          }
          className="text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/90 flex h-6 items-center rounded-full px-2 text-[11px] transition-colors"
        >
          子代理详情
        </button>
        {sessionKnown && sessionId !== null ? (
          <button
            type="button"
            data-slot="aui_delegation-open"
            onClick={() => switchSessionThreadBridge(sessionId)}
            className="text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/90 flex h-6 items-center rounded-full px-2 text-[11px] transition-colors"
          >
            查看子会话
          </button>
        ) : null}
      </div>
    </article>
  );
};
