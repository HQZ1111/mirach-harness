"use client";

/**
 * 摘要滚动队列（逐字移植 ZCode `ToolCallBlocks/QueuedSummaryContent.tsx`）。
 *
 * 用途：思考折叠态的单行流式摘要、工具行摘要。同一 `contentKey` 的内容
 * 原位刷新（`contentRefreshVersion` 变化 → 不重播整条）；`contentKey` 变化
 * 时纵向翻滚：旧行向上退出、新行自下方进入，节奏 = 300ms 动画 + 500ms 停留。
 * 队列最多保存「下一条 + 可插队条」两格；主线程卡顿（timer 迟到 > 250ms）
 * 时直接收敛到最新一条，不补播过期状态。reduced motion 或 `disableAnimation`
 * 时直出，不排队。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

export const SUMMARY_ROLL_TRANSITION_MS = 300;
export const SUMMARY_ROLL_HOLD_MS = 500;
export const SUMMARY_ROLL_TOTAL_MS =
  SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;
const SUMMARY_ROLL_TRANSITION = {
  duration: SUMMARY_ROLL_TRANSITION_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;

function getCurrentTimestamp() {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

/** timer 迟到太多时不补播积压，只保留最新一条。 */
export function resolveQueuedSummaryPlaybackQueue<T>(
  queuedContent: readonly T[],
  timerDriftMs: number,
): T[] {
  if (
    timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS &&
    queuedContent.length > 1
  ) {
    return queuedContent.slice(-1);
  }
  return [...queuedContent];
}

export function shouldAnimateQueuedSummaryContent({
  enabled,
  disableAnimation,
  reducedMotion,
}: {
  enabled: boolean;
  disableAnimation?: boolean;
  reducedMotion: boolean;
}): boolean {
  return enabled && disableAnimation !== true && !reducedMotion;
}

interface SummaryContentSnapshot {
  key: string;
  /** 同一 key 的内容版本；身份/值变化才原位刷新（ZCode：unknown）。 */
  refreshVersion?: unknown;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
}

/** 同一 key 下只有 version / trailing 变化时才原位刷新。 */
export function shouldRefreshQueuedSummaryContent(
  current: Pick<
    SummaryContentSnapshot,
    "key" | "refreshVersion" | "trailingText"
  >,
  next: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
): boolean {
  return (
    current.key === next.key &&
    (current.trailingText !== next.trailingText ||
      current.refreshVersion !== next.refreshVersion)
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function QueuedSummaryContent({
  contentKey,
  contentRefreshVersion,
  primaryText,
  secondaryText,
  trailingText,
  enabled,
  disableAnimation = false,
}: {
  contentKey: string;
  /** 同一 key 内的内容版本（对象身份/值任一变化都原位刷新）。 */
  contentRefreshVersion?: unknown;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
  enabled: boolean;
  disableAnimation?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = shouldAnimateQueuedSummaryContent({
    enabled,
    disableAnimation,
    reducedMotion,
  });
  const createSnapshot = (): SummaryContentSnapshot => ({
    key: contentKey,
    refreshVersion: contentRefreshVersion,
    primaryText,
    secondaryText,
    trailingText,
  });
  const [displayedContent, setDisplayedContent] = useState(createSnapshot);
  const displayedContentRef = useRef(displayedContent);
  const queuedContentRef = useRef<SummaryContentSnapshot[]>([]);
  const animationTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    displayedContentRef.current = displayedContent;
  }, [displayedContent]);

  useEffect(() => {
    const clearAnimationTimer = () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
    const enqueue = (snapshot: SummaryContentSnapshot) => {
      const queue = queuedContentRef.current;
      const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
      if (existingIndex >= 0) {
        // 同一 key 的待播项只更新内容，不为每次变化新增滚动项。
        const nextQueue = [...queue];
        nextQueue[existingIndex] = snapshot;
        queuedContentRef.current = nextQueue;
        return;
      }

      if (queue.length === 0) {
        queuedContentRef.current = [snapshot];
        return;
      }

      // 队列只保存后两格：第二条不能被覆盖，新摘要只能替换第三格。
      queuedContentRef.current = [queue[0]!, snapshot].slice(
        0,
        SUMMARY_ROLL_MAX_PENDING,
      );
    };
    const promote = (snapshot: SummaryContentSnapshot) => {
      displayedContentRef.current = snapshot;
      setDisplayedContent(snapshot);
      isAnimatingRef.current = true;
      clearAnimationTimer();
      const expectedTimerAt = getCurrentTimestamp() + SUMMARY_ROLL_TOTAL_MS;
      animationTimerRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        animationTimerRef.current = null;
        const queuedContent = queuedContentRef.current;
        const timerDrift = getCurrentTimestamp() - expectedTimerAt;
        const nextQueue = resolveQueuedSummaryPlaybackQueue(
          queuedContent,
          timerDrift,
        );
        const [nextQueued, ...restQueued] = nextQueue;
        if (!nextQueued) {
          queuedContentRef.current = [];
          return;
        }
        queuedContentRef.current = restQueued;
        promote(nextQueued);
      }, SUMMARY_ROLL_TOTAL_MS);
    };
    const nextContent = createSnapshot();

    if (!shouldAnimate) {
      clearAnimationTimer();
      isAnimatingRef.current = false;
      queuedContentRef.current = [];
      displayedContentRef.current = nextContent;
      setDisplayedContent(nextContent);
      return;
    }

    if (displayedContentRef.current.key === nextContent.key) {
      if (shouldRefreshQueuedSummaryContent(displayedContentRef.current, nextContent)) {
        displayedContentRef.current = nextContent;
        setDisplayedContent(nextContent);
      }
      return;
    }

    if (isAnimatingRef.current) {
      enqueue(nextContent);
      return;
    }

    if (queuedContentRef.current.length > 0) {
      enqueue(nextContent);
      return;
    }

    promote(nextContent);
  }, [contentKey, contentRefreshVersion, shouldAnimate, trailingText]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  if (!shouldAnimate) {
    return (
      <>
        {primaryText}
        {secondaryText}
        {trailingText}
      </>
    );
  }

  return (
    <span className="relative inline-flex min-w-0 items-center gap-2 overflow-hidden align-middle">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={displayedContent.key}
          className="inline-flex min-w-0 items-center gap-2"
          initial={{ y: "0.8em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={SUMMARY_ROLL_TRANSITION}
        >
          {displayedContent.primaryText}
          {displayedContent.secondaryText}
        </motion.span>
      </AnimatePresence>
      {displayedContent.trailingText}
    </span>
  );
}
