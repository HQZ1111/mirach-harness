"use client";

import { ComposerWired } from '@/components/panes/hermes-sidebar/composer-wired';
import { WorkspaceComposerMenu } from '@/components/panes/hermes-sidebar/workspace-composer-menu';
import {
  resolveStatusPanelShift,
  statusPanelStore,
} from '@/components/assistant-ui/status-panel-store';
import { VoiceLivePanel } from '@/components/assistant-ui/voice-live-panel';
import { VoiceLiveConversationDrive } from '@/components/assistant-ui/voice-live-conversation';
import { lookupLineageParentName } from "@/components/panes/session-manage/session-lineage-name";
import { ApprovalCards } from '@/components/assistant-ui/approval-cards'
import { AskCards } from '@/components/assistant-ui/ask-cards'
import {
  useConversationWidthAxis,
  WidthHandle,
} from '@/components/assistant-ui/width-handle';
import {
  branchBridge,
  toBranchPickerView,
} from "@/components/assistant-ui/branch-store";
import {
  useConnectionBridge,
  useConnectionPhase,
} from "@/components/assistant-ui/connection-store";
import {
  classifyScrollState,
  getSavedThreadScroll,
  saveThreadScroll,
  threadScrollBridge,
  threadScrollTargetTop,
} from "@/components/assistant-ui/thread-scroll-store";
import { useErrorBridge } from "@/components/assistant-ui/error-bridge";
import { useUsageBridge } from "@/components/assistant-ui/usage-bridge";
import { invoke } from "@tauri-apps/api/core";
import { MessageQueue } from "@/components/assistant-ui/elements/message-queue";
import { ReadAloud } from "@/components/assistant-ui/elements/read-aloud";
import {
  RegenerateMenu,
  type RegenerateOption,
} from "@/components/assistant-ui/elements/regenerate-menu";
import {
  checkpointBridge,
  formatCheckpointTime,
} from "@/components/assistant-ui/checkpoint-store";
import { sessionQueue } from "@/components/assistant-ui/session-queue-store";
import {
  modelCatalogStore,
  toModelOptions,
} from "@/components/assistant-ui/model-catalog-store";
import {
  SPEECH_RATES,
  ensureSpeechSupportLogged,
  getSpeechRate,
  segmentSpeechWords,
  setSpeechRate,
  speechProgressBridge,
  wordIndexAt,
} from "@/components/assistant-ui/speech-adapter";
import { EmptyState, EmptyStateGreeting, EmptyStateSuggestion, EmptyStateSuggestions } from "@/components/assistant-ui/elements/empty-state";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ConnectionState } from "@/components/assistant-ui/elements/connection-state";
import { MessageActions, type Reaction } from "@/components/assistant-ui/elements/message-actions";
import { MessageBranches } from "@/components/assistant-ui/elements/message-branches";
import { MessageTiming, type TimingStat } from "@/components/assistant-ui/elements/message-timing";
import { StoppedRun } from "@/components/assistant-ui/elements/stopped-run";
import { PiToolUI } from "@/components/assistant-ui/tool-renderers.aui";
import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { QuoteBlock } from "@/components/assistant-ui/elements/quote.aui";
import { File } from "@/components/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import { Image } from "@/components/image";
import { ThreadThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator.aui";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import {
  AssistantWorkParts,
  type WorkGroupPart,
} from "@/components/assistant-ui/elements/work-parts.aui";
import { TurnNavigator } from "@/components/assistant-ui/elements/turn-navigator.aui";
import { SelectionToolbar } from "@/components/assistant-ui/elements/selection-toolbar.aui";
import { ConversationFind } from "@/components/assistant-ui/elements/conversation-find.aui";
import { TurnFileSummary } from "@/components/assistant-ui/elements/turn-file-summary";
import { TimelineMarkerRow, MarkerDivider, bucketMarkers, compactionRowView } from "@/components/assistant-ui/elements/timeline-marker";
import { useTimelineMarkers } from "@/components/assistant-ui/timeline-marker-store";
import {
  ensureFullTranscript,
  loadOlderTranscript,
  releaseTranscriptHistory,
  transcriptTailStore,
  useEngineAttaching,
} from "@/components/assistant-ui/transcript-paging";
import {
  groupMessagesIntoTurns,
  isLastContentAssistantOfTurn,
} from "@/components/assistant-ui/turn-units";
import {
  FIRST_PAINT_BUDGET,
  FULL_TRANSCRIPT_BUDGET,
  TOP_EDGE_PX,
  expandBudget,
  nextBackfillBudget,
  selectTranscriptWindow,
  type WindowMessageLike,
} from "@/components/assistant-ui/transcript-window";
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
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  unstable_useThreadMessageIds,
  useAui,
  useAuiState,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArchiveIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  GitBranchIcon,
  HistoryIcon,
  MicIcon,
  MinimizeIcon,
  PencilIcon,
  PhoneIcon,
  Volume2Icon,
} from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { useStore } from "zustand";

import { ContribBoundary } from "@/hermes-shim/contrib/react/contrib-boundary";
import { useContributions } from "@/hermes-shim/contrib/react/use-contributions";
import { I18nProvider } from "@/hermes-mirror/i18n";
import { sessionCatalog } from "@/components/panes/session-manage/session-catalog";
import { readLocale } from "@/lib/ui-prefs";

export type ThreadGroupPart = WorkGroupPart;

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
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: WorkGroupPart }>>
    | undefined;
  TaskGroup?: ComponentType<{ group: WorkGroupPart }> | undefined;
};

// ── 分组路径（旧实现，2026-11-07 起由 work-parts.aui.tsx 承担）─────────
// 此前用 `groupPartByType` + 自建 groupBy（带 GROUPBY_MEMO_KEY 指纹）做
// 相邻合并；GroupedParts 的合并会被任何插入部件断组。
// 2026-11-15 定稿：ZCode 「连续摘要组」扫描在 `work-summary.ts`（跨族统计
// 组头 + 组内单行），渲染器在 `work-parts.aui.tsx` / `summary-group.aui.tsx`。

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  /** 会话分栏（v7.4）：跳过主会话管理 chrome（检查点/谱系/队列/成本/
   *  中断横幅——桥为主会话单例），消息/composer/思考指示照常。 */
  scoped?: boolean | undefined;
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
      // paper 全局去描边后原"仅底边"形态不再成立——显式补底边发丝线
      // 保持全宽状态条的原有分隔观感（条是状态横幅非卡片，不走去描边）。
      className="w-full max-w-none rounded-none border-b border-border/60 shadow-none"
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

// 上下文压缩行（ZCode `ConversationTimelineMarkerDivider` 的 compact 形态）：
// CUSTOM name=compaction 经轮次机归约进 context.compaction → adapter state
// 到达。2026-11-15 从顶部的 guardrail 横幅改成对话内的分隔线行（与历史
// compaction marker 同一壳体）：running 隐藏图标 + 文案流光；失败红字、
// 中断琥珀色；标题后缀 `tokensBefore → tokensAfter`。
const LiveCompactionRow: FC<{ hasTailCompactMarker: boolean }> = ({
  hasTailCompactMarker,
}) => {
  const raw = useAuiState((s) => s.thread.state);
  const st = parseTurnState(raw);
  const c = st?.compaction;
  if (
    !c ||
    (c.phase !== "start" && c.phase !== "end")
  ) {
    if (c) console.error("[aui] compaction 投影形状非法——分隔线不渲染", c);
    return null;
  }
  // 完成后历史 marker 已是真源（同壳同文案），实时快照不再重复一条；
  // 运行中（start）仍必须显示，旧 marker 不能盖住新的压缩进度。
  if (hasTailCompactMarker && c.phase === "end") return null;
  const view = compactionRowView({
    phase: c.phase,
    ...(typeof c.reason === "string" ? { reason: c.reason } : {}),
    ...(typeof c.tokensBefore === "number" ? { tokensBefore: c.tokensBefore } : {}),
    ...(typeof c.tokensAfter === "number" ? { tokensAfter: c.tokensAfter } : {}),
    ...(typeof c.aborted === "boolean" ? { aborted: c.aborted } : {}),
    ...(typeof c.errorMessage === "string" ? { errorMessage: c.errorMessage } : {}),
  });
  return (
    <div data-slot="aui_compaction-row">
      <MarkerDivider
        kind="compact"
        label={view.label}
        icon={<ArchiveIcon aria-hidden className="size-[var(--size-icon-sm)] shrink-0" />}
        running={view.running}
        tone={view.tone}
        {...(view.detail === undefined ? {} : { detail: view.detail })}
      />
    </div>
  );
};

// ── 会话线谱系条（会话级 fork 语义，唯一挂点=消息区顶部）────────────
// 数据 = branch store 的 lineage 投影（pi_get_session_lineage，真相在 pi）。
// 挂载 + refreshSeq 信号时拉取（runtime 的 onReload/onEdit/fork/switch/
// 会话切换/run 收尾成功后 requestRefresh）。
// 当前会话是 fork 子会话（branchedFrom 非空）时显示：谱系来源 + 回到父
// 会话。**只做会话级**——消息级变体（retry 在同一文件内长出的兄弟分支）
// 走助手消息 footer 的 MessageVariantPicker，两种语义不共用一个件。
const SessionLineBar: FC = () => {
  const lineage = useStore(branchBridge, (s) => s.lineage);
  const refreshSeq = useStore(branchBridge, (s) => s.refreshSeq);
  useEffect(() => {
    void branchBridge.getState().refresh();
  }, [refreshSeq]);
  const parent = lineage?.branchedFrom ?? null;
  // 父会话名反查（任务 3）：lineage 只暴露 jsonl 路径（pi_get_session_
  // lineage 裸 Option<String>），显示名 = pi_list_sessions 按 path 匹配
  // name（hermes 分支行名称语义：branchStem「└─ 」挂在父会话**显示名**
  // 下，session-branch-tree.ts:97-106——文件名不是面向用户的名字）。
  // lazy 查一次（模块级缓存防重复 IPC）；无匹配 → 回退文件名尾段
  // （lookupLineageParentName 返回 null，任务定稿）。
  const [parentName, setParentName] = useState<string | null>(null);
  useEffect(() => {
    if (!parent) {
      setParentName(null);
      return;
    }
    let alive = true;
    void lookupLineageParentName(parent).then((name) => {
      if (alive) setParentName(name);
    });
    return () => {
      alive = false;
    };
  }, [parent]);
  if (!parent) return null;
  const parentTail = parent.split(/[\\/]/).pop() || parent;
  const displayName = parentName ?? parentTail;
  return (
    <div
      data-slot="aui-session-line-bar"
      // 去描边（用户 2026-10-14 全局去描边：卡片不留描边线）——bg-muted/40 底色承担层次
      className="mb-2 flex w-full items-center gap-2 rounded-(--composer-radius) bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <GitBranchIcon className="size-[var(--size-icon-md)] shrink-0" />
      <span className="min-w-0 truncate">会话分支 · 分叉自「{displayName}」</span>
      <button
        type="button"
        onClick={() => branchBridge.getState().requestOpenParent(parent)}
        className="ms-auto shrink-0 rounded-md px-2 py-0.5 hover:bg-accent hover:text-accent-foreground"
      >
        回到父会话
      </button>
    </div>
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
  const { error, retryable } = useErrorBridge();
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
      title={retryable ? "运行出错" : "会话打开失败"}
      detail={error}
      retrying={false}
      onRetry={retryable ? onRetry : undefined}
      className="mt-1 w-full max-w-none"
    />
  );
};

// ── message-queue（官方元素）：isRunning 时用户提交的新消息排队可视化 ──
// 数据 = session-queue-store（runtime onNew 入队 / run 收尾 drain 逐条
// 发出）。running 标签 = 当前 run 的来源消息（最后一条 user 文本）。
// 仅 isRunning 且队列非空时渲染——队列存在本身就是"何时发出"的说明
// （模板自带 "sends when this finishes"）。「立即发送」不做：立即发送
// 必须先 pi_interrupt 中断当前 run（prompt 持锁跨整个 run），把中断语义
// 藏进一个发送钮会误伤正在跑的 run——队列本就按序自动发出，语义等价，
// 不做双入口（删除钮保留，模板 onCancel）。
const MessageQueueWired: FC = () => {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const queued = useStore(sessionQueue, (s) => s.items);
  const runningText = useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user") {
        return typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("");
      }
    }
    return null;
  });
  if (!isRunning || queued.length === 0) return null;
  return (
    <MessageQueue
      data-slot="aui_message-queue"
      running={runningText?.trim() || "正在处理当前消息"}
      queued={queued}
      onCancel={(id) => sessionQueue.getState().remove(id)}
      className="w-full max-w-none"
    />
  );
};

// ── 运行成本组件已删除（2026-11-15 用户要求）────────────────────────────
// 原 CostMeterWired（cost-meter 元素：run 成本 + 会话累计）在 composer
// 上方常驻一行，因为 rpi 的 usage.cost 恒有值（未配价目恒 0）而一直显示
// "$0.0000 this run / $0.0000 session"。用户判定为噪音，整体移除。
// cost-bridge（runtime 的入账面）保留不动——将来要恢复成本展示或接入
// 价目配置时数据面还在。

// ── 检查点（pi checkpoint/rewind 命令面，对话历史编辑）─────────────────
// 轻量弹出面板（消息区顶部工具位，SessionLineBar 旁）：列出当前会话
// checkpoints（pi_list_checkpoints：name/entryId/时间/消息数）、「打检查
// 点」（pi_mark_checkpoint，label 留空 = pi 默认 "checkpoint"）、「回到
// 此点」（pi_rewind——请求经 checkpoint-store 通道到 runtime 执行器：
// 守卫 interrupt + 重水合）。回退语义（pi_rewind = apply_rewind_to_active）：
// 活动上下文截断到该检查点，其后对话折叠为一条摘要——面板底部红字警示，
// 诚实不悄悄删历史（会话树保留，可再次回退）。
const CheckpointBar: FC = () => {
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const checkpoints = useStore(checkpointBridge, (s) => s.checkpoints);
  const currentId = useStore(checkpointBridge, (s) => s.currentId);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const markingRef = useRef(false);
  useEffect(() => {
    // 每次展开拉新鲜清单（跨会话切换后不残留上一会话的投影）
    if (open) void checkpointBridge.getState().refresh();
  }, [open]);
  if (!hasMessages) return null;

  const onMark = async () => {
    if (markingRef.current) return;
    markingRef.current = true;
    try {
      const trimmed = label.trim();
      // label 空/缺省 = pi 默认 "checkpoint"（上游语义，非兜底）
      await invoke("pi_mark_checkpoint", { label: trimmed || undefined });
      setLabel("");
      await checkpointBridge.getState().refresh();
    } catch (e) {
      // 无活动会话 / 持久化失败：错误可见，面板保持现状
      console.error("[pi] 打检查点失败", e);
    } finally {
      markingRef.current = false;
    }
  };

  return (
    <div
      data-slot="aui-checkpoint-bar"
      className="relative mb-2 flex w-full items-center"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <HistoryIcon className="size-[var(--size-icon-md)]" aria-hidden />
        检查点
        {checkpoints.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums">
            {checkpoints.length}
          </span>
        )}
      </button>
      {open && (
        <>
          {/* 点击面板外关闭（透明垫层，面板 z-50 之上） */}
          <div
            aria-hidden
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div
            data-slot="aui-checkpoint-panel"
            // 去描边（用户 2026-10-14 全局去描边：浮层不留描边线）——层次由 shadow-lg 承担
            className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 flex w-80 flex-col gap-2 rounded-xl p-3 shadow-lg"
          >
            <p className="text-muted-foreground px-1 text-xs">
              标记当前进度点，之后可回到此处。
            </p>
            <div className="flex items-center gap-1.5">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onMark();
                }}
                placeholder="检查点名称（可留空）"
                className="border-border/60 h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus:border-foreground/30"
              />
              <button
                type="button"
                onClick={() => void onMark()}
                className="shrink-0 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent"
              >
                打检查点
              </button>
            </div>
            <div className="flex flex-col">
              {checkpoints.length === 0 && (
                <p className="text-muted-foreground px-1 py-2 text-xs">
                  当前会话还没有检查点。
                </p>
              )}
              {checkpoints.map((cp) => {
                const current = cp.name === currentId;
                return (
                  <div
                    key={`${cp.entryId ?? "no-entry"}-${cp.name}-${cp.atMs}`}
                    className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-accent/50"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        current ? "bg-blue-500" : "bg-foreground/25",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {cp.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {formatCheckpointTime(cp.atMs)} · {cp.messageCount} 条消息
                    </span>
                    {current ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        当前
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          checkpointBridge.getState().requestRewind(cp.name);
                        }}
                        className="text-destructive hover:bg-destructive/10 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors"
                      >
                        回到此点
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 未用官方 checkpoint-history 元素：它把第三行硬编码成
                "{files} files"，而 pi 无文件数概念（只有 messageCount）——
                塞进去会把"3 条消息"显示成"3 files"（撒谎）。保留本行渲染。 */}
            <p className="text-destructive/90 px-1 text-[11px] leading-relaxed">
              回到此点会截断其后的上下文：该点之后的对话将折叠为一条摘要，不再逐条显示（会话树保留）。
            </p>
          </div>
        </>
      )}
    </div>
  );
};

// ── 工具渲染分流 ─────────────────────────────────────────────────────
// 工具部件的分流与摘要行渲染搬到 `tool-renderers.aui.tsx`（ZCode
// `ToolCallBlocks/resolveRenderer.ts` + `renderers/*.tsx` 的宿主口径，
// 2026-11-15）：摘要行（图标/类别词/参数 chip/状态/耗时/diff 计数）
// + 按需展开正文（命令/输出/参数/结果/diff/搜索卡），失败红显不换卡。
// `PiToolUI` 仍是 `ToolFallback` 槽位的默认值（注册工具 UI 优先）。

// ── message-timing（官方元素）：run 级 usage 展示。轮次机只归并 run 级
// 快照（RUN_FINISHED.usage，替换语义——不按消息归并），因此只在最后一条
// assistant 上显示（旧消息显示过期快照会误导）；流式中蓝字。
// ── 会话维护条（手动压缩）──────────────────────────────────────────────
// 只在非运行态渲染：运行中压缩会与自动压缩打架。
// 结果诚实反馈（失败 console.error + 可见文案；不乐观假装成功）。
//
// **撤销 / 重做按钮已删（2026-11-15）**：rpi-main v0.24.0 没有会话级
// FileMutationRecorder（`pi_undo_history` / `pi_undo_redo` 在 Rust 侧恒
// Err），入口是假入口。压缩（`pi_compact`）保留。
const SessionMaintenanceBar: FC = () => {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [busy, setBusy] = useState<null | 'compact'>(null);
  const [note, setNote] = useState<string | null>(null);

  if (isRunning) return null;

  const run = async (kind: 'compact') => {
    if (busy !== null) return;
    setBusy(kind);
    setNote(null);
    try {
      await invoke('pi_compact');
      setNote('已触发压缩');
    } catch (e) {
      console.error(`[pi] ${kind} 失败`, e);
      setNote(`压缩失败：${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const btn =
    'flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/90 disabled:opacity-40';

  return (
    <div
      data-slot="aui_session-maintenance"
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      <button type="button" className={btn} disabled={busy !== null} onClick={() => void run('compact')}>
        <MinimizeIcon className="size-[var(--size-icon-md)]" aria-hidden />
        压缩上下文
      </button>
      {note !== null && (
        <span className="min-w-0 truncate font-mono text-[11px] tracking-tight text-foreground/40">
          {note}
        </span>
      )}
    </div>
  );
};

const RunTiming: FC = () => {  const role = useAuiState((s) => s.message.role);
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
  // 费用行已按用户要求删除（2026-11-15）：rpi 的 usage.cost 恒有值（0 也报
  // 0），成本来自 models.json 的 per-model 价目；没配价目的端点恒显示
  // "$0.0000"，用户判定为噪音。需要成本时在 models.json 配 cost 后在
  // 设置 → 使用统计 查看（usage-settings 的聚合面仍保留成本字段）。
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

const MessageWithDaySeparator: FC = memo(function MessageWithDaySeparator() {
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
});

/**
 * 轮容器列表（ZCode `ConversationTurnRenderUnit` 的宿主投影，2026-11-02）。
 *
 * 替换原来的扁平 `<ThreadPrimitive.Messages>`：消息仍逐条渲染（
 * `Unstable_MessageById` 按 id 挂载，跨重排/插入保持同一节点），但外面多
 * 了一层**轮**——一条 user 消息 + 其后的 assistant 工作。分组规则是纯函数
 * （`turn-units.ts`，11 条单测）。
 *
 * ## 为什么需要这层
 *
 * 轮级能力全部以"这一轮从哪到哪"为前提：轮级操作条（一轮一条，已接）、
 * 轮尾文件变更汇总、轮导航器、轮尾 boundary marker。扁平列表做不出来。
 *
 * ## 不重渲染的取法
 *
 * `unstable_useThreadMessageIds` 返回的数组在**只有内容变化**时引用不变
 * （官方注释明说，正是为虚拟列表准备的）。轮结构只需要 id 序列 + role
 * 序列，所以 role 也压成一个字符串签名（`u`/`a` 串）——流式每帧 store 都
 * 会通知，但签名不变 → `Object.is` 命中 → 不重渲染、不重算分组。
 *
 * ## 间距保持宿主既有节奏
 *
 * 轮与轮之间、消息与消息之间都是 `gap-y-6`（宿主定稿；ZCode 的
 * pt-14+pb-5 是有意差异，见 AGENTS.md「确认为有意差异」表）。加这层**不改
 * 视觉**，只加结构。
 */
/** 引擎装配提示（peek-first 秒开的可见面）：尾部已画但 `pi_open_session`
 *  还在后台 replay——composer 上方如实一行「正在准备会话」，发送会等它
 *  就绪（prompt 持锁，不打在旧会话上）。 */
const EngineAttachHint: FC = () => {
  const attaching = useEngineAttaching();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  if (!attaching || isRunning) return null;
  return (
    <div
      data-slot="aui_engine-attach-hint"
      className="text-muted-foreground px-2 py-1 text-xs"
    >
      正在准备会话（引擎载入中）…
    </div>
  );
};

const MessageTurnList: FC = () => {
  const ids = unstable_useThreadMessageIds();
  const roleSig = useAuiState((s) =>
    s.thread.messages.map((m) => (m.role === "user" ? "u" : "a")).join(""),
  );
  const aui = useAui();
  const turns = useMemo(
    () =>
      groupMessagesIntoTurns(
        ids.map((id, i) => ({
          id,
          role: roleSig[i] === "u" ? "user" : "assistant",
        })),
      ),
    [ids, roleSig],
  );
  // ── 转录渲染窗口（hermes transcript-window 移植，2026-11-19）───────────
  // 切会话先挂尾部小预算，rAF 分步补齐到整页预算；窗口边界落在轮上。
  // 只裁剪**渲染**，不动 store 与 scrollTop（滚动记忆单一所有者不受扰）。
  const threadKey = ids[0] ?? "empty";
  const [renderBudget, setRenderBudget] = useState(FIRST_PAINT_BUDGET);
  const prevThreadKeyRef = useRef(threadKey);
  if (prevThreadKeyRef.current !== threadKey) {
    prevThreadKeyRef.current = threadKey;
    setRenderBudget(FIRST_PAINT_BUDGET);
  }
  useEffect(() => {
    if (renderBudget >= FULL_TRANSCRIPT_BUDGET) return;
    const frame = requestAnimationFrame(() =>
      setRenderBudget((current) => nextBackfillBudget(current)),
    );
    return () => cancelAnimationFrame(frame);
  }, [renderBudget]);
  const window_ = useMemo(() => {
    const byId = new Map<string, WindowMessageLike>(
      (aui.thread.getState().messages as readonly (WindowMessageLike & { id: string })[]).map(
        (m) => [m.id, m],
      ),
    );
    return selectTranscriptWindow(turns, byId, renderBudget);
  }, [turns, renderBudget, aui, roleSig]);
  const windowStartRef = useRef(window_.startTurn);
  windowStartRef.current = window_.startTurn;
  // 已加载历史后面还有更老的一页（tail 水合），「显示更早」走后端补页，
  // 而不是只展开渲染预算。
  const hasOlderHistory = useStore(transcriptTailStore, (s) => s.hasMore);
  const showEarlier = useCallback(() => {
    if (transcriptTailStore.getState().hasMore) {
      void loadOlderTranscript();
      return;
    }
    setRenderBudget(expandBudget);
  }, []);
  // 滚到顶再往上滚 = 用户要看更早（hermes shouldAutoShowEarlier 的宿主版：
  // 轮仍在 / 尚未补齐时不触发）。监听挂在本列表的布局透明包装上，用
  // closest 找自己的视口——分栏里每个 Thread 各管各的窗口。
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // 向下滚 = 离开顶部：按保留窗口释放最老的历史页（内存封顶）
      if (event.deltaY > 0) {
        releaseTranscriptHistory();
        return;
      }
      if (event.deltaY >= 0) return;
      const viewport = node.closest('[data-slot="aui_thread-viewport"]');
      if (!viewport || viewport.scrollTop > TOP_EDGE_PX) return;
      if (transcriptTailStore.getState().hasMore) {
        void loadOlderTranscript();
        return;
      }
      if (windowStartRef.current <= 0) return;
      setRenderBudget(expandBudget);
    };
    node.addEventListener('wheel', onWheel, { passive: true });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  // 时间线标记按「第几条消息之前」分桶（ZCode `lightBoundary` 语义：模型
  // 切换落在轮顶，渲染在该轮 user 气泡之前）。尾部水合时下标按
  // `loadedCount - fromEnd` 换算——见 bucketMarkers 注释。
  const markers = useTimelineMarkers();
  const buckets = useMemo(
    () => bucketMarkers(markers, ids.length),
    [markers, ids.length],
  );

  // 消息 id → thread 全局下标。`beforeMessageIndex` 与 `pi_get_messages`
  // 的顺序对齐，而 `ids` 就是同一序列（水合 + 流式追加都按序），所以
  // 直接用下标即可，不必再查 Map。
  // `beforeMessageIndex === ids.length` 的标记落在**全部消息之后**（最后
  // 一轮收尾后的模型切换，为下一轮准备的）——挂在列表末尾，不静默丢弃。
  const tailMarkers = buckets.get(ids.length);
  // 压缩完成后会话条目会落成 tail compact marker（`pi_get_timeline_markers`
  // 在 run 收尾后刷新）；此时实时投影还挂着同一事件的 end 快照。两者同壳，
  // 保留历史 marker（真源），隐掉实时行，避免末尾两条「已压缩」。
  const hasTailCompactMarker =
    tailMarkers?.some((m) => m.marker.kind === "compact") === true;
  return (
    <div ref={listRef} className="contents">
      {(window_.windowed || hasOlderHistory) && (
        <div className="flex justify-center py-1">
          <Button onClick={showEarlier} size="sm" type="button" variant="ghost">
            显示更早的消息
          </Button>
        </div>
      )}
      {turns.slice(window_.startTurn).map((turn, i) => {
        // 该轮首条消息的全局下标
        const firstIdx = ids.indexOf(turn.messageIds[0] ?? "");
        const turnIndex = window_.startTurn + i;
        const turnMarkers = firstIdx >= 0 ? buckets.get(firstIdx) : undefined;
        return (
          <div
            key={turn.key}
            data-slot="aui_turn"
            data-turn-key={turn.key}
            data-turn-has-user={turn.userId ? "true" : "false"}
            data-turn-last={turnIndex === turns.length - 1 ? "true" : "false"}
            // ZCode 同 turn flow items 实测间距 20px（user 气泡底 →「已工作」
            // 头顶 = 20）；宿主根字号 15px 下 gap-y-6 会变成 22.5px。
            className="group/turn flex flex-col gap-y-[20px]"
          >
            {turnMarkers?.map((m, i) => (
              <TimelineMarkerRow
                key={`${m.marker.kind}-${m.marker.beforeMessageIndex}-${i}`}
                marker={m.marker}
                prevModel={m.prevModel}
              />
            ))}
            {turn.messageIds.map((id) => (
              <ThreadPrimitive.Unstable_MessageById
                key={id}
                messageId={id}
                components={{ Message: MessageWithDaySeparator }}
              />
            ))}
          </div>
        );
      })}
      {tailMarkers?.map((m, i) => (
        <TimelineMarkerRow
          key={`tail-${m.marker.kind}-${m.marker.beforeMessageIndex}-${i}`}
          marker={m.marker}
          prevModel={m.prevModel}
        />
      ))}
      {/* 压缩事件（CUSTOM name=compaction）：发生在轮外、没有消息下标，
          落在列表末尾（= 最新事件的位置），与历史 compact marker 同一壳体。
          end 相在有 tail marker 时由组件自己让位（避免末尾重复）。 */}
      <LiveCompactionRow hasTailCompactMarker={hasTailCompactMarker} />
    </div>
  );
};

// ── empty-state（官方元素，挂 Welcome 槽位）────────────────────────────
// 只有问候语 + 起步建议；发送走 aui.thread.append = 现有发送通道（onNew → POST）。
// 2026-10-16：移除原挂的罐头 composer（见下方 EmptyStateWelcome 注释）。
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
      {/* 2026-10-16 去重：此处原挂 <EmptyStateComposer>——它是上游给
          "无底部 composer 场景"准备的**罐头输入框外观**（纯展示、onSend 即发），
          与页面底部真正的 ComposerBar 叠成两个输入框（用户实测："上面怎么还有
          一个输入框"）。
          hermes 参考：其新会话页不放该元素（全仓无 EmptyStateComposer 引用），
          只留底部 composer。故本处移除；组件本体在 elements/empty-state.tsx
          原样保留（上游原件不动），仅停止消费。
          起步提示仍由下方建议按钮承担（点击 append）。 */}
    </EmptyState>
  );
};

// ── chat.empty 贡献槽（2026-11-17）──────────────────────────────────────────
// 上游语义（components/assistant-ui/thread/index.tsx:166）：**草稿**（无会话）
// 看核心 splash；**已存在但为空**的会话交给 chat.empty 贡献（hermes-bots 的
// BotChatEmpty 用机器人名字/头像替换 splash）。宿主对偶 = 有活动会话 id 时
// 挂贡献（每个都挂，返回 null 即不渲染——上游同款：各贡献自行认领自己的
// 会话，首个认领不到的不能压掉真正的主人），无会话 id 时保留核心欢迎屏。
const CHAT_EMPTY_AREA = "chat.empty";

type ChatEmptyRender = (props: { sessionId: string }) => ReactNode;

function ChatEmptyEntry({
  id,
  render,
  sessionId,
}: {
  id: string;
  render: ChatEmptyRender;
  sessionId: string;
}) {
  // 稳定组件身份：每次 render 换闭包会把插件的空态整个重挂（上游同款注释）。
  const Render = useMemo(() => render, [render]);
  return (
    <ContribBoundary id={id} key={id}>
      {/* 插件贡献的宿主树没有 I18nProvider（dockview 的 PluginPane 各自挂）；
          不挂时 `usePluginI18n(id)` 的 locale 恒 DEFAULT_LOCALE('en')——
          BotChatEmpty 的中文文案会显示成英文（2026-11-20 实点发现）。 */}
      <I18nProvider
        configClient={null}
        initialLocale={readLocale() === "zh-CN" ? "zh" : "en"}
      >
        <Render sessionId={sessionId} />
      </I18nProvider>
    </ContribBoundary>
  );
}

const ChatEmptyBody: FC<{ Welcome: ComponentType }> = ({ Welcome }) => {
  const contributions = useContributions(CHAT_EMPTY_AREA);
  // 宿主的活动会话 id（stored id；pi 的 id 空间单一）。
  const sessionId = useStore(sessionCatalog, (s) => s.activeId);
  if (!sessionId || contributions.length === 0) return <Welcome />;
  return (
    <>
      {contributions.map((contribution) => {
        const render = (contribution.data as { render?: unknown } | undefined)?.render;
        if (typeof render !== "function") return null;
        return (
          <ChatEmptyEntry
            id={contribution.id}
            key={contribution.id}
            render={render as ChatEmptyRender}
            sessionId={sessionId}
          />
        );
      })}
    </>
  );
};

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  scoped = false,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} scoped={scoped} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean; scoped: boolean }> = ({
  isEmpty,
  autoFocus,
  scoped,
}) => {
  // Welcome 默认 = 官方 empty-state 元素（Greeting + 起步建议 + 罐头
  // composer）；消费者仍可经 ThreadComponents.Welcome 整体替换
  const { Welcome = EmptyStateWelcome } = useContext(ThreadComponentsContext);

  // ── 滚动位置按会话持久化（hermes thread-scroll 对标，runtime 代理建店）──
  // 恢复：runtime 在水合/切会话成功后投递 restoreRequest（seq 版一次性），
  // 这里消费——用 'instant'（视口带 scroll-smooth，smooth 会横跨长会话做
  // 动画）。采样：onScroll 300ms 节流写回（offset 存距底距离，上方内容
  // 增删不摇晃阅读位）。
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const restoreRequest = useStore(threadScrollBridge, (s) => s.scrollRestoreRequest);
  // 活动状态面板让位（与 ZCode conversationLayout.ts 逐条对账，2026-11-18）：
  // - 偏移只由"面板在场且非 mini 胶囊"决定（layout != none）；
  // - 偏移类本身是 `@min-[1280px]/conversation:-translate-x-42` —— 容器 <1280
  //   **一律不让位**。ZCode 里无断点的 INLINE_OFFSET 常量是死代码（只有定义，
  //   全仓无使用点），所以钉死形态也不在窄窗让位；
  // - 宽度类在 ZCode 里带不带面板是同一个字符串（面板出现**不收窄**内容列）。
  // 宿主照抄：宽度恒为 --dsh-chat-content-width，只有平移由面板在场决定。
  //
  // **让位必须以"面板真的在场"为前提**（2026-11-02 修）：override 只记录显示
  // 偏好；面板在无内容/draft 时根本不渲染——只看 override 会让"面板没渲染"的
  // 会话把整列推走（用户："对话区怎么靠左边了，间距也没有了"）。
  const statusPanelVariant = useStore(statusPanelStore, (s) => s.override ?? "auto");
  const statusPanelPresent = useStore(statusPanelStore, (s) => s.mounted);
  const statusPanelShift = useMemo(
    () =>
      resolveStatusPanelShift({
        scoped,
        present: statusPanelPresent,
        variant: statusPanelVariant,
      }),
    [scoped, statusPanelPresent, statusPanelVariant],
  );
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restoreRequest) return;
    sessionIdRef.current = restoreRequest.sessionId;
    const el = viewportRef.current;
    if (!el) return;
    const saved =
      getSavedThreadScroll(restoreRequest.sessionId) ??
      ({ mode: "bottom" as const } as const);
    el.scrollTo({ top: threadScrollTargetTop(saved, el), behavior: "instant" });
    threadScrollBridge.getState().consumeRestoreRequest(restoreRequest.seq);
  }, [restoreRequest]);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (scrollTimerRef.current !== undefined)
        clearTimeout(scrollTimerRef.current);
    },
    [],
  );
  const onViewportScroll = useCallback(() => {
    const el = viewportRef.current;
    const sid = sessionIdRef.current;
    if (!el || !sid || scrollTimerRef.current !== undefined) return;
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = undefined;
      const elNow = viewportRef.current;
      if (!elNow) return;
      saveThreadScroll(sid, classifyScrollState(elNow));
    }, 300);
  }, []);

  // 对话宽度轴（dsh ConversationRoot 移植，见 width-handle.tsx）：观察列宽
  // 发布 --dsh-chat-user-width / --dsh-conversation-column-width，供手柄
  // 拖拽与 CSS 宽度轴消费
  const widthAxis = useConversationWidthAxis();
  // scoped（v7.4 会话分栏）：跳过主会话管理 chrome——检查点/会话线谱系/
  // 队列/成本/中断横幅的桥是主会话单例（分栏各自会话不投影）；消息/
  // composer/思考指示/建议全部照常（分栏是完整 chat）。错误横幅同跳
  // （error-bridge 主会话单例；分栏 run 失败经消息流 Stop 行可见）。

  return (
    // asChild：Thread 不渲染自己的 div，行为合并到我们传入的容器上
    // （FlexLayout tab content 就是滚动/布局容器——官方"已有容器"场景）
    <ThreadPrimitive.Root asChild>
      <div
        ref={widthAxis.rootResizeRef}
        // 让位形态写在这里：panes.css 的 --dsh-column-width / --dsh-panel-offset
        // 由它选择（面板在场且非胶囊 → "wide"，仅 ≥1280 平移；与 ZCode 对账）。
        data-status-panel-shift={statusPanelShift.offset ? "wide" : undefined}
        className="aui-root aui-thread-root bg-transparent @container relative flex h-full flex-col"
        style={{
          // 可读列宽 = dsh 对话宽度轴（width-handle.tsx：拖拽手柄发布
          // --dsh-chat-user-width，自适应回退 = 列宽 64% 夹 [330,920]）。
          // composer 与消息同列，自动跟随。
          ["--composer-bg" as string]:
            "color-mix(in oklab, var(--color-muted) 30%, transparent)",
          ["--composer-radius" as string]: "32px",
          ["--composer-padding" as string]: "12px",
        }}
      >
        <ConnectionBanner />
        <ThreadPrimitive.Viewport asChild turnAnchor="top">
          <div
            ref={viewportRef}
            onScroll={onViewportScroll}
            data-slot="aui_thread-viewport"
            className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
          >
        <div
          className={cn(
            // 基础列：居中 + 行长上限（--dsh-chat-content-width 由宽度手柄
            // 的拖拽偏好/列宽自适应决定，见 panes.css）。
            "mx-auto flex w-full max-w-(--dsh-chat-content-width) flex-1 flex-col px-4 pt-4",
            // 活动状态面板让位（与 ZCode conversationLayout.ts 对账，2026-11-18）：
            // - 让位类只有一条 `@min-[1280px]/thread:-translate-x-[10.5rem]`
            //   （= 上游 `@min-[1280px]/conversation:-translate-x-42`）；容器
            //   <1280 一律不平移，钉死形态也一样（上游无断点的 INLINE_OFFSET
            //   常量是死代码）。
            // - 宽度**不随面板收窄**（上游 WITH/WITHOUT 宽度类内容相同）。
            // - 平移只在容器 ≥1280 生效（CSS 容器查询）；钉死形态也一样。
            // - 宽度不随面板收窄；只有平移。
            // 顶部余隙：胶囊（mini 恒为胶囊；auto 在 <1280 收胶囊）需要，
            // 展开面板不需要。值 = 上游 `pt-14`（conversationLayout.ts 的
            // TOP_CLEARANCE，胶囊底边 ~50px 之上）。
            statusPanelShift.topClearance === "below-wide" && "@max-[1279px]/thread:pt-14",
            statusPanelShift.topClearance === "always" && "pt-14",
            isEmpty && "justify-center",
          )}
          data-column-shift={statusPanelShift.offset ? "wide" : undefined}
        >
          <AuiIf condition={isNewChatView}>
            <ChatEmptyBody Welcome={Welcome} />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          {!scoped && (
            <>
              {/* 检查点工具条（pi checkpoint/rewind 命令面）：打点 / 回退面板
                  入口，消息区顶部工具位（SessionLineBar 旁） */}
              <CheckpointBar />

              {/* 会话线谱系条（会话级 fork 语义）：仅当前会话是 fork 子会话时
                  渲染；消息级变体走助手消息 footer 的 MessageVariantPicker */}
              <SessionLineBar />
            </>
          )}

          {/* 计划审批卡已删（2026-11-15）：rpi-plan-mode 没有宿主审批闸
              （plan_mode_complete 直接存盘退出，Rust `pi_decide_plan` 恒 Err，
              `planPending` 恒 null）——卡片永远不会出现，属于死功能。 */}

          {/* GPT-Live 委托回路驱动（2026-11-12）：面板写 pendingDelegation →
              这里消费（busy 先 cancelRun → aui.thread.append 提交）→ 回复经
              200ms tick 句界 speak 回语音。无会话 = no-op。 */}
          <VoiceLiveConversationDrive />

          <div
            data-slot="aui_message-group"
            // ZCode 实测（9444）：每个 turn 是独立 SECTION，`pt-56 pb-20`，
            // 相邻轮之间 = 76px。旧值 gap-y-6（根字号 15px 下 22.5px）只有
            // 三分之一，整段对话看起来"挤在一起"。
            className="mb-14 flex flex-col gap-y-[76px] empty:hidden"
          >
            <MessageTurnList />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              // 2026-11-15 用户："对话内容穿透到输入框下面" + "用白色啊"。
              // ZCode 的 composer dock 是白底（bg-background），不是外壳灰。
              // 用 --surface（白）做遮罩：滚动内容在输入区边界消失，颜色与
              // ZCode 一致；顶部 4px 白→透明渐隐，不硬切。
              "aui-thread-viewport-footer relative flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              "bg-[var(--surface)]",
              "before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-gradient-to-t before:from-[var(--surface)] before:to-transparent before:content-['']",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            <ThreadFollowupSuggestions />
            {/* 运行状态（2026-11-15 用户定稿）：ZCode 的「工作中 N」挂在
                **输入框上方**，不在消息流里。全线程只有一个实例（gated by
                thread.isRunning），轮内不再放第二个。 */}
                        <ThreadThinkingIndicator />
            {/* 引擎装配在途（peek 已画但 pi_open_session 未返回）：如实提示，
                避免用户对着可输入但发送要等的界面干等。 */}
            <EngineAttachHint />
            {!scoped && (
              <>
                <RunErrorBar />
                <StoppedRunBanner />
                <ApprovalCards />
                <AskCards />
                {/* 新建任务行（2026-11-01 用户："选择文件夹和压缩会话应该在
                    一排，压缩在选择文件夹后面不是上面"）：文件夹位置 chip 在
                    前、会话维护条在后。chip 组件内部按 activeId===null 自我
                    裁剪（有会话时行里只剩维护条）；运行态维护条渲染 null。 */}
                <div className="flex w-full flex-wrap items-center gap-1.5" data-slot="aui_composer-side-row">
                  <WorkspaceComposerMenu />
                  {/* 双工语音字幕条（2026-11-14：入口钮迁列头 workspace 行——
                      用户定稿"项目名右边，像微信语音通话钮"；字幕条/红显留
                      composer，钮与字幕条经 voiceLiveStore 传话）。 */}
                  <VoiceLivePanel />
                  {/* 会话维护条（手动压缩 / 撤销 / 重做）：pi 有这些能力但
                      此前无入口（docs/pi-coverage.md 缺口）。只在非运行态显示
                      ——运行中压缩会与自动压缩打架，撤销会与工具写入竞争。 */}
                  <SessionMaintenanceBar />
                </div>
                {/* 运行成本（cost-meter）已按用户要求移除（2026-11-15）；
                    排队消息（message-queue）保留在 composer 上方 */}
                <MessageQueueWired />
              </>
            )}
            <ComposerWired />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
          </div>
          </div>
        </ThreadPrimitive.Viewport>
        {/* 对话宽度手柄（dsh ConversationRoot 同款：左右各一条，拖拽 =
            对称缩放内容宽并持久化；仅对话在屏时渲染——新会话 hero 无列） */}
        {!isEmpty &&
          (['left', 'right'] as const).map((side) => (
            <WidthHandle
              key={side}
              side={side}
              // 让位时的位移/收窄由 panes.css 按 --dsh-column-width 与
              // --dsh-panel-offset 计算（与内容列同源），这里不再传类——
              // 传了就成第二个写入者，两边必然漂移。
              onStart={widthAxis.onHandleStart}
              onDrag={widthAxis.onHandleDrag}
              onCommit={widthAxis.onHandleCommit}
              onEnd={widthAxis.onHandleEnd}
            />
          ))}
        {/* 轮导航器（ZCode ConversationTurnNavigator）：左缘竖条 mini-map，
            悬停预览、点击跳轮；≥864px 容器宽且 ≥2 条 query 才显示 */}
        {!isEmpty && <TurnNavigator />}
        {/* 框选工具条（ZCode ConversationSelectionTooltip）：选中文字浮出
            复制 / 引用到输入框（ZCode 的任务/侧聊动作宿主没有，不放假入口） */}
        {!isEmpty && <SelectionToolbar />}
        {/* 会话内查找（ZCode TaskFindDialog）：Ctrl/Cmd+F，CSS Custom
            Highlight 高亮，n/m 计数 + ↑↓ 导航 */}
        <ConversationFind />
      </div>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = memo(function ThreadMessage() {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");
  // **空 assistant 消息整条不渲染**（2026-11-02）：`RUN_STARTED` 无条件
  // push 一条 `content: ''` 的 assistant 消息占位；run 直接失败（如
  // SESSION_PERSISTENCE_FAILED / provider 401）时它永远拿不到内容，却仍
  // 占一整条气泡的高度（-mb-7.5/pb-7.5 + footer），视觉上就是"ai 没回复
  // 却留了一块空行"。等第一个 part 到达再渲染（流式首 token 前由底部
  // thinking indicator 表达"在跑"）。
  const hasParts = useAuiState((s) => s.message.parts.length > 0);

  if (isEditing) return <EditComposer />;
  if (isSpoken) return <SpokenMessage />;
  if (role === "user") return <UserMessage />;
  if (!hasParts) return null;
  return <AssistantMessageComponent />;
});
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
          <PhoneIcon className="size-[var(--size-icon-sm)]" aria-hidden />
          <span>Voice conversation</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === "user" ? (
            <MicIcon className="size-[var(--size-icon-md)]" />
          ) : (
            <AudioLinesIcon className="size-[var(--size-icon-md)]" />
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
        <TooltipIconButton tooltip="Copy" className="size-[24px]">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-[14px] animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-[14px] animate-in zoom-in-75 fade-in duration-150" />
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
        <ErrorPrimitive.Root className="aui-message-error-root bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

// 朗读能力门（模块级判定一次）：无语音引擎环境不渲染朗读钮（runtime 侧
// 同门：适配器不注册 → capabilities.speech=false）
const speechSupported = ensureSpeechSupportLogged();

// ── read-aloud（官方元素）：朗读当前消息 ───────────────────────────────
// 播放走核心管道（aui.message.speak/stopSpeaking → runtime adapters.speech
// 的 BoundarySpeechSynthesisAdapter），进度 = speechProgressBridge 的
// boundary charIndex → 词下标映射（segmentSpeechWords：CJK 逐字、其余
// 整段；部分引擎不发 boundary——进度停在起点，播放本身不受影响，诚实
// 不伪造）。elapsed = 朗读计时；duration 传 "–"（Web Speech 不暴露合成
// 时长，不估算）。变速 = 以新 rate 重读（utterance 的 rate 在创建时固定，
// 运行中不可变——诚实于引擎能力）。暂停不支持：Web Speech 的 Utterance
// 接口无 pause/resume 钩子，toggle = 停止/重新开始。
const ReadAloudPanel: FC<{ className?: string }> = ({ className }) => {
  const aui = useAui();
  const text = aui.message.getCopyText();
  const words = useMemo(() => segmentSpeechWords(text ?? ""), [text]);
  // 播放态：bridge 记录"正在读的全文"——与本消息文本一致才算在读本消息
  // （另一消息朗读中时本面板显示未播放）
  const playing = useStore(speechProgressBridge, (s) => s.playing && s.text === text);
  const spokenIndex = useStore(speechProgressBridge, (s) =>
    s.text === text ? wordIndexAt(words, s.charIndex) : 0,
  );
  const [rate, setRate] = useState<number>(() => getSpeechRate());
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!playing) return;
    setElapsedSec(0);
    const timer = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);
  if (!text || words.length === 0) return null;
  const elapsed = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;

  const onToggle = () => {
    if (playing) {
      try {
        aui.message.stopSpeaking();
      } catch (e) {
        // 竞态（朗读恰在点击前结束）：错误可见，不中断面板
        console.error("[aui] 停止朗读失败", e);
      }
      return;
    }
    aui.message.speak();
  };

  const onRateChange = () => {
    const idx = SPEECH_RATES.indexOf(rate);
    const next = SPEECH_RATES[(idx + 1) % SPEECH_RATES.length] ?? SPEECH_RATES[0]!;
    setRate(next);
    setSpeechRate(next);
    if (playing) {
      // 变速重读：先停（若仍在读本消息）再以新 rate 从头合成
      const st = speechProgressBridge.getState();
      if (st.playing && st.text === text) {
        try {
          aui.message.stopSpeaking();
        } catch (e) {
          console.error("[aui] 变速停止朗读失败", e);
        }
      }
      aui.message.speak();
    }
  };

  return (
    <ReadAloud
      data-slot="aui_read-aloud"
      words={words.map((w) => w.word)}
      spokenIndex={Math.max(0, spokenIndex)}
      playing={playing}
      rate={rate}
      elapsed={elapsed}
      duration="–"
      onToggle={onToggle}
      onRateChange={onRateChange}
      className={className}
    />
  );
};

// ── regenerate-menu（官方元素）：换模型重生成 ──────────────────────────
// 模型清单 = model-catalog-store（composer-wired 的 pi_list_models 投影
// 上移共享；目录拉取失败时展开面板重试 load）。onPick =
// aui.message.reload({ runConfig: { custom: { modelOverride } } })——外部
// store runtime 的 startRun 原样透传 runConfig，runtime onReload 探测该
// 键：pi_set_model 成功 → retry_edit → 重发；set_model 失败不重发（错误
// 可见）。只挂最后一条 assistant（ActionBar autohide="not-last"），
// onReload 的 parentId 守卫天然满足。弹层绝对定位锚在触发钮下方（模板
// 默认在流内展开，会把 footer 行撑高）。
const RegenerateMenuWired: FC = () => {
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const entries = useStore(modelCatalogStore, (s) => s.entries);
  const currentId = useStore(modelCatalogStore, (s) => s.currentModel);
  const options = useMemo<readonly RegenerateOption[]>(
    () =>
      toModelOptions(entries).map((o) => ({
        id: o.id,
        label: o.name,
        detail: o.description ?? "",
      })),
    [entries],
  );
  useEffect(() => {
    if (open) void modelCatalogStore.getState().load();
  }, [open]);
  return (
    <RegenerateMenu
      data-slot="aui_regenerate-menu"
      options={options}
      open={open}
      currentId={currentId ?? ""}
      onOpenChange={setOpen}
      onPick={(id) => {
        setOpen(false);
        aui.message.reload({ runConfig: { custom: { modelOverride: id } } });
      }}
      className="relative w-auto [&>*+*]:absolute [&>*+*]:left-0 [&>*+*]:top-full [&>*+*]:z-50 [&>*+*]:mt-1 [&>*+*]:w-60 [&>*+*]:shadow-lg"
    />
  );
};

const AssistantMessage: FC = () => {
  const {
    // 工具渲染默认 = PiToolUI 分流（ZCode 口径：摘要行 + 按需展开正文，
    // bash/powershell 终端、read/ls/image 只读行、grep 系搜索行、
    // edit/write diff、web_search 搜索卡、submit_plan 计划卡、其余
    // presentation 兜底）——消费者传入的 ToolFallback 槽位仍优先
    ToolFallback: ToolFallbackComponent = PiToolUI,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  // 朗读面板开合（footer 朗读钮 ↔ 消息底部 ReadAloud 面板）
  const [readAloudOpen, setReadAloudOpen] = useState(false);

  // ── 轮级操作条：一轮只挂一条（2026-11-02，ZCode
  //    `hideAssistantActions={!item.latest}` 同款）────────────────────
  // 一个 turn 里可以有多条 assistant 消息（工具调用前后各一段文本、
  // 重试产生的兄弟段）。此前**每条**都渲染复制/赞踩/分叉/重试，用户在
  // 一个多轮工具的回复下面看到三四排一样的按钮。
  // ZCode 的口径：只有「本轮最后一条有正文的 assistant」挂操作条，
  // 中途段不挂。判定见 `turn-units.ts::isLastContentAssistantOfTurn`
  // ——直接吃 MessageState 数组（它自带 role/parts），不额外 map 一遍。
  const isTurnTail = useAuiState((s) =>
    isLastContentAssistantOfTurn(s.thread.messages, s.message.index),
  );
  const hasParts = useAuiState((s) => s.message.parts.length > 0);

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={cn(
        "fade-in slide-in-from-bottom-1 animate-in relative duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
        // 只有挂操作条的（轮尾）消息才为 footer 预留 30px——不预留会让
        // 中途段与下一段之间多出一段空气。
        isTurnTail && hasParts && "-mb-7.5 pb-7.5",
      )}
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground text-[14px] leading-[1.75] wrap-break-word"
      >
        {/* 工作项渲染器（2026-11-07）：替换 MessagePrimitive.GroupedParts。
            ZCode 扫描语义——隐藏的思考行（非首条）在扫描前剔除，工具族组
            因此能跨思考行（[思考,bash,思考,bash] → 一个「终端」组）。
            叶子机制与官方逐条对齐（part scope / 注册工具 UI / data 渲染器 /
            indicator），见 work-parts.aui.tsx 模块头。 */}
        <AssistantWorkParts
          ToolFallback={ToolFallbackComponent}
          ReasoningGroup={ReasoningGroup}
          TaskGroup={TaskGroupComponent}
          turnWorkOwner={isTurnTail}
        />
        <MessageError />
      </div>

      {/* 停滞指示已删（2026-11-15，用户第二次报"两个工作中"）：ZCode 运行态
          只有一个 ChatLoading（orbs + 工作中 + 计时），且挂在输入框上方
          （用户 2026-11-15："工作中不是在输入框上面吗？"）。消息内不再放
          第二个运行提示，也不在消息里重复一份加载位。 */}

      {/* **已删除 run 级工具时间线**（2026-11-02）：GroupedParts 的
          `group-explore/execute/changes` 分支已经渲染了本消息的全部工具行
          （ToolFamilyGroup → 子工具行），再挂一条聚合时间线就是**同一批
          工具调用渲染两遍**（用户："ass上百个消息组件……现在消息显示的有问题"）。
          ZCode 的对照口径：工具只以分组父行 + 子行出现一次，没有额外的
          run 级时间线摘要。 */}

      {/* 停滞指示已删（2026-11-15，用户第二次报"两个工作中"）：ZCode 运行态
          只有一个 ChatLoading（轮尾 orbs + 工作中 + 计时），消息内不再叠
          "仍在工作"——那会让流式期间同时出现两处运行提示。 */}

      {/* run 级 usage（官方 message-timing 元素）——只在最后一条 assistant */}
      <RunTiming />

      {/* 轮尾文件变更汇总（ZCode `ConversationFileSummaryPanel`）：只在
          轮尾消息渲染（isTurnTail 与操作条同门），**排在操作条之前**——
          ZCode 的明确排序理由：summary 在 bar 前面，读起来 summary 才是
          本轮收尾。数据面 turn-file-changes.ts（从本 turn 的工具结果现场
          聚合，不编造）。 */}
      {isTurnTail && hasParts && <TurnFileSummary />}

      <div
        data-slot="aui_assistant-message-footer"
        data-turn-tail={isTurnTail ? "1" : "0"}
        data-has-parts={hasParts ? "1" : "0"}
        // ZCode `ConversationAssistantTextActions`：与正文同 x（无缩进）、
        // 整条 h24、gap4，且默认 opacity-0，悬停 assistant turn 才显形。
        className={cn(
          "flex items-center gap-[4px] opacity-0 transition-opacity group-hover/turn:opacity-100",
          ACTION_BAR_HEIGHT,
        )}
      >
      {/* **空消息不挂操作条**（2026-11-02）：`RUN_STARTED` 会无条件 push
          一条 `content: ''` 的 assistant 消息，run 直接失败（如
          SESSION_PERSISTENCE_FAILED）时这条消息永远拿不到内容，却照样
          渲染复制/赞踩/分叉/重试一排按钮——用户看到的就是"ai 没回复，
          下面还是一串按钮，而且是乱的"。
          ZCode 同判：`latestAssistantTextRow?.state === "complete" &&
          assistantCopyText !== undefined`（没有正文 = 没有操作条）。
          第二道门 `isTurnTail`：一轮只挂一条（中途 assistant 段不挂）。 */}
        <AuiIf condition={(s) => s.message.parts.length > 0 && isTurnTail}>
          <AssistantActionBar
            readAloudOpen={readAloudOpen}
            onReadAloudToggle={() => setReadAloudOpen((o) => !o)}
          />
        </AuiIf>
      </div>

      {/* 朗读面板（官方 read-aloud 元素）：footer 朗读钮展开，挂消息底部 */}
      {readAloudOpen && (
        <ReadAloudPanel className="mt-1 w-full max-w-none rounded-xl" />
      )}
    </MessagePrimitive.Root>
  );
};

// 消息操作条（官方 message-actions 元素）。顺序照 ZCode
// `ConversationAssistantTextActions`：复制 → 赞 → 踩 → 分叉 → 时间。
// - 重新生成/更多是宿主的补充入口（ZCode 产品面没有 retry 与 `…` 菜单，
//   但宿主已有 regenerate-menu 与 ExportMarkdown 落地，保留在本条后面）。
// - 分叉 = 该轮最后一条 user 消息的 fork 点开新会话（ZCode 的
//   `forkAssistant` 语义）；fork 点未落盘时按钮禁用，不假装可点。
// - 时间放本条末尾（ZCode：只读元数据，不增加可点击区域）。
// feedback 能力未接入（无 FeedbackAdapter）时隐藏反馈钮（aui-hide-reactions，
// overlays.css）——与旧版 AuiIf capabilities.feedback 门控等价。
const MessageTimeLabel: FC = () => {
  const createdAt = useAuiState(
    (s) => s.thread.messages[s.message.index]?.createdAt,
  );
  const label = useMemo(() => {
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime()))
      return null;
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(createdAt);
  }, [createdAt]);
  if (!label) return null;
  return (
    <span
      data-slot="aui_message-time"
      // ZCode 实测（9444）：消息时间 12/18、text-foreground-subtlest、
      // 紧跟在动作钮之后（无额外内距）。旧值 0.6875rem（10.3px）+ px-1 偏小偏散。
      className="text-muted-foreground/50 select-none text-[12px] leading-[18px] tabular-nums"
    >
      {label}
    </span>
  );
};

/** 本轮分叉目标 = 本 assistant 消息之前最近的一条 user 消息。 */
const useTurnForkTarget = () => {
  const userOrdinal = useAuiState((s) => {
    let count = 0;
    const msgs = s.thread.messages;
    for (let i = 0; i < s.message.index && i < msgs.length; i++) {
      if (msgs[i]?.role === "user") count++;
    }
    return count - 1;
  });
  const messageText = useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = s.message.index - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== "user") continue;
      if (typeof m.content === "string") return m.content;
      return m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
    }
    return null;
  });
  const forkable = useStore(branchBridge, (s) => {
    if (userOrdinal < 0 || messageText === null) return false;
    const point = s.forkPoints[userOrdinal];
    return point !== undefined && point.text === messageText;
  });
  const fork = () => {
    if (userOrdinal < 0 || messageText === null) {
      console.error("[aui] fork：无法定位本轮 user 消息的序号/文本——取消");
      return;
    }
    branchBridge.getState().requestFork(userOrdinal, messageText);
  };
  return { forkable, fork };
};

const AssistantActionBar: FC<{
  readAloudOpen: boolean;
  onReadAloudToggle: () => void;
}> = ({ readAloudOpen, onReadAloudToggle }) => {
  const aui = useAui();
  const isCopied = useAuiState((s) => s.message.isCopied);
  const feedbackEnabled = useAuiState((s) => s.thread.capabilities.feedback);
  const { forkable, fork } = useTurnForkTarget();
  const [reaction, setReaction] = useState<Reaction>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  /** 隐藏的官方 ExportMarkdown 触发器：菜单项先补全历史，再程序化点击它。 */
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
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

  const onMore = () => {
    // 模板的 More 是回调式按钮——经隐藏的 ActionBarMorePrimitive.Trigger
    // 复用官方 ExportMarkdown 弹层（display:none 元素可程序化 click）
    moreTriggerRef.current?.click();
  };

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      // ZCode 实测（9444）：动作条**常驻 DOM、悬停才显示**
      // （`opacity-0 group-hover/assistant-turn:opacity-100`）。
      // autohide="always" 在 assistant-ui 里是**卸载**（Root 直接 return null），
      // 悬停时整行高度会跳一下，没有淡入——故用 never + CSS 透明度。
      autohide="never"
      className="aui-assistant-action-bar-root text-muted-foreground col-start-3 row-start-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/turn:opacity-100"
    >
      <MessageActions
        copied={isCopied}
        reaction={reaction}
        regenerating={false}
        onCopy={onCopy}
        onReactionChange={onReactionChange}
        onMore={onMore}
        onFork={fork}
        forkable={forkable}
        className={cn(!feedbackEnabled && "aui-hide-reactions")}
      />
      {/* 换模型重生成（官方 regenerate-menu 元素）：reload 带
          runConfig.custom.modelOverride → runtime onReload 探测后
          pi_set_model + 重发。图标 = Shuffle（与「重新生成」的 ↻ 区分）。 */}
      <RegenerateMenuWired />
      {/* 朗读（官方 read-aloud 元素入口）：无语音引擎环境隐藏（能力门） */}
      {speechSupported && (
        <TooltipIconButton
          tooltip={readAloudOpen ? "关闭朗读" : "朗读"}
          aria-pressed={readAloudOpen}
          onClick={onReadAloudToggle}
        >
          <Volume2Icon className="size-[14px]" />
        </TooltipIconButton>
      )}
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
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl p-1.5 shadow-(--shadow-pop)"
        >
          {/* 导出：Tail 水合后 store 只有尾部一页——先补全历史再触发官方导出
              （导出是显式全量消费面，不允许无声截断）。 */}
          <ActionBarMorePrimitive.Item
            className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            onClick={() => {
              void ensureFullTranscript()
                .catch((e) => console.error('[export] 全量历史加载失败——按已加载内容导出', e))
                .finally(() => exportTriggerRef.current?.click())
            }}
          >
            <DownloadIcon className="size-[var(--size-icon-lg)]" />
            Export as Markdown
          </ActionBarMorePrimitive.Item>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
      {/* 官方导出按钮藏在 DOM 里，由「Export as Markdown」菜单项在补全历史后
          程序化触发（Tail 水合后 store 只有尾部一页，不能让导出静默截断）。 */}
      <span aria-hidden="true" className="hidden">
        <ActionBarPrimitive.ExportMarkdown asChild>
          <button ref={exportTriggerRef} tabIndex={-1} type="button" />
        </ActionBarPrimitive.ExportMarkdown>
      </span>
      {/* 时间放**整条末尾**（ZCode 口径：只读元数据，跟在所有操作之后；
          原先夹在操作钮中间，用户实报"时间位置不对/像在上面"2026-11-15）。 */}
      <MessageTimeLabel />
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

// ── 消息级变体切换（retry 语义，官方 message-branches 模板）──────────
// 挂**user 消息** footer：pi 的分支模型是"从分叉点 user turn 长出的续接
// 分支"（每条分支以各自的新 user 消息开头——retry_edit 把叶移到该 user
// turn 的父级，重发即兄弟；fork 点之后的多条线同理），不是"同一 user 的
// 多个 assistant 回复"，所以变体条的正确锚点是分叉点那条 user 消息。
// 显示条件：本条 user 消息的 entryId（经 forkPoints 序号映射）===
// branches.forkPointId 且分支数 > 1。切换 = pi_switch_branch（runtime
// 执行器：守卫 + 重水合）。会话级 fork（新会话文件）在 SessionLineBar /
// 侧栏，两种语义不共用一个件。
const MessageVariantPicker: FC = () => {
  const userOrdinal = useAuiState((s) => {
    let count = 0;
    const msgs = s.thread.messages;
    for (let i = 0; i <= s.message.index && i < msgs.length; i++) {
      if (msgs[i]?.role === "user") count++;
    }
    return count - 1;
  });
  // 选择器只取稳定引用（zustand v5 Object.is 比较——选择器里返回新对象
  // 会无限重渲），视图在组件体计算并 memo
  const branches = useStore(branchBridge, (s) => s.branches);
  const forkPoints = useStore(branchBridge, (s) => s.forkPoints);
  const entryId =
    userOrdinal >= 0 ? forkPoints[userOrdinal]?.entryId : undefined;
  const view = useMemo(() => {
    if (!entryId || !branches) return null;
    if (branches.forkPointId !== entryId || branches.branches.length < 2)
      return null;
    return toBranchPickerView(branches);
  }, [entryId, branches]);
  if (!view) return null;
  return (
    <MessageBranches
      data-slot="aui-message-variant-picker"
      variants={view.variants}
      index={view.index}
      onIndexChange={(index) => {
        const leaf = branchBridge.getState().branches?.branches[index];
        if (!leaf) {
          console.error(`[aui] 变体选择越界（index=${index}）——忽略`);
          return;
        }
        branchBridge.getState().requestSwitch(leaf.leafId);
      }}
      className="max-w-none"
    />
  );
};

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = memo(function UserMessage() {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/user-row fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper col-start-2 min-w-0">
        {/* ZCode 实测（9444）：气泡四角统一 24px、无描边、py-12/px-16、
            text-ui-base 14/21。此前照旧版记的 24 + top-right 6 与 1px 描边
            都和现状不符（现在 ZCode 的 rounded-tr-xs 被 rounded-xl 覆盖，
            border 宽度为 0）。 */}
        <div className="aui-user-message-content bg-muted text-foreground rounded-[24px] px-[16px] py-[12px] text-[14px] leading-[21px] wrap-break-word empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart, Quote: QuoteBlock }}
          />
        </div>
      </div>

      {/* 用户消息操作条（复制/编辑）：**气泡下方、右对齐**（ZCode
          `ConversationRowView` 的 user row 同款——RowShell 是
          `flex flex-col items-end`，MessageActions 直接排在气泡之后）。
          旧实现在气泡左侧垂直居中（`absolute start-0 top-1/2
          -translate-x-full`），鼠标要先移到气泡左边才找得到，与 ZCode 不符。 */}
      <div
        data-slot="aui_user-action-bar"
        className="col-start-2 mt-1 flex justify-end"
      >
        <UserActionBar />
      </div>

      {/* 变体条独立成行：限定在气泡所在列（col-start-2）并跟随气泡右缘
          （justify-end）——col-span-full 会铺满整行，长变体文本从行左缘起
          排，视觉上挂在气泡左侧。empty:hidden：无变体时不占一行网格间隙。 */}
      <div
        data-slot="aui_user-branch-picker"
        className="col-start-2 mt-1 flex justify-end empty:hidden"
      >
        <MessageVariantPicker />
      </div>
    </MessagePrimitive.Root>
  );
});

const UserActionBar: FC = () => {
  const aui = useAui();
  // 复制（ZCode user hover 条=复制+编辑——补齐 Copy；copied 态 1.5s 复位，
  // 失败 console.error 可见）
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
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
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== undefined)
          clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = undefined;
          setCopied(false);
        }, 1500);
      })
      .catch((e) => console.error("[aui] 用户消息复制失败", e));
  };
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
      // ZCode 的用户消息操作条**常驻 DOM、悬停才显示**（`opacity-0
      // group-hover/user-row:opacity-100`），不看它是不是最后一条。
      // autohide="always" 在 assistant-ui 里是卸载（悬停时行高跳变），
      // 与 assistant 条同一处理：never + CSS 透明度。
      autohide="never"
      // ZCode `MessageActions` 是**横排**（复制 → 编辑），旧实现 `flex-col`
      // 把两枚钮竖着叠在气泡左侧。
      className="aui-user-action-bar-root text-muted-foreground mt-[4px] flex items-center gap-[4px] opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/user-row:opacity-100"
    >
      <TooltipIconButton
        tooltip={copied ? "已复制" : "复制"}
        className="aui-user-action-copy"
        onClick={onCopy}
      >
        {copied ? (
          <CheckIcon className="size-[14px]" />
        ) : (
          <CopyIcon className="size-[14px]" />
        )}
      </TooltipIconButton>
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑" className="aui-user-action-edit">
          <PencilIcon className="size-[14px]" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
      <TooltipIconButton
        tooltip="从此分支探索"
        className="aui-user-action-fork"
        disabled={!forkable}
        onClick={onFork}
      >
        <GitBranchIcon className="size-[14px]" />
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
