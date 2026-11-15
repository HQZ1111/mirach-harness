"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { QueuedSummaryContent } from "./queued-summary-content";

export const ANIMATION_DURATION = 200;

const ReasoningPreviewContext = createContext(false);

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

/** 允许在 Reasoning 之外复用 trigger（旧 ReasoningGroup 包装等）。 */
function useReasoningOptional() {
  return useContext(ReasoningContext);
}

// 2026-11-15：去掉 mb-4 / py-1.5。ZCode 的思考行是工作区里的普通摘要行，
// 垂直节奏由父容器 gap 决定；自带外边距会让组内出现 20px 空档（"乱的"）。
const reasoningVariants = cva("aui-reasoning-root mb-0 w-full", {
  variants: {
    variant: {
      // 去描边（用户 2026-10-14 全局去描边：卡片不留描边线）
      outline: "rounded-lg px-3 py-2",
      ghost: "",
      muted: "bg-muted/50 rounded-lg px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /**
     * 是否正在流式输出。流式期间默认保持收起（ZCode
     * `reasoning-streaming-auto-collapse.md`）：触发器后面接单行流式摘要；
     * 用户仍可主动展开看完整内容（一旦手动切换，默认规则不再覆盖）。
     */
    streaming?: boolean;
    /** Called right before the disclosure animates, on toggle and on streaming transitions. */
    onAnimationStart?: () => void;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  onAnimationStart,
  children,
  ...props
}: ReasoningRootProps) {
  const [initialOpen] = useState(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const isControlled = controlledOpen !== undefined;
  // **流式期间默认收起**（ZCode reasoning-streaming-auto-collapse.md 定稿）：
  // thought 块本身已表达"正在思考"，流式阶段默认保持收起，触发器后面接单行
  // 流式摘要；用户仍可主动展开看完整内容（userOpen 一旦有值就压过默认）。
  const isOpen = isControlled ? controlledOpen : (userOpen ?? initialOpen);
  // preview = 流式且展开（保留给 ReasoningContent 的底部渐隐）
  const isPreview = streaming === true && isOpen;

  // ── 耗时（ZCode 同款）：流式开始时起表，结束时定格；展开态每秒刷新，
  // 收起态不为了隐藏的耗时触发整块重渲。──
  const [measuredDuration, setMeasuredDuration] = useState<number | undefined>(
    undefined,
  );
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming) {
      if (startTimeRef.current !== null) {
        setMeasuredDuration(
          Math.ceil((Date.now() - startTimeRef.current) / 1000),
        );
        startTimeRef.current = null;
      }
      return;
    }

    if (startTimeRef.current === null) {
      startTimeRef.current = Date.now();
    }
    if (!isOpen) return;

    const updateDuration = () => {
      if (startTimeRef.current === null) return;
      setMeasuredDuration(
        Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)),
      );
    };
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, streaming]);

  const prevStreamingRef = useRef(streaming);
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return;
    prevStreamingRef.current = streaming;
    // A streaming transition only animates the panel when the resting state
    // is collapsed; with `defaultOpen` the disclosure stays open across it.
    if (!isControlled && userOpen === null && !initialOpen) {
      onAnimationStart?.();
    }
  }, [streaming, isControlled, userOpen, initialOpen, onAnimationStart]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onAnimationStart?.();
      if (!isControlled) {
        setUserOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [onAnimationStart, isControlled, controlledOnOpenChange],
  );

  const contextValue = useMemo<ReasoningContextValue>(
    () => ({
      isStreaming: streaming === true,
      isOpen,
      duration: measuredDuration,
    }),
    [streaming, isOpen, measuredDuration],
  );

  return (
    <ReasoningContext.Provider value={contextValue}>
      <Collapsible
        data-slot="reasoning-root"
        data-variant={variant}
        open={isOpen}
        onOpenChange={handleOpenChange}
        className={cn(
          "group/reasoning-root",
          reasoningVariants({ variant, className }),
        )}
        style={
          {
            "--animation-duration": `${ANIMATION_DURATION}ms`,
          } as React.CSSProperties
        }
        {...props}
      >
        <ReasoningPreviewContext.Provider value={isPreview}>
          {children}
        </ReasoningPreviewContext.Provider>
      </Collapsible>
    </ReasoningContext.Provider>
  );
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cn(
          "aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8",
          "bg-[linear-gradient(to_bottom,var(--color-background),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
          "fade-in-0 animate-in",
          "animation-duration-(--animation-duration)",
          className,
        )}
        {...props}
      />
    );
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
        "bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,color-mix(in_oklab,var(--color-muted)_50%,var(--color-background)),transparent)]",
        "fade-in-0 animate-in",
        "animation-duration-(--animation-duration)",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 折叠态单行流式摘要 = 文本里最后一条非空行（ZCode
 * `resolveReasoningStreamingSummary`）。行号当动画 key：同一行内的新 token
 * 原位刷新，出现新的非空行才纵向翻滚。
 */
export function resolveReasoningStreamingSummary(
  streamingText: string,
): { key: string; text: string } | null {
  const lines = streamingText.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text.length > 0) {
      return { key: String(index), text };
    }
  }
  return null;
}

const REASONING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

/** 横向溢出时才挂两侧 16px mask，短内容边缘不变淡。 */
export function getReasoningSummaryMaskStyle(
  isOverflowing: boolean,
): CSSProperties | undefined {
  if (!isOverflowing) return undefined;
  return {
    WebkitMaskImage: REASONING_SUMMARY_MASK,
    maskImage: REASONING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

function ReasoningTrigger({
  active,
  duration: durationProp,
  streamingText = "",
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  /** 覆盖自测耗时（外部已有时长时用）。 */
  duration?: number;
  /** 思考原文——折叠态单行摘要从这里派生。 */
  streamingText?: string;
}) {
  const ctx = useReasoningOptional();
  const isStreaming = ctx?.isStreaming ?? active === true;
  const isOpen = ctx?.isOpen ?? false;
  const duration = durationProp ?? ctx?.duration;

  const streamingSummary =
    isStreaming && !isOpen ? resolveReasoningStreamingSummary(streamingText) : null;
  const summaryViewportRef = useRef<HTMLSpanElement | null>(null);
  const summaryTextRef = useRef<HTMLSpanElement | null>(null);
  const [summaryOverflowing, setSummaryOverflowing] = useState(false);

  useEffect(() => {
    const viewport = summaryViewportRef.current;
    if (!viewport || !streamingSummary) return;

    const syncSummaryViewport = () => {
      setSummaryOverflowing((current) => {
        const next = viewport.scrollWidth > viewport.clientWidth + 1;
        return current === next ? current : next;
      });
      // 超宽后普通 overflow-hidden 会固定显示旧前缀；每次内容增长把视口推到
      // 末尾，让旧内容左移、最新 token 始终可见。
      viewport.scrollLeft = viewport.scrollWidth;
    };

    syncSummaryViewport();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncSummaryViewport);
    observer.observe(viewport);
    if (summaryTextRef.current) observer.observe(summaryTextRef.current);
    return () => observer.disconnect();
  }, [streamingSummary?.text]);

  // ZCode `chat.reasoning.thought` + `durationFewSeconds` / `durationSeconds`：
  // 「思考 持续了几秒」/「思考 持续了 N 秒」——两段之间只有 gap，没有分隔点。
  const thinkingMessage =
    isStreaming && !isOpen ? (
      <span className="shimmer font-normal motion-reduce:animate-none">
        正在思考
      </span>
    ) : duration === undefined ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-muted-foreground font-normal">思考</span>
        <span className="text-muted-foreground/70 font-normal">持续了几秒</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-2">
        <span className="text-muted-foreground font-normal">思考</span>
        <span className="text-muted-foreground/70 font-normal tabular-nums">
          持续了 {duration} 秒
        </span>
      </span>
    );

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger text-muted-foreground inline-flex max-w-full min-w-0 items-center gap-2 self-start py-0 text-sm transition-colors",
        className,
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        data-summary-leading-icon
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      {/* 左侧语义标签固定宽度，只让右侧摘要占剩余空间——否则长摘要会把
          「正在思考」挤成多行。 */}
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper shrink-0 whitespace-nowrap leading-none"
      >
        {thinkingMessage}
      </span>
      {streamingSummary ? (
        <span className="text-muted-foreground shrink-0">·</span>
      ) : null}
      {streamingSummary ? (
        <span
          ref={summaryViewportRef}
          data-slot="reasoning-trigger-summary"
          data-reasoning-streaming-mask={summaryOverflowing ? "both" : "none"}
          className="text-muted-foreground/80 min-w-0 flex-1 overflow-hidden whitespace-nowrap"
          style={getReasoningSummaryMaskStyle(summaryOverflowing)}
        >
          <QueuedSummaryContent
            contentKey={`reasoning-line:${streamingSummary.key}`}
            contentRefreshVersion={streamingSummary.text}
            primaryText={
              <span ref={summaryTextRef} className="inline-block min-w-max">
                {streamingSummary.text}
              </span>
            }
            enabled
          />
        </span>
      ) : null}
      <ChevronRightIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          "aui-reasoning-trigger-chevron size-[var(--size-icon-md)] shrink-0",
          "transition-[opacity,transform] duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          // ZCode：收起时不占视觉噪声，悬停才浮出。
          isOpen
            ? "rotate-90 opacity-100"
            : "rotate-0 opacity-0 group-hover/trigger:opacity-100",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className,
      )}
      {...props}
    >
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => {
      if (!pinned) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is user intent.
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true;
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false;
      }
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-[240px] overflow-y-auto pe-1 ps-6 pt-2 pb-2 leading-relaxed text-pretty",
        "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)]",
        "motion-reduce:animate-none",
        "group-data-open/collapsible-content:animate-in",
        "group-data-closed/collapsible-content:animate-out",
        "group-data-open/collapsible-content:fade-in-0",
        "group-data-closed/collapsible-content:fade-out-0",
        "group-data-open/collapsible-content:slide-in-from-top-4",
        "group-data-closed/collapsible-content:slide-out-to-top-4",
        "group-data-open/collapsible-content:blur-in-[2px]",
        "group-data-closed/collapsible-content:blur-out-[2px]",
        "group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        "group-data-closed/collapsible-content:animation-duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      {/* 思考原文按纯文本展示并保留换行（ZCode 同款）：thought 可能很长且
          持续追加，走 Markdown 每次 chunk 都要重解析，字越多越卡。 */}
      <div
        ref={contentRef}
        className="aui-reasoning-text-content min-w-0 whitespace-pre-wrap break-words"
      >
        {children}
      </div>
    </div>
  );
}

export {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
};
