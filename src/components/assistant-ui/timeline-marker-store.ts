/**
 * 会话时间线标记桥（ZCode `timelineMarkerRow` 的宿主投影，2026-11-02）。
 *
 * ## 数据源
 *
 * pi 的会话条目 `SessionEntry::ModelChange` / `Compaction`（session.rs:6763）。
 * 后端 `pi_get_timeline_markers` 沿当前分支扫描，给出每条标记出现在第几条
 * **消息之前**（`beforeMessageIndex`，索引与 `pi_get_messages` 对齐）。
 *
 * ## 为什么要桥而不是组件内 invoke
 *
 * 标记属于会话级数据（与消息同源、随会话切换整体替换），且**切换会话 /
 * 水合 / 新一轮落盘**三个时机都要重拉。放进 zustand 后，thread.aui 只按
 * 引用订阅；组件内各调一次 IPC 会变成 N 个并发请求 + N 份不一致快照。
 *
 * ## 失败语义
 *
 * 拉取失败 → `console.error` + 保持上一次快照（不清空）。清空会让已有的
 * 分隔线整批消失，用户以为"切换记录丢了"；保留旧快照至少与屏幕上已渲染
 * 的内容一致。**不伪造空数组**（那等于断言"没有切换"）。
 */
import { createStore, useStore } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/** 一条时间线标记（形状与 `pi_get_timeline_markers` 的 JSON 面一致）。 */
export type TimelineMarker =
  | {
      kind: 'modelChange';
      /** 该标记出现在第几条消息之前（0 = 首条消息之前） */
      beforeMessageIndex: number;
      provider: string;
      modelId: string;
    }
  | { kind: 'compact'; beforeMessageIndex: number };

interface TimelineMarkerState {
  markers: readonly TimelineMarker[];
  /** 当前快照对应的会话 id（切换会话时用于丢弃过期响应） */
  sessionId: string | null;
  refresh: (sessionId: string | null) => Promise<void>;
}

/** 形状校验：只接受两种 kind 且 `beforeMessageIndex` 为非负整数。
 * 后端形状变化时如实报错（不静默丢弃整批）。 */
export function parseTimelineMarkers(raw: unknown): TimelineMarker[] {
  if (!Array.isArray(raw)) {
    throw new Error(`时间线标记不是数组：${typeof raw}`);
  }
  const out: TimelineMarker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      console.error('[timeline] 标记条目不是对象——跳过', item);
      continue;
    }
    const v = item as Record<string, unknown>;
    const idx = v.beforeMessageIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      console.error('[timeline] 标记 beforeMessageIndex 非法——跳过', v);
      continue;
    }
    if (v.kind === 'modelChange') {
      if (typeof v.provider !== 'string' || typeof v.modelId !== 'string') {
        console.error('[timeline] modelChange 缺 provider/modelId——跳过', v);
        continue;
      }
      out.push({
        kind: 'modelChange',
        beforeMessageIndex: idx,
        provider: v.provider,
        modelId: v.modelId,
      });
    } else if (v.kind === 'compact') {
      out.push({ kind: 'compact', beforeMessageIndex: idx });
    } else {
      console.error(`[timeline] 未知标记 kind=${String(v.kind)}——跳过`, v);
    }
  }
  return out;
}

export const timelineMarkerBridge = createStore<TimelineMarkerState>((set, get) => ({
  markers: [],
  sessionId: null,
  refresh: async (sessionId) => {
    if (!sessionId) {
      // 无活动会话（New Chat / 首启）→ 清空是真实状态，不是降级
      set({ markers: [], sessionId: null });
      return;
    }
    // **先登记会话 id 再发请求**：响应回来时用它与当前请求比对，过期
    // 响应丢弃。若等响应回来才登记，首次调用时 store 里还是 null，守卫
    // 会把自己这次的合法响应也丢掉（分隔线永远不出现）。
    set({ sessionId });
    let raw: unknown;
    try {
      raw = await invoke('pi_get_timeline_markers');
    } catch (e) {
      console.error('[timeline] 标记拉取失败（保留上一次快照）', e);
      return;
    }
    // 响应回来时会话可能已切走——丢弃过期结果，否则会把 A 会话的分隔线
    // 画进 B 会话。
    if (get().sessionId !== sessionId) return;
    try {
      set({ markers: parseTimelineMarkers(raw), sessionId });
    } catch (e) {
      console.error('[timeline] 标记形状解析失败（保留上一次快照）', e);
    }
  },
}));

/** 订阅当前标记列表（引用稳定：无变化不重渲染）。 */
export const useTimelineMarkers = () =>
  useStore(timelineMarkerBridge, (s) => s.markers);
