"use client";
// beui.dev/components/motion/animated-sidebar —— **本地裁剪版**（2026-10-23）
//
// 上游是"页面级可收起侧栏"，本工程只要它的**菜单结构与动效**（设置弹窗
// 左导航）。用户口径（2026-10-23）："删除它的收起侧栏，删除快捷键之类的，
// 你看着删除结构负担和陷阱。其他的，左栏的选项，子选项，之类的所有全都保留。"
//
// ── 已删（弹窗场景下的结构负担与陷阱）─────────────────────────────
//   · AnimatedSidebarProvider —— 收起/展开状态机 + **Ctrl/⌘+B 全局快捷键
//     劫持**（`window.addEventListener("keydown")`，在弹窗里按 Ctrl+B 会
//     静默改掉一个看不见的侧栏状态，纯陷阱）
//   · AnimatedSidebar（`motion.aside` 宽度补间）/ Rail / Inset / Header /
//     Footer / Trigger / Close —— 页面级骨架与外壳控件
//   · MobileSidebar —— `createPortal` 抽屉 + **body 滚动锁**（position:
//     fixed + 复原 scrollY）+ 焦点陷阱 + `inert`。设置弹窗已有自己的遮罩、
//     Esc 分层（escape-layers）与焦点语义，再来一套会互相打架
//   · 折叠态分支（`panel.collapsed` 的 opacity/x 补间、icon-rail 语义、
//     `--sidebar-width-icon`）—— 弹窗左栏恒定展开，没有收起态
//   · `useIsMobile` / `useSyncExternalStore` / matchMedia 订阅 —— 随移动端
//     抽屉一起删
//
// ── 保留（逐字沿用上游类名与弹簧参数）────────────────────────────
//   AnimatedSidebarMenuProvider / Group / GroupLabel / GroupContent /
//   Menu / MenuItem / MenuButton / MenuSub / MenuSubItem / MenuSubButton
//   · 选中 pill：`layoutId` 共享布局投影，跨行**真滑动**（SPRING_LAYOUT）
//   · 悬停 pill：SharedLayoutBg 的 cloneElement 注入（每组一条独立 layoutId）
//   · 子选项展开：`clip-path: inset()` + `staggerChildren`，每项
//     `y:-6 / blur(3px)` 逐条进场；收起 `staggerDirection: -1` 反向退场
//   · 按压：`whileTap={{ scale: 0.98 }}` + SPRING_PRESS
//
// ── 与上游的唯一 API 差异（两处，均为设置页键盘导航所需）───────────
//   · MenuButton 增加 `sectionId` → 渲染 `data-section-id`（↑/↓ 环绕按 id 聚焦）
//   · MenuButton 增加 `tabIndex` → roving tabindex（只有选中节进 Tab 序列）
//   两者都是**可选**的；不传时行为与上游一致。

import { ChevronRight } from "lucide-react";
import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { SharedLayoutBg } from "@/components/motion/shared-layout-bg";
import { EASE_OUT, SLIDE_EASE_CSS, SPRING_LAYOUT, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";

/** 子选项面板的进出场（上游 SUBMENU_TRANSITION 原值）。 */
const SUBMENU_TRANSITION = {
  duration: 0.18,
  ease: EASE_OUT,
} as const;

/**
 * 子选项面板：`clip-path` 从上往下揭开（`round 8px` 让边缘在动画中不露直角），
 * 行级 stagger 由父变体的 `staggerChildren` 驱动——展开 0.045s/行、收起
 * 0.025s/行且**反向**（最后一行先走），上游原值。
 */
const SUBMENU_VARIANTS: Variants = {
  closed: {
    opacity: 0,
    clipPath: "inset(0 0 100% 0 round 8px)",
    transition: {
      duration: 0.14,
      ease: EASE_OUT,
      staggerChildren: 0.025,
      staggerDirection: -1,
    },
  },
  open: {
    opacity: 1,
    clipPath: "inset(0 0 0% 0 round 8px)",
    transition: {
      duration: 0.2,
      delayChildren: 0.035,
      ease: EASE_OUT,
      staggerChildren: 0.045,
    },
  },
};

/** 子选项行：从上方 -6px 带模糊落下（上游原值）。 */
const SUBMENU_ITEM_VARIANTS: Variants = {
  closed: {
    opacity: 0,
    y: -6,
    filter: "blur(3px)",
  },
  open: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: SUBMENU_TRANSITION,
  },
};

/** `prefers-reduced-motion` 下的统一降级时长（上游原值）。 */
const REDUCED_TRANSITION = {
  duration: 0.16,
  ease: EASE_OUT,
} as const;

/**
 * 菜单上下文：上游由 `AnimatedSidebarProvider` 一并提供 open/collapsed/
 * 移动端开关，这里只剩动效需要的两项——
 *   · `layoutId`：所有 MenuButton 共享，选中 pill 才能跨行/跨组滑动；
 *   · `reduce`：`prefers-reduced-motion`。
 */
interface AnimatedSidebarMenuContextValue {
  layoutId: string;
  reduce: boolean;
}

const AnimatedSidebarMenuContext =
  createContext<AnimatedSidebarMenuContextValue | null>(null);

function useAnimatedSidebarMenu(): AnimatedSidebarMenuContextValue {
  const context = useContext(AnimatedSidebarMenuContext);
  if (!context) {
    throw new Error(
      "AnimatedSidebarMenu* must be used inside AnimatedSidebarMenuProvider.",
    );
  }
  return context;
}

export interface AnimatedSidebarMenuProviderProps {
  children: ReactNode;
}

/**
 * 替代上游 `AnimatedSidebarProvider` 的最小上下文（只给动效，不给状态机）。
 *
 * **一个 provider 包住整个导航**：`layoutId` 必须跨组共享，否则选中项从
 * "基础设置"跳到"关于"时 pill 会重新出生而不是滑过去。
 */
export function AnimatedSidebarMenuProvider({
  children,
}: AnimatedSidebarMenuProviderProps) {
  const generatedId = useId();
  const reduce = useReducedMotion() ?? false;

  return (
    <AnimatedSidebarMenuContext.Provider
      value={{ layoutId: `${generatedId}-active`, reduce }}
    >
      {children}
    </AnimatedSidebarMenuContext.Provider>
  );
}

export const AnimatedSidebarGroup = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function AnimatedSidebarGroup({ className, ...props }, forwardedRef) {
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-slot="sidebar-group"
      className={cn("flex w-full min-w-0 flex-col px-1 py-1.5", className)}
    />
  );
});

export const AnimatedSidebarGroupLabel = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function AnimatedSidebarGroupLabel(
  { children, className, ...props },
  forwardedRef,
) {
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-slot="sidebar-group-label"
      className={cn(
        "mb-1 h-7 overflow-hidden px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
});

export const AnimatedSidebarGroupContent = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function AnimatedSidebarGroupContent(
  { className, ...props },
  forwardedRef,
) {
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-slot="sidebar-group-content"
      className={cn("w-full min-w-0", className)}
    />
  );
});

/**
 * 一组菜单项。**每组一个**（上游同构）——悬停 pill 的 `layoutId` 由
 * SharedLayoutBg 内部 `useId` 生成，天然按组隔离；选中 pill 则走外层
 * provider 的共享 `layoutId`，跨组滑动。
 *
 * `sharedHover={false}`（设置页左栏，2026-11-23 用户："子项没有滑动效果"）：
 * 不注入 SharedLayoutBg 的**每组一份**悬停 pill，改由导航容器层的
 * `AnimatedSidebarHoverPill` 统一承担——这样组头与子项（子项在父项 li
 * 内部，SharedLayoutBg 的 clone 注入够不到）能共用同一条滑动块。
 */
export interface AnimatedSidebarMenuProps
  extends HTMLAttributes<HTMLUListElement> {
  /** true = 上游语义（每组一条 SharedLayoutBg 悬停 pill）。 */
  sharedHover?: boolean;
}

export const AnimatedSidebarMenu = forwardRef<
  HTMLUListElement,
  AnimatedSidebarMenuProps
>(function AnimatedSidebarMenu(
  { children, className, sharedHover = true, ...props },
  forwardedRef,
) {
  const menuClassName = cn(
    "flex w-full min-w-0 list-none flex-col gap-0.5",
    className,
  );

  if (!sharedHover) {
    // 仍用 motion.ul + layoutRoot：子项的 layout="position" 补间需要同一
    // 个布局坐标系，否则滚动过的导航里换项会带着滚动偏移"发飘"。
    return (
      <motion.ul
        {...(props as HTMLMotionProps<"ul">)}
        ref={forwardedRef}
        layoutRoot
        data-slot="sidebar-menu"
        className={menuClassName}
      >
        {children}
      </motion.ul>
    );
  }

  return (
    <SharedLayoutBg
      {...props}
      ref={forwardedRef as React.Ref<HTMLElement>}
      as="ul"
      inset={0}
      /* 悬停 pill = `--hover-wash` 令牌（2026-10-23 用户："不要做好几种
         样式，只要一种，全部从令牌中调用"）。上游写的是 `bg-muted/70`
         （shadcn 令牌），在本工程会与选中态撞色，故改为 mirach 令牌。 */
      pillClassName="rounded-xl bg-[var(--hover-wash)]"
      pillContainerClassName="inset-y-auto top-0 h-9"
      data-slot="sidebar-menu"
      className={menuClassName}
    >
      {children}
    </SharedLayoutBg>
  );
});

/**
 * 导航容器层的跨组滑动悬停块（设置页左栏专用，2026-11-23）。
 *
 * 与 `SharedLayoutBg` 的悬停 pill 的差别：后者挂在每个 `<ul>` 上、只认
 * 直接子项；设置页的「可展开组头」的 li 里还嵌着子项列表，子项永远拿不到
 * 滑动块（用户："设置页的选项不能折叠，子项没有滑动效果"）。本组件挂在
 * `nav` 滚动容器上，按 `[data-sidebar-row]` 现测矩形——组头、子项、跨组
 * 移动共用同一条 pill。
 *
 * 坐标系同 `SessionListHoverPill`：abs 子元素随内容滚动，top 要加
 * `scrollTop`；行宽/行高现测（组头 36px、子项 ~22px）。
 * **纯视觉层**：不动点击/键盘；键盘 focusin 也驱动（a11y 不回退）。
 */
export function AnimatedSidebarHoverPill() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 36,
    visible: false,
  });
  const shownRef = useRef(false);
  const [sliding, setSliding] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    const root = el?.parentElement ?? null;
    if (!root) return;

    const hide = () => {
      rowRef.current = null;
      shownRef.current = false;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };

    /** 组标题/空态上的暂停：只淡出，不清 shownRef——跨组移动仍走滑动过渡。 */
    const suspend = () => {
      rowRef.current = null;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };

    const place = (row: HTMLElement) => {
      rowRef.current = row;
      const rootRect = root.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const next = {
        top: Math.round(rowRect.top - rootRect.top + root.scrollTop),
        left: Math.round(rowRect.left - rootRect.left),
        width: Math.round(rowRect.width),
        height: Math.round(rowRect.height),
        visible: true,
      };
      setState((s) =>
        s.visible &&
        s.top === next.top &&
        s.left === next.left &&
        s.width === next.width &&
        s.height === next.height
          ? s
          : next,
      );
      setSliding(shownRef.current);
      shownRef.current = true;
    };

    const hideIfDetached = () => {
      const row = rowRef.current;
      if (row === null) return;
      if (!root.contains(row)) hide();
    };

    const handleTarget = (target: HTMLElement | null) => {
      const row = target?.closest(
        "[data-sidebar-row]",
      ) as HTMLElement | null;
      if (row !== null && root.contains(row)) {
        place(row);
        return;
      }
      // 组标题/空态行不是选项面：淡出（不能把上一项的 pill 留在组头上），
      // 但保留 shownRef——跨组到下一项时仍要滑动，而不是重新淡入。
      if (target?.closest("[data-slot='sidebar-group-label'], .set-nav-empty")) {
        suspend();
        return;
      }
      hideIfDetached();
    };

    const onOver = (e: Event) => {
      const pe = e as PointerEvent;
      pointerRef.current = { x: pe.clientX, y: pe.clientY };
      handleTarget(e.target as HTMLElement | null);
    };
    const onMove = (e: Event) => {
      const pe = e as PointerEvent;
      pointerRef.current = { x: pe.clientX, y: pe.clientY };
    };
    const onLeave = () => hide();
    const onFocusIn = (e: Event) => {
      handleTarget(e.target as HTMLElement | null);
    };
    let blurTimer = 0;
    const onFocusOut = () => {
      // 焦点移到导航外才收；行间 Tab 会紧接着发 focusin 重新定位。
      blurTimer = window.setTimeout(() => {
        if (!root.contains(document.activeElement)) hide();
      }, 0);
    };

    let raf = 0;
    const resync = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const row = rowRef.current;
        if (row === null) return;
        if (!root.contains(row)) {
          hide();
          return;
        }
        place(row);
      });
    };
    const observer = new MutationObserver(resync);
    observer.observe(root, { childList: true, subtree: true });

    // 滚动重测独立排帧：不能和 resync 共用一个 raf（DOM 变更的 rAF 在
    // 途时若直接 return，滚轮只会发一次 scroll 事件，pill 就停在已滚出
    // 视口的旧行上——2026-11-23 实机踩中）。
    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf !== 0 || pointerRef.current === null) return;
      const { x, y } = pointerRef.current;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (hit === null || !root.contains(hit)) return;
        const row = hit.closest("[data-sidebar-row]") as HTMLElement | null;
        // 滚动后指针可能落在行间隙/组标题/子菜单的 padding 上：此时旧行
        // 可能已滚出视口，必须收起，不能按"间隙不动作"留在旧坐标。
        if (row === null || !root.contains(row)) {
          hide();
          return;
        }
        place(row);
      });
    };

    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
      if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf);
      if (blurTimer !== 0) window.clearTimeout(blurTimer);
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="set-nav-hover-pill"
      style={{
        top: state.top,
        left: state.left,
        width: state.width,
        height: state.height,
        opacity: state.visible ? 1 : 0,
        transition: sliding
          ? `top 260ms ${SLIDE_EASE_CSS}, left 200ms ${SLIDE_EASE_CSS}, width 200ms ${SLIDE_EASE_CSS}, height 200ms ${SLIDE_EASE_CSS}, opacity 120ms ${SLIDE_EASE_CSS}`
          : `opacity 120ms ${SLIDE_EASE_CSS}`,
      }}
    />
  );
}

export const AnimatedSidebarMenuItem = forwardRef<
  HTMLLIElement,
  HTMLMotionProps<"li">
>(function AnimatedSidebarMenuItem({ className, ...props }, forwardedRef) {
  return (
    <motion.li
      {...props}
      ref={forwardedRef}
      layout="position"
      transition={SPRING_LAYOUT}
      data-slot="sidebar-menu-item"
      className={cn("relative", className)}
    />
  );
});

export interface AnimatedSidebarMenuSubProps
  extends Omit<HTMLMotionProps<"ul">, "children"> {
  open: boolean;
  children?: ReactNode;
}

/** 子选项面板（二级项容器）：左侧竖线 + 缩进，clip-path 揭开 + 逐行 stagger。 */
export const AnimatedSidebarMenuSub = forwardRef<
  HTMLUListElement,
  AnimatedSidebarMenuSubProps
>(function AnimatedSidebarMenuSub(
  { open, children, className, ...props },
  forwardedRef,
) {
  const context = useAnimatedSidebarMenu();

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {open ? (
        <motion.ul
          {...props}
          ref={forwardedRef}
          key="sidebar-submenu"
          variants={context.reduce ? undefined : SUBMENU_VARIANTS}
          initial={context.reduce ? false : "closed"}
          animate={context.reduce ? { opacity: 1 } : "open"}
          exit={context.reduce ? { opacity: 0 } : "closed"}
          transition={context.reduce ? { duration: 0.12 } : undefined}
          data-slot="sidebar-menu-sub"
          className={cn(
            "relative mt-1 ml-5 flex min-w-0 flex-col gap-0.5 border-border border-l pl-3",
            className,
          )}
        >
          {children}
        </motion.ul>
      ) : null}
    </AnimatePresence>
  );
});

export const AnimatedSidebarMenuSubItem = forwardRef<
  HTMLLIElement,
  HTMLMotionProps<"li">
>(function AnimatedSidebarMenuSubItem(
  { className, ...props },
  forwardedRef,
) {
  return (
    <motion.li
      {...props}
      ref={forwardedRef}
      variants={SUBMENU_ITEM_VARIANTS}
      data-slot="sidebar-menu-sub-item"
      className={cn("relative min-w-0", className)}
    />
  );
});

export interface AnimatedSidebarMenuSubButtonProps {
  children: ReactNode;
  icon?: ReactNode;
  href?: string;
  isActive?: boolean;
  disabled?: boolean;
  target?: "_blank" | "_self" | "_parent" | "_top";
  rel?: string;
  onSelect?: () => void;
  className?: string;
}

export function AnimatedSidebarMenuSubButton({
  children,
  icon,
  href,
  isActive = false,
  disabled = false,
  target,
  rel,
  onSelect,
  className,
}: AnimatedSidebarMenuSubButtonProps) {
  const context = useAnimatedSidebarMenu();

  const select = (
    event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onSelect?.();
  };

  const content = (
    <>
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center"
      >
        {icon ?? <span className="size-1 rounded-full bg-current" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  );

  const interactiveClassName = cn(
    "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs outline-none",
    "text-muted-foreground transition-colors hover:bg-(--hover-wash) hover:text-foreground",
    "focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
    isActive && "bg-muted/70 text-foreground",
    disabled && "cursor-not-allowed opacity-40",
    className,
  );

  return href ? (
    <motion.a
      href={href}
      target={target}
      rel={rel ?? (target === "_blank" ? "noreferrer noopener" : undefined)}
      aria-current={isActive ? "page" : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      onClick={select}
      whileTap={context.reduce || disabled ? undefined : { scale: 0.98 }}
      transition={SPRING_PRESS}
      className={interactiveClassName}
    >
      {content}
    </motion.a>
  ) : (
    <motion.button
      type="button"
      disabled={disabled}
      aria-current={isActive ? "page" : undefined}
      aria-disabled={disabled || undefined}
      onClick={select}
      whileTap={context.reduce || disabled ? undefined : { scale: 0.98 }}
      transition={SPRING_PRESS}
      className={interactiveClassName}
    >
      {content}
    </motion.button>
  );
}

export interface AnimatedSidebarMenuButtonProps {
  children: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  href?: string;
  isActive?: boolean;
  ariaExpanded?: boolean;
  disabled?: boolean;
  target?: "_blank" | "_self" | "_parent" | "_top";
  rel?: string;
  onSelect?: () => void;
  className?: string;
  /** 本地扩展：设置页 ↑/↓ 环绕按节 id 聚焦（渲染 `data-section-id`）。 */
  sectionId?: string;
  /** 本地扩展：roving tabindex（只有选中节进 Tab 序列）。 */
  tabIndex?: number;
  /** 本地扩展：外部滑动悬停块的行标记（`AnimatedSidebarHoverPill` 认）。 */
  sidebarRow?: boolean;
}

export function AnimatedSidebarMenuButton({
  children,
  icon,
  badge,
  href,
  isActive = false,
  ariaExpanded,
  disabled = false,
  target,
  rel,
  onSelect,
  className,
  sectionId,
  tabIndex,
  sidebarRow = false,
}: AnimatedSidebarMenuButtonProps) {
  const context = useAnimatedSidebarMenu();
  const textLabel = typeof children === "string" ? children : undefined;

  const select = (
    event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onSelect?.();
  };

  const content = (
    <>
      {/* 选中 pill：layoutId 共享布局投影 → 换节时跨行滑过去而不是闪现。
          底色 = `--select-wash` 令牌（2026-10-23 统一口径：全工程列表选中
          只认这一个令牌，见 tokens.css 该段）。上游的 `bg-muted` 是 shadcn
          令牌，与悬停 pill 只差 1.2% 亮度，"当前在哪一节"看不出来。 */}
      {isActive ? (
        <motion.span
          layoutId={context.layoutId}
          transition={context.reduce ? { duration: 0 } : SPRING_LAYOUT}
          className="absolute inset-0 rounded-xl bg-[var(--select-wash)]"
        />
      ) : null}
      {icon ? (
        <span
          aria-hidden="true"
          className="relative z-10 grid size-5 shrink-0 place-items-center"
        >
          {icon}
        </span>
      ) : null}
      <span className="relative z-10 min-w-0 flex-1 truncate">{children}</span>
      {badge ? (
        <span className="relative z-10 shrink-0 text-xs text-muted-foreground">
          {badge}
        </span>
      ) : null}
      {ariaExpanded !== undefined ? (
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ rotate: ariaExpanded ? 90 : 0 }}
          transition={context.reduce ? { duration: 0 } : SPRING_LAYOUT}
          className="relative z-10 grid size-4 shrink-0 place-items-center text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </motion.span>
      ) : null}
    </>
  );

  const interactiveClassName = cn(
    "relative flex min-h-9 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-xl px-3 text-left text-sm font-medium outline-none",
    "text-muted-foreground transition-colors hover:text-foreground",
    "focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
    isActive && "text-foreground",
    disabled && "cursor-not-allowed opacity-40",
    className,
  );

  const shared = {
    "aria-current": isActive ? ("page" as const) : undefined,
    "aria-expanded": ariaExpanded,
    "aria-label": textLabel,
    "data-section-id": sectionId,
    "data-sidebar-row": sidebarRow ? "" : undefined,
    tabIndex: disabled ? -1 : tabIndex,
  };

  return href ? (
    <motion.a
      href={href}
      target={target}
      rel={rel ?? (target === "_blank" ? "noreferrer noopener" : undefined)}
      aria-disabled={disabled || undefined}
      onClick={select}
      whileTap={context.reduce || disabled ? undefined : { scale: 0.98 }}
      transition={SPRING_PRESS}
      className={interactiveClassName}
      {...shared}
    >
      {content}
    </motion.a>
  ) : (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={select}
      whileTap={context.reduce || disabled ? undefined : { scale: 0.98 }}
      transition={SPRING_PRESS}
      className={interactiveClassName}
      {...shared}
    >
      {content}
    </motion.button>
  );
}
