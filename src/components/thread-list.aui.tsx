"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  GitForkIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
} from "react";
import { useStore } from "zustand";

import { branchBridge } from "@/components/assistant-ui/branch-store";
import { startSessionRowDrag } from "@/components/panes/session-manage/session-drag";
import {
  sessionManageStore,
  useSessionManage,
} from "@/components/panes/session-manage/session-manage-store";
import {
  orderMapAfterMove,
  orderedSessionIds,
  type SessionRowMeta,
} from "@/components/panes/session-manage/session-order";

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot className="flex h-full min-h-0 flex-col bg-(--surface)">
      <div className="flex items-center gap-1.5 px-2 pt-2">
        {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
        <ThreadListNew
          aria-label="新建会话"
          className="grid size-7 shrink-0 place-items-center rounded-md border border-(--stroke-soft) p-0 text-(--text-2) hover:bg-(--hover-wash)"
          title="新建会话"
        >
          <PlusIcon className="size-3.5" />
        </ThreadListNew>
      </div>
      <ThreadListItems className="min-h-0 flex-1 overflow-y-auto pb-2" searchQuery={hasThreads ? search : ""} />
    </ThreadListRoot>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative min-w-0 flex-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="搜索会话"
        placeholder="搜索会话"
        className={cn("h-7 rounded-md border border-(--stroke-soft) bg-transparent ps-7 text-xs text-(--text)", className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

const DAY_IN_MS = 86_400_000;

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
): string => {
  if (!date || date.getTime() >= startOfToday) return "今天";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "昨天";
  return "更早";
};

export type ThreadListGroup = { label: string; indices: number[] };

/**
 * Filters the thread list by title and buckets the matches by last activity
 * (Today, Yesterday, Earlier). `groups` is null when no thread carries a
 * date, in which case `filteredIndices` keeps the runtime order.
 */
export const useThreadListGroups = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const query = searchQuery.trim().toLowerCase();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(
        ({ id }) =>
          !query ||
          (itemsById.get(id)?.title || "New Chat")
            .toLowerCase()
            .includes(query),
      )
      .map(({ index }) => index);
    if (!filteredIndices.some((index) => dates[index])) {
      return { threadIds, filteredIndices, groups: null };
    }

    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, query]);
};

// ── 会话管理（置顶 / 手动顺序 / 拖拽切换，hermes sidebar 对标）───────────────

/** 行活跃元数据：id → lastActiveMs（pi SessionMeta.lastModifiedMs，runtime
 *  refreshThreads 写进 custom；缺 0。会话侧栏排序的 lastActive 数据源）。 */
const useSessionRowMetas = (): SessionRowMeta[] => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  return useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item] as const));
    return threadIds.map((id) => {
      const ms = byId.get(id)?.custom?.lastModifiedMs;
      return {
        id,
        lastActiveMs: typeof ms === "number" && Number.isFinite(ms) ? ms : 0,
      };
    });
  }, [threadIds, threadItems]);
};

/** 拖拽/投放提交通道：list 移动 → orderMapAfterMove 重排并持久化；主会话
 *  页签投放 → aui.threads.switchToThread（assistant-ui 公开切换入口，直通
 *  runtime threadListAdapter.onSwitchToThread——中断守卫/pi_open_session/
 *  重水合都在 runtime 实现，失败 console.error 可见。**无需 runtime 改动**）。 */
const useSessionCommit = () => {
  const aui = useAui();
  const metas = useSessionRowMetas();
  return useMemo(
    () => ({
      commitListMove: (sessionId: string, beforeId: string | null) => {
        const st = sessionManageStore.getState();
        st.setOrder(orderMapAfterMove(metas, st.pinned, st.order, sessionId, beforeId));
      },
      commitMainTab: (sessionId: string) => {
        void aui.threads.switchToThread(sessionId);
      },
    }),
    [aui, metas],
  );
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices, groups } =
    useThreadListGroups(searchQuery);
  const query = searchQuery.trim();
  const pinned = useSessionManage((s) => s.pinned);
  const order = useSessionManage((s) => s.order);
  const drag = useSessionManage((s) => s.drag);
  const metas = useSessionRowMetas();

  // 死会话清理（任务：会话不存在于列表时清理键）。列表非空才清——首帧
  // threads=[] 是"未加载"不是"已删光"，不得借机毁持久化。
  useEffect(() => {
    sessionManageStore.getState().prune(threadIds);
  }, [threadIds]);

  // 展示序（纯函数）：置顶组（组内最后活跃降序）永远在非置顶组之上；非置顶
  // 组 = 手动顺序 + hermes mergeFreshByPosition 折回（新会话不沉底）。搜索态
  // 只在过滤后的行里排（filteredIndices 与原渲染同源）。日期分组态
  // （groups != null；当前 runtime 无 lastMessageAt，不可达）保持原渲染
  // 不动——分组与手动顺序的合并未实现，诚实留空。
  const display = useMemo(() => {
    if (groups) return null;
    const visible = new Set(filteredIndices.map((index) => threadIds[index]));
    const visibleMetas = metas.filter((m) => visible.has(m.id));
    const { pinnedIds, unpinnedIds } = orderedSessionIds(visibleMetas, pinned, order);
    const indexOfId = new Map(threadIds.map((id, index) => [id, index] as const));
    const toIndices = (ids: readonly string[]) =>
      ids
        .map((id) => indexOfId.get(id))
        .filter((index): index is number => index !== undefined);
    return { pinnedIndices: toIndices(pinnedIds), unpinnedIndices: toIndices(unpinnedIds) };
  }, [groups, metas, pinned, order, threadIds, filteredIndices]);

  if (query && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-(--text-4) px-3 py-6 text-center text-xs"
      >
        没有匹配的会话
      </div>
    );
  }

  if (display) {
    // 拖拽中（行拖拽会话写入的落点信号）：列表模式画插入符（beforeId =
    // 目标行 id，null = 尾部）；置顶组不是排序目标，插入符只出现在非置顶组。
    const dragTarget = drag?.target;
    const listDrag = drag !== null && dragTarget?.kind === "list" ? dragTarget : null;

    const renderRow = (index: number) => (
      <ThreadListPrimitive.ItemByIndex
        key={threadIds[index]}
        index={index}
        components={{ ThreadListItem }}
      />
    );

    const caret = (key: string) => (
      <div
        key={key}
        aria-hidden
        data-slot="aui_session-drop-caret"
        className="bg-(--fl-accent) mx-2 h-0.5 shrink-0 rounded-full"
      />
    );

    return (
      <>
        {display.pinnedIndices.length > 0 && (
          <div data-slot="aui_thread-list-pinned" className="flex flex-col gap-0.5">
            <div
              data-slot="aui_thread-list-group-label"
              className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
            >
              置顶
            </div>
            {display.pinnedIndices.map(renderRow)}
          </div>
        )}
        <div data-slot="aui_thread-list-unpinned" className="flex flex-col gap-0.5">
          {display.unpinnedIndices.map((index) => (
            <Fragment key={threadIds[index]}>
              {listDrag && listDrag.beforeId === threadIds[index] && caret(`caret-${threadIds[index]}`)}
              {renderRow(index)}
            </Fragment>
          ))}
          {listDrag && listDrag.beforeId === null && caret("caret-end")}
        </div>
      </>
    );
  }

  return groups!.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
  ));
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        variant="ghost"
        data-slot="aui_thread-list-new"
        className={cn(
          "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className="size-4 shrink-0"
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              New Thread
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label="Loading threads"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
        </div>
      ))}
    </div>
  );
};

export const ThreadListItem: FC = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const threadId = useAuiState((s) => s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title);
  const isPinned = useSessionManage((s) => s.pinned.includes(threadId));
  const isDragging = useSessionManage((s) => s.drag?.sessionId === threadId);
  const commit = useSessionCommit();
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      // 行标记（session-drag 的快照/候选识别按它找行；与 SESSION_ROW_ATTR
      // 同串，改一处必须改另一处）
      data-session-row-id={threadId}
      onPointerDown={(e) =>
        startSessionRowDrag(e, {
          sessionId: threadId,
          title: title ?? "New Chat",
          onCommitListMove: (beforeId) => commit.commitListMove(threadId, beforeId),
          onCommitMainTab: () => commit.commitMainTab(threadId),
        })
      }
      className={cn(
        "group/row hover:bg-(--hover-wash) data-active:bg-[color-mix(in_srgb,var(--fl-accent)_10%,transparent)] relative flex min-h-9 items-center rounded-md transition-colors focus-visible:outline-none",
        // 拖拽中的行半透明：插入符说去哪，变淡的说什么在动（同 hermes 行拖）
        isDragging && "opacity-45",
      )}
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-start outline-none group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9"
        >
          <span
            aria-hidden
            data-slot="aui_thread-list-item-running"
            className={cn(
              'me-1.5 size-1.5 shrink-0 rounded-full',
              isRunning ? 'animate-pulse bg-emerald-500' : 'bg-(--stroke)',
            )}
          />
          {isPinned && (
            <PinIcon
              aria-hidden
              data-slot="aui_thread-list-item-pin"
              className="text-(--fl-accent) me-1.5 size-3 shrink-0 fill-current"
            />
          )}
          <span
            data-slot="aui_thread-list-item-title"
            className="min-w-0 flex-1 truncate text-[0.8125rem] text-(--text-2)"
          >
            <ThreadListItemPrimitive.Title fallback="New Chat" />
          </span>
          {isRunning && <span className="sr-only">Running</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore onRename={() => setIsRenaming(true)} />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label="Rename thread"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const MORE_ITEM_CLASS =
  "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const ThreadListItemMore: FC<{ onRename: () => void }> = ({ onRename }) => {
  const threadId = useAuiState((s) => s.threadListItem.id);
  // 活动行判定：mainThreadId 与本行 id 同源（threadId = pi 会话 id）
  const isActive = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const isPinned = useSessionManage((s) => s.pinned.includes(threadId));
  // fork 点清单（branchBridge 投影；runtime 关键路径后 requestRefresh 保持
  // 新鲜）。活动行的「从此分支探索」在最后一个 fork 点（最新已落盘 user
  // 消息）分叉 = 整段对话的副本分支。
  const forkPoints = useStore(branchBridge, (s) => s.forkPoints);

  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={MORE_ITEM_CLASS}
          onSelect={() => sessionManageStore.getState().togglePin(threadId)}
        >
          {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
          {isPinned ? "取消置顶" : "置顶"}
        </ThreadListItemMorePrimitive.Item>
        {/* pi fork 只对活动会话（pi_fork_session 作用于当前打开的会话文件）——
            非活动行禁用；活动行还需 fork 点（历史 user 消息已落盘）才可分叉。 */}
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={MORE_ITEM_CLASS}
          disabled={!isActive || forkPoints.length === 0}
          onSelect={() => {
            const last = forkPoints[forkPoints.length - 1];
            if (!last) return;
            branchBridge.getState().requestFork(forkPoints.length - 1, last.text);
          }}
        >
          <GitForkIcon className="size-4" />
          从此分支探索
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={MORE_ITEM_CLASS}
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          重命名
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <TrashIcon className="size-4" />
            删除
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
