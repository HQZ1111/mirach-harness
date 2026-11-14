"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/motion/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";

export type TokenUsage = {
  totalTokens?: number | undefined;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
};

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
};

const getUsagePercent = (
  totalTokens: number | undefined,
  modelContextWindow: number,
): number => {
  if (!totalTokens) return 0;
  // 窗口 <=0 时除零 → Infinity → clamp 100 = 满格红环误报。返回 0
  // （Caller ContextDisplayBar 已把 <=0 归入不渲染集合，这里只防其他入口）
  if (modelContextWindow <= 0) return 0;
  return Math.min((totalTokens / modelContextWindow) * 100, 100);
};

type UsageSeverity = "normal" | "warning" | "critical";

const getUsageSeverity = (percent: number): UsageSeverity => {
  if (percent > 85) return "critical";
  if (percent >= 65) return "warning";
  return "normal";
};

const getStrokeColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "stroke-red-500";
  if (severity === "warning") return "stroke-amber-500";
  return "stroke-foreground";
};

const getBarColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-foreground";
};

const getPercentColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "text-red-500";
  if (severity === "warning") return "text-amber-500";
  return "text-muted-foreground";
};
type ContextDisplayContextValue = {
  usage: TokenUsage | undefined;
  totalTokens: number;
  percent: number;
  modelContextWindow: number;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(
  null,
);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) {
    throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  }
  return ctx;
}
export type PresetProps = {
  modelContextWindow: number;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  usage?: TokenUsage | undefined;
  resetKey?: string | undefined;
};

export type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  usage?: TokenUsage | undefined;
  resetKey?: string | undefined;
};

function ContextDisplayRoot({
  modelContextWindow,
  children,
  usage,
  resetKey,
}: ContextDisplayRootProps) {
  const rawTokens = usage?.totalTokens ?? 0;
  const [tokenState, setTokenState] = useState({
    resetKey,
    totalTokens: rawTokens > 0 ? rawTokens : 0,
    usage,
  });

  if (
    tokenState.resetKey !== resetKey ||
    (rawTokens > 0 && rawTokens !== tokenState.totalTokens) ||
    usage !== tokenState.usage
  ) {
    setTokenState((prev) => {
      if (prev.resetKey !== resetKey) {
        return {
          resetKey,
          totalTokens: rawTokens > 0 ? rawTokens : 0,
          usage,
        };
      }
      if (rawTokens > 0 && rawTokens !== prev.totalTokens) {
        return { ...prev, totalTokens: rawTokens, usage };
      }
      if (usage !== prev.usage) {
        return { ...prev, usage };
      }
      return prev;
    });
  }

  const current =
    tokenState.resetKey === resetKey
      ? tokenState
      : { totalTokens: rawTokens > 0 ? rawTokens : 0, usage };
  const totalTokens = current.totalTokens;
  const percent = getUsagePercent(totalTokens, modelContextWindow);
  const hasUsage = current.usage !== undefined || totalTokens > 0;

  const contextValue = useMemo(
    () => ({
      usage: current.usage,
      totalTokens,
      percent,
      modelContextWindow,
    }),
    [current.usage, totalTokens, percent, modelContextWindow],
  );

  if (!hasUsage) return null;

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      <TooltipProvider>
        <Tooltip>{children}</Tooltip>
      </TooltipProvider>
    </ContextDisplayContext.Provider>
  );
}
function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <TooltipTrigger asChild>
      <button
        type="button"
        data-slot="context-display-trigger"
        className={cn(
          "inline-flex items-center rounded-md transition-colors",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </TooltipTrigger>
  );
}

type ContextSegment = {
  label: string;
  tokens: number;
};

// Whether a provider counts cached tokens inside inputTokens, or reasoning
// inside outputTokens, differs by provider: OpenAI reports cached_tokens as a
// subset of prompt_tokens, while Anthropic documents input_tokens as excluding
// cache_read_input_tokens. Nothing in the usage contract says which is in hand,
// so these are reported as the counts they are and none of them is given a
// share of the bar, which stays the one reading that always holds: the
// provider's own total against the window.
const getContextSegments = (
  usage: TokenUsage | undefined,
): ContextSegment[] => {
  if (!usage) return [];
  return [
    { label: "Input", tokens: usage.inputTokens ?? 0 },
    { label: "Cached input", tokens: usage.cachedInputTokens ?? 0 },
    { label: "Output", tokens: usage.outputTokens ?? 0 },
    { label: "Reasoning", tokens: usage.reasoningTokens ?? 0 },
  ].filter((segment) => segment.tokens > 0);
};

function ContextDisplayContent({
  side = "top",
  className,
}: {
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const { usage, totalTokens, percent, modelContextWindow } =
    useContextDisplay();
  const segments = getContextSegments(usage);

  return (
    <TooltipContent
      side={side}
      sideOffset={8}
      data-slot="context-display-popover"
      className={cn(
        // 去描边（用户 2026-10-14 全局去描边）：浮层边界改由 shadow-md 承担
        "bg-popover text-popover-foreground block w-56 p-3 text-left shadow-md [&_[data-slot=tooltip-arrow]]:hidden",
        className,
      )}
    >
      <div className="text-xs">
        <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
          <span className={getPercentColor(percent)}>
            {Math.round(percent)}% full
          </span>
          <span className="font-mono tabular-nums">
            {formatTokenCount(Math.min(totalTokens, modelContextWindow))} /{" "}
            {formatTokenCount(modelContextWindow)}
          </span>
        </div>
        <div className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full w-(--usage-width) rounded-full transition-[width] duration-300",
              totalTokens > 0 && "min-w-1",
              getBarColor(percent),
            )}
            style={{ "--usage-width": `${percent}%` } as React.CSSProperties}
          />
        </div>
        {segments.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            {segments.map((segment) => (
              <div
                key={segment.label}
                className="flex items-baseline justify-between gap-6"
              >
                <span className="text-muted-foreground">{segment.label}</span>
                <span className="font-mono tabular-nums">
                  {formatTokenCount(segment.tokens)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </TooltipContent>
  );
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 环的纯绘制（props 进 percent）——RingVisual（读 Root context）与
 *  BreakdownButton（自带数值、无 Root）共用同一份几何。 */
function RingSvg({ percent }: { percent: number }) {
  return (
    <svg
      aria-hidden="true"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-muted"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={
          RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE
        }
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          getStrokeColor(percent),
        )}
      />
    </svg>
  );
}

function RingVisual() {
  const { percent } = useContextDisplay();

  return <RingSvg percent={percent} />;
}

function RingPercentLabel() {
  const { percent } = useContextDisplay();
  return <span className="font-mono tabular-nums">{Math.round(percent)}%</span>;
}
const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  resetKey,
}) => (
  <ContextDisplayRoot
    modelContextWindow={modelContextWindow}
    usage={usage}
    resetKey={resetKey}
  >
    <ContextDisplayTrigger
      className={cn(
        "text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs",
        className,
      )}
      aria-label="Context usage"
    >
      <RingVisual />
      <RingPercentLabel />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function BarVisual() {
  const { percent, totalTokens } = useContextDisplay();

  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            getBarColor(percent),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[10px] tabular-nums">
        {formatTokenCount(totalTokens)} ({Math.round(percent)}%)
      </span>
    </div>
  );
}

const ContextDisplayBar: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  resetKey,
}) => (
  <ContextDisplayRoot
    modelContextWindow={modelContextWindow}
    usage={usage}
    resetKey={resetKey}
  >
    <ContextDisplayTrigger
      className={cn("px-2 py-1", className)}
      aria-label="Context usage"
    >
      <BarVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function TextVisual() {
  const { totalTokens, modelContextWindow } = useContextDisplay();

  return (
    <>
      {formatTokenCount(totalTokens)} / {formatTokenCount(modelContextWindow)}
    </>
  );
}

const ContextDisplayText: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  resetKey,
}) => (
  <ContextDisplayRoot
    modelContextWindow={modelContextWindow}
    usage={usage}
    resetKey={resetKey}
  >
    <ContextDisplayTrigger
      aria-label="Context usage"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground px-2 py-1 font-mono text-xs tabular-nums",
        className,
      )}
    >
      <TextVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

/**
 * 上下文明细**按钮**（2026-11-01 用户："模型选择的左边加个上下文的按钮，
 * 和zcode一样的"；次日定稿："一个圆圈图标就行"）：挂 composer 动作组
 * 模型选择器左侧。**按钮本体 = 一枚圆环图标**（环的填充度 = 上下文占用，
 * 无用量即空环）——不放文字；点击弹明细卡（getContextSegments：Input /
 * Cached input / Output / Reasoning + %full 进度条）。渲染门槛 = 只看
 * 窗口；无用量是诚实空态（空环 + 弹层说明），不编 0 冒充数据
 * （pi_sessions_usage 的累计值当上下文占用是假语义，不用）；不走
 * ContextDisplayRoot（其 TooltipProvider/Tooltip 是悬停语义，点击卡
 * 不需要）。
 */
const ContextDisplayBreakdownButton: FC<PresetProps> = ({
  modelContextWindow,
  usage,
  className,
}) => {
  if (modelContextWindow <= 0) return null;
  const totalTokens = usage?.totalTokens ?? 0;
  const hasUsage = totalTokens > 0;
  const percent = hasUsage ? getUsagePercent(totalTokens, modelContextWindow) : 0;
  const segments = hasUsage ? getContextSegments(usage) : [];

  return (
    <Popover align="center" side="top" sideOffset={8}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label="上下文明细"
          className={cn(
            "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground grid size-8 place-items-center rounded-full transition-colors",
            percent > 85 && "text-red-500 dark:text-red-400",
            className,
          )}
        >
          <RingSvg percent={percent} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3 text-xs">
        {hasUsage ? (
          <div>
            <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
              <span className={getPercentColor(percent)}>{Math.round(percent)}% full</span>
              <span className="font-mono tabular-nums">
                {formatTokenCount(Math.min(totalTokens, modelContextWindow))} /{" "}
                {formatTokenCount(modelContextWindow)}
              </span>
            </div>
            <div className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  "h-full w-(--usage-width) rounded-full transition-[width] duration-300",
                  totalTokens > 0 && "min-w-1",
                  getBarColor(percent),
                )}
                style={{ "--usage-width": `${percent}%` } as React.CSSProperties}
              />
            </div>
            {segments.length > 0 && (
              <div className="mt-3 grid gap-1.5">
                {segments.map((segment) => (
                  <div
                    key={segment.label}
                    className="flex items-baseline justify-between gap-6"
                  >
                    <span className="text-muted-foreground">{segment.label}</span>
                    <span className="font-mono tabular-nums">
                      {formatTokenCount(segment.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
              <span className="text-muted-foreground">暂无用量记录</span>
              <span className="font-mono tabular-nums">
                – / {formatTokenCount(modelContextWindow)}
              </span>
            </div>
            <p className="text-muted-foreground/70 mt-2 text-[11px] leading-4">
              发送首条消息后显示上下文占用与分解。
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

const ContextDisplay = {} as {
  Root: typeof ContextDisplayRoot;
  Trigger: typeof ContextDisplayTrigger;
  Content: typeof ContextDisplayContent;
  Ring: typeof ContextDisplayRing;
  Bar: typeof ContextDisplayBar;
  Text: typeof ContextDisplayText;
  Button: typeof ContextDisplayBreakdownButton;
};

ContextDisplay.Root = ContextDisplayRoot;
ContextDisplay.Trigger = ContextDisplayTrigger;
ContextDisplay.Content = ContextDisplayContent;
ContextDisplay.Ring = ContextDisplayRing;
ContextDisplay.Bar = ContextDisplayBar;
ContextDisplay.Text = ContextDisplayText;
ContextDisplay.Button = ContextDisplayBreakdownButton;

export {
  ContextDisplay,
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayContent,
  ContextDisplayRing,
  ContextDisplayBar,
  ContextDisplayText,
  ContextDisplayBreakdownButton,
};
