"use client";

import {
  type MutableRefObject,
  useCallback,
  useLayoutEffect,
  useState,
} from "react";

export type PortalLayout = {
  trigger: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  content: {
    width: number;
    height: number;
  };
};

function sameLayout(a: PortalLayout | null, b: PortalLayout) {
  return (
    a?.trigger.left === b.trigger.left &&
    a.trigger.top === b.trigger.top &&
    a.trigger.width === b.trigger.width &&
    a.trigger.height === b.trigger.height &&
    a.content.width === b.content.width &&
    a.content.height === b.content.height
  );
}

/** Measures a trigger and portalled panel in viewport coordinates. */
export function usePopoverPortalPosition<
  TriggerElement extends HTMLElement,
  ContentElement extends HTMLElement,
>(
  triggerRef: MutableRefObject<TriggerElement | null>,
  contentRef: MutableRefObject<ContentElement | null>,
  active: boolean,
) {
  const [layout, setLayout] = useState<PortalLayout | null>(null);

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;

    const rect = trigger.getBoundingClientRect();
    const next: PortalLayout = {
      trigger: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      content: {
        width: content.offsetWidth,
        height: content.offsetHeight,
      },
    };
    setLayout((current) => (sameLayout(current, next) ? current : next));
  }, [contentRef, triggerRef]);

  useLayoutEffect(() => {
    update();
    if (!active) return;

    const trigger = triggerRef.current;
    const content = contentRef.current;
    const observer = new ResizeObserver(update);
    if (trigger) observer.observe(trigger);
    if (content) observer.observe(content);

    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);

    // **位置追踪（2026-11-01，用户："按钮位置变了后，弹窗还在老位置"）**。
    //
    // ResizeObserver 只在**尺寸**变化时触发；触发钮被别的东西挪动（面板栏
    // 收放、栏宽拖拽、标签条布局变化）时尺寸不变，它一声不响，`layout`
    // 停在旧值 → 弹窗留在原地，而按钮已经走了。
    //
    // window `resize` 只覆盖"视口尺寸变"，覆盖不了"同一视口内元素被挪动"。
    // 所以打开期间跑一个 rAF 轮询：每帧读一次 trigger 的位置，变了就
    // `update()`。开销可控——
    //   - 只在 `active`（弹窗打开）时跑，关闭即停；
    //   - 每帧只做一次 `getBoundingClientRect`（强制 layout 但那本来就已
    //     脏了，因为要判断位置就得读几何）；
    //   - `update()` 内部有 `sameLayout` 短路，值没变时**不 setState**，
    //     不触发 React 重渲。
    let raf = 0;
    let frame = 0;
    const track = () => {
      // 每 3 帧（≈50ms）比对一次：按钮被挪动通常伴随可见的布局动画，
      // 50ms 的延迟在视觉上不可辨；而每帧读几何会白烧 CPU。
      if (++frame % 3 === 0) update();
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, contentRef, triggerRef, update]);

  return layout;
}
