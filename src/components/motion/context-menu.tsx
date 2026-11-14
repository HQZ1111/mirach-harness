"use client";
// beui.dev/components/motion/context-menu

import { Check } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
} from "motion/react";
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  buildGooGeometry,
  GooSurface,
} from "@/components/motion/goo-layer";
import {
  EASE_OUT,
  POPOVER_GOO,
  POPOVER_GOO_CLOSE,
  POPOVER_GOO_OPEN,
  SPRING_LAYOUT,
  SPRING_PANEL,
} from "@/lib/ease";
import { holdSelection, TOUCH_GESTURE_CONTENT_CLASS } from "@/lib/touch";
import { cn } from "@/lib/utils";

type OpenModality = "pointer" | "keyboard" | "touch";
type MenuPoint = { x: number; y: number };

const VIEWPORT_PADDING = 8;
const LONG_PRESS_DELAY = 520;
const LONG_PRESS_TOLERANCE = 10;
// 原 clip-path 展开的时长常量已删除：进出场改由 tokens.css 的
// --beui-spring-goo-open/close 驱动（与模型选择器同一套 goo 动效）。

/**
 * 菜单从哪里长出来。
 *
 * - `point`：右键落点（0×0 锚点）。上游 beui 的唯一形态。
 * - `trigger`：触发钮矩形。**本地扩展**（2026-10-26 归拢）：侧栏选项、会话行
 *   ⋯、标签条 + 都是"按钮下面挂菜单"，与右键共用同一套 goo 动效，只是锚点
 *   从"一个点"换成"一颗按钮"——观感与模型选择器（beui Popover）一致。
 */
type MenuAnchor = "point" | "trigger";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

type TriggerElementProps = React.HTMLAttributes<HTMLElement> & {
  ref?: Ref<HTMLElement>;
};

interface ContextMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openAt: (point: MenuPoint, modality: OpenModality) => void;
  point: MenuPoint;
  modality: OpenModality;
  invocation: number;
  menuId: string;
  /** 祖先菜单 id 链（子菜单用）：外部点击判定要知道"这个 portal 是我的后代"。 */
  ancestorIds: string[];
  /** 子菜单打开时推进（不经过右键，靠 SubTrigger 的 hover/click 触发）。 */
  openTriggered: () => void;
  anchor: MenuAnchor;
  side: Side;
  align: Align;
  sideOffset: number;
  panelRadius: number;
  gooStrength: number;
  /** 是否做液滴粘性合并（见 `GooSurfaceProps.goo`）。 */
  goo: boolean;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  /**
   * 触发钮的视口矩形（anchor='trigger' 时有效）。
   *
   * 每次开菜单时重新量一次并写进 state —— 布局可能已经变了（侧栏滚动、
   * 窗口 resize），用 ref 读会让几何停在旧值。`trigger` 形态下这个矩形就是
   * goo 的锚点。
   */
  triggerRect: { left: number; top: number; width: number; height: number };
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  reduce: boolean;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

function useContextMenuContext(component: string) {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error(`${component} must be used within <ContextMenu>`);
  }
  return context;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

function getEnabledItems(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-context-menu-item="true"]:not([data-disabled="true"])',
    ),
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export interface ContextMenuProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /**
   * 受控落点（本地扩展，2026-10-26）：宿主自己管理"在哪儿弹"时用。
   *
   * 上游 beui 的落点只由 `ContextMenuTrigger` 的右键/long-press 计算
   * （`openAt`）；本项目的全局右键菜单是**store 驱动**的（main.tsx 的
   * capture 监听解析落点后写进 store），没有 Trigger 元素可挂。
   * 传了这个 prop 就以它为准，与 `open` 配合使用。
   */
  point?: { x: number; y: number };
  /**
   * 锚点形态（本地扩展，2026-10-26 归拢）：`trigger` = 面板从触发钮长出
   * （按钮下挂菜单，与 beui Popover 同一观感）；默认 `point` = 从右键落点长出。
   *
   * 用 `trigger` 时必须由 `ContextMenuTrigger` 包住触发元素（它负责把元素
   * 注册进 `triggerRef` 并接管 click 开合）。
   */
  anchor?: MenuAnchor;
  /** 面板落在锚点的哪一侧。默认 bottom。 */
  side?: Side;
  /** 沿锚点边的对齐。默认 start。 */
  align?: Align;
  /** 锚点与面板之间的间隙（= goo 脖子的长度）。默认 6。 */
  sideOffset?: number;
  /** 面板圆角。默认 12。 */
  panelRadius?: number;
  /** goo 滤镜的模糊半径，越大越"熔"。默认 8。 */
  gooStrength?: number;
  /**
   * 是否做液滴粘性合并。
   *
   * **默认值 = 令牌 `--beui-popover-goo`（ease.ts 的 POPOVER_GOO）**，调用点
   * 不该传这个 prop（2026-11-01 用户："调用点没传，直接在令牌中统一开关
   * 不行吗"）——一个令牌管全部，改观感只改 tokens.css。
   *
   * 关掉时菜单是独立的圆角矩形 + 投影，触发钮与菜单之间没有脖子，
   * 按钮也不被投影。
   */
  goo?: boolean;
  /** 祖先菜单 id 链（子菜单内部用，宿主不必传）。 */
  ancestorIds?: string[];
  /**
   * 外部锚点元素（本地扩展，2026-10-26）：`anchor='trigger'` 时用这个元素
   * 当锚点，而不是等 `ContextMenuTrigger` 注册。
   *
   * 子菜单就是这种形态——它的"触发元素"是父菜单里的一行，不在自己的
   * 子树里，没法用 `ContextMenuTrigger` 包。
   */
  anchorEl?: HTMLElement | null;
}

export function ContextMenu({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  point: controlledPoint,
  anchor = "point",
  side = "bottom",
  align = "start",
  sideOffset = 6,
  panelRadius = 12,
  gooStrength = 8,
  goo = POPOVER_GOO,
  ancestorIds = [],
  anchorEl = null,
}: ContextMenuProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [point, setPoint] = useState<MenuPoint>({ x: 0, y: 0 });
  const [modality, setModality] = useState<OpenModality>("pointer");
  const [invocation, setInvocation] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [triggerRect, setTriggerRect] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const menuId = useId();
  const reduce = useReducedMotion() ?? false;

  // 受控落点：外部给的坐标优先（见 point prop 注释）。同时把 invocation
  // 推进一格，让 Content 的 useLayoutEffect 重新测量/重放 morph——
  // 否则同一个菜单在第二次右键时不会重新定位。
  const lastControlledPoint = useRef<string>("");
  useEffect(() => {
    if (!controlledPoint) return;
    const key = `${controlledPoint.x},${controlledPoint.y}`;
    if (lastControlledPoint.current === key) return;
    lastControlledPoint.current = key;
    setPoint(controlledPoint);
    setInvocation((current) => current + 1);
  }, [controlledPoint]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
      if (!next) setActiveId(null);
    },
    [controlled, onOpenChange],
  );

  const openAt = useCallback(
    (nextPoint: MenuPoint, nextModality: OpenModality) => {
      setPoint(nextPoint);
      setModality(nextModality);
      setInvocation((current) => current + 1);
      setActiveId(null);
      setOpen(true);
    },
    [setOpen],
  );

  // 子菜单自己开合时同样推进 invocation（否则几何不重算）。
  const openTriggered = useCallback(() => {
    setModality("pointer");
    setInvocation((current) => current + 1);
    setActiveId(null);
  }, []);

  // 触发钮矩形：每次打开都重量一次（布局可能已变——侧栏滚动、窗口 resize）。
  // `anchorEl`（子菜单用）优先于 `triggerRef`（ContextMenuTrigger 注册的）。
  useLayoutEffect(() => {
    if (!open || anchor !== "trigger") return;
    const node = anchorEl ?? triggerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setTriggerRect({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [open, anchor, invocation, anchorEl]);

  // 外部点击 / Escape / 窗口变化 → 关。
  //
  // **受控打开要跳过"打开它的那一下"**（2026-10-26 实测）：上游的 open 由
  // Trigger 的 contextmenu 事件驱动，事件早已结束；本项目是 store 驱动——
  // `open` 在 `pointerdown`（右键按下）的同一次事件流里变 true，effect 立刻
  // 注册监听，紧接着的 `pointerup`/`pointerdown` 就被判成"外部点击"→ 菜单
  // 刚开就关（实测：DOM 里 role=menu 存在但 visibility:hidden）。
  //
  // 用 `setTimeout(0)` 把注册推迟到当前事件循环之后，等价于"下一次交互才算
  // 外部点击"。清理时 clearTimeout 防泄漏。
  //
  // **子菜单的 portal 不算外部**：子菜单是兄弟 portal，不在 contentRef 里，
  // 不排除会把"点进子菜单"判成外部点击（侧栏菜单三层结构会立刻全关）。
  const ancestorKey = ancestorIds.join("|");
  useEffect(() => {
    if (!open) return;
    const owned = new Set([menuId, ...ancestorKey.split("|").filter(Boolean)]);
    let cleanup: (() => void) | undefined;
    const timer = setTimeout(() => {
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Element | null;
        if (!target) return;
        if (contentRef.current?.contains(target)) return;
        // **触发钮本身 = 内部**（2026-11-01 修「侧栏选项点不回去」）。
        //
        // 缺这一条时：点触发钮 → 本捕获监听先 `setOpen(false)` → 紧接着
        // 按钮的 onClick 看到 `open === false` 走 else 分支 `setOpen(true)`
        // → 净效果"开了关不掉"（实测：连点两次 data-state 恒为 open）。
        //
        // 触发钮的 toggle 语义归 Trigger 自己的 onClick（:404 那段），
        // 外部点击判定不该插手——否则同一次手势里两个写入者互相打架。
        if (triggerRef.current?.contains(target)) return;
        if (anchorEl?.contains(target)) return;
        // 点在任何一个祖先菜单或本菜单的 portal 里 = 内部
        for (const id of owned) {
          if (target.closest(`[data-menu-portal="${id}"]`)) return;
        }
        setOpen(false);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpen(false);
      };
      const onWindowChange = () => setOpen(false);

      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onWindowChange);
      window.addEventListener("scroll", onWindowChange, true);
      cleanup = () => {
        window.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onWindowChange);
        window.removeEventListener("scroll", onWindowChange, true);
      };
    }, 0);

    return () => {
      clearTimeout(timer);
      cleanup?.();
    };
    // triggerRef 是 ref（稳定），anchorEl 是 state（可能变）——都进依赖，
    // 否则切换锚点后外部点击判定还指着旧节点。
  }, [open, setOpen, menuId, ancestorKey, anchorEl]);

  const value = useMemo<ContextMenuContextValue>(
    () => ({
      open,
      setOpen,
      openAt,
      openTriggered,
      point,
      modality,
      invocation,
      menuId,
      ancestorIds,
      anchor,
      side,
      align,
      sideOffset,
      panelRadius,
      gooStrength,
      goo,
      triggerRef,
      contentRef,
      triggerRect,
      activeId,
      setActiveId,
      reduce,
    }),
    [
      open,
      setOpen,
      openAt,
      openTriggered,
      point,
      modality,
      invocation,
      menuId,
      ancestorIds,
      anchor,
      side,
      align,
      sideOffset,
      panelRadius,
      gooStrength,
      goo,
      triggerRect,
      activeId,
      reduce,
    ],
  );

  return (
    <ContextMenuContext.Provider value={value}>
      <div className={cn("contents", className)}>{children}</div>
    </ContextMenuContext.Provider>
  );
}

export interface ContextMenuTriggerProps {
  children: ReactElement<TriggerElementProps>;
  disabled?: boolean;
  className?: string;
}

/**
 * 锚点登记器（本地扩展，2026-10-26）：把触发元素登记为 goo 锚点 + 接管
 * 左键开合。
 *
 * 为什么需要它：`ContextMenuTrigger` 靠 `cloneElement` 往子元素上挂
 * onClick/ref，外面再包一层 Tooltip（也是 cloneElement 链）时 ref 与
 * onClick 的合并顺序会打架。用 `ContextMenuAnchor` 包住按钮，通过 context
 * 直接登记，不参与克隆链。
 *
 * **必须 forwardRef**：Tooltip 是 `asChild` 克隆链（`TooltipTrigger` 给子元素
 * 塞 ref 来挂悬停监听）。`ContextMenuAnchor` 不是 DOM 元素，不转发 ref 的
 * 话 Tooltip 拿不到锚点 → 实测 12 条 `TooltipTrigger: the child did not
 * attach a ref` 警告、所有图标钮的悬停提示全失效。
 */
export const ContextMenuAnchor = forwardRef<
  HTMLElement,
  { children: ReactElement<TriggerElementProps>; disabled?: boolean }
>(function ContextMenuAnchor({ children, disabled = false }, forwardedRef) {
  const context = useContextMenuContext("ContextMenuAnchor");
  const childRef = children.props.ref;

  const onClick = (event: ReactMouseEvent<HTMLElement>) => {
    children.props.onClick?.(event);
    if (event.defaultPrevented || disabled) return;
    if (context.anchor !== "trigger") return;
    if (context.open) context.setOpen(false);
    else {
      context.openTriggered();
      context.setOpen(true);
    }
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    children.props.onContextMenu?.(event);
    if (event.defaultPrevented || disabled) return;
    event.preventDefault();
    context.openAt({ x: event.clientX, y: event.clientY }, "pointer");
  };

  return cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      context.triggerRef.current = node;
      assignRef(childRef, node);
      assignRef(forwardedRef, node);
    },
    "aria-controls": context.open ? context.menuId : undefined,
    "aria-haspopup": "menu",
    "aria-expanded": context.open,
    "data-state": context.open ? "open" : "closed",
    onClick,
    onContextMenu,
  } as TriggerElementProps);
});

export function ContextMenuTrigger({
  children,
  disabled = false,
  className,
}: ContextMenuTriggerProps) {
  const context = useContextMenuContext("ContextMenuTrigger");
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchOrigin = useRef<MenuPoint | null>(null);
  const releaseSelection = useRef<(() => void) | null>(null);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchOrigin.current = null;
  }, []);

  // Held for the whole press, not just the timer: a gesture that turned into a
  // drag must not paint a selection under the finger either.
  const endPress = useCallback(() => {
    cancelLongPress();
    releaseSelection.current?.();
    releaseSelection.current = null;
  }, [cancelLongPress]);

  useEffect(() => endPress, [endPress]);

  if (!isValidElement(children)) {
    throw new Error("<ContextMenuTrigger> requires a single React element");
  }

  const childProps = children.props;
  const childRef = children.props.ref;

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    childProps.onPointerDown?.(event);
    // A pen presses the same way a finger does and gets no `contextmenu` out
    // of the platform for it, so it holds to open too. A mouse has the right
    // button and is left to `onContextMenu`.
    const pressToOpen =
      event.pointerType === "touch" || event.pointerType === "pen";
    if (event.defaultPrevented || disabled || !pressToOpen) return;

    // `pointer-coarse:select-none` misses this press on a laptop whose mouse
    // is the primary pointer and whose touchscreen is not, and the platform's
    // own long-press selection then claims the gesture and cancels ours. The
    // press is the only thing that knows which input is on the glass, so it
    // takes selection away itself — for its own duration, and no longer.
    releaseSelection.current?.();
    releaseSelection.current = holdSelection(event.currentTarget);

    const origin = { x: event.clientX, y: event.clientY };
    touchOrigin.current = origin;
    longPressTimer.current = setTimeout(() => {
      context.openAt(origin, "touch");
      longPressTimer.current = null;
      touchOrigin.current = null;
    }, LONG_PRESS_DELAY);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    childProps.onPointerMove?.(event);
    const origin = touchOrigin.current;
    if (
      origin &&
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
        LONG_PRESS_TOLERANCE
    ) {
      cancelLongPress();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    childProps.onKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
      return;

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    context.openAt(
      { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 },
      "keyboard",
    );
  };

  // 锚点式（anchor='trigger'）：左键点开、再点关。右键仍走 openAt（落点式
  // 的语义不变——触发钮上右击也从落点弹出，与其它表面一致）。
  const onClick = (event: ReactMouseEvent<HTMLElement>) => {
    childProps.onClick?.(event);
    if (context.anchor !== "trigger") return;
    if (event.defaultPrevented || disabled) return;
    if (context.open) context.setOpen(false);
    else {
      context.openTriggered();
      context.setOpen(true);
    }
  };

  return cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      context.triggerRef.current = node;
      assignRef(childRef, node);
    },
    "aria-controls": context.open ? context.menuId : undefined,
    "aria-haspopup": "menu",
    "aria-expanded": context.open,
    // The long press is ours: without this iOS runs its own on the same
    // gesture and drops the selection callout and its handles on top of the
    // menu we just opened. Only the press gesture is ours though — the child
    // is the consumer's content, so a mouse can still select the text in it
    // and right-click the selection. `touch-none` stays off too: the page
    // still has to scroll from the trigger.
    className: cn(TOUCH_GESTURE_CONTENT_CLASS, childProps.className, className),
    onClick,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      childProps.onContextMenu?.(event);
      if (event.defaultPrevented || disabled) return;
      event.preventDefault();
      endPress();
      context.openAt({ x: event.clientX, y: event.clientY }, "pointer");
    },
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerUp?.(event);
      endPress();
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerCancel?.(event);
      endPress();
    },
  });
}

export interface ContextMenuContentProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function ContextMenuContent({
  children,
  className,
  ariaLabel = "Context menu",
}: ContextMenuContentProps) {
  const context = useContextMenuContext("ContextMenuContent");
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<MenuPoint>(context.point);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [closedAtRest, setClosedAtRest] = useState(true);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = useMotionValue(0);
  const filterId = `${context.menuId.replace(/:/g, "")}-goo`;

  useEffect(() => setMounted(true), []);

  // 两种锚点形态共用同一套 goo 几何（goo-layer.tsx 的 buildGooGeometry）：
  //
  // - 落点式（anchor='point'）：锚点 = 右键落点（0×0），面板偏移 =
  //   钳位后的左上 - 落点。面板从那一点"长"出来。
  // - 触发钮式（anchor='trigger'）：锚点 = 触发钮矩形，面板偏移由
  //   side/align/sideOffset 反推。观感与模型选择器（beui Popover）一致。
  //
  // 两种形态最终都落到同一份 GooSurface —— 这就是"所有弹窗效果归拢成
  // 一个"的落点（2026-10-26 用户定稿）。
  const triggerRect = context.triggerRect;
  const anchorW = context.anchor === "trigger" ? triggerRect.width : 0;
  const anchorH = context.anchor === "trigger" ? triggerRect.height : 0;

  const origin: MenuPoint =
    context.anchor === "trigger"
      ? { x: triggerRect.left, y: triggerRect.top }
      : context.point;

  // 面板左上（视口坐标）：先按 side/align 摆，再整体钳进视口。
  const placement = useMemo(() => {
    if (context.anchor !== "trigger") {
      return { left: position.x, top: position.y };
    }
    const gap = context.sideOffset;
    const left =
      context.align === "start"
        ? origin.x
        : context.align === "end"
          ? origin.x + anchorW - size.width
          : origin.x + (anchorW - size.width) / 2;
    const top =
      context.side === "bottom"
        ? origin.y + anchorH + gap
        : context.side === "top"
          ? origin.y - gap - size.height
          : origin.y;
    const leftWithSide =
      context.side === "right"
        ? origin.x + anchorW + gap
        : context.side === "left"
          ? origin.x - gap - size.width
          : left;
    // 钳进视口（触发钮式没有翻转，只做平移补偿——菜单宽度固定，够用）
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      window.innerWidth - size.width - VIEWPORT_PADDING,
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - size.height - VIEWPORT_PADDING,
    );
    return {
      left: Math.max(VIEWPORT_PADDING, Math.min(leftWithSide, maxLeft)),
      top: Math.max(VIEWPORT_PADDING, Math.min(top, maxTop)),
    };
  }, [
    context.anchor,
    context.side,
    context.align,
    context.sideOffset,
    origin,
    anchorW,
    anchorH,
    size,
    position,
  ]);

  const geo = useMemo(
    () =>
      buildGooGeometry(
        anchorW,
        anchorH,
        placement.left - origin.x,
        placement.top - origin.y,
        size.width,
        size.height,
        context.panelRadius,
      ),
    [anchorW, anchorH, placement, origin, size, context.panelRadius],
  );

  useLayoutEffect(() => {
    if (!context.open) return;
    const content = context.contentRef.current;
    if (!content) return;
    content.dataset.invocation = String(context.invocation);
    const rect = content.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });

    if (context.anchor === "trigger") return;

    // 落点式：钳进视口后落位
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(
        Math.max(context.point.x, VIEWPORT_PADDING),
        window.innerWidth - rect.width - VIEWPORT_PADDING,
      ),
    );
    const top = Math.max(
      VIEWPORT_PADDING,
      Math.min(
        Math.max(context.point.y, VIEWPORT_PADDING),
        window.innerHeight - rect.height - VIEWPORT_PADDING,
      ),
    );
    setPosition({ x: left, y: top });
  }, [
    context.open,
    context.point,
    context.anchor,
    context.contentRef,
    context.invocation,
    context.modality,
    context.reduce,
  ]);

  // 开/合各跑一次 goo 形变（弹簧曲线走 tokens.css 的 --beui-spring-goo-*）。
  useEffect(() => {
    if (context.open) {
      setClosedAtRest(false);
      if (context.modality === "keyboard") {
        progress.jump(1);
        return;
      }
      const animation = animate(
        progress,
        1,
        context.reduce ? { duration: 0 } : POPOVER_GOO_OPEN,
      );
      return () => animation.stop();
    }
    if (context.reduce) {
      progress.jump(0);
      setClosedAtRest(true);
      return;
    }
    const animation = animate(progress, 0, POPOVER_GOO_CLOSE);
    return () => animation.stop();
  }, [context.open, context.modality, context.reduce, progress]);

  useMotionValueEvent(progress, "animationComplete", () => {
    if (!context.open) setClosedAtRest(true);
  });

  useEffect(() => {
    if (!context.open) return;
    const frame = requestAnimationFrame(() => {
      const first = getEnabledItems(context.contentRef.current)[0];
      first?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [context.open, context.contentRef]);

  useEffect(
    () => () => {
      if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
    },
    [],
  );

  const moveFocus = (direction: 1 | -1) => {
    const items = getEnabledItems(context.contentRef.current);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current < 0 ? 0 : (current + direction + items.length) % items.length;
    items[next]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      context.setOpen(false);
      context.triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      context.setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const items = getEnabledItems(context.contentRef.current);
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      typeahead.current += event.key.toLocaleLowerCase();
      if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
      typeaheadTimer.current = setTimeout(() => {
        typeahead.current = "";
      }, 500);
      const match = getEnabledItems(context.contentRef.current).find((item) =>
        (item.dataset.label ?? item.textContent ?? "")
          .trim()
          .toLocaleLowerCase()
          .startsWith(typeahead.current),
      );
      match?.focus();
    }
  };

  if (!mounted) return null;
  // 关闭且退场播完 → 整个 portal 卸载。
  //
  // 不卸载的代价实测（2026-10-26）：每个菜单都带一份常驻 `<svg><filter>`，
  // 侧栏一屏 30 个文件树行 + 20 个会话行 → 31 个 portal / 31 个
  // feGaussianBlur 常驻合成树（实测 portalCount=31）。它们的 goo 滤镜虽然
  // 不可见，但仍参与合成层与 filter 解析，是白付的开销。
  //
  // `closedAtRest` 是"退场动画播完了"的信号（由 animationComplete 置位），
  // 所以卸载发生在形变收尾之后，不会切断退场。
  if (closedAtRest && !context.open) return null;

  return (
    <GooSurface
      contentClassName={cn(
        // 去描边（用户 2026-10-14 全局去描边：菜单不留描边线）
        "min-w-56 rounded-xl bg-card p-1.5 text-foreground outline-none",
        className,
      )}
      contentId={context.menuId}
      contentProps={{
        role: "menu",
        "aria-label": ariaLabel,
        "aria-hidden": !context.open,
        tabIndex: -1,
        onKeyDown,
        onContextMenu: (event) => event.preventDefault(),
      }}
      contentRef={context.contentRef}
      filterId={filterId}
      geo={geo}
      goo={context.goo}
      gooStrength={context.gooStrength}
      interactive={context.open}
      origin={{ left: origin.x, top: origin.y }}
      portalId={context.menuId}
      progress={progress}
      reduce={context.reduce}
      visible={!closedAtRest}
    >
      {children}
    </GooSurface>
  );
}

type ContextMenuItemTone = "default" | "destructive";

// ── 子菜单（本地扩展，2026-10-26 归拢）───────────────────────────────────
//
// 上游 beui ContextMenu 是单层（只有右键一层），本项目的侧栏菜单是三层
// （分组 ▸ / 排序 ▸ / 显示 ▸ 各带子菜单）。要让侧栏与右键同一套 goo 观感，
// 子菜单必须也走同一个 GooSurface —— 于是这里把"子菜单"实现成**独立的
// ContextMenu 实例**（自己一份 progress/filter/portal），只是锚点 = 父菜单
// 里那一行 SubTrigger 的矩形、方向固定 right（放不下翻左）。
//
// 与父菜单的协作：
// - 打开：SubTrigger 的 hover/click → `openTriggered()`（推进 invocation）
// - 关闭：父菜单关 → 子菜单收到 `ancestorIds` 变化时一并卸载（React 树序）
// - 外部点击：父菜单的判定把"任何 data-menu-portal 命中祖先 id 链"都算内部，
//   所以点子菜单不会把父菜单关掉（见 ContextMenu 的 dismiss effect）

export interface ContextMenuSubProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const SubMenuContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerEl: HTMLElement | null;
  setTriggerEl: (el: HTMLElement | null) => void;
} | null>(null);

export function ContextMenuSub({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: ContextMenuSubProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const value = useMemo(
    () => ({ open, setOpen, triggerEl, setTriggerEl }),
    [open, setOpen, triggerEl],
  );
  return <SubMenuContext.Provider value={value}>{children}</SubMenuContext.Provider>;
}

function useSubMenuContext(component: string) {
  const ctx = useContext(SubMenuContext);
  if (!ctx) throw new Error(`${component} must be used within <ContextMenuSub>`);
  return ctx;
}

export interface ContextMenuSubTriggerProps
  extends Omit<ContextMenuItemProps, "onSelect" | "closeOnSelect"> {}

export function ContextMenuSubTrigger({
  children,
  disabled = false,
  className,
  textValue,
  ...props
}: ContextMenuSubTriggerProps) {
  const sub = useSubMenuContext("ContextMenuSubTrigger");
  const id = useId();

  return (
    <button
      type="button"
      aria-expanded={sub.open}
      aria-haspopup="menu"
      className={cn(
        "relative isolate flex w-full select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none",
        "focus-visible:ring-2 focus-visible:ring-foreground/15",
        "disabled:pointer-events-none disabled:opacity-40",
        "text-foreground",
        className,
      )}
      data-context-menu-item="true"
      data-disabled={disabled ? "true" : undefined}
      data-label={textValue}
      data-submenu-trigger={id}
      disabled={disabled}
      ref={sub.setTriggerEl}
      onPointerEnter={(event) => {
        if (disabled || event.pointerType === "touch") return;
        sub.setOpen(true);
      }}
      onClick={() => {
        if (disabled) return;
        sub.setOpen(!sub.open);
      }}
      tabIndex={-1}
      {...props}
    >
      {children}
    </button>
  );
}

export interface ContextMenuSubContentProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

/**
 * 子菜单面板：一个**独立的** goo 菜单，锚点 = 父菜单里那一行 SubTrigger。
 *
 * 复用 `ContextMenu`（anchor='trigger'）而不是另写一套渲染——这样三层
 * 菜单与右键菜单永远是同一份动效代码。父菜单的 `menuId` 进 `ancestorIds`，
 * 让外部点击判定把子菜单认作内部。
 */
export function ContextMenuSubContent({
  children,
  className,
  ariaLabel = "Submenu",
}: ContextMenuSubContentProps) {
  const parent = useContextMenuContext("ContextMenuSubContent");
  const sub = useSubMenuContext("ContextMenuSubContent");

  return (
    <ContextMenu
      align="start"
      anchor="trigger"
      anchorEl={sub.triggerEl}
      ancestorIds={[...parent.ancestorIds, parent.menuId]}
      onOpenChange={sub.setOpen}
      open={sub.open}
      panelRadius={parent.panelRadius}
      side="right"
      sideOffset={4}
    >
      <ContextMenuContent ariaLabel={ariaLabel} className={className}>
        {children}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface ContextMenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  closeOnSelect?: boolean;
  tone?: ContextMenuItemTone;
  inset?: boolean;
  className?: string;
  textValue?: string;
  /**
   * 原生悬停说明（本地扩展，2026-10-26）：禁用项要能说清"为什么不可用"。
   *
   * 注意 disabled 按钮在浏览器里不发 pointer 事件，但 `title` 的 tooltip 仍
   * 由浏览器自己显示（它看的是 DOM 属性，不是事件）。hermes 的 disabled
   * 提示项就靠这个 —— 所以 VIEW_DISABLED_HINT_ITEM 不能带
   * `disabled:pointer-events-none`。
   */
  title?: string;
}

function ContextMenuItemBase({
  children,
  onSelect,
  disabled = false,
  closeOnSelect = true,
  tone = "default",
  inset = false,
  className,
  textValue,
  title,
  role = "menuitem",
  ariaChecked,
}: ContextMenuItemProps & {
  role?: "menuitem" | "menuitemcheckbox" | "menuitemradio";
  ariaChecked?: boolean;
}) {
  const context = useContextMenuContext("ContextMenuItem");
  const id = useId();
  const active = context.activeId === id;
  const checkedProps =
    role === "menuitem" ? {} : { "aria-checked": ariaChecked };

  return (
    <button
      type="button"
      id={id}
      role={role}
      {...checkedProps}
      disabled={disabled}
      data-context-menu-item="true"
      data-disabled={disabled ? "true" : undefined}
      data-label={textValue}
      tabIndex={-1}
      title={title}
      onFocus={() => context.setActiveId(id)}
      onPointerMove={(event) => {
        if (!disabled && event.pointerType !== "touch") event.currentTarget.focus();
      }}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        if (closeOnSelect) context.setOpen(false);
      }}
      className={cn(
        "relative isolate flex w-full select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none",
        "focus-visible:ring-2 focus-visible:ring-foreground/15",
        // 禁用项的观感：opacity-40 + 不接收点击。**带 title 时不能加
        // pointer-events-none**——那会让浏览器连悬停都不认，原生说明
        // tooltip 永远不出现（hermes 的 disabled 提示项就靠 title 说原因）。
        "disabled:opacity-40",
        title ? "disabled:cursor-default" : "disabled:pointer-events-none",
        inset && "pl-8",
        tone === "destructive" ? "text-destructive" : "text-foreground",
        className,
      )}
    >
      {active ? (
        <motion.span
          layoutId={`${context.menuId}-active`}
          className={cn(
            "absolute inset-0 -z-10 rounded-lg",
            tone === "destructive"
              ? "bg-destructive/10"
              : "bg-foreground/[0.065]",
          )}
          transition={context.reduce ? { duration: 0 } : SPRING_LAYOUT}
        />
      ) : null}
      {children}
    </button>
  );
}

export function ContextMenuItem(props: ContextMenuItemProps) {
  return <ContextMenuItemBase {...props} />;
}

export interface ContextMenuCheckboxItemProps
  extends Omit<ContextMenuItemProps, "onSelect"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function ContextMenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  ...props
}: ContextMenuCheckboxItemProps) {
  const context = useContextMenuContext("ContextMenuCheckboxItem");
  return (
    <ContextMenuItemBase
      {...props}
      role="menuitemcheckbox"
      ariaChecked={checked}
      onSelect={() => onCheckedChange?.(!checked)}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <AnimatePresence initial={false}>
          {checked ? (
            <motion.span
              key="check"
              initial={context.reduce ? false : { opacity: 0, scale: 0.75 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: context.reduce ? 1 : 0.75 }}
              transition={context.reduce ? { duration: 0.08 } : SPRING_PANEL}
            >
              <Check aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.4} />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
      {children}
    </ContextMenuItemBase>
  );
}

interface ContextMenuRadioGroupContextValue {
  value: string;
  onValueChange?: (value: string) => void;
}

const ContextMenuRadioGroupContext =
  createContext<ContextMenuRadioGroupContextValue | null>(null);

export interface ContextMenuRadioGroupProps {
  value: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}

export function ContextMenuRadioGroup({
  value,
  onValueChange,
  children,
  className,
}: ContextMenuRadioGroupProps) {
  const context = useMemo(
    () => ({ value, onValueChange }),
    [value, onValueChange],
  );
  return (
    <ContextMenuRadioGroupContext.Provider value={context}>
      <div className={className}>{children}</div>
    </ContextMenuRadioGroupContext.Provider>
  );
}

export interface ContextMenuRadioItemProps
  extends Omit<ContextMenuItemProps, "onSelect"> {
  value: string;
}

export function ContextMenuRadioItem({
  value,
  children,
  ...props
}: ContextMenuRadioItemProps) {
  const group = useContext(ContextMenuRadioGroupContext);
  if (!group) {
    throw new Error(
      "ContextMenuRadioItem must be used within <ContextMenuRadioGroup>",
    );
  }
  const checked = group.value === value;
  return (
    <ContextMenuItemBase
      {...props}
      role="menuitemradio"
      ariaChecked={checked}
      onSelect={() => group.onValueChange?.(value)}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-current transition-opacity",
            checked ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
      {children}
    </ContextMenuItemBase>
  );
}

export interface ContextMenuLabelProps {
  children: ReactNode;
  inset?: boolean;
  className?: string;
}

export function ContextMenuLabel({
  children,
  inset = false,
  className,
}: ContextMenuLabelProps) {
  return (
    <div
      className={cn(
        "px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
        inset && "pl-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ContextMenuSeparatorProps {
  className?: string;
}

export function ContextMenuSeparator({
  className,
}: ContextMenuSeparatorProps) {
  return (
    <hr className={cn("-mx-1 my-1 h-px border-0 bg-border", className)} />
  );
}

export interface ContextMenuShortcutProps {
  children: ReactNode;
  className?: string;
}

export function ContextMenuShortcut({
  children,
  className,
}: ContextMenuShortcutProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ml-auto pl-4 text-[10px] font-medium tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
