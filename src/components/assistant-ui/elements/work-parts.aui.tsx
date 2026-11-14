"use client";

/**
 * 助手消息工作项渲染器——`MessagePrimitive.GroupedParts` 的宿主替换
 * （2026-11-07，配合 `assistant-work-items.ts` 的 ZCode 扫描）。
 *
 * ## 为什么替换
 *
 * GroupedParts 按**相邻部件的分组路径**合并，任何插入部件断组——
 * `[思考, bash, 思考, bash]` 被拆成两个单子项「终端」组各自摊平。ZCode
 * 把隐藏的 reasoning 行在扫描前剔除（默认只显示首条思考），工具族组因此
 * 能跨思考行。扫描规则见 `assistant-work-items.ts`（18 条单测）。
 *
 * ## 与官方叶子机制的对齐（逐条核对过 core dist 源码）
 *
 * - **part scope**：官方每个叶子都包 `PartByIndexProvider`（`part` 派生
 *   scope）。`MarkdownTextPrimitive` 内部经 `useMessagePartText` 读
 *   `s.part`——没有 scope 文本读不到。`PartByIndexProvider` 不从包根导出，
 *   但其实现只用公开 API（`AuiConfig`/`Derived`/`AuiProvider`，与
 *   `MessageByIdProvider` 同构）——本文件 `PartScope` 逐行复刻。
 * - **注册工具 UI**：官方 `ToolUIDisplay` =
 *   `useAuiState(s => s.tools.toolUIs[toolName]?.[0]?.render ?? Fallback)`；
 *   宿主口径 = 有注册 UI 渲染注册 UI，否则 `ToolFallback` 槽位（旧
 *   `part.toolUI ?? <ToolFallback/>` 的等价改写——`part.toolUI` 是
 *   GroupedParts 组装期挂上的元素，自己扫部件后需要自解析）。
 * - **data 渲染器**：官方 `getDataRenderer(renderers, name, inlineFallback)`
 *   ——具名优先、fallbacks[0] 兜底；两者皆无 = 无 UI（渲染 null，与旧
 *   `part.dataRendererUI` 为 null 同结果）。
 * - **indicator**：官方 `shouldShowIndicator('no-text')`：running 且末部件
 *   不是 text/reasoning（隐藏思考也算 reasoning——思考流式期间不显示三点）。
 * - **组摘要**：`groupSummary` 逐行复刻官方 `getGroupSummary`（ReasoningGroup/
 *   TaskGroup 自定义槽位的 group 形状）。
 */

import { useMemo, type ComponentType, type FC, type PropsWithChildren } from "react";
import {
  AuiConfig,
  AuiProvider,
  Derived,
  useAui,
  useAuiState,
} from "@assistant-ui/store";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  buildAssistantWorkItems,
  groupSummary,
  type WorkEntry,
  type WorkItem,
  type WorkPartLike,
} from "@/components/assistant-ui/assistant-work-items";
import { classifyToolFamily } from "@/components/assistant-ui/tool-grouping";
import { ToolFamilyGroup } from "@/components/assistant-ui/elements/tool-family-group.aui";
import { WorkSegmentGroup } from "@/components/assistant-ui/elements/work-segment.aui";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { Reasoning } from "@/components/assistant-ui/elements/reasoning.aui";
import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";
import { File } from "@/components/file";
import { Image } from "@/components/image";
import { MarkdownText } from "@/components/markdown-text";

/** 自定义 ReasoningGroup/TaskGroup 槽位收到的 group 形状（旧
 * `MessagePrimitive.GroupedParts.GroupPart` 的结构等价物）。 */
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
  /** 自定义思考分组槽位（旧 ThreadComponents.ReasoningGroup）。 */
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: WorkGroupPart }>>;
  /** 自定义任务分组槽位（旧 ThreadComponents.TaskGroup）。 */
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
 * `MessagePartChildrenInner`：从 part scope 的 `aui.part` 取方法补上——
 * `ToolCallMessagePartComponent` 的 props 契约要求它们存在。 */
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

/** 单个部件叶子（scope 内）。按旧 GroupedParts 叶子分支一一对应。 */
const PartLeaf: FC<{ slots: AssistantWorkPartsSlots }> = ({ slots }) => {
  const part = useAuiState((s) => s.part);
  if (!part) return null;
  switch (part.type) {
    case "text":
      return <MarkdownText />;
    case "reasoning":
      return <Reasoning {...part} />;
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

// ── 工作段内的条目渲染 ────────────────────────────────────────────────

interface RenderCtx {
  parts: readonly WorkPartLike[];
  slots: AssistantWorkPartsSlots;
}

/** 思考行（旧 group-reasoning 分支）：合并相邻可见 reasoning。 */
const ReasoningRun: FC<{
  entry: Extract<WorkEntry, { kind: "reasoning" }>;
  ctx: RenderCtx;
}> = ({ entry, ctx }) => {
  const group: WorkGroupPart = {
    type: "group-reasoning",
    ...groupSummary(ctx.parts, entry.indices),
    indices: entry.indices,
  };
  const leaves = entry.indices.map((i) => (
    <PartScope key={i} index={i}>
      <PartLeaf slots={ctx.slots} />
    </PartScope>
  ));
  if (ctx.slots.ReasoningGroup) {
    return <ctx.slots.ReasoningGroup group={group}>{leaves}</ctx.slots.ReasoningGroup>;
  }
  return (
    <DefaultReasoningRun indices={entry.indices}>{leaves}</DefaultReasoningRun>
  );
};

/** 默认思考分组——原 thread.aui.tsx 的 DefaultReasoningGroup 原样迁移
 * （触发器 + 单行流式摘要；流式且无文本整块不渲染）。 */
const DefaultReasoningRun: FC<
  PropsWithChildren<{ indices: readonly number[] }>
> = ({ indices, children }) => {
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const streamingText = useMemo(() => {
    let out = "";
    for (const index of indices) {
      const part = parts[index];
      if (part?.type === "reasoning") out += part.text;
    }
    return out;
  }, [parts, indices]);
  if (running && streamingText.length === 0) return null;
  return (
    <ReasoningRoot streaming={running}>
      <ReasoningTrigger active={running} streamingText={streamingText} />
      <ReasoningContent aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
};

/** 族组 / 单工具行（旧 group-explore|execute|changes 分支：单子项摊平）。 */
const FamilyRun: FC<{
  entry: Extract<WorkEntry, { kind: "family" }>;
  ctx: RenderCtx;
}> = ({ entry, ctx }) => {
  if (entry.indices.length === 1) {
    return <PartLeafAt index={entry.indices[0]!} slots={ctx.slots} />;
  }
  const running = entry.indices.some(
    (i) => ctx.parts[i]?.status?.type === "running",
  );
  return (
    <ToolFamilyGroup family={entry.family} indices={entry.indices} running={running}>
      {entry.indices.map((i) => (
        <PartScope key={i} index={i}>
          <PartLeaf slots={ctx.slots} />
        </PartScope>
      ))}
    </ToolFamilyGroup>
  );
};

/** 任务工具行（旧 group-task 分支）。 */
const TaskRun: FC<{
  entry: Extract<WorkEntry, { kind: "task" }>;
  ctx: RenderCtx;
}> = ({ entry, ctx }) => {
  const TaskGroup = ctx.slots.TaskGroup;
  if (!TaskGroup) {
    // 防御：扫描仅在提供 TaskGroup 槽位时产 task 项；真到达这里按普通工具渲染
    return <PartLeafAt index={entry.index} slots={ctx.slots} />;
  }
  const group: WorkGroupPart = {
    type: "group-task",
    ...groupSummary(ctx.parts, [entry.index]),
    indices: [entry.index],
  };
  return <TaskGroup group={group} />;
};

/** 工作段（折叠单位）。 */
const SegmentView: FC<{
  item: Extract<WorkItem, { kind: "segment" }>;
  ctx: RenderCtx;
}> = ({ item, ctx }) => (
  <WorkSegmentGroup indices={item.indices}>
    {item.children.map((child) => {
      switch (child.kind) {
        case "reasoning":
          return <ReasoningRun key={child.key} entry={child} ctx={ctx} />;
        case "family":
          return <FamilyRun key={child.key} entry={child} ctx={ctx} />;
        case "task":
          return <TaskRun key={child.key} entry={child} ctx={ctx} />;
        case "tool":
          return <PartLeafAt key={child.key} index={child.index} slots={ctx.slots} />;
      }
    })}
  </WorkSegmentGroup>
);

// ── 顶层 ─────────────────────────────────────────────────────────────

export const AssistantWorkParts: FC<AssistantWorkPartsSlots> = ({
  ToolFallback,
  ReasoningGroup,
  TaskGroup,
}) => {
  const parts = useAuiState((s) => s.message.parts);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const toolUIs = useAuiState((s) => s.tools.toolUIs);

  const slots = useMemo<AssistantWorkPartsSlots>(
    () => ({ ToolFallback, ReasoningGroup, TaskGroup }),
    [ToolFallback, ReasoningGroup, TaskGroup],
  );
  const ctx = useMemo<RenderCtx>(() => ({ parts, slots }), [parts, slots]);

  const items = useMemo(
    () =>
      buildAssistantWorkItems(parts as readonly WorkPartLike[], {
        isFamily: (p) => classifyToolFamily(p.toolName ?? "", p.args),
        // ZCode 默认形态：只显示首条思考，其余剔除（工具族组因此能跨思考行）
        showAllReasoning: false,
        // 旧 taskAwareGroupBy 的启用条件：提供了 TaskGroup 槽位才判定任务工具；
        // 且要求无注册 UI（有注册 UI 的照常走注册 UI）
        ...(TaskGroup
          ? {
              isTaskPart: (p: WorkPartLike) =>
                p.messages !== undefined &&
                (p.toolName === undefined || (toolUIs[p.toolName]?.length ?? 0) === 0),
            }
          : {}),
      }),
    [parts, TaskGroup, toolUIs],
  );

  // 官方 shouldShowIndicator('no-text')：running 且末部件不是 text/reasoning
  const showIndicator = running
    ? (() => {
        const last = parts[parts.length - 1];
        return last === undefined || (last.type !== "text" && last.type !== "reasoning");
      })()
    : false;

  return (
    <>
      {items.map((item) =>
        item.kind === "part" ? (
          <PartLeafAt key={item.key} index={item.index} slots={slots} />
        ) : (
          <SegmentView key={item.key} item={item} ctx={ctx} />
        ),
      )}
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
