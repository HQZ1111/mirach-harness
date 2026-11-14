/**
 * 轮导航器纯函数——ZCode `conversationTurnNavigatorHelpers.ts` 的宿主投影
 * （2026-11-03）。可视化判定逐字照抄，目录构造按宿主数据源适配。
 */

// ── bar 视觉状态（ZCode resolveConversationTurnNavigatorBarVisualState
//    逐字照抄，conversationTurnNavigatorHelpers.ts:488-507）──────────────

export type NavigatorBarTone = 'idle' | 'near' | 'mid' | 'peak';

export interface NavigatorBarVisualState {
  colorTone: 'focus' | 'muted';
  opacity: number;
  scaleX: number;
  tone: NavigatorBarTone;
}

export function resolveNavigatorBarVisualState(options: {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}): NavigatorBarVisualState {
  const { itemIndex, visualFocusItemIndex } = options;
  if (visualFocusItemIndex === undefined) {
    return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
  }
  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: 'focus', opacity: 1, scaleX: 2.6, tone: 'peak' };
  }
  if (distance === 1) {
    return { colorTone: 'muted', opacity: 0.86, scaleX: 1.7, tone: 'near' };
  }
  if (distance === 2) {
    return { colorTone: 'muted', opacity: 0.72, scaleX: 1.25, tone: 'mid' };
  }
  return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
}

// ── 目录构造（宿主适配）───────────────────────────────────────────────

export interface TurnNavigatorItem {
  /**
   * React key / 滚动锚 = 开轮 user 消息 id。轮容器的 `data-turn-key` 就是
   * 同一个值（`groupMessagesIntoTurns` 的 key 语义），点击时按它找元素。
   */
  key: string;
}

/**
 * 目录 = 一次用户主动 query（ZCode `buildConversationTurnNavigatorItems`
 * 同口径：**只收 realUser**——宿主的 user 消息即用户输入，孤儿 assistant
 * 轮没有 user 输入，不进目录）。顺序 = 消息顺序 = 轮容器 DOM 顺序。
 */
export function buildTurnNavigatorItems(
  messages: readonly { id: string; role: string }[],
): TurnNavigatorItem[] {
  const out: TurnNavigatorItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ key: m.id });
  }
  return out;
}

/**
 * 滚动位置 → 当前活动项：视口顶部 40% 线以上最后一个"已越过"的 query。
 * （ZCode 的 `resolveConversationTurnNavigatorActiveUnitIndex` 按单位区间
 * 二分；宿主无虚拟化，直接线性扫 turn 元素的相对 top。）
 *
 * @param tops 每个目录项对应轮容器相对视口的 top（px，与 items 同序）
 * @param line 判定线（视口高度的 40% 处）
 */
export function resolveNavigatorActiveIndex(tops: readonly number[], line: number): number {
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= line) active = i;
  }
  return active;
}
