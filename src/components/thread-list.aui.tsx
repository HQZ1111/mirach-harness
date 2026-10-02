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
  ActivityIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  ClockIcon,
  DownloadIcon,
  FolderIcon,
  GitForkIcon,
  GitPullRequestIcon,
  HashIcon,
  InboxIcon,
  GripVerticalIcon,
  ListFilterIcon,
  MailIcon,
  MailOpenIcon,
  MoreVerticalIcon,
  NetworkIcon,
  PencilIcon,
  UserIcon,
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
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

import { branchBridge } from "@/components/assistant-ui/branch-store";
import { approvalBridge } from "@/components/assistant-ui/approval-bridge";
import {
  sessionArchiveStore,
  useSessionArchive,
} from "@/components/panes/session-manage/session-archive";
import {
  projectSessionActions,
  type SessionActionId,
} from "@/components/panes/session-manage/session-actions";
import { DeleteSessionDialog, RenameSessionDialog } from "@/components/panes/session-manage/session-dialogs";
import { startSessionRowDrag } from "@/components/panes/session-manage/session-drag";
import { ReorderableList, useSortableBindings } from "@/components/panes/session-manage/reorderable-list";
import { buildSessionFigures, type SessionUsageRow } from "@/components/panes/session-manage/session-figures";
import { exportSessionHtml } from "@/components/panes/session-manage/session-export";
import {
  sessionManageStore,
  useSessionManage,
  type SessionRowGroup,
} from "@/components/panes/session-manage/session-manage-store";
import {
  buildSessionDisplay,
  buildSessionSearch,
  matchesTitleSearch,
  workspaceGroupLabel,
} from "@/components/panes/session-manage/session-display";
import {
  commitRecentMove,
  diffArrayMove,
  moveBefore,
  type SessionRowMeta,
} from "@/components/panes/session-manage/session-order";
import { resolveSessionRowClick } from "@/components/panes/session-manage/session-row-gesture";
import type { SessionListRow } from "@/components/panes/session-manage/session-date-groups";
import {
  formatMessageTimestamp,
  parseTimestampMs,
  sessionRowAge,
  THREAD_TIME_LABELS,
} from "@/components/panes/session-manage/session-time";
import {
  isRowUnread,
  sessionUnreadStore,
  useSessionUnread,
} from "@/components/panes/session-manage/session-unread";
import { sessionUsageStore, useSessionUsage } from "@/components/panes/session-manage/session-usage";
import {
  sessionStatusBucket,
  STATUS_BUCKET_LABELS,
  STATUS_DOT_CLASS,
  type SessionStatusBucket,
} from "@/components/panes/session-manage/session-status";
import {
  effectiveOrdering,
  filterByStatus,
  isSidebarViewCustomized,
  sidebarViewStore,
  useSidebarView,
  type SidebarGroupingMode,
  type SidebarRowMeta,
  type SidebarSortKey,
} from "@/components/panes/session-manage/sidebar-view";

/**
 * 会话侧栏（左栏会话列表）——hermes app/chat/sidebar 一链到底对齐版：
 * 行布局/hover 钮/⋯ 菜单/右键上下文菜单/分组结构（已置顶 + 会话 + 分组
 * 分隔线 + 桶折叠）/搜索（结果段）/新建入口（段头 hover ＋）/段头侧栏
 * 选项钮（hermes SidebarFilterMenu 的用户截图 1-14 项逐行对齐：分组/排序/
 * 显示/收件箱样式/配置档案栏 + 筛选组（状态/拉取请求/配置档案/全部配置
 * 档案/已归档）+ 全部折叠/全部标记为已读；sidebar-view.ts 持选项状态，
 * session-status.ts 持五桶判定）/激活态/⇧+点击置顶/重命名与删除确认弹层。
 * 菜单项清单与顺序 = session-actions.ts 的纯投影（⋯ 与右键同源，hermes
 * actions-menu 体系）；文案逐字取 hermes zh catalog。
 */

// ── 行拖拽提交的上下文（分区 → 组 → 提交通道）─────────────────────────────

interface SessionListCtxValue {
  /** 该行所在列表组（置顶/会话/搜索——dnd-kit 让位轮后仅存渲染语义；
   *  拖拽机器不再消费它，搜索段无 bindings 即不可排）。 */
  group: SessionRowGroup | "search";
  /** 该行的展示元数据（SessionRowMeta 投影——figures/未读/归档/导出从
   *  这里读，行组件不再各自订阅 threadItems）。 */
  meta?: SessionRowMeta;
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
  // dnd-kit 传感器（hermes sidebar/index.tsx:506-509 逐值）：PointerSensor
  // 距离阈值 6px（阈值内松开 = 普通点击，切会话/置顶手势照常）+
  // KeyboardSensor（把手聚焦后空格拿起、方向键移动——坐标用 sortable 键盘序）。
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <ThreadListRoot className="flex h-full min-h-0 flex-col bg-(--surface)" data-density={density}>
      <div className="shrink-0 px-3 pb-1 pt-1">
        <ThreadListSearch aria-label="搜索会话" onValueChange={setSearch} value={search} />
      </div>
      {/* 左右边距 20px（用户定稿）：容器 px-3 + 行 px-2 合成文字线 20 ——
          hermes SidebarContent px-2.5 的同款分层 */}
      <ThreadListItems className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" dndSensors={dndSensors} searchQuery={search} />
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
  ComponentPropsWithoutRef<"div"> & {
    searchQuery?: string;
    dndSensors?: ReturnType<typeof useSensors>;
  }
> = ({ className, dndSensors, searchQuery = "", ...props }) => {
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
        <ThreadListSections dndSensors={dndSensors} searchQuery={searchQuery} />
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
      const custom = item?.custom;
      const ms = custom?.lastModifiedMs;
      const createdRaw = custom?.timestamp;
      const countRaw = custom?.messageCount;
      const createdMs =
        typeof createdRaw === "string" ? parseTimestampMs(createdRaw) : undefined;
      return {
        id,
        lastActiveMs: typeof ms === "number" && Number.isFinite(ms) ? ms : 0,
        title: typeof item?.title === "string" ? item.title : undefined,
        // pi SessionMeta 直投影（runtime.tsx refreshThreads 写进 custom）：
        // 工作区分组（cwd）/created 排序（timestamp）/未读水位与用量过期键
        // （messageCount）/导出（path）。
        path: typeof custom?.path === "string" ? custom.path : undefined,
        cwd: typeof custom?.cwd === "string" ? custom.cwd : undefined,
        createdMs,
        messageCount:
          typeof countRaw === "number" && Number.isFinite(countRaw) ? countRaw : undefined,
      };
    });
  }, [threadIds, threadItems]);
};
const useThreadDisplay = (searchQuery: string) => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const allMetas = useSessionRowMetas();
  const pinned = useSessionManage((s) => s.pinned);
  const order = useSessionManage((s) => s.order);
  const collapsed = useSessionManage((s) => s.groupsCollapsed);
  const archived = useSessionArchive((s) => s.archived);
  // 侧栏选项（hermes $sidebarGrouping/$sidebarOrdering 同构：manual 压过
  // 排序键——拖拽 IS 选择手动序）。
  const grouping = useSidebarView((s) => s.grouping);
  const ordering = useSidebarView(effectiveOrdering);
  const showArchived = useSidebarView((s) => s.showArchived);
  const query = searchQuery.trim();

  // 归档过滤（hermes $sidebarShowArchived 关 = 归档行整个不渲染；开 =
  // 归位显示，行 lead 换归档字形）。搜索同样只搜未归档面。
  const metas = useMemo(
    () => (showArchived ? allMetas : allMetas.filter((m) => !archived.includes(m.id))),
    [allMetas, archived, showArchived],
  );

  // 状态桶判定（session-status.ts：needs-input > working > unread > draft >
  // idle，hermes claim 链同序）——状态筛选/分组/排序共用同一份。pi 前端
  // 全可判定：needsInput = 审批卡挂起（approvalBridge 为真相——Rust
  // ApprovalRegistry 的前端缓存，pi 的 extension 请求只发生在当前活跃
  // 会话 → 挂在 mainThreadId）；working = runtime isRunning + mainThreadId。
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const pendingApprovals = useStore(approvalBridge, (s) => s.pending);
  const seen = useSessionUnread((s) => s.seen);
  const markers = useSessionUnread((s) => s.markers);
  const runningThreadId = isRunning ? mainThreadId : null;
  const needsInputThreadId = pendingApprovals.length > 0 ? mainThreadId : null;

  const statusBuckets = useMemo(() => {
    const map = new Map<string, SessionStatusBucket>();
    for (const m of metas) {
      map.set(
        m.id,
        sessionStatusBucket({
          needsInput: m.id === needsInputThreadId,
          running: m.id === runningThreadId,
          unread: isRowUnread({ id: m.id, messageCount: m.messageCount ?? 0 }, seen, markers),
          draft: !m.messageCount,
        }),
      );
    }
    return map;
  }, [metas, needsInputThreadId, runningThreadId, seen, markers]);

  // 状态筛选（hermes Filters>Status：五桶多选，空 = 不过滤）。
  const statusFilter = useSidebarView((s) => s.statusFilter);
  const filteredMetas = useMemo(
    () =>
      filterByStatus(metas, statusFilter, (m) => {
        const bucket = statusBuckets.get(m.id);
        if (bucket === undefined) {
          throw new Error(`[thread-list] 行缺状态桶（${m.id}）——statusBuckets 必须覆盖全部行`);
        }
        return bucket;
      }),
    [metas, statusFilter, statusBuckets],
  );

  // 用量缓存订阅（tokens 排序键的辅助面 + 行尾 figures 的数据源共用——
  // 同一份 session-usage 缓存，不重复拉取）。
  const usageRows = useSessionUsage((s) => s.rows);

  // 排序辅助面（rankIdsByOrdering 的 aux）：status 五桶 + tokens 词元总数
  // （session-usage 缓存的 totalTokens，未缓存的行缺键——rankIdsByOrdering
  // 按 0 沉底，拉取到达后排序自然上浮）。
  const aux = useMemo(
    () => ({
      statusBuckets,
      tokenTotals: (() => {
        const map = new Map<string, number>();
        for (const m of filteredMetas) {
          if (typeof m.path === "string") {
            const row = usageRows[m.path];
            if (row) map.set(m.id, row.totalTokens);
          }
        }
        return map;
      })(),
    }),
    [statusBuckets, filteredMetas, usageRows],
  );

  return useMemo(() => {
    if (query) {
      const byId = new Map(threadItems.map((item) => [item.id, item] as const));
      const matched = filteredMetas.filter((m) =>
        matchesTitleSearch(byId.get(m.id)?.title ?? "", query),
      );
      return { mode: "search" as const, threadIds, metas: filteredMetas, search: buildSessionSearch(matched) };
    }
    return {
      mode: "groups" as const,
      threadIds,
      metas: filteredMetas,
      display: buildSessionDisplay(filteredMetas, pinned, order, collapsed, {
        view: { grouping, ordering, aux },
      }),
    };
  }, [query, threadIds, threadItems, filteredMetas, pinned, order, collapsed, grouping, ordering, aux]);
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

/** 禁用但带 title 说明的行（Show 子菜单 PR/配置档案）：不用
 *  VIEW_MENU_ITEM_BASE——其 data-[disabled]:pointer-events-none 会让
 *  native title 无法触发（说明文字必须可 hover）；观感（opacity-50）与
 *  非交互（cursor-default）固定，onSelect 由 Radix 对 disabled 项短路。 */
const VIEW_DISABLED_HINT_ITEM =
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none opacity-50 cursor-default";

/** 排序/分组选项行（图标 + 文案；hermes OptionGlyph 的 lucide 等价物）。 */
const ViewOptionRow: FC<{ icon: FC<{ className?: string }>; label: string }> = ({ icon: Icon, label }) => (
  <>
    <Icon className={VIEW_OPTION_GLYPH} />
    <span>{label}</span>
  </>
);

/** hermes STATUS_FILTERS（filter-menu.tsx:114-120 的五桶多选）：色点 =
 *  STATUS_DOT_CLASS（session-status.ts），文案 = 用户截图（需要输入●橙 /
 *  运行中●蓝 / 未读●绿 / 草稿○ / 空闲○）。 */
const STATUS_FILTER_OPTIONS: readonly SessionStatusBucket[] = [
  "needs-input",
  "working",
  "unread",
  "draft",
  "idle",
];

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
  const rowMeta = useSidebarView((s) => s.rowMeta);
  const showArchived = useSidebarView((s) => s.showArchived);
  const inboxStyle = useSidebarView((s) => s.inboxStyle);
  const projectFilter = useSidebarView((s) => s.projectFilter);
  // 状态筛选（hermes $sidebarStatusFilter 同构：五桶多选，空 = 不过滤）。
  const statusFilter = useSidebarView((s) => s.statusFilter);
  const customized = useSidebarView(isSidebarViewCustomized);
  // 「全部标记为已读」的可用面：当前渲染的行里有未读（hermes：disabled 当
  // unreadIds 空——markAllSessionsRead 清 transient 面，这里 ack 可见面）。
  const metas = useThreadVisibleMetas();
  // 项目过滤子菜单的候选 = 全量 metas 的 distinct cwd（Home 桶=空串）；
  // hermes 同款条件（filter-menu.tsx:388）：多于一个候选才出子菜单。
  const allMetasForProjects = useSessionRowMetas();
  const projectChoices = useMemo(() => {
    const set = new Set<string>();
    for (const m of allMetasForProjects) set.add(m.cwd ?? "");
    return [...set].sort();
  }, [allMetasForProjects]);
  const seen = useSessionUnread((s) => s.seen);
  const markers = useSessionUnread((s) => s.markers);
  const unreadCount = metas.filter((m) =>
    isRowUnread({ id: m.id, messageCount: m.messageCount ?? 0 }, seen, markers),
  ).length;

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
          {/* 1. 分组 ▸（触发行显示当前值 + chevron-right；子菜单四项 =
              用户截图：更新时间✓/项目/状态/网关与配置——无「平铺」）。
              网关与配置（hermes grouping='profile' 的菜单标签）pi 单配置
              档案无语义 → disabled radio 不发。 */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <span>分组</span>
              <span className="text-(--text-3) ml-auto flex items-center gap-1 pl-4">
                {grouping === "date" ? "更新时间" : grouping === "project" ? "项目" : "状态"}
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
                  <ViewOptionRow icon={ClockIcon} label="更新时间" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="project"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={FolderIcon} label="项目" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="status"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ActivityIcon} label="状态" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_DISABLED_HINT_ITEM}
                  disabled
                  title="pi 单配置档案，无可分组的网关与配置"
                  value="gateway"
                >
                  <ViewIndicatorSlot>{null}</ViewIndicatorSlot>
                  <ViewOptionRow icon={UserIcon} label="网关与配置" />
                </DropdownMenuPrimitive.RadioItem>
              </DropdownMenuPrimitive.RadioGroup>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>

          {/* 2. 排序 ▸（子菜单四项 = 用户截图：更新时间✓/创建时间/状态/
              词元数——无「标题字母序」无「手动」：hermes 拖拽排序不经此
              菜单，拖拽声明 manual 时 radio 无命中项不高亮，选任意排序键
              = 退出手动并清掉保存的手动序）。status 键 = 五桶 rank 升序
              （needs-input > working > unread > draft > idle）；tokens 键 =
              session-usage 懒拉（未拉到按 0 沉底）。 */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <span>排序</span>
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.SubContent
              className={VIEW_MENU_CONTENT_CLASS}
              sideOffset={6}
            >
              <DropdownMenuPrimitive.RadioGroup
                onValueChange={(value) =>
                  sidebarViewStore
                    .getState()
                    .setOrdering(value as SidebarSortKey)
                }
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
                  <ViewOptionRow icon={ClockIcon} label="更新时间" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="created"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  {/* hermes ORDERINGS.created 的图标字面量 = 'add' */}
                  <ViewOptionRow icon={PlusIcon} label="创建时间" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="status"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={ActivityIcon} label="状态" />
                </DropdownMenuPrimitive.RadioItem>
                <DropdownMenuPrimitive.RadioItem
                  className={VIEW_MENU_ITEM_BASE}
                  onSelect={keepViewMenuOpen}
                  value="tokens"
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <span aria-hidden className="bg-current size-1.5 rounded-full" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={HashIcon} label="词元数" />
                </DropdownMenuPrimitive.RadioItem>
              </DropdownMenuPrimitive.RadioGroup>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>

          {/* 3. 显示 ▸（子菜单 = 用户截图：更新时间/词元数 + PR/配置档案
              disabled——无「成本」无「紧凑行高」。PR = pi 未集成 gh、配置
              档案 = pi 单配置档案：disabled + title 说明，不许假可点。） */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <span>显示</span>
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.SubContent
              className={VIEW_MENU_CONTENT_CLASS}
              sideOffset={6}
            >
              {(
                [
                  { id: "updated", label: "更新时间", icon: ClockIcon },
                  { id: "tokens", label: "词元数", icon: HashIcon },
                ] as const satisfies readonly { id: SidebarRowMeta; label: string; icon: FC<{ className?: string }> }[]
              ).map((option) => (
                <DropdownMenuPrimitive.CheckboxItem
                  checked={rowMeta.includes(option.id)}
                  className={VIEW_MENU_ITEM_BASE}
                  key={option.id}
                  onCheckedChange={() =>
                    sidebarViewStore.getState().toggleRowMeta(option.id)
                  }
                  onSelect={keepViewMenuOpen}
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <CheckIcon className="size-3" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  <ViewOptionRow icon={option.icon} label={option.label} />
                </DropdownMenuPrimitive.CheckboxItem>
              ))}
              {/* PR/配置档案（hermes ROW_META 的 pr/profile 两项，图标
                  git-pull-request/account → lucide GitPullRequest/User）：
                  专用 class 固定 disabled 观感（不用 VIEW_MENU_ITEM_BASE 的
                  data-[disabled]:pointer-events-none——native title 需要
                  hover，说明文字必须可触发）；onSelect 由 Radix 对 disabled
                  项短路，不假可点。 */}
              <DropdownMenuPrimitive.CheckboxItem
                checked={false}
                className={VIEW_DISABLED_HINT_ITEM}
                disabled
                title="pi 未集成 gh，PR 数据不可用"
              >
                <ViewIndicatorSlot>{null}</ViewIndicatorSlot>
                <ViewOptionRow icon={GitPullRequestIcon} label="PR" />
              </DropdownMenuPrimitive.CheckboxItem>
              <DropdownMenuPrimitive.CheckboxItem
                checked={false}
                className={VIEW_DISABLED_HINT_ITEM}
                disabled
                title="pi 单配置档案，无可展示项"
              >
                <ViewIndicatorSlot>{null}</ViewIndicatorSlot>
                <ViewOptionRow icon={UserIcon} label="配置档案" />
              </DropdownMenuPrimitive.CheckboxItem>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>

          {/* 4. 收件箱样式（hermes「Inbox style」：卡片行形态开关——中文
              措辞按用户截图）。 */}
          <DropdownMenuPrimitive.CheckboxItem
            checked={inboxStyle}
            className={VIEW_MENU_ITEM_BASE}
            onCheckedChange={(checked) => sidebarViewStore.getState().setInboxStyle(Boolean(checked))}
            onSelect={keepViewMenuOpen}
          >
            <ViewIndicatorSlot>
              <DropdownMenuPrimitive.ItemIndicator>
                <CheckIcon className="size-3" />
              </DropdownMenuPrimitive.ItemIndicator>
            </ViewIndicatorSlot>
            <ViewOptionRow icon={InboxIcon} label="收件箱样式" />
          </DropdownMenuPrimitive.CheckboxItem>

          {/* 5. 配置档案栏（hermes $profileRailVisible：侧栏左缘的 profile
              rail）——pi 单配置档案无 rail 数据面 → disabled（诚实）。 */}
          <DropdownMenuPrimitive.CheckboxItem
            checked={false}
            className={VIEW_DISABLED_HINT_ITEM}
            disabled
            title="pi 单配置档案，无配置档案栏"
          >
            <ViewIndicatorSlot>{null}</ViewIndicatorSlot>
            <ViewOptionRow icon={NetworkIcon} label="配置档案栏" />
          </DropdownMenuPrimitive.CheckboxItem>

          {/* 6. ── 筛选（hermes「Filters」label 组：Status/PR/Profile/
              AllProfiles/Archived；分组区与筛选区之间的分隔线。 */}
          <DropdownMenuPrimitive.Separator className="bg-(--stroke-soft) mx-1 my-1 h-px" />
          <DropdownMenuPrimitive.Label className="text-(--text-3) px-2 pt-1.5 pb-1 text-[11px]">
            筛选
          </DropdownMenuPrimitive.Label>
          {/* 7. 状态 ▸（子菜单 = 用户截图五桶 checkbox 多选：需要输入●橙 /
              运行中●蓝 / 未读●绿 / 草稿○ / 空闲○——色点 =
              STATUS_DOT_CLASS，文案 = STATUS_BUCKET_LABELS。筛选 =
              只显示命中桶的行，空选 = 不过滤；pi 前端全可判定。） */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
              <ViewOptionRow icon={ActivityIcon} label="状态" />
              <ChevronRightIcon className="text-(--text-3) ml-auto size-3" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.SubContent
              className={VIEW_MENU_CONTENT_CLASS}
              sideOffset={6}
            >
              {STATUS_FILTER_OPTIONS.map((bucket) => (
                <DropdownMenuPrimitive.CheckboxItem
                  checked={statusFilter.includes(bucket)}
                  className={VIEW_MENU_ITEM_BASE}
                  key={bucket}
                  onCheckedChange={() =>
                    sidebarViewStore.getState().toggleStatusBucket(bucket)
                  }
                  onSelect={keepViewMenuOpen}
                >
                  <ViewIndicatorSlot>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <CheckIcon className="size-3" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </ViewIndicatorSlot>
                  {/* 色点在指示位之外（hermes OptionGlyph：glyph 在行首、
                      选中指示在其左——checkbox 的 ✓ 槽与色点并存）。 */}
                  <span aria-hidden className={STATUS_DOT_CLASS[bucket]} />
                  <span>{STATUS_BUCKET_LABELS[bucket]}</span>
                </DropdownMenuPrimitive.CheckboxItem>
              ))}
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Sub>
          {/* 8. 拉取请求 ▸（子菜单：打开/草稿/已合并/已关闭/无 PR）——
              pi 无 gh → 整个 SubTrigger disabled（诚实：无数据面）。 */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE} disabled>
              <ViewOptionRow icon={GitPullRequestIcon} label="拉取请求" />
              <ChevronRightIcon className="text-(--text-3) ml-auto size-3" />
            </DropdownMenuPrimitive.SubTrigger>
          </DropdownMenuPrimitive.Sub>
          {/* 9. 配置档案 ▸（子菜单：新建配置档案/导入配置档案…，hermes
              t.profiles 文案）——pi 单配置档案无 profiles 桥面 → disabled。
              10. 全部配置档案 checkbox：pi 单配置档案恒 ✓（诚实——所有
              profile 就是这一个，永远全显示，不可取消）。 */}
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE} disabled>
              <ViewOptionRow icon={UserIcon} label="配置档案" />
              <ChevronRightIcon className="text-(--text-3) ml-auto size-3" />
            </DropdownMenuPrimitive.SubTrigger>
          </DropdownMenuPrimitive.Sub>
          <DropdownMenuPrimitive.CheckboxItem
            checked
            className={VIEW_DISABLED_HINT_ITEM}
            disabled
            title="pi 单配置档案——始终显示全部"
          >
            <ViewIndicatorSlot>
              <DropdownMenuPrimitive.ItemIndicator>
                <CheckIcon className="size-3" />
              </DropdownMenuPrimitive.ItemIndicator>
            </ViewIndicatorSlot>
            <span>全部配置档案</span>
          </DropdownMenuPrimitive.CheckboxItem>
          {/* 项目过滤（hermes Filters>Project 子菜单的条件形态：
              filter-menu.tsx:388 只在多于一个候选时出现——用户截图只有一个
              工作区所以没有这项；harness 候选 = distinct cwd（Home 桶=
              空串），condition 同构）。 */}
          {projectChoices.length > 1 && (
            <DropdownMenuPrimitive.Sub>
              <DropdownMenuPrimitive.SubTrigger className={VIEW_MENU_ITEM_BASE}>
                <ViewOptionRow icon={FolderIcon} label="项目" />
                <span className="text-(--text-3) ml-auto flex items-center gap-1 pl-4">
                  {projectFilter ? workspaceGroupLabel(projectFilter) : "全部"}
                  <ChevronRightIcon className="size-3" />
                </span>
              </DropdownMenuPrimitive.SubTrigger>
              <DropdownMenuPrimitive.SubContent
                className={VIEW_MENU_CONTENT_CLASS}
                sideOffset={6}
              >
                <DropdownMenuPrimitive.RadioGroup
                  onValueChange={(value) =>
                    sidebarViewStore
                      .getState()
                      .setProjectFilter(
                        value === "__all__"
                          ? null
                          : value === "__home__"
                            ? ""
                            : value,
                      )
                  }
                  value={
                    projectFilter === null
                      ? "__all__"
                      : projectFilter === ""
                        ? "__home__"
                        : projectFilter
                  }
                >
                  <DropdownMenuPrimitive.RadioItem
                    className={VIEW_MENU_ITEM_BASE}
                    onSelect={keepViewMenuOpen}
                    value="__all__"
                  >
                    <ViewIndicatorSlot>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <span aria-hidden className="bg-current size-1.5 rounded-full" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </ViewIndicatorSlot>
                    <span>全部</span>
                  </DropdownMenuPrimitive.RadioItem>
                  {projectFilter !== null && projectFilter !== "" && !projectChoices.includes(projectFilter) && (
                    <DropdownMenuPrimitive.RadioItem
                      className={VIEW_MENU_ITEM_BASE}
                      onSelect={keepViewMenuOpen}
                      value={projectFilter}
                    >
                      <ViewIndicatorSlot>
                        <DropdownMenuPrimitive.ItemIndicator>
                          <span aria-hidden className="bg-current size-1.5 rounded-full" />
                        </DropdownMenuPrimitive.ItemIndicator>
                      </ViewIndicatorSlot>
                      <span className="truncate">{workspaceGroupLabel(projectFilter)}</span>
                    </DropdownMenuPrimitive.RadioItem>
                  )}
                  {projectChoices.map((cwd) => (
                    <DropdownMenuPrimitive.RadioItem
                      className={VIEW_MENU_ITEM_BASE}
                      key={cwd || "__home__"}
                      onSelect={keepViewMenuOpen}
                      value={cwd || "__home__"}
                    >
                      <ViewIndicatorSlot>
                        <DropdownMenuPrimitive.ItemIndicator>
                          <span aria-hidden className="bg-current size-1.5 rounded-full" />
                        </DropdownMenuPrimitive.ItemIndicator>
                      </ViewIndicatorSlot>
                      <span className="truncate">{workspaceGroupLabel(cwd)}</span>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Sub>
          )}
          {/* 11. 已归档（hermes $sidebarShowArchived）。 */}
          <DropdownMenuPrimitive.CheckboxItem
            checked={showArchived}
            className={VIEW_MENU_ITEM_BASE}
            onCheckedChange={(checked) => sidebarViewStore.getState().setShowArchived(Boolean(checked))}
            onSelect={keepViewMenuOpen}
          >
            <ViewIndicatorSlot>
              <DropdownMenuPrimitive.ItemIndicator>
                <CheckIcon className="size-3" />
              </DropdownMenuPrimitive.ItemIndicator>
            </ViewIndicatorSlot>
            <ViewOptionRow icon={ArchiveIcon} label="已归档" />
          </DropdownMenuPrimitive.CheckboxItem>
          {/* hermes「Reset to defaults」（filter-menu.tsx:430 的条件形态：
              viewCustomized 才出现——用户截图是出厂态所以没有）。一并复原
              分组与排序，这是唯一的回程（hermes 注释同语义）。 */}
          {customized && (
            <DropdownMenuPrimitive.Item
              className={VIEW_MENU_ITEM_BASE}
              onSelect={() => sidebarViewStore.getState().resetView()}
            >
              <RotateCcwIcon className={VIEW_OPTION_GLYPH} />
              <span>重置为默认</span>
            </DropdownMenuPrimitive.Item>
          )}

          {/* 12. ──（分隔线）13. 全部折叠 14. 全部标记为已读 */}
          <DropdownMenuPrimitive.Separator className="bg-(--stroke-soft) mx-1 my-1 h-px" />

          {dividerKeys.length > 0 && (
            <DropdownMenuPrimitive.Item className={VIEW_MENU_ITEM_BASE} onSelect={onCollapseAll}>
              {foldCollapsed ? "全部展开" : "全部折叠"}
            </DropdownMenuPrimitive.Item>
          )}
          <DropdownMenuPrimitive.Item
            className={VIEW_MENU_ITEM_BASE}
            disabled={unreadCount === 0}
            onSelect={() => {
              sessionUnreadStore.getState().ackAll(
                metas.map((m) => ({ id: m.id, messageCount: m.messageCount ?? 0 })),
              );
            }}
          >
            全部标记为已读
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
};

/** 当前渲染面（归档/项目过滤后）的行 metas——Mark all as read 的 ack 面与
 *  未读计数共用。与 ThreadListSections 的 metas 消费同源。
 *  projectFilter = pi cwd 直投影过滤（hermes Filters>Project 的等价物）；
 *  状态筛选不在此处（useThreadDisplay 的桶管线已滤——ack 面跟着可视面走）。 */
function useThreadVisibleMetas(): SessionRowMeta[] {
  const allMetas = useSessionRowMetas();
  const archived = useSessionArchive((s) => s.archived);
  const showArchived = useSidebarView((s) => s.showArchived);
  const projectFilter = useSidebarView((s) => s.projectFilter);
  return useMemo(() => {
    let rows = allMetas;
    if (!showArchived) rows = rows.filter((m) => !archived.includes(m.id));
    if (projectFilter) rows = rows.filter((m) => (m.cwd ?? "") === projectFilter);
    return rows;
  }, [allMetas, archived, showArchived, projectFilter]);
}

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

/**
 * 工作区分隔线（分组=按项目；hermes grouping='project' 的组头——项目树
 * 节点在此简化为 cwd 组头：folder 字形 + 组名（pathLeaf）+ 折叠 caret；
 * 折叠语义与日期桶相同：组头保留、其下行隐藏，键 = `w:<cwd>`）。
 */
const WorkspaceDividerRow: FC<{ bucketKey: string; label: string }> = ({ bucketKey, label }) => {
  const collapsed = useSessionManage((s) => s.groupsCollapsed[bucketKey] === true);
  return (
    <div
      className="group/workspace flex w-full min-w-0 items-center gap-2 px-2 pb-0.5 pt-(--tl-div-pt,0.5rem) select-none"
      data-slot="aui_thread-list-workspace-divider"
    >
      <button
        aria-expanded={!collapsed}
        className="group/section-label flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left"
        onClick={() =>
          sessionManageStore.getState().setGroupCollapsed(bucketKey, !collapsed)
        }
        title={collapsed ? "展开" : "收起"}
        type="button"
      >
        <FolderIcon
          aria-hidden
          className="text-(--text-4) size-3 shrink-0"
        />
        <span className="text-(--text-2) min-w-0 truncate text-xs font-medium">{label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "text-(--text-3) size-3 shrink-0 opacity-0 transition group-hover/workspace:opacity-100 group-focus-visible/workspace:opacity-100",
            collapsed && "-rotate-90",
          )}
        />
        <span aria-hidden className="bg-(--stroke-soft) h-px min-w-4 flex-1" />
      </button>
    </div>
  );
};

/**
 * 状态桶分隔线（分组=状态；hermes grouping='status' 的组头——色点 +
 * 状态中文名（STATUS_BUCKET_LABELS，组序 = 状态 rank：需要输入最前、
 * 空闲殿后）；折叠语义与日期桶相同：组头保留、其下行隐藏，键 =
 * `s:<bucket>`）。
 */
const StatusDividerRow: FC<{ bucketKey: string; label: string }> = ({ bucketKey, label }) => {
  const collapsed = useSessionManage((s) => s.groupsCollapsed[bucketKey] === true);
  // key = `s:<bucket>`（session-display groupEntriesByStatus 的约定）。
  const bucket = bucketKey.slice("s:".length) as SessionStatusBucket;
  return (
    <div
      className="group/workspace flex w-full min-w-0 items-center gap-2 px-2 pb-0.5 pt-(--tl-div-pt,0.5rem) select-none"
      data-slot="aui_thread-list-status-divider"
    >
      <button
        aria-expanded={!collapsed}
        className="group/section-label flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left"
        onClick={() =>
          sessionManageStore.getState().setGroupCollapsed(bucketKey, !collapsed)
        }
        title={collapsed ? "展开" : "收起"}
        type="button"
      >
        <span aria-hidden className={STATUS_DOT_CLASS[bucket]} />
        <span className="text-(--text-2) min-w-0 truncate text-xs font-medium">{label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "text-(--text-3) size-3 shrink-0 opacity-0 transition group-hover/workspace:opacity-100 group-focus-visible/workspace:opacity-100",
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

type SortableRowBindings = ReturnType<typeof useSortableBindings>;

/** 行级 dnd-kit 绑定（useSortable 必须在 SortableContext 子树内按行调用——
 *  hermes 的形态是 SortableSidebarSessionRow 包装行组件（sessions-section
 *  .tsx:651-653），本处因 assistant-ui 的 ItemByIndex 注入行而无从传 props，
 *  用等价的 Provider 桥把 bindings 送进 ThreadListItem）。 */
const SortableRowContext = createContext<SortableRowBindings | null>(null);

const SortableRowBridge: FC<{ id: string; children: ReactNode }> = ({ children, id }) => {
  const bindings = useSortableBindings(id);
  return <SortableRowContext.Provider value={bindings}>{children}</SortableRowContext.Provider>;
};

const ThreadListSections: FC<{ searchQuery: string; dndSensors?: ReturnType<typeof useSensors> }> = ({
  dndSensors,
  searchQuery,
}) => {
  const { mode, threadIds, metas, display, search } = useThreadDisplay(searchQuery);
  const groupsCollapsed = useSessionManage((s) => s.groupsCollapsed);
  const collapsedPinned = useSessionManage((s) => s.groupsCollapsed.pinned === true);
  const collapsedRecent = useSessionManage((s) => s.groupsCollapsed.recent === true);
  // 状态筛选值（空态文案分面：筛选激活且无命中 → hermes noFilterMatches
  // 「没有会话符合这些筛选条件」zh.ts:2900 逐字）。
  const statusFilter = useSidebarView((s) => s.statusFilter);
  const aui = useAui();

  // 死会话清理：列表非空才清——首帧 threads=[] 是"未加载"不是"已删光"。
  // 归档表/未读水位同纪律（归档会话被 pi_delete_session 后不留死键）。
  useEffect(() => {
    sessionManageStore.getState().prune(threadIds);
    sessionArchiveStore.getState().prune(threadIds);
    sessionUnreadStore.getState().prune(threadIds);
  }, [threadIds]);

  // rowMeta 开了 词元数 / 排序切了 词元数 → 拉取可见行的用量（缺/过期才发
  // IPC，缓存键带 messageCount；都没开不发——懒计算）。拉取到达后 tokens
  // 排序自然上浮（rankIdsByOrdering 的 tokenTotals 缺键按 0 沉底）。
  const rowMeta = useSidebarView((s) => s.rowMeta);
  const orderingKnob = useSidebarView((s) => s.ordering);
  useEffect(() => {
    if (!rowMeta.includes("tokens") && orderingKnob !== "tokens") return;
    const rows = metas
      .filter((m) => typeof m.path === "string" && typeof m.messageCount === "number")
      .map((m) => ({ path: m.path!, messageCount: m.messageCount! }));
    if (rows.length === 0) return;
    void sessionUsageStore.getState().ensure(rows);
  }, [metas, rowMeta, orderingKnob]);

  // 拖拽落点提交通道（dnd-kit ReorderableList 的 onReorder 全量新序经
  // diffArrayMove 反解出 (sessionId, beforeId) 后走这里——置顶区 = pinned
  // 数组重排 hermes reorderPinned；会话区 = 可见序改后拼回全量序（折叠桶
  // 藏行不丢排序；会话区拖拽同时声明手动序 = hermes「drag IS how you pick
  // manual」）。跨面投放（主会话页签）走 session-drag.ts 的 pointer 机器。
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

  const metasById = useMemo(
    () => new Map(metas.map((m) => [m.id, m] as const)),
    [metas],
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

  // ReorderableList 只回全量新序（hermes 原语签名），提交通道要 (id,
  // beforeId)——diffArrayMove 反解；无位移/形状异常不动作（禁止兜底）。
  const commitReorder = (group: SessionRowGroup, ids: string[], nextIds: string[]) => {
    const moved = diffArrayMove(ids, nextIds);
    if (!moved) return;
    ctxValue.commitListMove(moved.movedId, group, moved.beforeId);
  };

  const renderRow = (id: string, group: SessionRowGroup | "search", key: string) => {
    const row = (
      <ThreadListPrimitive.ItemByIndex index={indexOfId.get(id) ?? 0} components={{ ThreadListItem }} />
    );
    // 搜索段不挂 sortable（hermes 搜索结果段不接 ReorderableList）——
    // 无 SortableRowBridge ⇒ ThreadListItem 无 bindings ⇒ 跨面拖照常、
    // 列表内不排。
    const body = group === "search" ? row : <SortableRowBridge id={id}>{row}</SortableRowBridge>;
    return (
      <SessionListContext.Provider key={key} value={{ ...ctxValue, group, meta: metasById.get(id) }}>
        {body}
      </SessionListContext.Provider>
    );
  };

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
  const sessionRows = rows.filter(
    (r): r is Extract<SessionListRow, { kind: "session" }> => r.kind === "session",
  );
  // dnd-kit 只见渲染序（hermes sessions-section.tsx:438 实锤注释：sortable
  // 集合从 rows 派生而非从数据派生——喂未渲染的序会让落点对着用户没看的
  // 列表算 index，把行放进错误的槽）。分隔线行不是条目，但照 hermes 留在
  // SortableContext 的 children 里（dividers 不 transform，行在其间换位）。
  const sortablePinnedIds = pinnedIds;
  const sortableSessionIds = sessionRows.map((r) => r.id);

  return (
    <SessionListContext.Provider value={ctxValue}>
      {/* 已置顶区（恒在；空态教 ⇧+点击；组内拖排 = pinned 数组序——
          hermes：置顶区一个 ReorderableList，与会话区互不越组） */}
      <SectionHeader
        collapsed={collapsedPinned}
        headerKey="pinned"
        label="已置顶"
      />
      {!collapsedPinned &&
        (pinnedIds.length > 0 ? (
          <ReorderableList
            ids={sortablePinnedIds}
            onReorder={(next) => commitReorder("pinned", sortablePinnedIds, next)}
            sensors={dndSensors}
          >
            {pinnedIds.map((id) => renderRow(id, "pinned", `p-${id}`))}
          </ReorderableList>
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
          statusFilter.length > 0 ? (
            // 状态筛选激活导致的空（hermes noFilterMatches 空态——zh
            // 「没有会话符合这些筛选条件」逐字）。
            <div
              className="text-(--text-3) grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs"
              data-slot="aui_thread-list-empty-filtered"
            >
              没有会话符合这些筛选条件
            </div>
          ) : (
            <div className="text-(--text-3) grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs">
              暂无会话
            </div>
          )
        ) : (
          <ReorderableList
            ids={sortableSessionIds}
            onReorder={(next) => commitReorder("recent", sortableSessionIds, next)}
            sensors={dndSensors}
          >
            {rows.map((row) =>
              row.kind === "divider" ? (
                row.variant === "project" ? (
                  <WorkspaceDividerRow key={`div-${row.key}`} bucketKey={row.key} label={row.label} />
                ) : row.variant === "status" ? (
                  <StatusDividerRow key={`div-${row.key}`} bucketKey={row.key} label={row.label} />
                ) : (
                  <DateDividerRow key={`div-${row.key}`} bucketKey={row.key} label={row.label} />
                )
              ) : (
                renderRow(row.id, "recent", `r-${row.id}`)
              ),
            )}
          </ReorderableList>
        ))}
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
  // read-state 项的图标随状态（hermes：unread → 'mail-read'，read → 'mail'
  // ——见 renderDropdownItems 的动态分支；此处为缺省位）
  unread: MailIcon,
  "copy-id": ClipboardIcon,
  branch: GitForkIcon,
  export: DownloadIcon,
  archive: ArchiveIcon,
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
  // fork 点清单（活动会话才谈得上「分支」——pi fork 作用于当前打开的会话
  // 文件；非活动行/无落盘 user 消息 → 该项禁用）。
  const forkPoints = useStore(branchBridge, (s) => s.forkPoints);
  const ctx = useContext(SessionListContext);
  // dnd-kit 行绑定（SortableRowBridge 提供；搜索段 = null ⇒ 不可排、跨面照拖）。
  const sortable = useContext(SortableRowContext);
  // 行展示元数据（ThreadListSections 经 context 下发）——figures/时间戳/
  // 未读水位/导出路径从这里读，行组件不各自订阅 threadItems。
  const meta = ctx?.meta;
  const path = meta?.path;
  const messageCount = meta?.messageCount ?? 0;
  const aui = useAui();

  // 未读/归档态（客户端水位语义——hermes session-unread/archive 对偶）。
  const isArchived = useSessionArchive((s) => s.archived.includes(threadId));
  const isUnread = useSessionUnread((s) =>
    isRowUnread({ id: threadId, messageCount }, s.seen, s.markers),
  );

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
    // hermes read-state 项：未读 → 确认已读（水位 := 当前 count + 撤显式
    // 标记）；已读 → 显式标记未读（水位之外的第二未读源）。
    unread: () => {
      if (isUnread) {
        sessionUnreadStore.getState().ackSession(threadId, messageCount);
      } else {
        sessionUnreadStore.getState().markSessionUnread(threadId);
      }
    },
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
    export: () => {
      if (typeof path !== "string") {
        console.error(`[session] 会话 ${threadId} 缺少 path，无法导出`);
        return;
      }
      void exportSessionHtml({ sessionId: threadId, path, title }).catch((e) => {
        console.error("[session] 导出失败（HTML 未落盘）", e);
      });
    },
    archive: () => sessionArchiveStore.getState().toggleArchive(threadId),
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
        unread: isUnread,
        archived: isArchived,
      }),
    [isPinned, isActive, forkPoints, isUnread, isArchived],
  );

  // ── 行尾标注（hermes session-row figures 段照抄）：
  //    rowMeta 开关（时间/tokens/成本）共享一个右对齐槽，` · ` 连读；
  //    hermes「The last thing in the trailing slot hands its place to the
  //    ⋯ button on hover」——tail 元素 hover 隐没（min-w-5 = kebab 宽，
  //    布局不跳），kebab 转绝对定位压进该槽。age 显示时全部 figures 归
  //    head、tail = age；age 不显示时最后一项 figures 留在 tail。
  const rowMetaFlags = useSidebarView((s) => s.rowMeta);
  const usage = useSessionUsage((s) => (path ? s.rows[path] : undefined));
  // hermes：timestamp = last_active || started_at——lastActiveMs 缺失回退
  // 创建时刻（pi header.timestamp）。
  const inboxStyle = useSidebarView((s) => s.inboxStyle);
  const tsMs = meta?.lastActiveMs || meta?.createdMs || 0;
  const age =
    rowMetaFlags.includes("updated") && tsMs > 0 ? sessionRowAge(tsMs) : null;
  const absoluteAge =
    tsMs > 0 ? formatMessageTimestamp(new Date(tsMs), THREAD_TIME_LABELS) : "";
  const figures = buildSessionFigures(
    rowMetaFlags.filter((m): m is "tokens" => m === "tokens"),
    usage,
  );
  const figParts = figures ? figures.split(" · ") : [];
  const head = age ? figParts.join(" · ") : figParts.slice(0, -1).join(" · ");
  const tailText =
    age ?? (figParts.length > 0 ? figParts[figParts.length - 1]! : null);
  // Inbox style：第二行承载时间·消息数，行尾标注让位（hermes 卡片行）
  const hasTrailing = !inboxStyle && (head !== "" || tailText !== null);

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
            // read-state 项动态图标（hermes session-actions-menu identityItems
            // 第三项：unread → 'mail-read'，read → 'mail'——文案随状态、
            // 图标也随状态，是清单里唯一的一处）。
            const Icon =
              spec.id === "unread" && isUnread ? MailOpenIcon : ACTION_ICONS[spec.id];
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
            // read-state 项动态图标（同 renderDropdownItems）
            const Icon =
              spec.id === "unread" && isUnread ? MailOpenIcon : ACTION_ICONS[spec.id];
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
          ref={sortable?.ref}
          className={cn(
            "group/row hover:bg-(--hover-wash) data-active:bg-[color-mix(in_srgb,var(--fl-accent)_10%,transparent)] relative grid min-h-(--tl-row-min-h,1.625rem) grid-cols-[minmax(0,1fr)_auto] items-stretch rounded-md pr-2 transition-colors focus-visible:outline-none",
            // 拖起态逐字 hermes session-row.tsx:369——lifted 行盖过下层
            // （z-10 + 不透明侧栏表面，「translucency let the rows below
            // bleed through」的解法）+ grabbing 光标；压暗 0.45 由跨面
            // pointer 机器 engage 时内联施加（session-drag.ts 实锤值）。
            // hover:bg 也要同底色：拖起时指针必然悬在本行，基础的
            // hover:bg-(--hover-wash)（半透明）会压过 bg-(--surface) 让下层
            // 行渗出来（实测 computed bg rgba(0,0,0,.07)）——tailwind-merge
            // 取后者，dragging 期间 hover 也不透。
            sortable?.dragging && "z-10 cursor-grabbing bg-(--surface) hover:bg-(--surface)",
          )}
          data-slot="aui_thread-list-item"
          style={sortable?.style}
          onClickCapture={(e) => {
            // 修饰键手势解析（hermes resolveSessionRowClick）：⇧ = 置顶；
            // ⌥+⇧ = 归档（客户端归档——重审计 #6 落地）；纯点击 = 恢复会话
            // （Trigger 原生语义放行）。newTab / newWindow 数据面不适用
            // （主区单会话投影，重审计 #7），吞掉默认行为不误伤。
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
            } else if (action === "archive") {
              e.preventDefault();
              e.stopPropagation();
              sessionArchiveStore.getState().toggleArchive(threadId);
            } else if (action !== "resume") {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onPointerDown={(e) => {
            if (!ctx) return;
            // 双机器并行（hermes session-row.tsx:374-395 实锤）：同一
            // pointerdown 同时起「跨面 pointer 会话」与「dnd-kit 列表排序」，
            // 各管各的区域、互不仲裁——侧栏上只有排序有目标（pointer 机器
            // 拒绝区），主会话页签上只有 pointer 机器有目标。释放落在谁的
            // 合法区就谁提交。把手/⋯ 动作簇自带监听，行壳不重复起拖
            // （hermes :385 同款豁免选择器）。
            if ((e.target as HTMLElement).closest("[data-reorder-handle], [data-row-actions]")) return;
            startSessionRowDrag(e, {
              sessionId: threadId,
              title: title ?? "New Chat",
              onCommitMainTab: () => ctx.commitMainTab(threadId),
            });
            sortable?.dragHandleProps.onPointerDown?.(e);
          }}
        >
          <ThreadListItemPrimitive.Trigger
            className="flex h-full min-w-0 items-center gap-1.5 self-stretch rounded-md py-0.5 pr-2 pl-2 text-start outline-none"
            data-slot="aui_thread-list-item-trigger"
          >
            {/* lead：状态圆点，hover 与拖拽把手互换（hermes SidebarRowGrab）。
                未读 = 成功绿实心（hermes --ui-success，DOT_VARIANTS.unread）；
                归档行 = lead 位换归档字形（hermes：archived has no live
                status to paint——archive glyph takes the dot's slot）。
                sortable 行 = 把手（hermes chrome.tsx:324-364 SidebarRowGrab：
                完整 dragHandleProps——role/tabIndex+键盘/指针激活器只归把手，
                容器带键盘激活器会让 ⋯ 钮一聚焦就空格起拖、rename 对话框吞
                空格 #83617；行壳只转发 onPointerDown）。data-reorder-handle
                是行壳 onPointerDown 的豁免选择器。 */}
            <span
              {...(sortable?.dragHandleProps ?? {})}
              aria-hidden={sortable ? undefined : true}
              aria-label={sortable ? `拖动排序 ${title ?? "New Chat"}` : undefined}
              className={cn(
                "relative grid size-3.5 shrink-0 place-items-center overflow-hidden",
                sortable && "group/handle cursor-grab touch-none active:cursor-grabbing",
              )}
              data-reorder-handle={sortable ? "" : undefined}
              data-slot="aui_thread-list-item-lead"
              onClick={sortable ? (e) => e.stopPropagation() : undefined}
            >
              {isArchived ? (
                <ArchiveIcon className="text-(--text-4) size-3 transition-opacity group-hover/row:opacity-0" />
              ) : (
                <span
                  className={cn(
                    "rounded-full transition-opacity group-hover/row:opacity-0",
                    isRunning
                      ? "bg-(--fl-accent) size-1.5"
                      : isUnread
                        ? "bg-(--success) size-1.5"
                        : "bg-(--text-4) size-1",
                  )}
                  data-slot="aui_thread-list-item-running"
                />
              )}
              <GripVerticalIcon className="text-(--text-4) absolute size-3 opacity-0 transition group-hover/row:opacity-80" />
            </span>
            {isUnread && !isRunning && <span className="sr-only">已完成 — 未读</span>}
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
              {/* Inbox style（hermes 卡片行）：第二行 = 时间 · 消息数；
                  行尾标注让位（tail 不渲染）。 */}
              {inboxStyle && (
                <span
                  className="text-(--text-3) block truncate text-[0.6875rem] leading-[1.3]"
                  data-slot="aui_thread-list-item-inbox-line"
                >
                  {absoluteAge || "刚刚"}
                  {typeof messageCount === "number" ? ` · ${messageCount} 条消息` : ""}
                </span>
              )}
            </span>
            {isRunning && <span className="sr-only">会话运行中</span>}
          </ThreadListItemPrimitive.Trigger>
          {/* 行操作簇（hermes [data-row-actions]：拖拽豁免区。行尾标注
              （figures/age）占槽在先，kebab 转 absolute 压进槽尾——tail 元素
              hover 隐没让位，同 hermes session-row 的 TAIL_HIDES/KEBAB 机制） */}
          <div
            className="z-[2] relative flex shrink-0 items-center justify-end gap-1 self-stretch"
            data-row-actions=""
          >
            {hasTrailing && (
              <span className="text-(--text-3) pointer-events-none whitespace-nowrap text-[0.625rem] leading-none">
                {head ? (
                  <span>
                    {head}
                    {" · "}
                  </span>
                ) : null}
                <time
                  aria-label={age ? `${age}, ${absoluteAge}` : undefined}
                  className="inline-block min-w-5 text-right transition-opacity group-hover/row:opacity-0"
                  dateTime={age ? new Date(tsMs).toISOString() : undefined}
                  title={age ? absoluteAge : undefined}
                >
                  {tailText}
                </time>
              </span>
            )}
            <ThreadListItemMorePrimitive.Root sharedFocusGroup>
              <ThreadListItemMorePrimitive.Trigger asChild>
                <button
                  aria-label="会话操作"
                  className={cn(
                    "text-transparent group-hover/row:text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text) focus-visible:bg-(--hover-wash) focus-visible:text-(--text) data-[state=open]:bg-(--hover-wash) data-[state=open]:text-(--text) size-5 shrink-0 cursor-pointer rounded-[4px] p-0 transition-colors duration-100",
                    hasTrailing && "absolute right-0",
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
