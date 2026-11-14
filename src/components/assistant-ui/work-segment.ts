/**
 * 工作段（work segment）纯函数——ZCode `ConversationTurnWorkSegment` /
 * `AssistantHistoryStatus` 的宿主投影（2026-11-03）。
 *
 * ZCode 的口径（`ConversationTurnGroup.tsx:738-904`）：
 * - 折叠的是**中间工作**（reasoning + 工具调用），正文（最终 assistant
 *   文本）在折叠区外；
 * - 头部状态字：interrupted → `已停止`；running → `工作中 {duration}`；
 *   completed 带时长 → `已工作 {duration}`；无时长 → `已处理`；
 * - **running 时头部不渲染**（`shouldShowHistoryStatus = !turnRunning &&
 *   state !== "running"`），内容展开——运行反馈在轮尾 loading 位；
 * - 默认开合（`assistantHistoryDefaultOpen`）：异常结束强制开；最后一轮
 *   且 running 开；**没有最终文本时开**（避免「已工作 N 秒」下面空空如也）；
 *   其余关。
 *
 * 宿主的对应物：`group-chainOfThought` 分组（reasoning + 工具调用全部挂在
 * 它下面，正文 text 不分组）——**它就是宿主的工作段**。折叠它 = 折叠中间
 * 工作，正文自然在外。这让折叠成为 GroupedParts 分支里的一个 Collapsible，
 * 不用复刻分组树（`buildGroupTree` 非导出，AGENTS.md 明令禁止复刻）。
 */

/** 工作段状态。 */
export type WorkSegmentState = 'running' | 'completed' | 'interrupted';

export interface WorkSegmentStatus {
  state: WorkSegmentState;
  /** 段时长（ms）。无计时数据 = undefined（不编造「0 秒」）。 */
  durationMs?: number;
}

/** 部件最小形状（MessageState.parts 的 tool-call / reasoning 子集）。 */
export interface WorkPartLike {
  type: string;
  /** tool-call 的宿主计时（convertTurnMessage 写入） */
  timing?: { startedAt?: number; completedAt?: number };
  /** 文本/思考内容（hasText 判定用） */
  text?: string;
  status?: { type?: string };
}

/**
 * 解析工作段状态与时长：区间 = [firstStartedAt, lastCompletedAt]。
 *
 * - 任何子部件 status.type === 'running' → running（时长不冻结）；
 * - 有 startedAt/completedAt 计时 → completed + durationMs；
 * - 全无计时（纯 reasoning 段——思考块的计时由 Reasoning 组件自测）→
 *   completed 且无 durationMs（头部落「已处理」，不造时长）。
 */
export function resolveWorkSegmentStatus(
  parts: readonly WorkPartLike[],
  indices: readonly number[],
): WorkSegmentStatus {
  let start: number | undefined;
  let end: number | undefined;
  let running = false;
  let interrupted = false;
  for (const index of indices) {
    const p = parts[index];
    if (!p) continue;
    if (p.status?.type === 'running') running = true;
    if (p.status?.type === 'incomplete') interrupted = true;
    const timing = p.timing;
    if (timing) {
      if (typeof timing.startedAt === 'number') {
        start = start === undefined ? timing.startedAt : Math.min(start, timing.startedAt);
      }
      if (typeof timing.completedAt === 'number') {
        end = end === undefined ? timing.completedAt : Math.max(end, timing.completedAt);
      }
    }
  }
  if (running) return { state: 'running' };
  if (start !== undefined && end !== undefined && end >= start) {
    return { state: 'completed', durationMs: end - start };
  }
  return { state: interrupted ? 'interrupted' : 'completed' };
}

/**
 * 状态字（ZCode `AssistantHistoryStatus` 的 label 逻辑，zh 文案取自
 * ZCode `zh-CN.ts:5489-5497`：已停止 / 工作中 {duration} / 已工作
 * {duration} / 已处理）。duration 由调用方格式化后传入（本模块不管
 * locale，与 ZCode 的 formatConversationWorkDuration 分层一致）。
 */
export function workSegmentLabel(
  status: WorkSegmentStatus,
  duration: string | null,
): string {
  if (status.state === 'interrupted') return '已停止';
  if (status.state === 'running') return `工作中 ${duration ?? ''}`.trim();
  return duration ? `已工作 ${duration}` : '已处理';
}

/**
 * 默认开合（ZCode `assistantHistoryDefaultOpen`）。
 *
 * @param hasTextAfter 该工作段之后（本消息后续 parts 或本轮后续 assistant
 *   消息）是否存在正文 text——**没有正文 = 折叠区下面空空如也**，强制开。
 * @param isRunning 轮仍在跑（running 恒开，且头部不渲染）。
 */
export function workSegmentDefaultOpen(hasTextAfter: boolean, isRunning: boolean): boolean {
  if (isRunning) return true;
  return !hasTextAfter;
}

/**
 * 该工作段之后是否还有正文：本消息 `afterPartIndex` 之后的非空 text part，
 * 或本消息之后（同一 turn 内，即下一条 user 之前）的 assistant 消息里的
 * 非空 text part。纯函数，可单测。
 */
export function turnHasTextAfter(
  messages: readonly { role: string; parts: readonly WorkPartLike[] }[],
  messageIndex: number,
  afterPartIndex: number,
): boolean {
  const own = messages[messageIndex];
  if (own) {
    for (let i = afterPartIndex + 1; i < own.parts.length; i++) {
      const p = own.parts[i];
      if (p?.type === 'text' && (p.text ?? '').trim()) return true;
    }
  }
  for (let i = messageIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') break;
    if (m.role === 'assistant') {
      if (m.parts.some((p) => p.type === 'text' && (p.text ?? '').trim())) return true;
    }
  }
  return false;
}

/** 时长格式化（ZCode `conversationWorkDuration`：≥1s、至多两个单位、
 * 中文数字与单位间不加空格——ZCode zh 实测「3 秒 20 毫秒」形态是 en 的，
 * zh 为「3秒」）。这里取最简形态：≥60s → 「N 分 M 秒」，否则「N 秒」；
 * 不足 1s → 「<1 秒」。 */
export function formatWorkDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1 秒';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min} 分` : `${min} 分 ${sec} 秒`;
}
