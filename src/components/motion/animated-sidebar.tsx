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
  useId,
} from "react";
import { SharedLayoutBg } from "@/components/motion/shared-layout-bg";
import { EASE_OUT, SPRING_LAYOUT, SPRING_PRESS } from "@/lib/ease";
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
 */
export const AnimatedSidebarMenu = forwardRef<
  HTMLUListElement,
  HTMLAttributes<HTMLUListElement>
>(function AnimatedSidebarMenu(
  { children, className, ...props },
  forwardedRef,
) {
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
      className={cn("flex w-full min-w-0 list-none flex-col gap-0.5", className)}
    >
      {children}
    </SharedLayoutBg>
  );
});

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
    "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
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
