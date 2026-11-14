"use client";

/**
 * 会话内查找面板（ZCode `TaskFindDialog` placement="chat" 的宿主版）：
 * 对话区顶部居中浮层。Ctrl/Cmd+F 开（对话区聚焦时）、Esc 关、↑↓ 或
 * Enter（Shift=反向）导航；计数 `n/m`。
 *
 * 高亮 = CSS Custom Highlight API：收集到的 Range 注册进
 * `CSS.highlights`（不动 DOM——markdown 子树里插 span 会打断 React 管理），
 * CSS 侧 `::highlight(mirach-conversation-find)` 上色。搜索范围 =
 * 对话根内全部消息根；`FIND_SKIP_SELECTOR` 内的子树跳过。
 * 流式更新经 MutationObserver 防抖重扫。
 *
 * 本组件渲染在 `.aui-thread-root`（relative）内部：面板直接 absolute 定位，
 * **不经 portal**——hostRef 在渲染期求值 closest 依赖已挂载的旧节点，脆。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  FIND_ACTIVE_HIGHLIGHT_NAME,
  FIND_HIGHLIGHT_NAME,
  FIND_SKIP_SELECTOR,
  findCountLabel,
  nextActiveIndex,
  normalizeQuery,
} from "@/components/assistant-ui/conversation-find";
import { TooltipIconButton } from "@/components/tooltip-icon-button";

interface FindSupport {
  HighlightCtor: (typeof Highlight) | undefined;
  highlights: Map<string, unknown> | undefined;
}

/** 取浏览器的 Custom Highlight 支持（WebView2 = Chromium，恒有）。
 * 注意：`Highlight` 是**全局**构造器（`new Highlight(...ranges)`），挂在
 * window 上而不是 CSS 命名空间下——`CSS.highlights` 注册表才在 CSS 上。 */
function highlightSupport(): FindSupport {
  const css = window.CSS as unknown as
    | { highlights?: Map<string, unknown> }
    | undefined;
  const HighlightCtor = (window as unknown as { Highlight?: typeof Highlight }).Highlight;
  return { HighlightCtor, highlights: css?.highlights };
}

/** 在 root 内收集 query 的全部出现 Range（跳过 FIND_SKIP_SELECTOR 子树；
 * root 自身命中 skip 时返回空——输入框里的文字不高亮）。 */
function collectFindRanges(root: HTMLElement, normalizedQuery: string): Range[] {
  if (!normalizedQuery) return [];
  if (root.closest(FIND_SKIP_SELECTOR)) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(FIND_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    const lower = text.data.toLocaleLowerCase();
    let idx = lower.indexOf(normalizedQuery);
    while (idx >= 0) {
      const range = document.createRange();
      range.setStart(text, idx);
      range.setEnd(text, idx + normalizedQuery.length);
      ranges.push(range);
      idx = lower.indexOf(normalizedQuery, idx + normalizedQuery.length);
    }
    current = walker.nextNode();
  }
  return ranges;
}

export const ConversationFind: FC = () => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const rangesRef = useRef<Range[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [total, setTotal] = useState(0);

  const normalized = useMemo(() => normalizeQuery(query), [query]);

  // 重扫 + 注册高亮（query / 开关 / DOM 变化共用）
  const rescan = useCallback(() => {
    rafRef.current = undefined;
    const root = hostRef.current?.closest('.aui-thread-root');
    const { HighlightCtor, highlights } = highlightSupport();
    if (!root || !highlights || !HighlightCtor) return;
    if (!open || !normalized) {
      highlights.delete(FIND_HIGHLIGHT_NAME);
      highlights.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
      rangesRef.current = [];
      setTotal(0);
      setActiveIndex(0);
      return;
    }
    const roots = root.querySelectorAll<HTMLElement>(
      '[data-slot="aui_user-message-root"], [data-slot="aui_assistant-message-root"]',
    );
    const ranges: Range[] = [];
    for (const el of roots) ranges.push(...collectFindRanges(el, normalized));
    rangesRef.current = ranges;
    setTotal(ranges.length);
    setActiveIndex((prev) => (ranges.length === 0 ? 0 : prev % ranges.length));
    highlights.set(FIND_HIGHLIGHT_NAME, new HighlightCtor(...ranges));
  }, [open, normalized]);

  // query / 开关变化 → 重扫
  useEffect(() => {
    rescan();
  }, [rescan]);

  // activeIndex / 总数变化 → 更新 active 高亮 + 滚到可见
  useEffect(() => {
    const { HighlightCtor, highlights } = highlightSupport();
    if (!highlights || !HighlightCtor) return;
    const ranges = rangesRef.current;
    const active =
      ranges.length > 0
        ? ranges[Math.min(Math.max(activeIndex, 0), ranges.length - 1)]
        : undefined;
    if (open && normalized && active) {
      highlights.set(FIND_ACTIVE_HIGHLIGHT_NAME, new HighlightCtor(active));
      const container = active.commonAncestorContainer;
      const el = container instanceof Element ? container : container.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'auto' });
    } else {
      highlights.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
    }
  }, [activeIndex, total, open, normalized]);

  // 流式更新 → 防抖重扫
  useEffect(() => {
    if (!open) return;
    const root = hostRef.current?.closest('.aui-thread-root');
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (rafRef.current !== undefined) return;
      rafRef.current = window.requestAnimationFrame(rescan);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [open, rescan]);

  // 关闭清理
  useEffect(() => {
    if (open) return;
    const { highlights } = highlightSupport();
    highlights?.delete(FIND_HIGHLIGHT_NAME);
    highlights?.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
    rangesRef.current = [];
    setTotal(0);
  }, [open]);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (total <= 0) return;
      setActiveIndex((prev) => nextActiveIndex(prev, total, direction));
    },
    [total],
  );

  // Ctrl/Cmd+F 开；面板内 Esc 关（root 级 keydown——聚焦对话区才触发）
  useEffect(() => {
    const root = hostRef.current?.closest('.aui-thread-root') as HTMLElement | null;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    root.addEventListener('keydown', onKeyDown as EventListener);
    return () => root.removeEventListener('keydown', onKeyDown as EventListener);
  }, [open]);

  return (
    <div ref={hostRef} className="contents" data-slot="aui_conversation-find-host">
      {open && (
        <div
          data-slot="aui_conversation-find"
          className="bg-popover text-popover-foreground animate-in fade-in slide-in-from-top-1 duration-100 absolute inset-x-0 top-3 z-30 mx-auto flex h-9 w-[min(32rem,calc(100%-1.5rem))] items-center gap-1.5 rounded-xl border border-border px-2 shadow-(--shadow-pop)"
        >
          <SearchIcon className="text-muted-foreground size-[var(--size-icon-sm)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
                e.preventDefault();
                move(-1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="在对话中查找…"
            className="text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
          />
          <div className="text-muted-foreground w-10 shrink-0 text-center text-xs font-medium tabular-nums">
            {findCountLabel(activeIndex, total)}
          </div>
          <div className="border-border flex shrink-0 items-center gap-0.5 border-l pl-1.5">
            <TooltipIconButton
              tooltip="上一处"
              disabled={total === 0}
              onClick={() => move(-1)}
            >
              <ArrowUpIcon className="size-[var(--size-icon-sm)]" />
            </TooltipIconButton>
            <TooltipIconButton
              tooltip="下一处"
              disabled={total === 0}
              onClick={() => move(1)}
            >
              <ArrowDownIcon className="size-[var(--size-icon-sm)]" />
            </TooltipIconButton>
          </div>
          <div className="ml-0.5 flex shrink-0 border-border border-l pl-1.5">
            <TooltipIconButton tooltip="关闭（Esc）" onClick={() => setOpen(false)}>
              <XIcon className="size-[var(--size-icon-sm)]" />
            </TooltipIconButton>
          </div>
        </div>
      )}
    </div>
  );
};
