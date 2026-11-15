"use client";

/**
 * 助手消息工作区渲染（2026-11-15 重写：ZCode 对话工作区的完整复刻）。
 *
 * ## 一个 turn 一个工作段
 *
 * ZCode 的 turn = 一条 user 行 + 其后全部 assistant 行；工作段（可折叠的
 * 「已工作 N 分 M 秒」）**整轮只有一个**，折叠区里是「最后一条非空正文之前
 * 的全部部件」（含中间正文），最后正文留在折叠区外（
 * `conversationTurnWorkSegments.ts` 的 assistantHistoryRows / followingRows）。
 *
 * 宿主对应物：历史会话在 `pi-hydrate.ts` 里把连续 assistant 消息合并成一条
 * TurnMessage（实时路径 run 本来就是一条），故本文件按**一条消息**切分：
 * `splitWorkParts` 找到最后一条非空 text 部件，它之前的一切进工作段。
 *
 * ## 组内：连续摘要组（不是旧的「族组」）
 *
 * `work-summary.ts::buildWorkSummaryItems` 扫出「连续可归类行」的运行段：
 * 思考 + explore/run/change 工具。长度 ≥ 2 的运行段合成一个
 * `ConsecutiveSummaryGroup`，组头是跨族统计
 * 「已查阅 20 项，已执行 134 命令，已修改 4 文件」；长度 1 摊平成普通行。
 * 正文 / 子代理 / 未归类工具 / 图片是边界（ZCode 同款）。
 *
 * ## 叶子机制（与官方逐条对齐，见旧版模块头，未变）
 *
 * part scope（PartByIndexProvider 的公开 API 复刻）、注册工具 UI 优先、
 * data 渲染器具名优先、indicator 判据 —— 全部保留。
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
  summaryChangeFiles,
  summaryIconIndex,
  summaryFileLeafName,
  type SummaryPartLike,
  type WorkSummaryItem,
} from "@/components/assistant-ui/work-summary";
import {
  resolveWorkSegmentStatus,
  splitWorkParts,
  type WorkPartLike,
} from "@/components/assistant-ui/work-segment";
import { SummaryPreviewContext } from "@/components/assistant-ui/summary-preview-context";
import {
  CollapsedChangeLabel,
  ConsecutiveSummaryGroup,
} from "@/components/assistant-ui/elements/summary-group.aui";
import { WorkSegmentGroup } from "@/components/assistant-ui/elements/work-segment.aui";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";
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
          <MarkdownText />
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
  running: boolean;
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

/** 收起态组头滚动的当前项摘要（ZCode 用摘要预览上下文渲染同一套行）。 */
const SummaryPreviewRow: FC<{ index: number; ctx: RenderCtx }> = ({ index, ctx }) => {
  const part = ctx.parts[index];
  if (!part) return null;
  if (part.type === "reasoning") {
    const streaming = part.status?.type === "running";
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <BrainIcon className="size-4 shrink-0" />
        <span className={streaming ? "shimmer" : undefined}>思考</span>
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

const SummaryRunView: FC<{
  indices: readonly number[];
  ctx: RenderCtx;
  /** 该运行段是工作段的尾段（ZCode `tailRowId === lastRowId`）。 */
  isTail: boolean;
}> = ({ indices, ctx, isTail }) => {
  // 组内 < 2：单行保持普通摘要行（ZCode 三处 builder 的 length === 1 分支）
  if (indices.length < 2) {
    return <PartLeafAt index={indices[0]!} slots={ctx.slots} />;
  }
  // 工具暂时全部结束不代表结构闭合：只有整轮尾组可继续翻滚（ZCode 同款）
  const groupRunning = ctx.running && isTail;
  const completed = !groupRunning;
  const statistics = formatSummaryStatistics(ctx.parts, indices, completed);
  const iconIndex = summaryIconIndex(ctx.parts, indices);
  const activeIndex = activeSummaryIndex(ctx.parts, indices);
  const currentIndex = activeIndex ?? indices[indices.length - 1]!;
  const changes = summaryChangeFiles(ctx.parts, indices);
  const collapsedStatistics =
    changes && changes.files.length === 1 && changes.unresolved === 0 && changes.files[0] ? (
      <CollapsedChangeLabel
        label={completed ? "已修改" : "修改"}
        fileName={summaryFileLeafName(changes.files[0].path)}
        additions={changes.files[0].additions}
        removed={changes.files[0].removed}
      />
    ) : undefined;

  return (
    <ConsecutiveSummaryGroup
      statistics={statistics}
      statisticsIcon={statisticsIconFor(iconIndex === undefined ? undefined : ctx.parts[iconIndex])}
      collapsedStatistics={collapsedStatistics}
      groupRunning={groupRunning}
      activeKey={`summary:${currentIndex}`}
      activeSummary={<SummaryPreviewRow index={currentIndex} ctx={ctx} />}
    >
      {indices.map((index) => (
        <PartLeafAt key={index} index={index} slots={ctx.slots} />
      ))}
    </ConsecutiveSummaryGroup>
  );
};

/** 一段部件（工作段内或折叠区外）→ 摘要组 / 单行。 */
const WorkItems: FC<{ indices: readonly number[]; ctx: RenderCtx }> = ({
  indices,
  ctx,
}) => {
  const items = useMemo<WorkSummaryItem[]>(
    () => buildWorkSummaryItems(ctx.parts, indices),
    [ctx.parts, indices],
  );
  return (
    <>
      {items.map((item, position) =>
        item.kind === "part" ? (
          <PartLeafAt key={item.key} index={item.index} slots={ctx.slots} />
        ) : (
          <SummaryRunView
            key={item.key}
            indices={item.indices}
            ctx={ctx}
            isTail={position === items.length - 1}
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
}) => {
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const toolUIs = useAuiState((s) => s.tools.toolUIs);
  const bounds = useWorkBounds();

  const slots = useMemo<AssistantWorkPartsSlots>(
    // ReasoningGroup / TaskGroup 槽位保留兼容（宿主无消费者；ZCode 的组头
    // 统计已取代旧的思考分组/任务分组渲染）
    () => ({ ToolFallback, ReasoningGroup, TaskGroup }),
    [ToolFallback, ReasoningGroup, TaskGroup],
  );
  const ctx = useMemo<RenderCtx>(
    () => ({ parts: parts as readonly SummaryPartLike[], slots, running }),
    [parts, slots, running],
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

  // 官方 shouldShowIndicator('no-text')：running 且末部件不是 text/reasoning
  const showIndicator = running
    ? (() => {
        const last = parts[parts.length - 1];
        return last === undefined || (last.type !== "text" && last.type !== "reasoning");
      })()
    : false;

  // 没有最终正文 → 全折叠且默认展开（ZCode assistantHistoryDefaultOpen 分支）
  const hasFinalText = split.lastTextIndex >= 0;

  return (
    <>
      {history.length > 0 ? (
        <WorkSegmentGroup
          status={status}
          defaultOpen={!hasFinalText}
          running={running}
        >
          <div data-slot="aui_assistant-work-items" className="flex flex-col gap-1">
            <WorkItems indices={history} ctx={ctx} />
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
          {following.length > 0 ? <WorkItems indices={following} ctx={ctx} /> : null}
        </div>
      ) : null}
      {showIndicator && (
        <span
          data-slot="aui_assistant-message-indicator"
          className="inline-flex items-center py-1"
        >
          <TypingIndicator variant="bare" />
        </span>
      )}
    </>
  );
};

// ReasoningContent / ReasoningRoot / ReasoningText / ReasoningTrigger 仍被
// 本模块的理智行经 `ReasoningPart` 间接消费（re-export 供旧调用方）。
export { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger };
