/**
 * 工作段（work segment）纯函数——ZCode `ConversationTurnWorkSegment` /
 * `AssistantHistoryStatus` 的宿主投影（2026-11-03，2026-11-15 按源码事实
 * 复核两层结构）。
 *
 * ZCode 的口径（`ConversationTurnGroup.tsx:540-630` / `:713-821`）：
 * - 折叠的是**中间工作**（reasoning + 工具调用），正文（最终 assistant
 *   文本）在折叠区外；
 * - 外层头部状态字：interrupted → `已停止`；running → `工作中 {duration}`；
 *   completed 带时长 → `已工作 {duration}`；无时长 → `已处理`；
 * - **running 时外层头不渲染**（`shouldShowHistoryStatus = !turnRunning &&
 *   state !== "running"`），内容展开——运行反馈只在轮尾 loading 位；
 * - 默认开合（`assistantHistoryDefaultOpen`）：没有最终文本时开（避免
 *   折叠区空着）；其余关。
 *
 * 统计属于**内层**连续摘要组（`ConsecutiveSummaryGroup`），不在外层头。
 */

/** 工作段状态。 */
export type WorkSegmentState = 'running' | 'completed' | 'interrupted';

export interface WorkSegmentStatus {
  state: WorkSegmentState;
  /** 段时长（ms）。无计时数据 = undefined（不编造「0 秒」）。 */
  durationMs?: number;
}

/** 消息级兜底边界（history 水合写 metadata.custom，实时路径缺省）。 */
export interface WorkSegmentFallback {
  /** turn 起始（= 前一条 user 时间戳 / assistant createdAt） */
  startedAt?: number;
  /** turn 结束（= 本轮最后一条 pi 消息 timestamp） */
  completedAt?: number;
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
 * - 起始优先取**部件计时**（首个 assistant 产出时刻），结束优先取**消息级
 *   兜底**（本轮最后一条 pi 消息 timestamp，含最终正文的生成时间）——
 *   ZCode 的 turn.activeMs 同样把最终正文算进工时；
 * - 有 startedAt/completedAt 计时 → completed + durationMs；
 * - 全无计时（纯 reasoning 段——思考块的计时由 Reasoning 组件自测）→
 *   completed 且无 durationMs（头部落「已处理」，不造时长）。
 */
export function resolveWorkSegmentStatus(
  parts: readonly WorkPartLike[],
  indices: readonly number[],
  fallback?: WorkSegmentFallback,
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
  const rangeStart = start ?? fallback?.startedAt;
  const rangeEnd = fallback?.completedAt ?? end;
  const durationMs =
    rangeStart !== undefined && rangeEnd !== undefined && rangeEnd >= rangeStart
      ? rangeEnd - rangeStart
      : undefined;
  // 中断优先于完成（ZCode 的 interrupted 来自 turn header；宿主用部件的
  // incomplete 状态表达「本段被取消/打断」，标签只写「已停止」不写时长）
  if (interrupted) {
    return { state: 'interrupted', ...(durationMs === undefined ? {} : { durationMs }) };
  }
  if (durationMs !== undefined) {
    return { state: 'completed', durationMs };
  }
  return { state: 'completed' };
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
 * 该 work 段之外是否还有正文：本消息 `afterPartIndex` 之后的非空 text part，
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

/** 一个 turn 的部件切分（ZCode `segmentHistoryRows` / `segmentFollowingRows`）：
 * **最后一条非空 assistant 正文**留在折叠区外，它之前的全部部件（含中间
 * 正文）进工作段；它之后的（少见：正文后又有工具）在折叠区外顺序渲染。 */
export function splitWorkParts(
  parts: readonly { type: string; text?: string }[],
): { history: readonly number[]; following: readonly number[]; lastTextIndex: number } {
  let lastTextIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.type === 'text' && (p.text ?? '').trim().length > 0) {
      lastTextIndex = i;
      break;
    }
  }
  const history: number[] = [];
  const following: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === lastTextIndex) continue;
    if (lastTextIndex >= 0 && i > lastTextIndex) following.push(i);
    else history.push(i);
  }
  return { history, following, lastTextIndex };
}

/**
 * 时长格式化（ZCode `conversationWorkDuration`）：秒向最近取整、至少显示
 * 「<1 秒」；天 / 时 / 分 / 秒只写非零的，**最多两段**（「1 时 3 分」，不写
 * 秒）；中文单位前留一个空格（ZCode `workDurationUnitSeparator('zh-CN')`）。
 */
export function formatWorkDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1 秒';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.slice(0, 2).join(' ');
}
