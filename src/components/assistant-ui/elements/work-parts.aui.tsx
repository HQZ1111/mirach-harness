"use client";

/**
 * 助手消息工作区渲染（2026-11-15 重写：ZCode 对话工作区的完整复刻；
 * 同日恢复 ZCode 的**两层工作过程结构**）。
 *
 * ## 两层结构（ZCode 源码事实）
 *
 * 1. **外层（每 turn 一个）**：`WorkSegmentGroup` —
 *    `AssistantHistoryStatus` 同款，只有状态/时长（`已停止` / `已工作 N` /
 *    `已处理`），**运行中不建头**（`ConversationTurnGroup.tsx:540-630`）；
 *    running 时内容恒开，运行反馈只有轮尾 ChatLoading 一处。
 * 2. **内层（按连续摘要行分段）**：`SummaryRunView` → `ConsecutiveSummaryGroup`
 *    （`ToolSummaryRow.tsx:261-381`）。组头是统计
 *    「已查阅 N 项，已执行 M 命令，已修改 K 文件」；组内 < 2 直接平铺；
 *    正文/子代理/未归类工具是边界，组之间内联渲染
 *    （`conversationAssistantWorkItems.ts:157-178`）。只有「组尾行 ==
 *    整轮尾行且轮 running」的尾组，收起头才滚动当前活动项。
 *
 * 宿主对应物：历史会话在 `pi-hydrate.ts` 里把连续 assistant 消息合并成一条
 * TurnMessage（实时路径 run 本来就是一条），故本文件按**一条消息**切分：
 * `splitWorkParts` 找到最后一条非空 text 部件，它之前的一切进工作段。
 *
 * ## 叶子机制（与官方逐条对齐，未变）
 *
 * part scope（PartByIndexProvider 的公开 API 复刻）、注册工具 UI 优先、
 * data 渲染器具名优先、indicator 判据 —— 全部保留。
 * 文件 chip（组头折叠 change 摘要）点击走 `openFileFromToolPath` → 预览
 * 面板（代码查看器）。
 */

import { useMemo, type ComponentType, type FC, type PropsWithChildren, type ReactNode } from "react";
import {
  AuiConfig,
  AuiProvider,
  Derived,
  useAui,
  useAuiState,
} from "@assistant-ui/store";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  BrainIcon,
  FilePenIcon,
  FilePlusIcon,
  ListChecksIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import {
  activeSummaryIndex,
  buildWorkSummaryItems,
  classifySummaryCategory,
  formatSummaryStatistics,
  isSubagentToolName,
  isTailSummaryGroup,
  isTodoToolName,
  summaryChangeFiles,
  summaryIconIndex,
  summaryFileLeafName,
  type SummaryPartLike,
} from "@/components/assistant-ui/work-summary";
import {
  resolveWorkSegmentStatus,
  splitWorkParts,
  workSegmentDefaultOpen,
  type WorkPartLike,
} from "@/components/assistant-ui/work-segment";
import { SummaryPreviewContext } from "@/components/assistant-ui/summary-preview-context";
import {
  CollapsedChangeLabel,
  ConsecutiveSummaryGroup,
} from "@/components/assistant-ui/elements/summary-group.aui";
import { openFileFromToolPath } from "@/components/assistant-ui/open-file";
import { WorkSegmentGroup } from "@/components/assistant-ui/elements/work-segment.aui";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { resolveReasoningStreamingSummary } from "@/components/assistant-ui/elements/reasoning";
import { File } from "@/components/file";
import { Image } from "@/components/image";
import { MarkdownText } from "@/components/markdown-text";
import { cn } from "@/lib/utils";

/** 兼容旧槽位形状（自定义组渲染器收到的 group 描述）。 */
export interface WorkGroupPart {
  type: string;
  status: { type: string };
  counts: {
    running: number;
    complete: number;
    incomplete: number;
    requiresAction: number;
  };
  indices: readonly number[];
}

export interface AssistantWorkPartsSlots {
  /** 工具渲染兜底（宿主 = PiToolUI 分流；旧 ToolFallback 槽位）。 */
  ToolFallback: ToolCallMessagePartComponent;
  /** 自定义思考分组槽位（保留兼容；默认不提供）。 */
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: WorkGroupPart }>>;
  /** 自定义任务分组槽位（保留兼容；默认不提供）。 */
  TaskGroup?: ComponentType<{ group: WorkGroupPart }>;
  /**
   * 本消息是否是该 turn 的工作段宿主（= 轮尾有正文的 assistant）。
   * 一个 turn 只允许一个总折叠块：轮内更早的 assistant 段（引擎理论上
   * 不产；水合路径已合并）逐项平铺，不再各出一个组头。
   */
  turnWorkOwner?: boolean;
}

// ── part scope（PartByIndexProvider 的公开 API 复刻）──────────────────

const PartScope: FC<PropsWithChildren<{ index: number }>> = ({ index, children }) => {
  const aui = useAui();
  const config = useMemo(
    () =>
      AuiConfig({
        part: Derived({
          source: "message",
          query: { type: "index", index },
          get: (aui0) => aui0.message.part({ index }),
        }),
      }),
    [index],
  );
  return (
    <AuiProvider extends={aui} config={config}>
      {children}
    </AuiProvider>
  );
};

// ── 叶子渲染（scope 内；与官方 MessagePartChildren 同一挂接面）─────────

/** 注册工具 UI / 兜底分流（官方 ToolUIDisplay 的宿主口径）。
 * 工具部件的方法挂接（addResult/resume/respondToApproval）照抄官方
 * `MessagePartChildrenInner`：从 part scope 的 `aui.part` 取方法补上。 */
const ToolLeaf: FC<{ fallback: ToolCallMessagePartComponent }> = ({
  fallback: Fallback,
}) => {
  const aui = useAui();
  const part = useAuiState((s) => s.part);
  const Render = useAuiState((s) =>
    part?.type === "tool-call" ? s.tools.toolUIs[part.toolName]?.[0]?.render : undefined,
  );
  if (!part || part.type !== "tool-call") return null;
  const partMethods = aui.part;
  const full = {
    ...part,
    addResult: partMethods.addToolResult,
    resume: partMethods.resumeToolCall,
    respondToApproval: partMethods.respondToToolApproval,
    ...(partMethods.unstable_recordInteraction && {
      unstable_recordInteraction: partMethods.unstable_recordInteraction,
    }),
  };
  if (Render) return <Render {...full} />;
  return <Fallback {...full} />;
};

/** data 渲染器（官方 getDataRenderer：具名优先、fallbacks[0] 兜底）。 */
const DataLeaf: FC = () => {
  const part = useAuiState((s) => s.part);
  const Render = useAuiState((s) => {
    if (part?.type !== "data") return undefined;
    return (
      s.dataRenderers?.renderers[part.name]?.[0] ?? s.dataRenderers?.fallbacks?.[0]
    );
  });
  if (!part || part.type !== "data" || !Render) return null;
  return <Render {...part} />;
};

/** 思考行（ZCode 组内子行形态）：`思考 持续了几秒` / `思考 持续了 N 秒`，
 * 点击展开思考正文。摘要组的导线由组容器提供，这里不再叠一层缩进。 */
const ReasoningLeaf: FC = () => {
  const part = useAuiState((s) => s.part);
  const streaming = part?.type === "reasoning" && part.status?.type === "running";
  // 流式但还没有任何思考文本：整块不渲染（避免只有图标和标签的空行）
  if (!part || part.type !== "reasoning") return null;
  if (streaming && part.text.length === 0) return null;
  return (
    <ReasoningRoot streaming={streaming} variant="ghost">
      <ReasoningTrigger active={streaming} streamingText={part.text} />
      <ReasoningContent aria-busy={streaming}>
        <ReasoningText>
          {/* ZCode 的思考正文是**纯文本 + whitespace-pre-wrap**（reasoning.tsx
              注释：thought 很长且流式追加，走 Markdown 每 chunk 重解析会卡）。
              此前这里渲染 MarkdownText，段落被套上 p 的 mb-16 + leading-24.5，
              用户实报"思考的内容分段的间距有点大"。 */}
          {part.text}
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

/** 单个部件叶子（scope 内）。 */
const PartLeaf: FC<{ slots: AssistantWorkPartsSlots }> = ({ slots }) => {
  const part = useAuiState((s) => s.part);
  if (!part) return null;
  switch (part.type) {
    case "text":
      return <MarkdownText />;
    case "reasoning":
      return <ReasoningLeaf />;
    case "tool-call":
      return <ToolLeaf fallback={slots.ToolFallback} />;
    case "data":
      return <DataLeaf />;
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
    default:
      return null;
  }
};

const PartLeafAt: FC<{ index: number; slots: AssistantWorkPartsSlots }> = ({
  index,
  slots,
}) => (
  <PartScope index={index}>
    <PartLeaf slots={slots} />
  </PartScope>
);

// ── 摘要组 ────────────────────────────────────────────────────────────

interface RenderCtx {
  parts: readonly SummaryPartLike[];
  slots: AssistantWorkPartsSlots;
}

/** 组头代表图标（ZCode 取原工具 renderer 的图标；宿主按类别给 lucide）。 */
function statisticsIconFor(part: SummaryPartLike | undefined): ReactNode {
  if (!part) return <BrainIcon className="size-4" />;
  if (part.type === "reasoning") return <BrainIcon className="size-4" />;
  const toolName = part.toolName ?? "";
  if (isSubagentToolName(toolName)) return <ListChecksIcon className="size-4" />;
  const category = classifySummaryCategory(part);
  if (category === "change") {
    return toolName === "write" ? (
      <FilePlusIcon className="size-4" />
    ) : (
      <FilePenIcon className="size-4" />
    );
  }
  if (category === "run") return <SquareTerminalIcon className="size-4" />;
  if (category === "session") return <ListChecksIcon className="size-4" />;
  return <SearchIcon className="size-4" />;
}

/**
 * 收起态组头滚动的当前项摘要（ZCode 用摘要预览上下文渲染同一套行）。
 *
 * 思考行显示**流式末行**（ZCode `resolveReasoningStreamingSummary`）：这
 * 就是「折叠时头部显示当前正在跑的内容」；工具行走原摘要行的 preview
 * 分支（图标 + 类别词 + 参数 chip + 状态词）。
 */
const SummaryPreviewRow: FC<{ index: number; ctx: RenderCtx }> = ({ index, ctx }) => {
  const part = ctx.parts[index];
  if (!part) return null;
  if (part.type === "reasoning") {
    const streaming = part.status?.type === "running";
    const summary = streaming
      ? resolveReasoningStreamingSummary(part.text ?? "")
      : null;
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <BrainIcon className="size-4 shrink-0" />
        <span className={streaming ? "shrink-0 shimmer motion-reduce:animate-none" : "shrink-0"}>
          思考
        </span>
        {summary ? (
          <>
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate">{summary.text}</span>
          </>
        ) : null}
      </span>
    );
  }
  return (
    <PartScope index={index}>
      <SummaryPreviewContext.Provider value={true}>
        <PartLeaf slots={ctx.slots} />
      </SummaryPreviewContext.Provider>
    </PartScope>
  );
};

/** 收起态组头滚动项的动画 key：思考按流式末行滚动，其余按项身份。 */
function previewKeyFor(part: SummaryPartLike | undefined, index: number): string {
  if (part?.type === "reasoning" && part.status?.type === "running") {
    const line = resolveReasoningStreamingSummary(part.text ?? "");
    return `reasoning:${index}:${line?.key ?? ""}`;
  }
  return `summary:${index}`;
}

/**
 * 一段连续摘要行 → `ConsecutiveSummaryGroup`（ZCode
 * `ConversationAssistantWorkContent` 的 group 分支）。
 *
 * - 组内 < 2：**直接渲染该行，不建组头**（ZCode `items.length < 2`）；
 * - `groupRunning = 轮仍 running && 组尾行 == 整轮尾行`（ZCode
 *   `tailRowId === lastRowId && taskRunning`）——只有尾组可滚动当前项，
 *   其余组收起恒显示统计；
 * - 统计只在这里产生（外层头只有时长/状态）。
 */
const SummaryRunView: FC<{
  indices: readonly number[];
  ctx: RenderCtx;
  running: boolean;
  /** 整轮最后一个可见行（正文也参与）；组尾等于它才是 running 组。 */
  turnTailIndex: number;
}> = ({ indices, ctx, running, turnTailIndex }) => {
  if (indices.length < 2) {
    return <PartLeafAt index={indices[0]!} slots={ctx.slots} />;
  }
  const groupRunning = isTailSummaryGroup({
    running,
    groupLastIndex: indices[indices.length - 1]!,
    turnTailIndex,
  });
  const completed = !groupRunning;
  const statistics = formatSummaryStatistics(ctx.parts, indices, completed);
  const iconIndex = summaryIconIndex(ctx.parts, indices);
  const activeIndex = activeSummaryIndex(ctx.parts, indices);
  const currentIndex = activeIndex ?? indices[indices.length - 1]!;
  const currentPart = ctx.parts[currentIndex];
  const changes = summaryChangeFiles(ctx.parts, indices);
  const collapsedStatistics =
    changes && changes.files.length === 1 && changes.unresolved === 0 && changes.files[0] ? (
      <CollapsedChangeLabel
        label={completed ? "已修改" : "修改"}
        fileName={summaryFileLeafName(changes.files[0].path)}
        additions={changes.files[0].additions}
        removed={changes.files[0].removed}
        onOpen={() => openFileFromToolPath(changes.files[0]!.path)}
      />
    ) : undefined;

  return (
    <ConsecutiveSummaryGroup
      statistics={statistics}
      statisticsIcon={statisticsIconFor(
        iconIndex === undefined ? undefined : ctx.parts[iconIndex],
      )}
      collapsedStatistics={collapsedStatistics}
      groupRunning={groupRunning}
      activeKey={previewKeyFor(currentPart, currentIndex)}
      activeRefreshVersion={currentPart}
      activeSummary={<SummaryPreviewRow index={currentIndex} ctx={ctx} />}
    >
      {indices.map((index) => (
        <PartLeafAt key={index} index={index} slots={ctx.slots} />
      ))}
    </ConsecutiveSummaryGroup>
  );
};

/**
 * 工作段内的渲染项 → 连续摘要组 / 平铺单行。
 *
 * `buildWorkSummaryItems` 只把**连续**摘要行合成 `rows` 项；正文、子代理、
 * 未归类工具、图片是边界（`part` 项），在组之间内联渲染。待办行在扫描时
 * 剔除（不渲染、不断组）。
 */
const WorkItems: FC<{
  indices: readonly number[];
  ctx: RenderCtx;
  running: boolean;
  turnTailIndex: number;
}> = ({ indices, ctx, running, turnTailIndex }) => {
  const items = useMemo(
    () => buildWorkSummaryItems(ctx.parts as readonly SummaryPartLike[], indices),
    [ctx.parts, indices],
  );
  return (
    <>
      {items.map((item) =>
        item.kind === "part" ? (
          <PartLeafAt key={item.key} index={item.index} slots={ctx.slots} />
        ) : (
          <SummaryRunView
            key={item.key}
            indices={item.indices}
            ctx={ctx}
            running={running}
            turnTailIndex={turnTailIndex}
          />
        ),
      )}
    </>
  );
};

// ── 顶层 ─────────────────────────────────────────────────────────────

/** 解析消息级工作段兜底边界（history 水合写 metadata.custom，见
 * `pi-hydrate.ts::convertTurnMessage`）。selector 只取引用稳定的原始值，
 * 派生放 useMemo——不得在选择器里造对象（getSnapshot 缓存契约）。 */
function useWorkBounds(): { startedAt?: number; completedAt?: number } {
  const metadata = useAuiState((s) => s.message.metadata);
  const createdAt = useAuiState((s) => s.message.createdAt);
  return useMemo(() => {
    const custom = (metadata as { custom?: Record<string, unknown> } | undefined)?.custom;
    const startedAt =
      typeof custom?.workStartedAt === "number"
        ? custom.workStartedAt
        : createdAt instanceof Date
          ? createdAt.getTime()
          : undefined;
    const completedAt =
      typeof custom?.workEndedAt === "number" ? custom.workEndedAt : undefined;
    return {
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
  }, [metadata, createdAt]);
}

export const AssistantWorkParts: FC<AssistantWorkPartsSlots> = ({
  ToolFallback,
  ReasoningGroup,
  TaskGroup,
  turnWorkOwner = true,
}) => {
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const bounds = useWorkBounds();

  const slots = useMemo<AssistantWorkPartsSlots>(
    // ReasoningGroup / TaskGroup 槽位保留兼容（宿主无消费者；ZCode 的组头
    // 统计已取代旧的思考分组/任务分组渲染）
    () => ({ ToolFallback, ReasoningGroup, TaskGroup }),
    [ToolFallback, ReasoningGroup, TaskGroup],
  );
  const ctx = useMemo<RenderCtx>(
    () => ({ parts: parts as readonly SummaryPartLike[], slots }),
    [parts, slots],
  );

  // 工作段 = 最后一条非空正文之前的全部部件；正文与之后的部件在折叠区外
  const split = useMemo(() => splitWorkParts(parts), [parts]);
  const status = useMemo(
    () =>
      resolveWorkSegmentStatus(
        parts as readonly WorkPartLike[],
        split.history,
        bounds,
      ),
    [parts, split, bounds],
  );
  const history = useMemo(() => [...split.history], [split]);
  const following = useMemo(() => [...split.following], [split]);

  // 整轮最后一个可见行（正文也参与；待办行不渲染，跳过）——ZCode
  // `getAssistantSummaryTailRowId` 的宿主对应物。只有「组尾行 === 它」且轮
  // 仍 running 的组是 running 组（收起头滚动当前项）；一旦最终正文流出，
  // 尾行变成正文，所有组收起头都回到统计文本（ZCode 同判）。
  const turnTailIndex = useMemo(() => {
    const list = parts as readonly SummaryPartLike[];
    for (let i = list.length - 1; i >= 0; i--) {
      const part = list[i];
      if (part?.type === "tool-call" && isTodoToolName(part.toolName ?? "")) continue;
      return i;
    }
    return -1;
  }, [parts]);

  // 运行中的唯一指示器是轮尾 ChatLoading（orbs + 工作中 + 计时，见
  // ThreadThinkingIndicator）。ZCode 没有第二个 inline typing dots——
  // 这里不再渲染 TypingIndicator，避免出现两处“正在生成”。

  // 没有最终正文 → 强制展开且不可收起（ZCode assistantHistoryDefaultOpen 分支）
  const hasFinalText = split.lastTextIndex >= 0;

  // 非轮尾段：不建外层工作段（一个 turn 只能有一个外层头），但内层连续
  // 摘要组照常。引擎实时路径一个 run 一条 assistant 消息、水合路径已合并
  // 连续 assistant，这个分支只在持有旧快照/未来引擎拆分时才走。
  const allPartIndices = useMemo(
    () => (turnWorkOwner ? [] : parts.map((_, index) => index)),
    [parts, turnWorkOwner],
  );
  if (!turnWorkOwner) {
    return (
      <>
        <div
          data-slot="aui_assistant-work-flat"
          className="flex flex-col gap-5"
        >
          <WorkItems
            indices={allPartIndices}
            ctx={ctx}
            running={running}
            turnTailIndex={turnTailIndex}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {history.length > 0 ? (
        <WorkSegmentGroup
          status={status}
          defaultOpen={workSegmentDefaultOpen(hasFinalText, running)}
          running={running}
        >
          {/* ZCode ConversationAssistantWorkContent 的 gap-1：组与组之间的
              间距由各自组件（组头 + 内容 mt-2）承担，外层不再加导线。 */}
          <div data-slot="aui_assistant-work-items" className="flex flex-col gap-1">
            <WorkItems
              indices={history}
              ctx={ctx}
              running={running}
              turnTailIndex={turnTailIndex}
            />
          </div>
        </WorkSegmentGroup>
      ) : null}
      {hasFinalText ? (
        <div
          data-slot="aui_assistant-work-following"
          className={cn(
            "flex flex-col gap-5",
            // ZCode 外层 flow items 之间是 mt-5（20px）；历史折叠区与最终
            // 正文之间的间距必须与"已工作"头→内容（pb-2 + pt-5）分开算。
            history.length > 0 && "mt-5",
          )}
        >
          <PartLeafAt index={split.lastTextIndex} slots={slots} />
          {following.length > 0 ? (
            <WorkItems
              indices={following}
              ctx={ctx}
              running={running}
              turnTailIndex={turnTailIndex}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
};

// ReasoningContent / ReasoningRoot / ReasoningText / ReasoningTrigger 仍被
// 本模块的理智行经 `ReasoningPart` 间接消费（re-export 供旧调用方）。
export { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger };
