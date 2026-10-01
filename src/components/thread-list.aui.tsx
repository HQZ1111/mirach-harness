"use client";

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
  AlignJustifyIcon,
  ArrowDownAZIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  ClockIcon,
  GitForkIcon,
  GripVerticalIcon,
  ListFilterIcon,
  ListIcon,
  ListOrderedIcon,
  MoreVerticalIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FC,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useStore } from "zustand";

import { branchBridge } from "@/components/assistant-ui/branch-store";
import { DeleteSessionDialog, RenameSessionDialog } from "@/components/panes/session-manage/session-dialogs";
import { startSessionRowDrag } from "@/components/panes/session-manage/session-drag";
import {
  sessionManageStore,
  useSessionManage,
  type SessionRowGroup,
} from "@/components/panes/session-manage/session-manage-store";
import {
  buildSessionDisplay,
  buildSessionSearch,
  matchesTitleSearch,
} from "@/components/panes/session-manage/session-display";
import {
  commitRecentMove,
  moveBefore,
  type SessionRowMeta,
} from "@/components/panes/session-manage/session-order";
import {
  projectSessionActions,
  type SessionActionId,
} from "@/components/panes/session-manage/session-actions";
import { resolveSessionRowClick } from "@/components/panes/session-manage/session-row-gesture";
import type { SessionListRow } from "@/components/panes/session-manage/session-date-groups";
import {
  effectiveOrdering,
  isSidebarViewCustomized,
  sidebarViewStore,
  useSidebarView,
  type SidebarGroupingMode,
} from "@/components/panes/session-manage/sidebar-view";

/**
 * 会话侧栏（左栏会话列表）——hermes app/chat/sidebar 一链到底对齐版：
 * 行布局/hover 钮/⋯ 菜单/右键上下文菜单/分组结构（已置顶 + 会话 + 日期
 * 分隔线 + 桶折叠）/搜索（结果段）/新建入口（段头 hover ＋）/段头侧栏
 * 选项钮（hermes SidebarFilterMenu：分组/排序/密度 + 全部收起/展开 +
 * 重置为默认；sidebar-view.ts 持选项状态）/激活态/⇧+点击置顶/重命名与
 * 删除确认弹层。菜单项清单与顺序 = session-actions.ts 的纯投影（⋯ 与
 * 右键同源，hermes actions-menu 体系）；文案逐字取 hermes zh catalog。
 */

// ── 行拖拽提交的上下文（分区 → 组 → 提交通道）─────────────────────────────

interface SessionListCtxValue {
  group: SessionRowGroup | "search";
  commitListMove(sessionId: string, group: SessionRowGroup, beforeId: string | null): void;
  commitMainTab(sessionId: string): void;
}

const SessionListContext = createContext<SessionListCtxValue | null>(null);

// ── 顶部壳：搜索行（hermes SearchField 形制）───────────────────────────────

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  // 密度（侧栏选项钮）：data-density 是行几何令牌（--tl-row-min-h 等，
  // panes.css）的载体，行规则只引用变量。
  const density = useSidebarView((s) => s.density);

  return (
    <ThreadListRoot className="flex h-full min-h-0 flex-col bg-(--surface)" data-density={density}>
      <div className="shrink-0 px-2 pb-1 pt-1">
        <ThreadListSearch aria-label="搜索会话" onValueChange={setSearch} value={search} />
      </div>
      <ThreadListItems className="min-h-0 flex-1 overflow-y-auto pb-2" searchQuery={search} />
    </ThreadListRoot>
  );
};

/**
 * 搜索框（hermes components/ui/search-field.tsx 照抄）：无边框、下划线式——
 * 平时淡（30%），focus 实；有值出 ✕ 清除钮（aria「清除搜索」）。占位文案
 * hermes zh：搜索会话…。匹配为标题子串（pi 无服务端全文检索——不适用面，
 * 见交接报告）。
 */
export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div
      className={cn(
        "border-transparent inline-flex max-w-full min-w-0 items-center gap-1.5 border-b px-0.5 transition-[color,border-color,opacity]",
        !value && "opacity-30 focus-within:opacity-100",
        className,
      )}
      data-slot="aui_thread-list-search"
    >
      <SearchIcon
        className="text-(--text-3) pointer-events-none size-3.5 shrink-0"
        data-slot="aui_thread-list-search-icon"
      />
      <input
        aria-label="搜索会话"
        className="placeholder:text-(--text-3) text-(--text) h-7 w-full min-w-0 bg-transparent text-xs focus:outline-none"
        onChange={(event) => onValueChange(event.target.value)}
        placeholder="搜索会话…"
        ref={ref}
        type="text"
        value={value}
        {...props}
      />
      {value ? (
        <button
          aria-label="清除搜索"
          className="text-(--text-3) hover:text-(--text) shrink-0 cursor-pointer rounded p-0.5"
          onClick={() => onValueChange("")}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      className={cn("flex flex-col gap-px", className)}
      data-slot="aui_thread-list-root"
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      className={cn("flex flex-col gap-px", className)}
      data-slot="aui_thread-list-items"
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListSections searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

// ── 展示行投影（纯函数消费：已置顶/会话 两组 + 搜索段）───────────────────

const useSessionRowMetas = (): SessionRowMeta[] => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  return useMemo(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item] as const));
    return threadIds.map((id) => {
      const item = byId.get(id);
      const ms = item?.custom?.lastModifiedMs;
      const title = item?.title;
      return {
        id,
        lastActiveMs: typeof ms === "number" && Number.isFinite(ms) ? ms : 0,
        title: typeof title === "string" ? title : undefined,
      };
    });
  }, [threadIds, threadItems]);
};

const useThreadDisplay = (searchQuery: string) => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const metas = useSessionRowMetas();
  const pinned = useSessionManage((s) => s.pinned);
  const order = useSessionManage((s) => s.order);
  const collapsed = useSessionManage((s) => s.groupsCollapsed);
  // 侧栏选项（hermes $sidebarGrouping/$sidebarOrdering 同构：manual 压过
  // 排序键——拖拽 IS 选择手动序）。
  const grouping = useSidebarView((s) => s.grouping);
  const ordering = useSidebarView(effectiveOrdering);
  const query = searchQuery.trim();

  return useMemo(() => {
    if (query) {
      const byId = new Map(threadItems.map((item) => [item.id, item] as const));
      const matched = metas.filter((m) =>
        matchesTitleSearch(byId.get(m.id)?.title ?? "", query),
      );
      return { mode: "search" as const, threadIds, search: buildSessionSearch(matched) };
    }
    return {
      mode: "groups" as const,
      threadIds,
      display: buildSessionDisplay(metas, pinned, order, collapsed, {
        view: { grouping, ordering },
      }),
    };
  }, [query, threadIds, threadItems, metas, pinned, order, collapsed, grouping, ordering]);
};

// ── 侧栏选项钮（hermes SidebarFilterMenu 对齐：段头 + 右侧的常驻视图
//    选项菜单——只搬数据面支持的选项；其余 hermes 选项的取舍见交接报告）──

/** hermes「Every option row leaves the menu open」——单/多选行不关菜单，
 *  只有底部动作项（收起/展开全部、重置为默认）关。 */
const keepViewMenuOpen = (event: Event) => event.preventDefault();

const VIEW_MENU_CONTENT_CLASS =
  "bg-popover text-popover-foreground z-50 min-w-52 overflow-hidden rounded-xl border p-1.5 shadow-(--shadow-pop)";

const VIEW_MENU_ITEM_BASE =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-(--hover-wash)";

const VIEW_OPTION_GLYPH = "text-(--text-3) size-3.5 shrink-0";

/** 排序/分组选项行（图标 + 文案；hermes OptionGlyph 的 lucide 等价物）。 */
const ViewOptionRow: FC<{ icon: FC<{ className?: string }>; label: string }> = ({ icon: Icon, label }) => (
  <>
    <Icon className={VIEW_OPTION_GLYPH} />
    <span>{label}</span>
  </>
);

/** 选中指示槽：未选中也要占位（指示器卸载时行内文字不横移）。 */
const ViewIndicatorSlot: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="flex size-3.5 shrink-0 items-center justify-center">{children}</span>
);

const SidebarViewMenu: FC<{ dividerKeys: readonly string[]; foldCollapsed: boolean }> = ({
  dividerKeys,
  foldCollapsed,
}) => {
  const grouping = useSidebarView((s) => s.grouping);
  const ordering = useSidebarView(effectiveOrdering);
  const density = useSidebarView((s) => s.density);
  const customized = useSidebarView(isSidebarViewCustomized);

  const onCollapseAll = () => {
    const st = sessionManageStore.getState();
    for (const key of dividerKeys) st.setGroupCollapsed(key, !foldCollapsed);
  };

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {/* hermes 触发钮：list-filter 图标 ghost icon-xs（HEADER_NAV_BTN
            形态——常驻可见 70%，open 态点亮）。 */}
        <button
          aria-label="侧栏选项"
          className="text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text) data-[state=open]:bg-(--hover-wash) data-[state=open]:text-(--text) size-5 shrink-0 cursor-pointer rounded-[4px] p-0 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          data-slot="aui_thread-list-view-menu-trigger"
          title="侧栏选项"
          type="button"
        >
          <ListFilterIcon className="mx-auto size-3" />
          <span className="sr-only">侧栏选项</span>
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          className={VIEW_MENU_CONTENT_CLASS}
          data-slot="aui_thread-list-view-menu-content"
          sideOffset={6}
        >
          {/* 分组（hermes Grouping 子菜单：触发行显示当前值 + chevron-right；
              选项 = 数据面支持的 date/none 两档） */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <span>分组</span>
              <span className="text-(--text-3) ml-auto flex items-center gap-1 pl-4">
                {grouping === "date" ? "按日期" : "平铺"}
                <ChevronRightIcon className="size-3" />
              </span>
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.SubContent
              className={VIEW_MENU_CONTENT_CLASS}
              sideOffset={6}
            >
              <DropdownMenuPrimitive.RadioGroup
                onValueChange={(value) =>
                  sidebarViewStore.getState().setGrouping(value as SidebarGroupingMode)
                }
                value={grouping}
              >
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="date"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ClockIcon} label="按日期" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="none"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ListIcon} label="平铺" />
                </DropdownMenuPrimitive.RadioItem>
              </DropdownMenuPrimitive.RadioGroup>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>

          {/* 排序（hermes Ordering 子菜单；Manual 项仅在拖拽声明后出现——
              它是当前态的展示位，选任意排序键 = 退出并清掉手动序） */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <span>排序</span>
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.SubContent
              className={VIEW_MENU_CONTENT_CLASS}
              sideOffset={6}
            >
              <DropdownMenuPrimitive.RadioGroup
                onValueChange={(value) => {
                  if (value === "manual") return;
                  sidebarViewStore.getState().setOrdering(value as "title" | "updated");
                }}
                value={ordering}
              >
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="updated"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ClockIcon} label="最近活动" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="title"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ArrowDownAZIcon} label="标题字母序" />
                </DropdownMenuPrimitive.RadioItem>
                {ordering === "manual" && (
                  <DropdownMenuPrimitive.RadioItem
                    className={VIEW_MENU_ITEM_BASE}
                    onSelect={keepViewMenuOpen}
                    value="manual"
                  >
                    <ViewIndicatorSlot>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <span aria-hidden className="bg-current size-1.5 rounded-full" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </ViewIndicatorSlot>
                    <ViewOptionRow icon={ListOrderedIcon} label="手动" />
                  </DropdownMenuPrimitive.RadioItem>
                )}
              </DropdownMenuPrimitive.RadioGroup>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>

          {/* 密度（任务定稿选项，hermes 无——checkbox 同「Inbox style」行
              形制：渲染变体，不属分组/排序） */}
          <DropdownMenuPrimitive.CheckboxItem
            checked={density === "compact"}
            className={VIEW_MENU_ITEM_BASE}
            onCheckedChange={(checked) =>
              sidebarViewStore.getState().setDensity(checked ? "compact" : "comfortable")
            }
            onSelect={keepViewMenuOpen}
          >
            <ViewIndicatorSlot>
              <DropdownMenuPrimitive.ItemIndicator>
                <CheckIcon className="size-3" />
              </DropdownMenuPrimitive.ItemIndicator>
            </ViewIndicatorSlot>
            <ViewOptionRow icon={AlignJustifyIcon} label="紧凑行高" />
          </DropdownMenuPrimitive.CheckboxItem>

          {dividerKeys.length > 0 && (
            <>
              <DropdownMenuPrimitive.Separator className="bg-(--stroke-soft) mx-1 my-1 h-px" />
              {/* hermes「Expand all / Collapse all」：一个动作项、标签随
                  状态翻转——全折叠时展开全部，否则收起全部。 */}
              <DropdownMenuPrimitive.Item className={VIEW_MENU_ITEM_BASE} onSelect={onCollapseAll}>
                {foldCollapsed ? "全部展开" : "全部收起"}
              </DropdownMenuPrimitive.Item>
            </>
          )}

          {customized && (
            <>
              <DropdownMenuPrimitive.Separator className="bg-(--stroke-soft) mx-1 my-1 h-px" />
              {/* hermes「Reset to defaults」：分组与排序一并回出厂。 */}
              <DropdownMenuPrimitive.Item
                className={VIEW_MENU_ITEM_BASE}
                onSelect={() => sidebarViewStore.getState().resetView()}
              >
                <RotateCcwIcon className={VIEW_OPTION_GLYPH} />
                <span>重置为默认</span>
              </DropdownMenuPrimitive.Item>
            </>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
};

// ── 区头（hermes SidebarSectionHeader：label + hover 显现 caret + 动作位）──

const SectionHeader: FC<{
  headerKey: string;
  label: string;
  collapsed: boolean;
  collapsible?: boolean;
  action?: ReactNode;
}> = ({ headerKey, label, collapsed, collapsible = true, action }) => {
  const body = (
    <>
      <span className="text-(--text-2) text-xs font-medium">{label}</span>
      {collapsible && (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "text-(--text-3) size-3 shrink-0 opacity-0 transition group-hover/section-label:opacity-100 focus-visible:opacity-100",
            collapsed && "-rotate-90",
          )}
        />
      )}
    </>
  );
  return (
    <div
      className="group/section flex shrink-0 items-center justify-between gap-1 pb-1 pt-1.5"
      data-slot="aui_thread-list-section-header"
    >
      {collapsible ? (
        <button
          aria-expanded={!collapsed}
          className="group/section-label flex w-fit min-w-0 cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-left leading-none"
          onClick={() =>
            sessionManageStore.getState().setGroupCollapsed(headerKey, !collapsed)
          }
          title={collapsed ? "展开" : "收起"}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-fit min-w-0 items-center gap-1 px-2 leading-none">{body}</div>
      )}
      {action}
    </div>
  );
};

/**
 * 日期分隔线（hermes SidebarDateDivider 照抄）：小体量大字距 caption + 发丝
 * 线 + hover 显现折叠 caret——点击收起该桶下的会话（分隔线保留）。折叠态
 * 持久化 sessionManageStore.groupsCollapsed（桶 key → collapsed）。
 */
const DateDividerRow: FC<{ bucketKey: string; label: string }> = ({ bucketKey, label }) => {
  const collapsed = useSessionManage((s) => s.groupsCollapsed[bucketKey] === true);
  return (
    <div
      className="group/workspace flex w-full min-w-0 items-center gap-2 px-2 pb-0.5 pt-(--tl-div-pt,0.5rem) select-none"
      data-slot="aui_thread-list-date-divider"
    >
      <button
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 bg-transparent text-left"
        onClick={() =>
          sessionManageStore.getState().setGroupCollapsed(bucketKey, !collapsed)
        }
        title={collapsed ? "展开" : "收起"}
        type="button"
      >
        <span className="text-(--text-4) shrink-0 text-[0.64rem] font-semibold tracking-[0.12em] uppercase">
          {label}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "text-(--text-3) size-3 shrink-0 opacity-0 transition group-hover/workspace:opacity-100",
            collapsed && "-rotate-90",
          )}
        />
        <span aria-hidden className="bg-(--stroke-soft) h-px min-w-4 flex-1" />
      </button>
    </div>
  );
};

/** 已置顶空态（hermes SidebarPinnedEmptyState 照抄——置顶手势的常驻教学位）。 */
const PinnedEmptyState: FC = () => (
  <div className="text-(--text-3) flex min-h-7 items-center gap-1.5 rounded-lg pl-2 text-xs">
    <span className="text-(--text-4) grid w-3.5 shrink-0 place-items-center">
      <PinIcon aria-hidden className="size-3" />
    </span>
    <span>Shift+ 单击对话以置顶 · 拖动以重新排序</span>
  </div>
);

/** 拖拽插入符（本区机制：目标组/槽位由 session-drag 落点信号驱动）。 */
const DropCaret: FC = () => (
  <div
    aria-hidden
    className="bg-(--fl-accent) mx-2 h-0.5 shrink-0 rounded-full"
    data-slot="aui_session-drop-caret"
  />
);

const ThreadListSections: FC<{ searchQuery: string }> = ({ searchQuery }) => {
  const { mode, threadIds, display, search } = useThreadDisplay(searchQuery);
  const drag = useSessionManage((s) => s.drag);
  const groupsCollapsed = useSessionManage((s) => s.groupsCollapsed);
  const collapsedPinned = useSessionManage((s) => s.groupsCollapsed.pinned === true);
  const collapsedRecent = useSessionManage((s) => s.groupsCollapsed.recent === true);
  const aui = useAui();

  // 死会话清理：列表非空才清——首帧 threads=[] 是"未加载"不是"已删光"。
  useEffect(() => {
    sessionManageStore.getState().prune(threadIds);
  }, [threadIds]);

  // 拖拽落点提交通道（置顶区拖 = pinned 数组重排 hermes reorderPinned；
  // 会话区拖 = 可见序改后拼回全量序——折叠桶藏行不丢排序；会话区拖拽
  // 同时声明手动序 = hermes「dragging IS how you pick manual」）。
  const ctxValue = useMemo<SessionListCtxValue>(
    () => ({
      group: mode === "search" ? "search" : "recent",
      commitListMove: (sessionId, group, beforeId) => {
        const st = sessionManageStore.getState();
        if (group === "pinned") {
          const visiblePinned =
            mode === "groups" ? display.pinnedIds : [];
          st.setPinnedOrder(moveBefore(visiblePinned, sessionId, beforeId));
          return;
        }
        if (mode !== "groups") return;
        const visibleRecents = display.rows
          .filter((r): r is Extract<SessionListRow, { kind: "session" }> => r.kind === "session")
          .map((r) => r.id);
        st.setOrder(
          commitRecentMove(display.allUnpinnedIds, visibleRecents, sessionId, beforeId),
        );
        sidebarViewStore.getState().claimManual();
      },
      commitMainTab: (sessionId) => {
        void aui.threads.switchToThread(sessionId);
      },
    }),
    [aui, display, mode],
  );

  const indexOfId = useMemo(
    () => new Map(threadIds.map((id, index) => [id, index] as const)),
    [threadIds],
  );

  // 「全部收起/展开全部」的折面（hermes foldIds = 当前屏上的日期桶；
  // 平铺分组无分隔线 → 空面，动作项整个不出现）。foldCollapsed =
  // hermes 同款判定：面非空且每一只桶都已显式收起。
  const dividerKeys = useMemo(
    () =>
      mode === "groups"
        ? display.rows.filter((r) => r.kind === "divider").map((r) => r.key)
        : [],
    [mode, display],
  );
  const foldCollapsed =
    dividerKeys.length > 0 && dividerKeys.every((key) => groupsCollapsed[key] === true);

  const renderRow = (id: string, group: SessionRowGroup | "search", key: string) => (
    <SessionListContext.Provider
      children={
        <ThreadListPrimitive.ItemByIndex
          index={indexOfId.get(id) ?? 0}
          components={{ ThreadListItem }}
        />
      }
      key={key}
      value={{ ...ctxValue, group }}
    />
  );

  const query = searchQuery.trim();

  if (mode === "search") {
    const ids = search.resultIds;
    return (
      <>
        <SectionHeader collapsible={false} collapsed={false} headerKey="results" label="结果" />
        {ids.length === 0 ? (
          <div
            className="text-(--text-3) grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs"
            data-slot="aui_thread-list-empty"
          >
            {`没有会话匹配“${query}”。`}
          </div>
        ) : (
          ids.map((id) => renderRow(id, "search", id))
        )}
      </>
    );
  }

  const { pinnedIds, rows } = display;
  const dragList = drag?.target.kind === "list" ? drag.target : null;
  const sessionRows = rows.filter(
    (r): r is Extract<SessionListRow, { kind: "session" }> => r.kind === "session",
  );
  const pinnedCaret = dragList?.group === "pinned" ? dragList.beforeId : undefined;
  const recentCaret = dragList?.group === "recent" ? dragList.beforeId : undefined;

  return (
    <SessionListContext.Provider value={ctxValue}>
      {/* 已置顶区（恒在；空态教 ⇧+点击；组内拖排 = pinned 数组序） */}
      <SectionHeader
        collapsed={collapsedPinned}
        headerKey="pinned"
        label="已置顶"
      />
      {!collapsedPinned &&
        (pinnedIds.length > 0 ? (
          <>
            {pinnedIds.map((id) => (
              <Fragment key={id}>
                {pinnedCaret === id && <DropCaret key={`pc-${id}`} />}
                {renderRow(id, "pinned", `p-${id}`)}
              </Fragment>
            ))}
            {pinnedCaret === null && <DropCaret key="pc-end" />}
          </>
        ) : (
          <PinnedEmptyState />
        ))}

      {/* 会话区（日期分隔线 + 桶内手动序 + 桶折叠；段头 hover ＝新建入口、
              常驻＝侧栏选项钮） */}
      <SectionHeader
        action={
          // hermes 一个动作簇（index.tsx:1781）：+ 与选项钮 gap-0.5 同行。
          <div className="flex shrink-0 items-center gap-0.5">
            <ThreadListNewAria />
            <SidebarViewMenu dividerKeys={dividerKeys} foldCollapsed={foldCollapsed} />
          </div>
        }
        collapsed={collapsedRecent}
        headerKey="recent"
        label="会话"
      />
      {!collapsedRecent &&
        (sessionRows.length === 0 && rows.length === 0 ? (
          <div className="text-(--text-3) grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs">
            暂无会话
          </div>
        ) : (
          rows.map((row) =>
            row.kind === "divider" ? (
              <DateDividerRow key={`div-${row.key}`} bucketKey={row.key} label={row.label} />
            ) : (
              <Fragment key={`s-${row.id}`}>
                {recentCaret === row.id && <DropCaret key={`rc-${row.id}`} />}
                {renderRow(row.id, "recent", `r-${row.id}`)}
              </Fragment>
            ),
          )
        ))}
      {!collapsedRecent && recentCaret === null && rows.length > 0 && (
        <DropCaret key="rc-end" />
      )}
    </SessionListContext.Provider>
  );
};

/** 会话区段头的新建入口（hermes SidebarSectionAddButton：hover 显现 ＋）。 */
const ThreadListNewAria: FC = () => (
  <ThreadListPrimitive.New asChild>
    <button
      aria-label="新建会话"
      className="text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text) size-5 shrink-0 cursor-pointer rounded-[4px] p-0 opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100"
      title="新建会话"
      type="button"
    >
      <PlusIcon className="mx-auto size-3.5" />
    </button>
  </ThreadListPrimitive.New>
);

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.New>
>(({ className, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New
      className={cn(
        "hover:bg-(--hover-wash) flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-normal text-(--text-2)",
        className,
      )}
      data-slot="aui_thread-list-new"
      ref={ref}
      {...props}
    />
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div className="flex flex-col gap-px">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          className="flex h-7 items-center px-2.5"
          key={i}
          role="status"
          aria-label="Loading threads"
          data-slot="aui_thread-list-skeleton-wrapper"
        >
          <Skeleton className="h-3.5 w-full" data-slot="aui_thread-list-skeleton" />
        </div>
      ))}
    </div>
  );
};

// ── 行（hermes SidebarSessionRow compact 形态：圆点 lead + 标题 + ⋯）───────

/** hover 跑马灯测量（hermes armMarquee/disarmMarquee 逐字）：真实溢出才
 *  上弦——CSS 测不了 overflow；动画距离按 80px/s 等速。状态进 DOM 属性，
 *  不进 React state（hover 不得重渲 memoized 行）。 */
const MARQUEE_PX_PER_SECOND = 80;

function armMarquee(event: ReactPointerEvent<HTMLElement>) {
  const el = event.currentTarget;
  const distance = el.scrollWidth - el.clientWidth;
  if (distance > 2) {
    // 关键帧 65% 行程（10%→75%）；按目标等速反推总时长。
    el.style.setProperty("--marquee-d", `${distance}px`);
    el.style.setProperty(
      "--marquee-t",
      `${Math.max(1, distance / MARQUEE_PX_PER_SECOND / 0.65)}s`,
    );
    el.dataset.marquee = "true";
  }
}

function disarmMarquee(event: ReactPointerEvent<HTMLElement>) {
  delete event.currentTarget.dataset.marquee;
}

const MENU_CONTENT_CLASS =
  "bg-popover text-popover-foreground z-50 w-40 overflow-hidden rounded-xl border p-1.5 shadow-(--shadow-pop)";

const MENU_ITEM_BASE =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const DESTRUCTIVE_ITEM_CLASS =
  "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive";

const ACTION_ICONS: Record<SessionActionId, FC<{ className?: string }>> = {
  rename: PencilIcon,
  // hermes identity 组的 pin 项图标恒为 'pin'（文案才随状态翻转）
  pin: PinIcon,
  "copy-id": ClipboardIcon,
  branch: GitForkIcon,
  delete: TrashIcon,
};

export const ThreadListItem: FC = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const threadId = useAuiState((s) => s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title);
  const isActive = useAuiState(
    (s) => s.threads.mainThreadId === s.threadListItem.id,
  );
  const isPinned = useSessionManage((s) => s.pinned.includes(threadId));
  const isDragging = useSessionManage((s) => s.drag?.sessionId === threadId);
  // fork 点清单（活动会话才谈得上「分支」——pi fork 作用于当前打开的会话
  // 文件；非活动行/无落盘 user 消息 → 该项禁用）。
  const forkPoints = useStore(branchBridge, (s) => s.forkPoints);
  const ctx = useContext(SessionListContext);
  const group: SessionRowGroup | "search" = ctx?.group ?? "recent";
  const aui = useAui();

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // 菜单关闭时 Radix 把焦点还给触发钮（行/kebab）——重命名对话框的输入框
  // 就抢不到焦点（Space 会激活行、方向键会移动列表）。这一次还原被吞掉
  // （hermes suppressCloseFocusRef 同款）。
  const suppressCloseFocusRef = useRef(false);
  const onCloseAutoFocus = (event: Event) => {
    if (suppressCloseFocusRef.current) {
      suppressCloseFocusRef.current = false;
      event.preventDefault();
    }
  };

  // ── 动作实现（⋯ 与右键共用；数据面真相在 runtime 适配器/桥，失败在那
  //    里 console.error 可见）──
  const handlers: Record<SessionActionId, () => void> = {
    rename: () => {
      suppressCloseFocusRef.current = true;
      setRenameOpen(true);
    },
    pin: () => sessionManageStore.getState().togglePin(threadId),
    "copy-id": () => {
      navigator.clipboard.writeText(threadId).catch((err) => {
        console.error("[session] 复制会话 ID 失败", err);
      });
    },
    branch: () => {
      const last = forkPoints[forkPoints.length - 1];
      if (!last) return;
      branchBridge.getState().requestFork(forkPoints.length - 1, last.text);
    },
    delete: () => {
      suppressCloseFocusRef.current = true;
      setDeleteOpen(true);
    },
  };

  const specs = useMemo(
    () =>
      projectSessionActions({
        pinned: isPinned,
        branchDisabled: !isActive || forkPoints.length === 0,
      }),
    [isPinned, isActive, forkPoints],
  );

  const renderDropdownItems = () =>
    specs.map((spec) =>
      spec.kind === "separator" ? (
        <ThreadListItemMorePrimitive.Separator
          className="bg-(--stroke-soft)"
          key={spec.id}
        />
      ) : (
        <ThreadListItemMorePrimitive.Item
          className={cn(
            MENU_ITEM_BASE,
            spec.destructive && DESTRUCTIVE_ITEM_CLASS,
          )}
          disabled={spec.disabled}
          key={spec.id}
          onSelect={() => handlers[spec.id]()}
        >
          {(() => {
            const Icon = ACTION_ICONS[spec.id];
            return <Icon className="size-3.5 shrink-0" />;
          })()}
          <span>{spec.label}</span>
        </ThreadListItemMorePrimitive.Item>
      ),
    );

  const renderContextItems = () =>
    specs.map((spec) =>
      spec.kind === "separator" ? (
        <ContextMenuPrimitive.Separator className="bg-(--stroke-soft)" key={spec.id} />
      ) : (
        <ContextMenuPrimitive.Item
          className={cn(
            MENU_ITEM_BASE,
            spec.destructive && DESTRUCTIVE_ITEM_CLASS,
          )}
          disabled={spec.disabled}
          key={spec.id}
          onSelect={() => handlers[spec.id]()}
        >
          {(() => {
            const Icon = ACTION_ICONS[spec.id];
            return <Icon className="size-3.5 shrink-0" />;
          })()}
          <span>{spec.label}</span>
        </ContextMenuPrimitive.Item>
      ),
    );

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        <ThreadListItemPrimitive.Root
          className={cn(
            "group/row hover:bg-(--hover-wash) data-active:bg-[color-mix(in_srgb,var(--fl-accent)_10%,transparent)] relative grid min-h-(--tl-row-min-h,1.625rem) grid-cols-[minmax(0,1fr)_auto] items-stretch rounded-md pr-2 transition-colors focus-visible:outline-none",
            // 拖拽中的行半透明：插入符说去哪，变淡的说什么在动
            isDragging && "opacity-45",
          )}
          data-session-row-group={group}
          data-slot="aui_thread-list-item"
          // 行标记（session-drag 的快照/候选识别按它找行；与 SESSION_ROW_ATTR
          // 常量同串，改一处必须改另一处）
          data-session-row-id={threadId}
          onClickCapture={(e) => {
            // 修饰键手势解析（hermes resolveSessionRowClick）：⇧ = 置顶；
            // 纯点击 = 恢复会话（Trigger 原生语义放行）。newTab / newWindow /
            // archive 数据面不适用（主区单会话投影、pi 无归档/独立窗口），
            // 吞掉默认行为不误伤。
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-row-actions]")) return;
            const action = resolveSessionRowClick(
              { altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey },
              { canOpenWindow: false },
            );
            if (action === "pin") {
              e.preventDefault();
              e.stopPropagation();
              sessionManageStore.getState().togglePin(threadId);
            } else if (action !== "resume") {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onPointerDown={(e) => {
            if (!ctx) return;
            startSessionRowDrag(e, {
              sessionId: threadId,
              title: title ?? "New Chat",
              group,
              onCommitListMove: (beforeId) => ctx.commitListMove(threadId, group as SessionRowGroup, beforeId),
              onCommitMainTab: () => ctx.commitMainTab(threadId),
            });
          }}
        >
          <ThreadListItemPrimitive.Trigger
            className="flex h-full min-w-0 items-center gap-1.5 self-stretch rounded-md py-0.5 pr-2 pl-2 text-start outline-none"
            data-slot="aui_thread-list-item-trigger"
          >
            {/* lead：状态圆点，hover 与拖拽把手互换（hermes SidebarRowGrab） */}
            <span
              aria-hidden
              className="relative grid size-3.5 shrink-0 place-items-center overflow-hidden"
              data-slot="aui_thread-list-item-lead"
            >
              <span
                className={cn(
                  "rounded-full transition-opacity group-hover/row:opacity-0",
                  isRunning ? "bg-(--fl-accent) size-1.5" : "bg-(--text-4) size-1",
                )}
                data-slot="aui_thread-list-item-running"
              />
              <GripVerticalIcon className="text-(--text-4) absolute size-3 opacity-0 transition group-hover/row:opacity-80" />
            </span>
            <span className="min-w-0 flex-1 self-center">
              <span
                className="hover-marquee text-(--text-2) group-hover/row:text-(--text) block truncate text-[0.8125rem] leading-[1.35] font-normal"
                data-slot="aui_thread-list-item-title"
                onPointerEnter={armMarquee}
                onPointerLeave={disarmMarquee}
              >
                <span className="hover-marquee-inner">
                  <ThreadListItemPrimitive.Title fallback="New Chat" />
                </span>
              </span>
            </span>
            {isRunning && <span className="sr-only">会话运行中</span>}
          </ThreadListItemPrimitive.Trigger>
          {/* 行操作簇（hermes [data-row-actions]：拖拽豁免区，只装 ⋯——
              置顶走 ⇧+点击/菜单，hermes 行上没有独立置顶钮） */}
          <div
            className="z-[2] relative flex shrink-0 items-center justify-end gap-1 self-stretch"
            data-row-actions=""
          >
            <ThreadListItemMorePrimitive.Root sharedFocusGroup>
              <ThreadListItemMorePrimitive.Trigger asChild>
                <button
                  aria-label="会话操作"
                  className={cn(
                    "text-transparent group-hover/row:text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text) focus-visible:bg-(--hover-wash) focus-visible:text-(--text) data-[state=open]:bg-(--hover-wash) data-[state=open]:text-(--text) size-5 shrink-0 cursor-pointer rounded-[4px] p-0 transition-colors duration-100",
                  )}
                  data-slot="aui_thread-list-item-more"
                  type="button"
                >
                  <MoreVerticalIcon className="size-3.5" />
                  <span className="sr-only">会话操作</span>
                </button>
              </ThreadListItemMorePrimitive.Trigger>
              <ThreadListItemMorePrimitive.Content
                align="end"
                onCloseAutoFocus={onCloseAutoFocus}
                sideOffset={6}
                className={MENU_CONTENT_CLASS}
                data-slot="aui_thread-list-item-more-content"
              >
                {renderDropdownItems()}
              </ThreadListItemMorePrimitive.Content>
            </ThreadListItemMorePrimitive.Root>
          </div>
        </ThreadListItemPrimitive.Root>
      </ContextMenuPrimitive.Trigger>
      {/* 右键上下文菜单：与 ⋯ 同一份 spec 投影（hermes SessionContextMenu
          同源机制——两份菜单永不漂移）；行上右击由 Radix 吞掉 WebView2
          默认菜单。 */}
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label="会话操作"
          className={MENU_CONTENT_CLASS}
          data-slot="aui_thread-list-item-context"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {renderContextItems()}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
      <RenameSessionDialog
        currentTitle={title ?? ""}
        onOpenChange={setRenameOpen}
        open={renameOpen}
        onRename={async (next) => {
          await aui.threadListItem.rename(next);
        }}
      />
      <DeleteSessionDialog
        onDelete={async () => {
          await aui.threadListItem.delete();
        }}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        sessionTitle={title ?? "New Chat"}
      />
    </ContextMenuPrimitive.Root>
  );
};
