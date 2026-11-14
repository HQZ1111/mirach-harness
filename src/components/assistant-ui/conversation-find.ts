/**
 * 会话内查找——ZCode `TaskFindDialog` + `conversationFindHighlightDom` 的
 * 宿主版（2026-11-03）。
 *
 * ## 与 ZCode 的口径差异（有意裁剪）
 *
 * | 面 | ZCode | 宿主 |
 * |---|---|---|
 * | 搜索目标 | user 行 + assistant **text** 行（不搜工具/思考） | 同口径 |
 * | 高亮 | CSS Custom Highlight API（不动 DOM） | 同技术 |
 * | 匹配计数 | 源文本 matches 序号 rebase | **DOM 实际出现处**（渲染后
 *   markdown 会增删字符，源偏移与 DOM 对不上；以可见出现为准，计数/高亮/
 *   跳转三者同源，不会出现"计数 3 处只亮出 2 处"） |
 * | 范围 | 会话 + 变更两个 scope | 只会话（宿主无变更视图） |
 * | 缓存 | 按 unit 引用的多层缓存 | 无（无虚拟化，消息常驻，直接扫 DOM） |
 *
 * 打开 = Ctrl/Cmd+F（对话区聚焦时）；↑↓/Enter 导航；Esc 关闭。
 */

/** 高亮 registry 名（`CSS.highlights` 键 + `::highlight()` 伪类名）。 */
export const FIND_HIGHLIGHT_NAME = 'mirach-conversation-find';
export const FIND_ACTIVE_HIGHLIGHT_NAME = 'mirach-conversation-find-active';

/** 高亮扫描要跳过的元素（ZCode 同款 + 宿主 composer）。 */
export const FIND_SKIP_SELECTOR =
  'button, input, textarea, select, [contenteditable="true"], [data-conversation-find-ignore="true"]';

/** 计数文案：`当前/总数`（无匹配 = `0/0`，ZCode 同款）。 */
export function findCountLabel(activeIndex: number, total: number): string {
  if (total <= 0) return '0/0';
  return `${Math.min(Math.max(activeIndex, 0) + 1, total)}/${total}`;
}

/** 导航后活动序号（循环：末尾 +1 回 0，头部 -1 回末尾）。 */
export function nextActiveIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + direction + total) % total;
}

/** query 归一化：trim 后小写比较（ZCode `toLocaleLowerCase` 同款）；空串不搜。 */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLocaleLowerCase();
}
