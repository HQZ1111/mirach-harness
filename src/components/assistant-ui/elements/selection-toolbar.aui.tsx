"use client";

/**
 * 框选工具条（ZCode `ConversationSelectionTooltip` + `SelectionActionMenu`
 * 的宿主版，2026-11-03）：对话区里选中文字 → 浮出工具条。
 *
 * ## 触发与消失（ZCode `useTextSelection` 同规则）
 *
 * mouseup / touchend 后 rAF 检查选区；收起（collapse）、Escape、根内滚动、
 * 窗口 resize 都关闭。守卫见 `conversation-selection.ts`（单 range、同一
 * 消息根内、非排除元素、非空文本有布局；无最小长度；>8000 字只渲染警告）。
 *
 * ## 按钮：两枚（ZCode 是「加入任务 / 侧聊询问」）
 *
 * ZCode 的两个动作依赖它的任务系统与侧聊，宿主都没有——**不渲染假入口**。
 * 宿主等价两枚：**复制**（写入剪贴板，成功即关）与**引用到输入框**
 * （`> ` 引用排版追加进 composer）。这是动作层的宿主适配，守卫/定位/消失
 * 逻辑与 ZCode 一致。
 *
 * 定位：portal 到 body、fixed、水平对选区中心、垂直优先上方放不下落下方
 * （纯函数有单测）；pointerdown preventDefault 防点按钮清掉选区。
 */
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon, QuoteIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import {
  MESSAGE_ROOT_SELECTOR,
  formatQuoteForComposer,
  guardSelectionCandidate,
  isExcludedSelectionEndpoint,
  resolveSelectionMenuPosition,
  type SelectionRect,
} from "@/components/assistant-ui/conversation-selection";

interface TooltipState {
  text: string;
  rect: SelectionRect;
  overLimit: boolean;
}

export const SelectionToolbar: FC = () => {
  const aui = useAui();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const [state, setState] = useState<TooltipState | null>(null);
  const [copied, setCopied] = useState(false);

  const close = useCallback(() => {
    setState(null);
    setCopied(false);
  }, []);

  const inspect = useCallback((): TooltipState | null => {
    const root = hostRef.current?.closest(".aui-thread-root");
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endEl =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    if (!startEl || !endEl) return null;
    const startRow = startEl.closest(MESSAGE_ROOT_SELECTOR);
    const endRow = endEl.closest(MESSAGE_ROOT_SELECTOR);
    const text = selection.toString().trim();
    const rect = range.getBoundingClientRect();
    const verdict = guardSelectionCandidate({
      enabled: true,
      sameRow: Boolean(startRow) && startRow === endRow,
      insideRoot: Boolean(startRow && root.contains(startRow)),
      excluded: isExcludedSelectionEndpoint(startEl) || isExcludedSelectionEndpoint(endEl),
      text,
      hasLayout: rect.width > 0 || rect.height > 0,
    });
    if (verdict === 'ineligible') return null;
    return {
      text,
      overLimit: verdict === 'single-limit',
      rect: { centerX: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom },
    };
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = undefined;
      const next = inspect();
      setState(next);
      if (!next) setCopied(false);
    });
  }, [inspect]);

  useEffect(() => {
    const root = hostRef.current?.closest(".aui-thread-root");
    if (!root) return;
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" ? close() : schedule());
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) close();
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelectionChange);
    root.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelectionChange);
      root.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
    };
  }, [schedule, close]);

  // 工具条自身尺寸变化时重定位（ResizeObserver）
  useEffect(() => {
    if (!state || !menuRef.current) return;
    const ro = new ResizeObserver(() => {
      setState((prev) => (prev ? { ...prev } : prev));
    });
    ro.observe(menuRef.current);
    return () => ro.disconnect();
  }, [state]);

  const position = (() => {
    if (!state) return null;
    const w = menuRef.current?.offsetWidth ?? 160;
    const h = menuRef.current?.offsetHeight ?? 36;
    return resolveSelectionMenuPosition(state.rect, w, h, window.innerWidth, window.innerHeight);
  })();

  const onCopy = () => {
    if (!state) return;
    navigator.clipboard
      .writeText(state.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(close, 600);
      })
      .catch((e) => console.error('[selection] 复制失败', e));
  };

  const onQuote = () => {
    if (!state) return;
    // `aui.thread.composer` 是方法（`composer()` 返回 ComposerMethods）
    const composer = aui.thread.composer();
    const prev = composer.getState().text ?? '';
    composer.setText(`${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${formatQuoteForComposer(state.text)}`);
    close();
  };

  return (
    <div ref={hostRef} className="hidden" data-slot="aui_selection-toolbar-host">
      {state &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            data-slot="aui_selection-toolbar"
            data-conversation-selection-tooltip="true"
            data-over-limit={state.overLimit ? 'true' : undefined}
            className="bg-popover text-popover-foreground animate-in fade-in zoom-in-95 duration-100 fixed z-50 flex items-center gap-1 rounded-xl border border-border p-1 shadow-(--shadow-pop)"
            style={{ left: position.left, top: position.top }}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
          >
            {state.overLimit ? (
              <span className="text-muted-foreground px-2 py-1 text-xs">
                选中超长（上限 8000 字），请缩小范围
              </span>
            ) : (
              <>
                <button
                  type="button"
                  data-conversation-selection-action="copy"
                  onClick={onCopy}
                  className={cn(
                    'text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs outline-none',
                    copied && 'text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {copied ? (
                    <CheckIcon className="size-[var(--size-icon-sm)]" />
                  ) : (
                    <CopyIcon className="size-[var(--size-icon-sm)]" />
                  )}
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  data-conversation-selection-action="quote"
                  onClick={onQuote}
                  className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs outline-none"
                >
                  <QuoteIcon className="size-[var(--size-icon-sm)]" />
                  引用到输入框
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
};
