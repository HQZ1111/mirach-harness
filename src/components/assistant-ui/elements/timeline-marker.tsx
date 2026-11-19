/**
 * 时间线分隔线（ZCode `MarkerDividerRow` 的宿主移植，2026-11-02）。
 *
 * ZCode 原文（`ConversationRowView.tsx:1898-1975`）：
 * ```
 * <div className="flex w-full items-center gap-3 px-4 py-2 text-ui-base
 *                 text-[var(--color-foreground-subtle)]">
 *   <div aria-hidden className="h-px min-w-8 flex-1 bg-border/50" />
 *   <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5">
 *     {icon}<span>{label}</span>
 *   </span>
 *   <div aria-hidden className="h-px min-w-8 flex-1 bg-border/50" />
 * </div>
 * ```
 * 即**两侧细横线 + 居中「图标 + 文案」**。
 *
 * ## 宿主保留的两种 marker
 *
 * | marker | ZCode 文案 | 宿主文案 |
 * |---|---|---|
 * | `modelChange`（有来源） | `模型已切换 {from} → {to}` | 同 |
 * | `modelChange`（无来源） | `正在使用 {model}` | 同 |
 * | `compact` | `上下文已压缩` 家族 | `上下文已压缩` |
 *
 * ZCode 的 `goalVerify` / `forkNotice` / `forkCreated` / `retryNotice` /
 * `checkpointRestored` 宿主没有对应数据面（无 goal 引擎、fork 谱系走
 * SessionLineBar、重试不产 marker），**不渲染空壳**。
 *
 * ## 实时压缩行（2026-11-15）
 *
 * 历史 compact marker 只有「已压缩」事实；运行中的压缩（CUSTOM
 * name=compaction 的 start/end）走 `compactionRowView` + 同一个
 * `MarkerDivider` 壳体，支持 running/失败/中断三态与
 * `tokensBefore → tokensAfter`（ZCode 的 marker 协议带 token 但渲染层
 * 没展示，宿主按用户要求补上）。
 *
 * ## 颜色
 *
 * ZCode 用 `--color-foreground-subtle`；宿主令牌层对应 `--text-4`
 * （AGENTS.md「颜色必须接回 mirach 令牌」：照抄 shadcn 令牌会与正文同灰）。
 */
import type { FC, ReactNode } from 'react';
import { ArrowRightLeftIcon, ArchiveIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineMarker } from '../timeline-marker-store';

/** 分隔线状态色（ZCode 的运行态 = 无图标 + 文案流光；失败/中断给状态色）。 */
export type MarkerTone = 'default' | 'warning' | 'error';

/** 模型显示名：`provider/modelId` 里 provider 段做轻量美化（ZCode
 * `resolveProviderLabel` 的降级形态——宿主没有 provider 目录快照，
 * 直接用原始 id，不编造展示名）。 */
function providerLabel(provider: string): string {
  return provider;
}

function modelLabel(provider: string, modelId: string): string {
  return `${providerLabel(provider)}/${modelId}`;
}

/** 分隔线文案（纯函数，可单测）。 */
export function markerLabel(marker: TimelineMarker): string {
  if (marker.kind === 'compact') return '上下文已压缩';
  return `正在使用 ${modelLabel(marker.provider, marker.modelId)}`;
}

/**
 * 把标记列表按「第几条消息之前」分桶，并推出每条 `modelChange` 的
 * **前一个模型**（ZCode 的 marker 自带 `fromProvider/fromModel`；pi 的
 * `ModelChange` 条目只记"切到谁"，前值只能由序列推出）。
 *
 * 纯函数，可单测。返回 `Map<beforeMessageIndex, {marker, prevModel}[]>`。
 *
 * `prevModel` 的推导规则：沿标记顺序扫，记住上一个 `modelChange` 的
 * `provider/modelId`。首个 `modelChange` 没有前值 → `undefined`（渲染层
 * 走「正在使用 X」，与 ZCode 的 sourceLess 分支同文案）。`compact` 不参与
 * 前值推导（它不改变模型身份）。
 */
export function bucketMarkers(
  markers: readonly TimelineMarker[],
  /** 已加载消息条数（user|assistant）。尾部水合时 store 只含分支尾部，
   *  标记按「之后还剩几条」换算成本地下标；落在未加载头部（<0）的不画。 */
  loadedMessageCount?: number,
): Map<number, { marker: TimelineMarker; prevModel?: string }[]> {
  const out = new Map<number, { marker: TimelineMarker; prevModel?: string }[]>();
  let prevModel: string | undefined;
  // 按出现位置排序（后端已按条目顺序给出，这里不依赖它——乱序输入
  // 仍要得到正确的前值链）
  const ordered = [...markers].sort((a, b) => a.beforeMessageIndex - b.beforeMessageIndex);
  for (const marker of ordered) {
    const bucket =
      loadedMessageCount !== undefined && marker.beforeMessageIndexFromEnd !== undefined
        ? loadedMessageCount - marker.beforeMessageIndexFromEnd
        : marker.beforeMessageIndex;
    // 标记位于尚未加载的头部消息之前 -> 当前窗口无落点，跳过
    if (bucket < 0) continue;
    const entry: { marker: TimelineMarker; prevModel?: string } = { marker };
    if (marker.kind === 'modelChange') {
      if (prevModel !== undefined) entry.prevModel = prevModel;
      prevModel = modelLabel(marker.provider, marker.modelId);
    }
    const list = out.get(bucket);
    if (list) list.push(entry);
    else out.set(bucket, [entry]);
  }
  return out;
}

/** CUSTOM name=compaction 的投影形状（turn-actor.ts::CompactionSnapshot）。 */
export interface CompactionRowSnapshot {
  phase: 'start' | 'end';
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  aborted?: boolean;
  errorMessage?: string;
}

export interface CompactionRowView {
  label: string;
  running: boolean;
  tone: MarkerTone;
  /** 失败原因（红字独立行；ZCode 模板无该槽位，宿主补一行可见错误）。 */
  detail?: string;
}

/** token 数走技术规格格式（en-US 千分位），与 context-display 同口径。 */
const formatTokenCount = (value: number) => value.toLocaleString('en-US');

/** `tokensBefore → tokensAfter`（缺 tokensAfter 时只报 before；都没有 → undefined）。 */
export function compactionTokenSummary(
  snapshot: Pick<CompactionRowSnapshot, 'tokensBefore' | 'tokensAfter'>,
): string | undefined {
  if (typeof snapshot.tokensBefore !== 'number') return undefined;
  return typeof snapshot.tokensAfter === 'number'
    ? `${formatTokenCount(snapshot.tokensBefore)} → ${formatTokenCount(snapshot.tokensAfter)} tokens`
    : `${formatTokenCount(snapshot.tokensBefore)} tokens`;
}

/**
 * 上下文压缩分隔线的视图（ZCode `ConversationTimelineMarkerDivider` 的
 * `case "compact"`：标题按状态取 `chat.contextCompaction.*`；running 隐藏
 * 图标、文案流光；失败/中断给状态色）。
 *
 * ZCode 的 marker 不展示 token（协议里有、渲染层没用）；宿主把
 * `tokensBefore → tokensAfter` 追加在标题后——这是用户明确要的可见信息，
 * 不改变状态文案本身。
 */
export function compactionRowView(snapshot: CompactionRowSnapshot): CompactionRowView {
  const tokens = compactionTokenSummary(snapshot);
  const withTokens = (label: string) => (tokens ? `${label} · ${tokens}` : label);
  if (snapshot.phase === 'start') {
    return { label: '正在压缩上下文', running: true, tone: 'default' };
  }
  const errorMessage = snapshot.errorMessage?.trim();
  if (errorMessage) {
    return { label: withTokens('上下文压缩失败'), running: false, tone: 'error', detail: errorMessage };
  }
  if (snapshot.aborted === true) {
    return { label: withTokens('上下文压缩已中断'), running: false, tone: 'warning' };
  }
  return { label: withTokens('上下文已压缩'), running: false, tone: 'default' };
}

/**
 * 系统标记分隔线的展示壳（ZCode `MarkerDividerRow`）：两侧细横线 + 居中
 * 「图标 + 文案」pill；running 时隐藏图标、文案走 shimmer（同 ZCode）；
 * 失败/中断用状态色（ZCode 用 foreground-subtle，状态色是宿主要求）。
 */
export const MarkerDivider: FC<{
  kind: string;
  label: ReactNode;
  icon?: ReactNode;
  running?: boolean;
  tone?: MarkerTone;
  detail?: string;
}> = ({ kind, label, icon, running = false, tone = 'default', detail }) => (
  <div
    data-slot="aui_timeline-marker"
    data-marker-kind={kind}
    data-marker-tone={tone}
    data-marker-running={running ? '1' : undefined}
    className="flex w-full flex-col gap-1"
  >
    <div className="text-muted-foreground/70 flex w-full items-center gap-3 px-2 py-2 text-xs">
      <div aria-hidden className="bg-foreground/10 h-px min-w-8 flex-1" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={cn(
            'min-w-0 break-words',
            running && 'shimmer motion-reduce:animate-none font-medium',
            tone === 'error' && 'text-red-500',
            tone === 'warning' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {label}
        </span>
      </span>
      <div aria-hidden className="bg-foreground/10 h-px min-w-8 flex-1" />
    </div>
    {detail ? (
      <p className="text-destructive px-2 text-xs whitespace-pre-wrap">{detail}</p>
    ) : null}
  </div>
);

/**
 * 单条标记。
 *
 * `prevModel` 用于 `modelChange` 的「A → B」形态：ZCode 的 marker 自带
 * `fromProvider/fromModel`，宿主后端只记「切换到谁」（pi 的 ModelChange
 * 条目就是这个语义）。前一个模型由调用方从**前一条 marker**推出来，
 * 推不出（会话首条 marker）就走「正在使用」形态——与 ZCode 的
 * sourceLess 分支同文案。
 */
export const TimelineMarkerRow: FC<{ marker: TimelineMarker; prevModel?: string }> = ({
  marker,
  prevModel,
}) => {
  if (marker.kind === 'compact') {
    return (
      <MarkerDivider
        kind="compact"
        icon={<ArchiveIcon aria-hidden className="size-[var(--size-icon-sm)] shrink-0" />}
        label={markerLabel(marker)}
      />
    );
  }
  const to = modelLabel(marker.provider, marker.modelId);
  const label = prevModel ? `模型已切换 ${prevModel} → ${to}` : `正在使用 ${to}`;
  return (
    <MarkerDivider
      kind="modelChange"
      icon={<ArrowRightLeftIcon aria-hidden className="size-[var(--size-icon-sm)] shrink-0" />}
      label={label}
    />
  );
};
