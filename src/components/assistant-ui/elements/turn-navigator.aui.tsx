"use client";

/**
 * 轮导航器（ZCode `ConversationTurnNavigator` 的宿主版，2026-11-03）：
 * 对话区左缘的**竖条 mini-map**，一条横杠 = 一次用户 query；悬停出预览、
 * 点击滚到该轮。容器 ≥864px 且 ≥2 条 query 才显示（ZCode
 * `CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864` 同值）。
 *
 * ## 与 ZCode 的结构差异（有意）
 *
 * ZCode 的对话区是**虚拟列表**（turn 未挂载时先挂载再对齐，重试 12 帧）。
 * 宿主无虚拟化（用户裁定"虚拟滚动先不做"）——所有轮常驻 DOM，点击直接
 * `scrollTo` 该轮容器，不需要挂载重试。
 *
 * bar 视觉（opacity/scaleX 距离衰减）、预览浮层内容（user 两行 +
 * assistant 三行）、running 不透明度下限 0.72，全部照抄（视觉判定在
 * `turn-navigator.ts` 纯函数，有单测）。预览浮层不用 Radix HoverCard
 * （宿主没有该封装），由本组件按 hoveredIndex 自绘——跟随 hover 杠的
 * y 位置，语义与 ZCode 的 side="right" 浮层一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAui, useAuiState, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import {
  buildTurnNavigatorItems,
  resolveNavigatorActiveIndex,
  resolveNavigatorBarVisualState,
} from "@/components/assistant-ui/turn-navigator";

/** 判定线 = 视口高度 40%（滚动到这个位置以上算"已读"） */
const ACTIVE_LINE_RATIO = 0.4;
/** 显示下限（ZCode CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX） */
const MIN_WIDTH_PX = 864;

/** 从消息 state 取纯文本（string 直取；parts 拼全部 text） */
function messageText(m: { content: unknown } | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

export const TurnNavigator: FC = () => {
  const aui = useAui();
  const ids = unstable_useThreadMessageIds();
  const roleSig = useAuiState((s) =>
    s.thread.messages.map((m) => (m.role === "user" ? "u" : "a")).join(""),
  );
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const items = useMemo(
    () =>
      buildTurnNavigatorItems(
        ids.map((id, i) => ({ id, role: roleSig[i] === "u" ? "user" : "assistant" })),
      ),
    [ids, roleSig],
  );

  const [hovered, setHovered] = useState<number | undefined>(undefined);
  const [active, setActive] = useState(-1);
  const navRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);

  // 滚动位置 → 活动项（rAF 节流；判定线 = 视口高度 40%，tops 相对视口）
  const measure = useCallback(() => {
    rafRef.current = undefined;
    const nav = navRef.current;
    const viewport = nav
      ?.closest(".aui-thread-root")
      ?.querySelector('[data-slot="aui_thread-viewport"]');
    if (!nav || !viewport) return;
    const vh = viewport.getBoundingClientRect();
    const tops = items.map((item) => {
      const el = viewport.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(item.key)}"]`);
      return el ? el.getBoundingClientRect().top - vh.top : Number.POSITIVE_INFINITY;
    });
    setActive(resolveNavigatorActiveIndex(tops, vh.height * ACTIVE_LINE_RATIO));
  }, [items]);

  useEffect(() => {
    const nav = navRef.current;
    const viewport = nav
      ?.closest(".aui-thread-root")
      ?.querySelector('[data-slot="aui_thread-viewport"]');
    if (!viewport || items.length === 0) return;
    const onScroll = () => {
      if (rafRef.current !== undefined) return;
      rafRef.current = window.requestAnimationFrame(measure);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
    };
  }, [items, measure]);

  const jump = useCallback(
    (key: string) => {
      const nav = navRef.current;
      const viewport = nav
        ?.closest(".aui-thread-root")
        ?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      const el = viewport?.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(key)}"]`);
      if (!viewport || !el) return;
      // 该轮顶部对齐视口顶部（留 8px 呼吸）；ZCode scrollToQuery 同语义
      const top = Math.max(
        0,
        viewport.scrollTop + el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8,
      );
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      viewport.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    },
    [],
  );

  // 悬停预览：hover 时现取（不订阅——预览是即时读数，非渲染依赖）
  const preview = useMemo(() => {
    if (hovered === undefined) return null;
    const key = items[hovered]?.key;
    if (!key) return null;
    const msgs = aui.thread.getState().messages;
    const start = msgs.findIndex((m) => m.id === key);
    if (start < 0) return null;
    let assistantText = "";
    for (let i = start + 1; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || m.role === "user") break;
      assistantText = messageText(m) || assistantText;
      if (assistantText) break;
    }
    const runningAssistant =
      msgs[start + 1]?.role === "assistant" && msgs[start + 1]?.status?.type === "running";
    return {
      userPreview: messageText(msgs[start]) || "（无文本）",
      assistantPreview:
        assistantText || (runningAssistant ? "正在回复…" : "（本轮还没有回复）"),
      assistantIsRunning: runningAssistant && !assistantText,
    };
  }, [hovered, items, aui]);

  if (items.length < 2) return null;

  return (
    <nav
      ref={navRef}
      data-slot="aui_turn-navigator"
      data-item-count={items.length}
      aria-label="会话轮导航"
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out @min-[864px]/thread:visible @min-[864px]/thread:translate-x-0 @min-[864px]/thread:opacity-100 motion-reduce:transition-none"
    >
      <div className="pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1 [scrollbar-width:none]">
        {items.map((item, itemIndex) => {
          const visual = resolveNavigatorBarVisualState({
            itemIndex,
            visualFocusItemIndex: hovered,
          });
          // running 标记 = 正在跑的轮的最后一条 query（ZCode 同款：
          // `unit.isRunning && queryIndex === realUserInputs.length - 1`）
          const itemRunning = isRunning && itemIndex === items.length - 1;
          return (
            <div
              key={item.key}
              className="relative h-2.5 w-9"
            >
              <button
                type="button"
                aria-current={active === itemIndex ? "location" : undefined}
                aria-label={`跳到第 ${itemIndex + 1} 条提问`}
                aria-posinset={itemIndex + 1}
                aria-setsize={items.length}
                data-slot="aui_turn-navigator-item"
                data-item-index={itemIndex}
                data-turn-key={item.key}
                data-active={active === itemIndex ? "true" : "false"}
                data-running={itemRunning ? "true" : "false"}
                onPointerEnter={() => setHovered(itemIndex)}
                onPointerLeave={() => setHovered(undefined)}
                onFocus={() => setHovered(itemIndex)}
                onBlur={() => setHovered(undefined)}
                onClick={() => jump(item.key)}
                className="flex h-2.5 w-9 items-center justify-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span
                  className={cn(
                    "bg-foreground/30 block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                    visual.colorTone === "focus" && "bg-foreground",
                  )}
                  style={{
                    opacity: itemRunning
                      ? Math.max(visual.opacity, 0.72)
                      : active === itemIndex && hovered === undefined
                        ? 0.9
                        : visual.opacity,
                    transform: `scaleX(${visual.scaleX})`,
                  }}
                />
              </button>
            </div>
          );
        })}
      </div>

      {/* 悬停预览（跟随 hovered 杠；ZCode HoverCard side="right" 同位） */}
      {preview !== null && hovered !== undefined && (
        <div
          data-slot="aui_turn-navigator-tooltip"
          data-item-index={hovered}
          className="bg-popover text-popover-foreground pointer-events-none absolute left-11 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border p-3 shadow-(--shadow-pop)"
          style={{ top: `calc(50% - 2rem + ${hovered * 10}px)` }}
        >
          <div className="space-y-2">
            <p className="line-clamp-2 whitespace-pre-line text-sm leading-5 font-medium">
              {preview.userPreview}
            </p>
            <p
              className={cn(
                "line-clamp-3 whitespace-pre-line text-sm leading-5",
                preview.assistantIsRunning
                  ? "text-muted-foreground"
                  : "text-popover-foreground/80",
              )}
            >
              {preview.assistantPreview}
            </p>
          </div>
        </div>
      )}
    </nav>
  );
};
