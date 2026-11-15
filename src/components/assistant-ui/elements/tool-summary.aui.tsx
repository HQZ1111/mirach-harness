"use client";

/**
 * 工具摘要行 + 可展开正文（ZCode `ToolCallBlocks/ToolLayout.tsx` +
 * `ToolSummaryRow.tsx` 的宿主移植，2026-11-15）。
 *
 * ## 为什么重写
 *
 * 宿主此前每个工具都渲染**整张卡**（terminal-block / code-diff / tool-call），
 * 一屏工具调用占掉半屏高度。ZCode 的口径是：**一行摘要 + 按需展开**——
 * 摘要行 = 图标 + 类别词（正在读取/已读取）+ 关键参数 chip + 状态词
 * （+ diff 计数），正文（命令/输出/参数/结果/diff）只在展开后出现。
 *
 * ## 逐条对齐的 ZCode 行为
 *
 * 1. **展开态按 toolCallId 持久化**（`toolLayoutOpenState`，ZCode 同款模块级
 *    Map）——流式追加导致重挂载不会把用户展开的卡收回去；
 * 2. **ONDR 收起延迟卸载 300ms**：Radix 的收起动画要读内容真实高度，先卸载
 *    children 会让高度变量消失 → 详情区瞬间撑成超高空白（ZCode 实测注释）；
 * 3. **运行态类别词扫光、图标保持静态**：流式期间工具卡数量多，旋转 loader
 *    长期占用渲染资源（ZCode 同理由）；
 * 4. **失败不换错误卡**：错误挂在状态词的虚线下划线上（tooltip = 错误原文 +
 *    复制钮），摘要行保持与成功态一致的展开逻辑（ZCode `showFailureStatus`）；
 * 5. **整行是 trigger**，Enter/Space 可开合；摘要里可能有文件 chip 按钮，所以
 *    用 div[role=button] 而不是 button（ZCode 同）。
 *
 * 纯展示组件：不含数据解析（分流在 `tool-renderers.aui.tsx`）。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SummaryPreviewContext } from "@/components/assistant-ui/summary-preview-context";

const CONTENT_UNMOUNT_DELAY_MS = 300;

/** 展开态按工具实例持久化（ZCode `toolLayoutOpenState` 同款）。 */
const toolSummaryOpenState = new Map<string, boolean>();

export interface ToolSummaryProps {
  /** 工具实例 id（展开记忆的键）。 */
  toolId: string;
  /** 工具名（DOM 标记，排查/自动化用）。 */
  toolName?: string;
  icon: ReactNode;
  /** 类别词：正在读取 / 已读取 / 正在执行 / 已执行 … */
  kindLabel: string;
  /** 关键参数 chip（路径 / 命令 / 查询词）。 */
  primaryText?: ReactNode;
  /** 次要参数（命令原文等）；展开后默认隐藏以免与正文重复。 */
  secondaryText?: ReactNode;
  hideSecondaryWhenOpen?: boolean;
  /** 状态词：执行中 / 已执行 / 执行失败 … */
  statusLabel?: string;
  /** 失败态：状态词变红 + 虚线下划线 + tooltip 错误原文。 */
  failed?: boolean;
  statusTooltip?: string;
  /** diff 统计（+N/−N），只在编辑类工具出现。 */
  diffCount?: ReactNode;
  running?: boolean;
  canToggle?: boolean;
  /** 首次满足条件时自动展开一次，之后仍允许用户收起。 */
  autoOpen?: boolean;
  title?: string;
  /** 展开后的正文；`canToggle === false` 时不渲染。 */
  content?: ReactNode;
  /**
   * 整行激活动作（ZCode `ToolSummaryRow` 的 `action` 分支）：不可展开的
   * 摘要行整行可点，打开详情面板（宿主子代理详情等）。
   */
  onActivate?: () => void;
  /** onActivate 的无障碍标签（缺省取 title）。 */
  activateLabel?: string;
  className?: string;
}

export const ToolSummary: FC<ToolSummaryProps> = ({
  toolId,
  toolName,
  icon,
  kindLabel,
  primaryText,
  secondaryText,
  hideSecondaryWhenOpen = false,
  statusLabel,
  failed = false,
  statusTooltip,
  diffCount,
  running = false,
  canToggle = true,
  autoOpen = false,
  title,
  content,
  onActivate,
  activateLabel,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(() => toolSummaryOpenState.get(toolId) ?? false);
  const [shouldRenderContent, setShouldRenderContent] = useState(isOpen);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const preview = useContext(SummaryPreviewContext);

  // toolId 变化（列表位移复用节点）时重新读持久化态——ZCode 同款重置语义
  useEffect(() => {
    hasAutoOpenedRef.current = false;
    setIsOpen(toolSummaryOpenState.get(toolId) ?? false);
  }, [toolId]);

  // 自动展开只发生一次（ZCode autoOpen 语义：不是 forceOpen 的锁死）
  useEffect(() => {
    if (!autoOpen || hasAutoOpenedRef.current) return;
    hasAutoOpenedRef.current = true;
    toolSummaryOpenState.set(toolId, true);
    setIsOpen(true);
    setShouldRenderContent(true);
  }, [autoOpen, toolId]);

  // 收起时延迟卸载 children（收起动画要读真实内容高度）
  useEffect(() => {
    if (isOpen) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }
    if (!shouldRenderContent) return;
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, CONTENT_UNMOUNT_DELAY_MS);
    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isOpen, shouldRenderContent]);

  useEffect(
    () => () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
      }
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      toolSummaryOpenState.set(toolId, open);
      if (open) setShouldRenderContent(true);
      setIsOpen(open);
    },
    [toolId],
  );

  const copyError = useCallback(() => {
    if (statusTooltip === undefined || statusTooltip.trim().length === 0) return;
    navigator.clipboard
      .writeText(statusTooltip)
      .then(() => {
        setCopied(true);
        if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
        copyResetRef.current = window.setTimeout(() => {
          copyResetRef.current = null;
          setCopied(false);
        }, 1500);
      })
      .catch((e) => console.error("[tool] 复制错误信息失败", e));
  }, [statusTooltip]);

  const statusWord =
    statusLabel !== undefined && statusLabel.length > 0 ? (
      statusTooltip !== undefined && statusTooltip.trim().length > 0 ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "cursor-help whitespace-nowrap underline decoration-dotted underline-offset-2",
                  failed ? "text-red-500" : "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-96">
              <div className="flex max-w-96 items-center gap-2">
                <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {statusTooltip}
                </span>
                <button
                  type="button"
                  className="hover:bg-background/20 inline-flex size-5 shrink-0 items-center justify-center rounded"
                  title={copied ? "已复制" : "复制错误"}
                  aria-label={copied ? "已复制" : "复制错误"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    copyError();
                  }}
                >
                  {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span
          className={cn(
            "whitespace-nowrap",
            failed ? "text-red-500" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
      )
    ) : null;

  const showSecondary = secondaryText != null && !(isOpen && hideSecondaryWhenOpen);

  // 摘要预览（连续摘要组收起态的组头滚动）：只渲染摘要行本体，不挂折叠壳，
  // 不写展开记忆（ZCode ToolLayout 的 preview 分支同款）。
  if (preview) {
    return (
      <div className="summary-hover-text group/tool-summary flex min-w-0 max-w-full items-center gap-2 text-sm">
        <SummaryContent
          icon={icon}
          kindLabel={kindLabel}
          running={running}
          primaryText={primaryText}
          secondaryText={secondaryText}
          diffCount={diffCount}
          statusWord={statusWord}
          isOpen={false}
          canToggle={false}
        />
      </div>
    );
  }

  return (
    <Collapsible
      data-slot="aui_tool-summary"
      data-tool-id={toolId}
      data-tool-name={toolName}
      data-tool-state={running ? "running" : failed ? "failed" : "done"}
      open={canToggle && isOpen}
      onOpenChange={handleOpenChange}
      className={cn("flex w-full flex-col", className)}
    >
      {canToggle ? (
        <CollapsibleTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            aria-label={isOpen ? "收起工具详情" : "展开工具详情"}
            title={title}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              handleOpenChange(!isOpen);
            }}
            className="summary-hover-text group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SummaryContent
              icon={icon}
              kindLabel={kindLabel}
              running={running}
              primaryText={primaryText}
              secondaryText={showSecondary ? secondaryText : undefined}
              diffCount={diffCount}
              statusWord={statusWord}
              isOpen={isOpen}
              canToggle
            />
          </div>
        </CollapsibleTrigger>
      ) : onActivate ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={activateLabel ?? title ?? "打开详情"}
          title={title}
          onClick={onActivate}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onActivate();
          }}
          className="summary-hover-text group/tool-summary focus-visible:ring-ring inline-flex w-full max-w-full cursor-pointer items-center gap-2 text-left text-sm outline-none transition-colors focus-visible:ring-2"
        >
          <SummaryContent
            icon={icon}
            kindLabel={kindLabel}
            running={running}
            primaryText={primaryText}
            secondaryText={secondaryText}
            diffCount={diffCount}
            statusWord={statusWord}
            isOpen={false}
            canToggle={false}
          />
        </div>
      ) : (
        <div
          title={title}
          className="summary-hover-text group/tool-summary inline-flex w-full max-w-full cursor-default items-center gap-2 text-left text-sm"
        >
          <SummaryContent
            icon={icon}
            kindLabel={kindLabel}
            running={running}
            primaryText={primaryText}
            secondaryText={secondaryText}
            diffCount={diffCount}
            statusWord={statusWord}
            isOpen={false}
            canToggle={false}
          />
        </div>
      )}
      {canToggle ? (
        <CollapsibleContent
          data-slot="aui_tool-summary-content"
          className={cn(
            "overflow-hidden outline-none",
            "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
            "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
            "data-closed:fill-mode-forwards data-closed:pointer-events-none",
          )}
        >
          {/* padding 挂在内部：高度动画节点归零时 8px 内距仍停在原地，
              延迟卸载切换 display 才瞬间消失（ZCode 同款结构）。 */}
          {shouldRenderContent ? <div className="pt-2">{content}</div> : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
};

const SummaryContent: FC<{
  icon: ReactNode;
  kindLabel: string;
  running: boolean;
  primaryText?: ReactNode;
  secondaryText?: ReactNode;
  diffCount?: ReactNode;
  statusWord: ReactNode;
  isOpen: boolean;
  canToggle: boolean;
}> = ({
  icon,
  kindLabel,
  running,
  primaryText,
  secondaryText,
  diffCount,
  statusWord,
  isOpen,
  canToggle,
}) => (
  <>
    {/* 图标槽自己持 hover 色：全局 SVG 选择器会盖掉图标自身的固定色（ZCode 注释） */}
    <span
      data-summary-leading-icon
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover/tool-summary:text-foreground [&_svg]:size-4"
    >
      {icon}
    </span>
    <span
      className={cn(
        "shrink-0 font-normal whitespace-nowrap",
        running ? "shimmer motion-reduce:animate-none" : "text-muted-foreground",
      )}
    >
      {kindLabel}
    </span>
    <span className="flex min-w-0 max-w-full items-center gap-2 font-normal">
      {primaryText != null && primaryText !== "" ? (
        <span className="text-foreground/80 min-w-0 truncate">{primaryText}</span>
      ) : null}
      {secondaryText != null && secondaryText !== "" ? (
        <span className="text-muted-foreground/70 min-w-0 truncate">
          {secondaryText}
        </span>
      ) : null}
      {diffCount}
      {statusWord}
    </span>
    {canToggle ? (
      <ChevronRightIcon
        aria-hidden
        className={cn(
          // twMerge 会把 transition-transform / transition-opacity 判为冲突，
          // 合并成一条属性级 transition（ZCode 原文在非 Tailwind 环境是两条）
          "text-muted-foreground/60 size-4 shrink-0 transition-[opacity,transform] duration-200 will-change-transform",
          "opacity-0 group-hover/tool-summary:opacity-100",
          isOpen ? "rotate-90 opacity-100" : "rotate-0",
        )}
      />
    ) : null}
  </>
);

/** diff 计数：+N / −N（新增绿、删除红；无变更不渲染）。 */
export const ToolDiffStat: FC<{ added: number; removed: number }> = ({
  added,
  removed,
}) => {
  if (added === 0 && removed === 0) return null;
  return (
    <span
      data-slot="aui_tool-diff-stat"
      className="shrink-0 font-mono text-xs tabular-nums"
    >
      {added > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}
      {removed > 0 ? (
        <span className="ml-1 text-red-600 dark:text-red-400">−{removed}</span>
      ) : null}
    </span>
  );
};

/** 展开正文的外框（ZCode 三个 renderer 的统一卡片底）。 */
export const ToolBody: FC<{ children: ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div
    data-slot="aui_tool-body"
    className={cn(
      "border-border/60 bg-muted/20 space-y-2 rounded-xl border px-3 py-2.5",
      className,
    )}
  >
    {children}
  </div>
);
