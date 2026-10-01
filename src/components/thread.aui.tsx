"use client";

import { ComposerWired } from '@/components/panes/hermes-sidebar/composer-wired'
import { ApprovalCards } from '@/components/assistant-ui/approval-cards'
import {
  branchBridge,
  toBranchPickerView,
} from "@/components/assistant-ui/branch-store";
import {
  useConnectionBridge,
  useConnectionPhase,
} from "@/components/assistant-ui/connection-store";
import { useErrorBridge } from "@/components/assistant-ui/error-bridge";
import { useUsageBridge } from "@/components/assistant-ui/usage-bridge";
import { EmptyState, EmptyStateComposer, EmptyStateGreeting, EmptyStateSuggestion, EmptyStateSuggestions } from "@/components/assistant-ui/elements/empty-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { ConnectionState } from "@/components/assistant-ui/elements/connection-state";
import { MessageActions, type Reaction } from "@/components/assistant-ui/elements/message-actions";
import { MessageBranches } from "@/components/assistant-ui/elements/message-branches";
import { MessageTiming, type TimingStat } from "@/components/assistant-ui/elements/message-timing";
import { StoppedRun } from "@/components/assistant-ui/elements/stopped-run";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import { ToolError } from "@/components/assistant-ui/elements/tool-error";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { WebSearch, type WebSearchResult } from "@/components/assistant-ui/elements/web-search";
import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { File } from "@/components/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/image";
import { MarkdownText } from "@/components/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ThreadThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator.aui";import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  GitBranchIcon,
  MicIcon,
  PencilIcon,
  PhoneIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";
import { useStore } from "zustand";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
};

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

type ThreadGroupKey =
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1],
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === "tool-call" &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

// SSE 连接态横幅（L1 可见性，官方 connection-state 元素四相）：connecting
// （首连之前）不渲染——启动瞬间不误报（既有语义）；reconnecting 带 attempt
// 计数；dropped（浏览器放弃自动重连）提供手动 Reconnect。样式只用令牌
// （覆盖模板的 max-w-sm/rounded-2xl，铺满顶部条）。
const ConnectionBanner: FC = () => {
  const phase = useConnectionPhase();
  const { reconnectAttempts, requestReconnect } = useConnectionBridge();
  if (phase === "online" || phase === "connecting") return null;
  return (
    <ConnectionState
      data-slot="aui_connection-banner"
      phase={phase}
      attempt={phase === "reconnecting" ? reconnectAttempts : undefined}
      onRetry={phase === "dropped" ? requestReconnect : undefined}
      className="w-full max-w-none rounded-none border-x-0 border-t-0"
    />
  );
};

// ── runtime adapter state 通道（runtime.tsx state: {compaction, interrupted}）
// 的严格解析：形状不符整体丢弃 + console.error 可见（渲染选择非吞错）。
type TurnStateProjection = {
  compaction?: {
    phase?: unknown;
    reason?: unknown;
    tokensBefore?: unknown;
    tokensAfter?: unknown;
    aborted?: unknown;
    errorMessage?: unknown;
  } | null;
  interrupted?: unknown;
};

const parseTurnState = (raw: unknown): TurnStateProjection | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as TurnStateProjection;
};

// 压缩横幅（官方 guardrail-notice 元素，挂 thread 顶部）：CUSTOM
// name=compaction 经轮次机归约进 context.compaction → adapter state 到达。
// explanation = reason 或 tokensBefore→tokensAfter；errorMessage 红字独立
// 行（模板无该槽位，宿主补一行 destructive 文本）。start 相标题“压缩中”。
const CompactionBanner: FC = () => {
  const raw = useAuiState((s) => s.thread.state);
  const st = parseTurnState(raw);
  const c = st?.compaction;
  if (
    !c ||
    (c.phase !== "start" && c.phase !== "end")
  ) {
    if (c) console.error("[aui] compaction 投影形状非法——横幅不渲染", c);
    return null;
  }
  const explanationParts: string[] = [];
  if (typeof c.reason === "string" && c.reason) {
    explanationParts.push(c.reason);
  } else if (
    typeof c.tokensBefore === "number" &&
    typeof c.tokensAfter === "number"
  ) {
    explanationParts.push(`${c.tokensBefore} → ${c.tokensAfter} tokens`);
  }
  const explanation =
    explanationParts.join(" · ") || "对话上下文已自动压缩，较早的内容已摘要收拢。";
  const errorMessage =
    typeof c.errorMessage === "string" && c.errorMessage ? c.errorMessage : null;
  return (
    <div
      data-slot="aui_compaction-banner"
      className="flex w-full flex-col gap-1 pt-2"
    >
      <GuardrailNotice
        title={c.phase === "start" ? "上下文压缩中" : "上下文已压缩"}
        explanation={explanation}
        policy="compaction"
        alternatives={[]}
        className="w-full max-w-none"
      />
      {errorMessage && (
        <p className="text-destructive px-1 text-xs">{errorMessage}</p>
      )}
    </div>
  );
};

// 分支切换条（官方 message-branches 模板，挂消息区顶部——CompactionBanner
// 上方）：数据 = branch store 投影（pi_list_sibling_branches，真相在 pi），
// null（无分支/无活动会话/拉取失败）不渲染。挂载 + refreshSeq 信号时拉取
// （runtime 的 onReload/onEdit/fork/switch_branch/会话切换/run 收尾成功后
// requestRefresh）。variants 吃各分支 preview、index 吃 isCurrent 项、
// onIndexChange → pi_switch_branch 请求（runtime 执行器：守卫 + 重水合）。
const BranchPickerBar: FC = () => {
  const branches = useStore(branchBridge, (s) => s.branches);
  const refreshSeq = useStore(branchBridge, (s) => s.refreshSeq);
  useEffect(() => {
    void branchBridge.getState().refresh();
  }, [refreshSeq]);
  if (!branches || branches.branches.length === 0) return null;
  const view = toBranchPickerView(branches);
  return (
    <MessageBranches
      data-slot="aui_branch-picker-bar"
      variants={view.variants}
      index={view.index}
      onIndexChange={(index) => {
        const leaf = branches.branches[index];
        if (!leaf) {
          console.error(`[aui] 分支选择越界（index=${index}）——忽略`);
          return;
        }
        branchBridge.getState().requestSwitch(leaf.leafId);
      }}
      className="w-full max-w-none pt-2"
    />
  );
};

// 中断态横幅（官方 stopped-run 元素）：pi_interrupt 成功后 run 收尾、且无
// 错误时展示（RUN_ERROR 路径由错误条负责，二者不叠显）。words = 最后一条
// assistant 段已收到的文本。挂载点在 ViewportFooter（thread 级，无 message
// scope）——只允许读 s.thread.*。
const StoppedRunBanner: FC = () => {
  const aui = useAui();
  const interrupted =
    useAuiState((s) => parseTurnState(s.thread.state)?.interrupted) === true;
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const error = useErrorBridge().error;
  const lastAssistantText = useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant") {
        if (typeof m.content === "string") return m.content;
        return m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
    }
    return null;
  });
  // 本地放弃标记：Discard 只收起本次横幅（UI 态——轮次真相里的
  // interrupted 标记由下一个 run 的 RUN_STARTED 归约清除）
  const [dismissed, setDismissed] = useState(false);
  if (!interrupted || isRunning || dismissed || error) return null;
  // 中断的是最后一个 run 段（最后一条消息是 assistant）才展示——若用户
  // 中断后又发了新消息，横幅已无意义
  const lastRole = aui.thread.getState().messages.at(-1)?.role;
  if (lastRole !== "assistant") return null;

  const onContinue = () => {
    // 继续 = 重新生成最后一条 assistant（message.reload → startRun →
    // runtime onReload → pi_retry_edit + POST），新 run 的 RUN_STARTED
    // 归约清 interrupted 标记，横幅随之消失
    const msgs = aui.thread.getState().messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant") {
      console.error("[aui] 继续运行：最后一条消息不是 assistant 段——无法 reload");
      return;
    }
    aui.thread.message({ index: last.index }).reload();
  };

  return (
    <StoppedRun
      data-slot="aui_stopped-run-banner"
      // 模板按空格 join words——中文整段作为单个词传入，不切分
      words={lastAssistantText ? [lastAssistantText] : []}
      reason="已停止"
      onContinue={onContinue}
      onDiscard={() => setDismissed(true)}
      className="w-full max-w-none pt-1"
    />
  );
};

// RUN_ERROR 用户可见面（§0.3 错误即错误）：官方 error-state 元素替换原
// 手写条。轮次机 error 经 error-bridge 到达；下一个 run 的 RUN_STARTED
// 归约清 error 后自动消失。onRetry = 重刷最后一条 assistant（与 Reload
// 同一机制：message.reload → startRun → onReload）。
const RunErrorBar: FC = () => {
  const { error } = useErrorBridge();
  const aui = useAui();
  if (!error) return null;
  const onRetry = () => {
    const msgs = aui.thread.getState().messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant") {
      console.error("[aui] 错误重试：最后一条消息不是 assistant 段——无法 reload");
      return;
    }
    aui.thread.message({ index: last.index }).reload();
  };
  return (
    <ErrorState
      data-slot="aui_run-error-bar"
      title="运行出错"
      detail={error}
      retrying={false}
      onRetry={onRetry}
      className="mt-1 w-full max-w-none"
    />
  );
};

// ── 工具渲染分流（pi 默认工具的结构化渲染）────────────────────────────
// 形状严格解析：args/result 不符时回退通用 ToolFallback——渲染选择非吞错
// （回退仍完整可见 args/result，不丢信息）。

/** 工具主要参数摘要（bash.command / web_search.query / 路径类优先） */
const summarizeArgs = (args: unknown): string => {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    const primary = a.command ?? a.query ?? a.q ?? a.path ?? a.file ?? a.url;
    if (typeof primary === "string" && primary) return primary;
  }
  try {
    const s = JSON.stringify(args);
    if (typeof s === "string") return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    // 不可序列化参数走 String()——展示用途，无数据流
  }
  return String(args);
};

/** 工具结果文本化：string 原样；其余 JSON 格式化（失败 String()） */
const toolResultText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
};

/** web_search 结果严格解析：数组或 {results:[...]},单项 {title|url,
 * domain|url}；任何一项不符整体返回 null（回退通用渲染） */
const parseWebSearchResults = (
  result: unknown,
): readonly WebSearchResult[] | null => {
  let items: unknown = result;
  if (typeof result === "string") {
    try {
      items = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (items && typeof items === "object" && !Array.isArray(items)) {
    const r = (items as { results?: unknown }).results;
    if (r !== undefined) items = r;
  }
  if (!Array.isArray(items)) return null;
  const out: WebSearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const it = item as { title?: unknown; url?: unknown; domain?: unknown };
    const title =
      typeof it.title === "string" && it.title
        ? it.title
        : typeof it.url === "string"
          ? it.url
          : null;
    if (!title) return null;
    let domain = typeof it.domain === "string" && it.domain ? it.domain : null;
    if (!domain && typeof it.url === "string") {
      try {
        domain = new URL(it.url).hostname;
      } catch {
        domain = null;
      }
    }
    if (!domain) return null;
    out.push({ title, domain });
  }
  return out;
};

// 通用工具卡（官方 tool-call 元素）：折叠面板 + Request/Result
const GenericToolCall: FC<{
  toolName: string;
  argsText?: string;
  args: unknown;
  result: unknown;
  running: boolean;
}> = ({ toolName, argsText, args, result, running }) => {
  const [open, setOpen] = useState(false);
  return (
    <ToolCall
      label={toolName}
      activeLabel={`${toolName} 运行中`}
      query={summarizeArgs(args)}
      request={argsText || summarizeArgs(args)}
      result={toolResultText(result)}
      running={running}
      open={open}
      onOpenChange={setOpen}
    />
  );
};

// 分流器：isError → tool-error（attempt 1/1，前端不自动重试，Retry/Skip
// 保持模板的禁用态）；bash → terminal-block；web_search → web-search；
// 其余 → 通用 tool-call；形状不符 → ToolFallback（官方完整回退，
// 含 argsText 与审批面）。
const PiToolUI: ToolCallMessagePartComponent = (part) => {
  const { toolName, args, result, status, isError, argsText } = part;
  const running = status?.type === "running";

  if (isError === true) {
    return (
      <ToolError
        name={toolName}
        target={summarizeArgs(args)}
        message={toolResultText(result)}
        attempt={1}
        maxAttempts={1}
        retrying={false}
      />
    );
  }

  if (toolName === "bash") {
    const command =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>).command
        : undefined;
    // 形状契约：command 为 string、result 为 string/未到——否则回退通用
    if (typeof command === "string" && (result === undefined || typeof result === "string")) {
      const lines = typeof result === "string" && result.length > 0 ? result.split("\n") : [];
      return (
        <TerminalBlock
          command={command}
          lines={lines}
          visibleCount={lines.length}
          done={!running}
        />
      );
    }
    return <ToolFallback {...part} />;
  }

  if (toolName === "web_search") {
    const query =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>).query ?? (args as Record<string, unknown>).q
        : undefined;
    if (typeof query === "string" && query) {
      const results = parseWebSearchResults(result);
      // 运行中（result 未到）即可渲染搜索条；结果解析失败回退通用
      if (results || result === undefined) {
        return (
          <WebSearch
            query={query}
            results={results ?? []}
            visibleResults={results?.length ?? 0}
            searching={running}
            cycle={0}
          />
        );
      }
    }
    return <ToolFallback {...part} />;
  }

  return (
    <GenericToolCall
      toolName={toolName}
      argsText={argsText}
      args={args}
      result={result}
      running={running}
    />
  );
};

// ── message-timing（官方元素）：run 级 usage 展示。轮次机只归并 run 级
// 快照（RUN_FINISHED.usage，替换语义——不按消息归并），因此只在最后一条
// assistant 上显示（旧消息显示过期快照会误导）；流式中蓝字。
const RunTiming: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isLast = useAuiState((s) => s.message.isLast);
  const streaming = useAuiState((s) => s.thread.isRunning);
  const { usage } = useUsageBridge();
  if (role !== "assistant" || !isLast || !usage) return null;
  const stats: TimingStat[] = [];
  if (usage.inputTokens !== undefined)
    stats.push({ label: "输入", value: `${usage.inputTokens} tok` });
  if (usage.outputTokens !== undefined)
    stats.push({ label: "输出", value: `${usage.outputTokens} tok` });
  if (usage.totalTokens !== undefined)
    stats.push({ label: "总计", value: `${usage.totalTokens} tok` });
  if (usage.costUsd !== undefined)
    stats.push({ label: "费用", value: `$${usage.costUsd.toFixed(4)}` });
  if (stats.length === 0) return null;
  return <MessageTiming stats={stats} streaming={streaming} className="ms-2 mt-1" />;
};

// ── day-separator（官方模板行提取）：消息列表按 createdAt 日期插入分隔。
// 模板 DaySeparator 是自带迷你消息列表的整块演示组件，无法嵌进真实消息
// 循环——这里提取其日期分隔行（发丝线 + mono 日期）按消息间隙挂载，数据
// 即模板的 DatedMessage{day,time}。无 createdAt 的消息跳过。
const DAY_FMT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayLabel = (d: Date): string => DAY_FMT.format(d);
const timeLabel = (d: Date): string => TIME_FMT.format(d);

const DaySeparatorRow: FC<{ day: string; time: string }> = ({ day, time }) => (
  <div data-slot="day-separator" className="flex items-center gap-2.5 py-1">
    <span className="bg-foreground/[0.08] h-px flex-1" />
    <span className="font-mono text-[11px] tracking-tight text-foreground/30">
      {day}
      <span className="ms-2 tabular-nums">{time}</span>
    </span>
    <span className="bg-foreground/[0.08] h-px flex-1" />
  </div>
);

const MessageWithDaySeparator: FC = () => {
  const day = useAuiState((s) =>
    s.message.createdAt ? dayLabel(s.message.createdAt) : null,
  );
  const time = useAuiState((s) =>
    s.message.createdAt ? timeLabel(s.message.createdAt) : null,
  );
  // 前一条消息的日期（无 createdAt 视为无日期——不触发分隔）
  const prevDay = useAuiState((s) => {
    const prev = s.thread.messages[s.message.index - 1];
    return prev?.createdAt ? dayLabel(prev.createdAt) : null;
  });
  const showSeparator = day !== null && day !== prevDay;
  return (
    <>
      {showSeparator && day && time && <DaySeparatorRow day={day} time={time} />}
      <ThreadMessage />
    </>
  );
};

// ── empty-state（官方元素，挂 Welcome 槽位）────────────────────────────
// 起步建议 + 罐头 composer：EmptyStateComposer 是纯展示模板（无输入框，
// onSend 即发），发送走 aui.thread.append = 现有发送通道（onNew → POST）。
const STARTER_PROMPT = "帮我梳理这个仓库的模块结构";
const STARTER_SUGGESTIONS = [
  "梳理这个仓库的模块结构",
  "总结我们当前的对话进度",
  "写一个 PowerShell 脚本批量重命名文件",
  "帮我分析一段报错堆栈",
] as const;

const EmptyStateWelcome: FC = () => {
  const aui = useAui();
  return (
    <EmptyState className="aui-thread-welcome-root mx-auto my-6">
      <EmptyStateGreeting>有什么可以帮你的？</EmptyStateGreeting>
      <EmptyStateSuggestions>
        {STARTER_SUGGESTIONS.map((s, i) => (
          <EmptyStateSuggestion
            key={s}
            index={i}
            onClick={() => aui.thread.append(s)}
          >
            {s}
          </EmptyStateSuggestion>
        ))}
      </EmptyStateSuggestions>
      <EmptyStateComposer
        placeholder={STARTER_PROMPT}
        onSend={() => aui.thread.append(STARTER_PROMPT)}
      />
    </EmptyState>
  );
};

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean }> = ({
  isEmpty,
  autoFocus,
}) => {
  // Welcome 默认 = 官方 empty-state 元素（Greeting + 起步建议 + 罐头
  // composer）；消费者仍可经 ThreadComponents.Welcome 整体替换
  const { Welcome = EmptyStateWelcome } = useContext(ThreadComponentsContext);

  return (
    // asChild：Thread 不渲染自己的 div，行为合并到我们传入的容器上
    // （FlexLayout tab content 就是滚动/布局容器——官方"已有容器"场景）
    <ThreadPrimitive.Root asChild>
      <div
        className="aui-root aui-thread-root bg-transparent @container flex h-full flex-col"
        style={{
          ["--thread-max-width" as string]: "44rem",
          ["--composer-bg" as string]:
            "color-mix(in oklab, var(--color-muted) 30%, transparent)",
          ["--composer-radius" as string]: "1rem",
          ["--composer-padding" as string]: "8px",
        }}
      >
        <ConnectionBanner />
        <ThreadPrimitive.Viewport asChild turnAnchor="top">
          <div
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
          >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          {/* 分支切换条（官方 message-branches 模板）：pi 兄弟分支——
              fork/重试建立分支后出现；无分支不渲染 */}
          <BranchPickerBar />

          {/* 压缩横幅（官方 guardrail-notice 元素）：CUSTOM name=compaction
              经轮次机 → adapter state 到达；挂 thread 消息区顶部 */}
          <CompactionBanner />

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <MessageWithDaySeparator />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-transparent flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {/* 运行状态行（官方 thinking-indicator 元素）：思考前/思考中
                （正文未到时）显示"正在思考/正在使用 <tool>" + 耗时——
                放 composer 上方（用户视线处），正文流出即消失 */}
            <ThreadThinkingIndicator />
            <RunErrorBar />
            <StoppedRunBanner />
            <ApprovalCards />
            <ComposerWired />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
          </div>
        </ThreadPrimitive.Viewport>
      </div>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");

  if (isEditing) return <EditComposer />;
  if (isSpoken) return <SpokenMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });

const SpokenText: TextMessagePartComponent = ({ text }) => (
  <p className="aui-spoken-message-text m-0">{text}</p>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      className={cn(
        "aui-spoken-message bg-muted/40 mx-2 px-3 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto]",
        position === "single" && "rounded-xl py-2",
        position === "start" && "rounded-t-xl pt-2",
        position === "middle" && "-mt-6",
        position === "end" && "-mt-6 rounded-b-xl pb-2",
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <PhoneIcon className="size-3" aria-hidden />
          <span>Voice conversation</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === "user" ? (
            <MicIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
        </span>
        <span className="sr-only">
          {role === "user" ? "You said" : "Assistant said"}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans"
              aria-label="Assistant is speaking"
            >
              ●
            </span>
          )}
        </div>
        <SpokenActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-spoken-action-bar text-muted-foreground flex shrink-0 gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" className="size-6">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {">"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{" "}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    // 工具渲染默认 = PiToolUI 分流（bash/web_search/isError/通用；形状
    // 不符回退官方 ToolFallback）——消费者传入的 ToolFallback 槽位仍优先
    ToolFallback: ToolFallbackComponent = PiToolUI,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-task":
                return TaskGroupComponent ? (
                  <TaskGroupComponent group={part} />
                ) : null;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      {/* run 级 usage（官方 message-timing 元素）——只在最后一条 assistant */}
      <RunTiming />

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

// 消息操作条（官方 message-actions 元素）：复制（copied 态）/ 反馈 /
// 重新生成 / 更多。重新生成与 ActionBarPrimitive.Reload 同一机制
// （aui.message.reload → startRun → runtime onReload）——不重复造重发
// 管道；onReload 接通后 Reload 能力即活（capabilities.reload = true）。
// feedback 能力未接入（无 FeedbackAdapter）时隐藏反馈钮（aui-no-feedback，
// overlays.css）——与旧版 AuiIf capabilities.feedback 门控等价。
const AssistantActionBar: FC = () => {
  const aui = useAui();
  const isCopied = useAuiState((s) => s.message.isCopied);
  const feedbackEnabled = useAuiState((s) => s.thread.capabilities.feedback);
  const [reaction, setReaction] = useState<Reaction>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined)
        clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const onCopy = () => {
    const text = aui.message.getCopyText();
    if (!text) return;
    // 与官方 useActionBarCopy 同语义：写入成功才点亮 copied，3s 后回落；
    // 失败 console.error 可见（不装作已复制）
    navigator.clipboard
      .writeText(text)
      .then(() => {
        aui.message.setIsCopied(true);
        if (copiedTimerRef.current !== undefined)
          clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = undefined;
          aui.message.setIsCopied(false);
        }, 3000);
      })
      .catch((e) => console.error("[aui] 复制失败", e));
  };

  const onReactionChange = (r: Reaction) => {
    if (!feedbackEnabled) {
      console.error("[aui] feedback 能力未接入（无 FeedbackAdapter），反馈未提交");
      return;
    }
    setReaction(r);
    // Reaction("up"/"down") → submitFeedback("positive"/"negative")
    if (r) aui.message.submitFeedback({ type: r === "up" ? "positive" : "negative" });
  };

  const onRegenerate = () => {
    aui.message.reload();
  };

  const onMore = () => {
    // 模板的 More 是回调式按钮——经隐藏的 ActionBarMorePrimitive.Trigger
    // 复用官方 ExportMarkdown 弹层（display:none 元素可程序化 click）
    moreTriggerRef.current?.click();
  };

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <MessageActions
        copied={isCopied}
        reaction={reaction}
        regenerating={false}
        onCopy={onCopy}
        onReactionChange={onReactionChange}
        onRegenerate={onRegenerate}
        onMore={onMore}
        className={cn(!feedbackEnabled && "aui-hide-reactions")}
      />
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <button
            ref={moreTriggerRef}
            type="button"
            aria-label="More response actions"
            className="hidden"
          />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  // ── fork 入口（「从此分支探索」）─────────────────────────────────────
  // 需要该 user 消息的 fork 点：index 映射——thread 里第 N 条 user 消息 =
  // pi_get_fork_points() 第 N 项（同源水合+流式追加，按序一一对应；清单
  // 投影由 branch store 持有，随 runtime 的刷新信号更新）。
  // 流式未落盘/清单未含的消息在清单中缺失 → 钮禁用（fork 点只在已水合
  // 历史上有——诚实处理，注释即说明）；点击后的守卫（isRunning 中断）、
  // entryId 解析、文本比对与 fork 执行都在 runtime 执行器。
  const userOrdinal = useAuiState((s) => {
    let count = 0;
    const msgs = s.thread.messages;
    for (let i = 0; i <= s.message.index && i < msgs.length; i++) {
      if (msgs[i]?.role === "user") count++;
    }
    return count - 1;
  });
  const messageText = useAuiState((s) => {
    const m = s.thread.messages[s.message.index];
    if (!m) return null;
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  });
  // fork 点存在且文本与投影一致才可点（防投影与 pi 路径漂移的错位 fork）
  const forkable = useStore(branchBridge, (s) => {
    if (userOrdinal < 0 || messageText === null) return false;
    const point = s.forkPoints[userOrdinal];
    return point !== undefined && point.text === messageText;
  });
  const onFork = () => {
    if (userOrdinal < 0 || messageText === null) {
      console.error("[aui] fork：无法定位该 user 消息的序号/文本——取消");
      return;
    }
    branchBridge.getState().requestFork(userOrdinal, messageText);
  };

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
      <TooltipIconButton
        tooltip="从此分支探索"
        className="aui-user-action-fork"
        disabled={!forkable}
        onClick={onFork}
      >
        <GitBranchIcon />
      </TooltipIconButton>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-foreground/10 focus-within:border-foreground/25 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) transition-[border-color]">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
