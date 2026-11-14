/**
 * 对话框选守卫与几何——ZCode `conversationSelectionGuard.ts` +
 * `SelectionActionMenu.tsx` 定位逻辑的宿主投影（2026-11-03）。纯函数，可单测。
 *
 * ZCode 原规则（`guardConversationSelectionCandidate`）：单 range、两端点在
 * **同一行**、在时间线根内、端点不在排除元素里、同一可选中区、内容类型受
 * 支持、文本非空、有布局。**无最小长度**；超
 * `CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8000` → 只渲染警告（single-limit）。
 */

/** 超长上限（ZCode `conversationSelection.ts:2` 同值）。 */
export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;

/** 框选裁决结果。 */
export type SelectionGuardResult = 'eligible' | 'ineligible' | 'single-limit';

export interface SelectionGuardInput {
  enabled: boolean;
  /** 两端点是否落在同一条消息根内 */
  sameRow: boolean;
  /** 选区是否在对话根内 */
  insideRoot: boolean;
  /** 端点是否落在排除元素（按钮/输入框/弹层…）里 */
  excluded: boolean;
  text: string;
  /** 选区有可见布局（宽度或高度 > 0） */
  hasLayout: boolean;
}

export function guardSelectionCandidate(input: SelectionGuardInput): SelectionGuardResult {
  if (
    !input.enabled ||
    !input.sameRow ||
    !input.insideRoot ||
    input.excluded ||
    !input.text ||
    !input.hasLayout
  ) {
    return 'ineligible';
  }
  return input.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH ? 'single-limit' : 'eligible';
}

/** 端点元素是否在排除列表里（ZCode 的排除选择器宿主化）。 */
export function isExcludedSelectionEndpoint(el: Element | null): boolean {
  if (!el) return true;
  return Boolean(
    el.closest(
      [
        'button',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="dialog"]',
        '[contenteditable="true"]',
        '[data-slot*="composer"]',
        '[data-conversation-selection-tooltip]',
      ].join(','),
    ),
  );
}

/** 宿主的消息根：两端点必须落在同一条消息里（ZCode 的 [data-row-id] 行）。 */
export const MESSAGE_ROOT_SELECTOR =
  '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-root"]';

export interface SelectionRect {
  /** 选区水平中心（viewport 坐标） */
  centerX: number;
  /** 选区上缘 */
  top: number;
  /** 选区下缘 */
  bottom: number;
}

/**
 * 工具条定位（ZCode `SelectionActionMenu` 同规则）：水平对选区中心、两侧
 * 夹 12px；垂直优先选区**上方**（top − 高 − 8，且落点 ≥ 12px），放不下落
 * **下方**（bottom + 8），同样夹取。
 */
export function resolveSelectionMenuPosition(
  selectionRect: SelectionRect,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const MARGIN = 12;
  const GAP = 8;
  const left = Math.min(
    Math.max(MARGIN, selectionRect.centerX - menuWidth / 2),
    Math.max(MARGIN, viewportWidth - menuWidth - MARGIN),
  );
  const above = selectionRect.top - menuHeight - GAP;
  const top =
    above >= MARGIN
      ? above
      : Math.min(selectionRect.bottom + GAP, Math.max(MARGIN, viewportHeight - menuHeight - MARGIN));
  return { left, top };
}

/** 引用文本排版（引用到输入框）：逐行加 `> `，末尾空一行。 */
export function formatQuoteForComposer(text: string): string {
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n`;
}
