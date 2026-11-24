"use client";
// beui.dev/components/motion/popover
//
// harness 适配（2026-10-16，接线到模型选择器/标签总览时做的两处扩展，
// 其余与 beui.dev 注册表逐字一致）：
// - PopoverTrigger：改 forwardRef + 多余 props 透传到子元素（原版只取
//   children，外面包一层 Tooltip 时 ref/aria 线会丢——Tooltip 需要锚点
//   ref 才挂得上）；className 合并；aria-haspopup 尊重子元素已有值
//   （combobox 用 listbox，不被覆盖成 dialog）。
// - PopoverContent：接受任意 div props（data-slot/aria 便于测试与无障碍）
//   + onOpenAutoFocus（开面板/定位完成后回调，对应 Radix 的同名契约——
//   cmdk 菜单的键盘可用性依赖它把焦点送进输入框）。

import {
  useReducedMotion,
} from "motion/react";
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverPortalPosition } from "@/components/motion/popover-position";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import {
  type HoverGesture,
  useHoverGesture,
} from "@/lib/hooks/use-hover-gesture";
import { useTapGesture } from "@/lib/hooks/use-tap-gesture";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom";
type Align = "start" | "center" | "end";
type TriggerMode = "click" | "hover";

const HOVER_CLOSE_DELAY = 120;

// `onPointerEnter`/`onPointerLeave` rather than the mouse pair: a tap fires
// compatibility mouseenter/mouseleave that carry no pointerType at all, and
// they are what made the panel flicker open and shut under a finger. The
// gesture pairs the two, so the panel a pen tap opened is not closed again by
// the boundary event that ends the same tap.
function makeHoverHandlers(
  hover: HoverGesture,
  enter: () => void,
  leave: () => void,
) {
  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (hover.enter(event)) enter();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (hover.leave(event)) leave();
    },
  };
}


interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  openHover: () => void;
  scheduleClose: () => void;
  triggerMode: TriggerMode;
  side: Side;
  align: Align;
  gap: number;
  panelRadius: number;
  reduce: boolean;
  contentId: string;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string) {
  const ctx = useContext(PopoverContext);
  if (!ctx) throw new Error(`${component} must be used within <Popover>`);
  return ctx;
}

export interface PopoverProps {
  children: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** How the popover is summoned. Default "click". */
  trigger?: TriggerMode;
  /** Which side of the trigger the panel opens on. Default "bottom". */
  side?: Side;
  /** Alignment along the trigger's edge. Default "center". */
  align?: Align;
  /** Gap between trigger and panel, in px. Default 14. */
  sideOffset?: number;
  /** Corner radius of the open panel, in px. Default 16. */
  panelRadius?: number;
  /** 保留 prop（历史 goo 滤镜参数，2026-11-22 起无效果）。 */
  gooStrength?: number;
  /** 保留 prop（历史 goo 粘性合并开关，2026-11-22 起无效果）。 */
  goo?: boolean;
  className?: string;
}

export function Popover({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  trigger = "click",
  side = "bottom",
  align = "center",
  sideOffset = 14,
  panelRadius = 16,
  gooStrength = 8,
  goo = false,
  className,
}: PopoverProps) {
  const reduce = useReducedMotion() ?? false;
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootHover = useHoverGesture();

  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openHover = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose, setOpen]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY);
  }, [cancelClose, setOpen]);

  const toggle = useCallback(() => setOpen(!open), [setOpen, open]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  // The panel is a `role="dialog"` and goes inert the moment it closes, so
  // focus cannot be left sitting inside it: Escape hands it back to the
  // trigger, the way the ARIA dialog pattern asks. A pointer dismissal takes
  // the focus onward itself when it lands on something focusable — this only
  // catches the case where it would otherwise be stranded.
  const close = useCallback(() => {
    setOpen(false);
    const focused = document.activeElement;
    const inPanel =
      focused instanceof HTMLElement && contentRef.current?.contains(focused);
    if (inPanel) triggerRef.current?.focus();
  }, [setOpen]);
  // The panel is portalled, so both trees participate in outside detection.
  const ignoreContent = useCallback(
    (target: Element) => Boolean(contentRef.current?.contains(target)),
    [],
  );
  // A hover trigger opens on tap as well now, so it needs the same outside
  // dismissal the click trigger always had. The gesture passes through to
  // whatever it landed on, which is the light-dismiss bargain the platform's
  // own popovers strike.
  useDismiss(open, close, rootRef, { ignore: ignoreContent });

  const ctx = useMemo<PopoverContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      openHover,
      scheduleClose,
      triggerMode: trigger,
      side,
      align,
      gap: sideOffset,
      panelRadius,
      reduce,
      contentId,
      triggerRef,
      contentRef,
    }),
    [
      open,
      setOpen,
      toggle,
      openHover,
      scheduleClose,
      trigger,
      side,
      align,
      sideOffset,
      panelRadius,
      reduce,
      contentId,
    ],
  );

  const hoverHandlers =
    trigger === "hover"
      ? makeHoverHandlers(rootHover, openHover, scheduleClose)
      : {};

  return (
    <PopoverContext.Provider value={ctx}>
      <div
        ref={rootRef}
        className={cn("relative inline-flex isolate", className)}
        {...hoverHandlers}
      >
        {children}
      </div>
    </PopoverContext.Provider>
  );
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object")
        (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export interface PopoverTriggerProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
  /** A single focusable element (e.g. a Button) that opens the popover. */
  children: ReactElement;
}

export const PopoverTrigger = forwardRef<HTMLElement, PopoverTriggerProps>(
  function PopoverTrigger({ children, ...rest }, forwardedRef) {
    const ctx = usePopoverContext("PopoverTrigger");
    // What the last gesture on the trigger was, and whether the panel was
    // already open when it started. A click reports neither.
    const tap = useTapGesture<boolean>();

    if (!isValidElement(children)) return children;

    const child = children as ReactElement<Record<string, unknown>>;
    const childProps = child.props;
    const childRef = (childProps as { ref?: Ref<HTMLElement> }).ref;

    const compose =
      <E extends { defaultPrevented?: boolean }>(
        name: string,
        handler: (event: E) => void,
      ) =>
      (event: E) => {
        (childProps[name] as ((e: unknown) => void) | undefined)?.(event);
        (rest[name as keyof typeof rest] as ((e: unknown) => void) | undefined)?.(
          event,
        );
        if (!event.defaultPrevented) handler(event);
      };

    // Observation, not action. `compose` steps aside for a child that handled
    // the event itself, which is right for anything that *does* something — but
    // a child preventing the pointerdown default (to hold focus, say) has not
    // said the gesture didn't happen. Skipping the record there left the panel
    // reading whatever the gesture before it had put in.
    const observe =
      <E,>(name: string, handler: (event: E) => void) =>
      (event: E) => {
        (childProps[name] as ((e: unknown) => void) | undefined)?.(event);
        (rest[name as keyof typeof rest] as ((e: unknown) => void) | undefined)?.(
          event,
        );
        handler(event);
      };

    // The hover trigger keeps its hover path and *adds* a tap one, rather than
    // swapping mode on a device that reports a touchscreen: a touchscreen laptop
    // has both inputs and the mouse must keep working. A hovering pointer has
    // already opened the panel on its way in, and a keyboard press arrives with
    // no pointerdown behind it, so only a tap toggles here. Which panel state
    // the tap acts on is read from the gesture's start, because a browser that
    // focuses the trigger on contact would otherwise open it mid-gesture and let
    // the click close it again.
    const handlers: Record<string, unknown> =
      ctx.triggerMode === "hover"
        ? {
            onFocus: compose("onFocus", ctx.openHover),
            onBlur: compose("onBlur", ctx.scheduleClose),
            onPointerDown: observe<React.PointerEvent>(
              "onPointerDown",
              (event) => tap.start(event, ctx.open),
            ),
            onPointerCancel: observe("onPointerCancel", tap.drop),
            onKeyDown: observe("onKeyDown", tap.drop),
            onClick: compose("onClick", () => {
              const gesture = tap.take();
              if (!gesture || gesture.pointerType === "mouse") return;
              ctx.setOpen(!gesture.state);
            }),
          }
        : { onClick: compose("onClick", ctx.toggle) };

    // harness 扩展：调用方传入的 aria-*（如 combobox 的 listbox）不被覆盖。
    const existingHaspopup = rest["aria-haspopup" as keyof typeof rest] as
      | string
      | undefined;

    // `...rest` 先铺、`...handlers` 后盖：handlers 里的事件名（onClick /
    // hover 模式全套）由 compose/observe 负责与 rest 同名 handler 串联，
    // 所以不会被双重触发；其余 rest 键（data-slot/role/键盘 handler 等）
    // 原样落到子元素。
    return cloneElement(child, {
      ...rest,
      ...handlers,
      ref: mergeRefs(
        childRef,
        (node: HTMLElement | null) => {
          ctx.triggerRef.current = node;
        },
        (node: HTMLElement | null) => {
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef)
            (forwardedRef as React.MutableRefObject<HTMLElement | null>).current =
              node;
        },
      ),
      // Above the goo layer (z-[-1]) so the neck reads behind it.
      className: cn(
        "relative z-0",
        childProps.className as string | undefined,
        rest.className,
      ),
      "aria-haspopup": existingHaspopup ?? "dialog",
      "aria-expanded": ctx.open,
      "aria-controls": ctx.open ? ctx.contentId : undefined,
      "data-state": ctx.open ? "open" : "closed",
    });
  },
);

export interface PopoverContentProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children: ReactNode;
  /** harness 扩展（Radix 同名契约）：面板定位完成、可见之后的回调——
   *  cmdk 菜单键盘可用性依赖它把焦点送进输入框（Radix 的
   *  onOpenAutoFocus 等位物）。 */
  onOpenAutoFocus?: (content: HTMLDivElement) => void;
}

export function PopoverContent({
  children,
  className,
  onOpenAutoFocus,
  ...rest
}: PopoverContentProps) {
  const ctx = usePopoverContext("PopoverContent");
  const [portalReady, setPortalReady] = useState(false);
  const {
    side,
    align,
    gap,
    reduce,
    contentId,
    triggerRef,
    contentRef,
    open,
    triggerMode,
    openHover,
    scheduleClose,
  } = ctx;

  const measureRef = contentRef;
  const panelHover = useHoverGesture();
  // 只在弹层打开期间跑位置追踪（active 传入 open）：关闭后内容仍在 DOM
  // （收起动画/首帧对齐要用旧 geometry），但 rAF 轮询没有意义 —— 常驻轮询
  // 会每 50ms dispatch 一次同值 setState，挂进 React queue.pending 永不回收。
  const layout = usePopoverPortalPosition(
    triggerRef,
    measureRef,
    open,
  );

  useEffect(() => setPortalReady(true), []);

  // harness 扩展：定位就绪且打开时回调一次（每次打开会话一次）。
  const focusedOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOnOpen.current = false;
      return;
    }
    if (layout === null || focusedOnOpen.current || !contentRef.current) return;
    focusedOnOpen.current = true;
    onOpenAutoFocus?.(contentRef.current);
  }, [open, layout, contentRef, onOpenAutoFocus]);

  // harness 扩展（2026-10-16）：视口翻转/钳位——beUI 原版无碰撞处理
  // （放不下就出屏）。对位 Radix 的 collision 行为：首选 side 装不下且
  // 另一侧更宽裕 → 翻转；水平方向钳在 gutter 内。composer 的模型选择器
  // 触发钮在窗口底部，依赖此逻辑自动翻到上方（换 goo 前由 Radix 提供）。
  const gutter = 12;
  const resolvedSide: Side = (() => {
    if (!layout) return side;
    const below =
      window.innerHeight -
      layout.trigger.top -
      layout.trigger.height -
      gap -
      gutter;
    const above = layout.trigger.top - gap - gutter;
    const requested = side === "bottom" ? below : above;
    const other = side === "bottom" ? above : below;
    if (layout.content.height > requested && other > requested)
      return side === "bottom" ? "top" : "bottom";
    return side;
  })();

  // 面板偏移（锚点坐标系）：side/align/gap 反推 —— 这部分是"锚点式"
  // 独有的，落点式菜单由 context-menu.tsx 直接给偏移。
  const panelOffsetX =
    align === "start"
      ? 0
      : align === "end"
        ? (layout?.trigger.width ?? 0) - (layout?.content.width ?? 0)
        : ((layout?.trigger.width ?? 0) - (layout?.content.width ?? 0)) / 2;
  const panelOffsetY =
    resolvedSide === "bottom"
      ? (layout?.trigger.height ?? 0) + gap
      : -(gap + (layout?.content.height ?? 0));

  const hoverHandlers =
    triggerMode === "hover"
      ? makeHoverHandlers(panelHover, openHover, scheduleClose)
      : {};

  // harness 扩展：水平钳位——面板超出视口左右缘时整体平移补偿
  // （beUI 原版无碰撞处理；对位 Radix 的 shift 行为）。
  const preferredLeft = layout ? layout.trigger.left + panelOffsetX : 0;
  const clampX = layout
    ? Math.max(
        gutter,
        Math.min(preferredLeft, window.innerWidth - layout.content.width - gutter),
      ) - preferredLeft
    : 0;

  // Match the server and first client render, then attach the portal after
  // hydration. This preserves SSR without regenerating the page on the client.
  if (!portalReady) return null;

  // **必须 portal 到 body**（2026-11-15）：面板是 `position: fixed` +
  // 视口坐标（usePopoverPortalPosition 用 getBoundingClientRect）。留作
  // 内联节点时，任何带 layout containment 的祖先（composer 的
  // `@container/composer` 就是）都会成为 fixed 的包含块 → 整个面板按
  // "卡片左上角 + 视口坐标"偏移，弹层飞到别处。外部点击检测本来就按
  // "面板在 portal、两棵树都参与"写的（见 ignoreContent 上方注释）。
  //
  // 动效 = 默认弹层效果（tw-animate 的 fade+zoom），不再是自绘 goo 形变
  // （2026-11-22 用户："这个弹窗效果组件就不要了，换成默认的弹窗效果"）。
  // 关闭时保留挂载但 visibility:hidden——测量内容尺寸要用它（零尺寸会让
  // align/side 反推全错）。
  return createPortal(
    <div
      data-state={open ? "open" : "closed"}
      {...hoverHandlers}
      {...rest}
      aria-hidden={!open}
      className={cn(
        "fixed z-[9999] w-max max-w-[min(92vw,20rem)] rounded-xl bg-popover p-4 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.14)] outline-none",
        // 进场只在"已定位"的这一帧开始：否则动画会在 layout 测量前起跑，
      // 可见第一帧已是动画中段，看起来像弹层先出现再抖一下。
        open && layout && !reduce && "animate-in fade-in-0 zoom-in-95",
        className,
      )}
      id={contentId}
      ref={contentRef}
      role="dialog"
      style={{
        left: preferredLeft + clampX,
        top: layout ? layout.trigger.top + panelOffsetY : 0,
        // 从锚点方向长出来（不是从面板中心缩放）——向上弹的模型选择器
        // 若以中心为原点，缩放过程会把上缘推上去，观感就是"打开后抖一下"。
        transformOrigin: `${align === "start" ? "left" : align === "end" ? "right" : "center"} ${
          resolvedSide === "bottom" ? "top" : "bottom"
        }`,
        visibility: open && layout ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
