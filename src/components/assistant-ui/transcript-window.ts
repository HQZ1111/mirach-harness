/**
 * 长会话的转录窗口（hermes `app/chat/transcript-window.ts` 的宿主版，2026-11-19）。
 *
 * ## 为什么要有这一层
 *
 * 宿主此前把所有水合到的消息一次性挂进 thread 渲染树——会话一长，一次切换
 * 就同步挂载几百条消息（实测：切到 114 条消息的会话主线程持续 ~2s 变动），
 * 用户感受为「切长会话更慢」。hermes 的答案不是虚拟列表，而是**渲染预算**：
 *
 * - 稳定行很便宜，会长行很贵：预算按 `messagePaintWeight` 计价（见
 *   render-weight.ts），不是条数；
 * - **首帧小预算**（FIRST_PAINT_BUDGET）：切会话先挂最近一两轮——用户滚动
 *   到底后真正看得到的就这些——再用 rAF 分步补齐到整页预算，把重的
 *   markdown/语法高亮渲染推到首次 commit 之后，切换手感即时；
 * - **以轮为粒度**：窗口边界落在 user 消息开启的新轮上，永不切轮内部
 *   （hermes 同一条纪律：prepend 后「人」气泡不失去它那一轮）；
 * - 窗口只影响**渲染**，不动 store 数据与 scrollTop——滚动记忆的单一所有者
 *   （thread-scroll-store）不受干扰，向上翻页靠「显示更早的消息」按钮。
 *
 * 纯函数、无 React / DOM，可单测。
 */

import { messagePaintWeight, type PaintWeightPartLike } from "@/components/assistant-ui/render-weight";
import type { ThreadTurn } from "@/components/assistant-ui/turn-units";

/** 切会话的同步首帧预算（≈ 底部一两轮正常对话）。 */
export const FIRST_PAINT_BUDGET = 20;

/** 整页预算：约 10-20 个 agentic 轮（工具密集轮 30-90，普通往返 5-10）。 */
export const FULL_TRANSCRIPT_BUDGET = 600;

/** 首帧之后每个 rAF 追加的步长：两步填满一页，单步远低于可见冻结阈值。 */
export const BACKFILL_STEP = 290;

/** 底部边缘判定的容差（px）：滚到顶才自动翻页。 */
export const TOP_EDGE_PX = 48;

/** 「显示更早的消息」最少保留轮数——再重也不在离底部两轮处出按钮。 */
export const MIN_VISIBLE_TURNS = 8;

export interface WindowMessageLike {
  parts?: readonly PaintWeightPartLike[];
}

function turnWeight(
  turn: ThreadTurn,
  byId: ReadonlyMap<string, WindowMessageLike>,
): number {
  let weight = 0;
  for (const id of turn.messageIds) {
    const message = byId.get(id);
    if (message) weight += messagePaintWeight(message);
  }
  return weight;
}

/**
 * 选出转录尾部的一个窗口：从最新一轮往回累计绘制重量，直到预算满足——
 * 但至少保留 `minTurns` 轮（或全部，若本来就没那么多）。
 *
 * @returns startTurn = 窗口中第一条轮的下标（0 = 全量）；windowed = 是否截掉了更早的轮。
 */
export function selectTranscriptWindow(
  turns: readonly ThreadTurn[],
  byId: ReadonlyMap<string, WindowMessageLike>,
  budget: number = FULL_TRANSCRIPT_BUDGET,
  minTurns: number = MIN_VISIBLE_TURNS,
): { startTurn: number; windowed: boolean } {
  if (turns.length === 0) return { startTurn: 0, windowed: false };
  const floorTurns = Math.min(Math.max(1, Math.floor(minTurns)), turns.length);
  let weight = 0;
  let index = turns.length - 1;
  for (; index >= 0; index--) {
    weight += turnWeight(turns[index]!, byId);
    const included = turns.length - index;
    if (weight >= budget && included >= floorTurns) break;
  }
  const startTurn = Math.max(0, index);
  return { startTurn, windowed: startTurn > 0 };
}

/**
 * 首帧之后的下一个补齐预算：每次 +BACKFILL_STEP 直到整页预算；
 * 已超过整页预算（用户已点过「显示更早」）时保持不变。
 */
export function nextBackfillBudget(current: number): number {
  if (current >= FULL_TRANSCRIPT_BUDGET) return current;
  return Math.min(FULL_TRANSCRIPT_BUDGET, current + BACKFILL_STEP);
}

/** 「显示更早的消息」一页：再往前放一整页预算。 */
export function expandBudget(current: number): number {
  return current + FULL_TRANSCRIPT_BUDGET;
}