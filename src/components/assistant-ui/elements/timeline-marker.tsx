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
 * ## 颜色
 *
 * ZCode 用 `--color-foreground-subtle`；宿主令牌层对应 `--text-4`
 * （AGENTS.md「颜色必须接回 mirach 令牌」：照抄 shadcn 令牌会与正文同灰）。
 */
import type { FC } from 'react';
import { ArrowRightLeftIcon, ArchiveIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineMarker } from '../timeline-marker-store';

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
): Map<number, { marker: TimelineMarker; prevModel?: string }[]> {
  const out = new Map<number, { marker: TimelineMarker; prevModel?: string }[]>();
  let prevModel: string | undefined;
  // 按出现位置排序（后端已按条目顺序给出，这里不依赖它——乱序输入
  // 仍要得到正确的前值链）
  const ordered = [...markers].sort((a, b) => a.beforeMessageIndex - b.beforeMessageIndex);
  for (const marker of ordered) {
    const entry: { marker: TimelineMarker; prevModel?: string } = { marker };
    if (marker.kind === 'modelChange') {
      if (prevModel !== undefined) entry.prevModel = prevModel;
      prevModel = modelLabel(marker.provider, marker.modelId);
    }
    const bucket = out.get(marker.beforeMessageIndex);
    if (bucket) bucket.push(entry);
    else out.set(marker.beforeMessageIndex, [entry]);
  }
  return out;
}

const MarkerRow: FC<{ icon: React.ReactNode; label: string; marker: TimelineMarker }> = ({
  icon,
  label,
  marker,
}) => (
  <div
    data-slot="aui_timeline-marker"
    data-marker-kind={marker.kind}
    className="text-muted-foreground/70 flex w-full items-center gap-3 px-2 py-2 text-xs"
  >
    <div aria-hidden className="bg-foreground/10 h-px min-w-8 flex-1" />
    <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
      {icon}
      <span className="min-w-0 break-words">{label}</span>
    </span>
    <div aria-hidden className="bg-foreground/10 h-px min-w-8 flex-1" />
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
      <MarkerRow
        marker={marker}
        icon={<ArchiveIcon aria-hidden className="size-[var(--size-icon-sm)] shrink-0" />}
        label={markerLabel(marker)}
      />
    );
  }
  const to = modelLabel(marker.provider, marker.modelId);
  const label = prevModel ? `模型已切换 ${prevModel} → ${to}` : `正在使用 ${to}`;
  return (
    <MarkerRow
      marker={marker}
      icon={<ArrowRightLeftIcon aria-hidden className="size-[var(--size-icon-sm)] shrink-0" />}
      label={label}
    />
  );
};
