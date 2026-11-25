/**
 * 会话列表悬停滑动指示块（beUI SharedLayoutBg 样式语义移植，2026-10-14；
 * 照 FileTreeHoverPill 模式）。
 *
 * **纯视觉层**：不动 dnd-kit 排序/点击/右键/键盘任何逻辑——挂进
 * ThreadListItems 滚动容器做首子节点（DOM 在行之前，行是 relative 定位、
 * 后绘制盖其上，pill 只作容器底色）；事件委托监听
 * `[data-slot="aui_thread-list-item"]` 行 hover，把绝对定位指示块移到悬停行。
 * 行自身 hover 洗底已移除（防瞬时双层；data-active 选中态保留）。
 *
 * 挂载点差异（公式由此定）：文件树挂「不滚动的 relative 列表根」，会话列表
 * 挂**滚动容器本身**——abs 子元素随内容滚动 → top 必须加 root.scrollTop 才能
 * 钉在行上（2026-10-14 CDP 实测：不加偏差 = scrollTop）。行宽/行高不固定
 * （inset 边距/收件箱样式）→ 从 rowRect 现测。
 *
 * 动画纪律（与 FileTreeHoverPill 的窄差别）：**行间滑行**要位移过渡；但
 * 重新进入列表（pointer 离开又回来）或首次悬停时若带位移过渡，pill 会从
 * 上一处静止位置（或 0,0）"飞"过来。解析法：shown 标志只在"已钉在某行上"
 * 时开位移过渡——进场/退场都只是透明度淡变（beUI SharedLayoutBg 的
 * fade-in 语义）。
 *
 * **结构行（2026-11-23 用户实报"碰到可折叠组头会打架/残留"）**：
 * 组头/日期桶/工作区桶/状态桶不是会话行——指针停上去或从上方行滑到下方行
 * 时，pill 不能再停在上一行（否则看起来像组头被高亮，收起组后更是以旧
 * 几何悬在被收起的区域上）。故：
 *   1. 指针命中结构行 → 收起（只淡出，不位移）；
 *   2. 锚定行被卸载（收起组 / 过滤 / 换排序）→ MutationObserver 立即收起；
 *   3. 同组其它行增删导致锚定行位移 → 跟着重新钉；
 *   4. 滚动时指针不动、行在下面换位 → 按最后指针位置 elementFromPoint
 *      重新判定（pointerover 不会因滚动触发）。
 * 行间 1px 间隙仍不操作（保持逐行滑过不闪断）。
 */
import { useEffect, useRef, useState } from "react";

import { SLIDE_EASE_CSS } from "@/lib/ease";

interface PillState {
  top: number;
  left: number;
  width: number;
  height: number;
  visible: boolean;
}

const HIDDEN: PillState = { top: 0, left: 0, width: 0, height: 33, visible: false };

const ROW_SELECTOR = '[data-slot="aui_thread-list-item"]';

/** 可折叠/结构行：指针命中它们时 pill 必须收起（不是会话行）。 */
const STRUCTURAL_SELECTOR = [
  '[data-slot="aui_thread-list-section-header"]',
  '[data-slot="aui_thread-list-date-divider"]',
  '[data-slot="aui_thread-list-workspace-divider"]',
  '[data-slot="aui_thread-list-status-divider"]',
  '[data-slot="aui_thread-list-profile-divider"]',
].join(",");

/** 收起过渡中的行（deferred-collapse 的 120ms 延迟提交窗口）。 */
const CLOSING_SELECTOR = ".disclose-row--closing";

export function SessionListHoverPill() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PillState>(HIDDEN);
  /** 上一帧 pill 是否已钉在某行上（决定本轮样式是否带位移过渡——见头注）。 */
  const shownRef = useRef(false);
  /** 渲染侧读的"本轮是否滑行"（事件侧不阻塞；直读 ref 无法触发重渲）。 */
  const [sliding, setSliding] = useState(false);
  /** 当前钉住的行（收起/过滤/换排序时用来判"行还在不在"）。 */
  const hoveredRowRef = useRef<HTMLElement | null>(null);
  /** 最后一次指针位置（滚动时按它重新找行；pointerover 不因滚动触发）。 */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    const root = el?.parentElement ?? null;
    if (!root) return;

    const hide = () => {
      hoveredRowRef.current = null;
      shownRef.current = false;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };

    /**
     * 结构行（组头/分隔线）上的"暂停"：只淡出，**不清 shownRef**。
     *
     * 2026-11-23 用户实报"滑动组件没有滑动的效果了"：分组模式里行与行之间
     * 隔着日期/项目/状态分隔线，旧实现每次命中结构行都 `hide()` 把 shownRef
     * 归零，下一行只能重新淡入——整条列表看起来不再滑行。暂停保留"上次
     * 钉住的位置"，下一行落位时仍走 top/left 过渡，视觉上连续滑过去；
     * 同时 hoveredRowRef 清空，避免行被收起后 MutationObserver 又把它钉回。
     */
    const suspend = () => {
      hoveredRowRef.current = null;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };

    const place = (row: HTMLElement) => {
      hoveredRowRef.current = row;
      const rootRect = root.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const next = {
        top: Math.round(rowRect.top - rootRect.top + root.scrollTop),
        left: Math.round(rowRect.left - rootRect.left),
        width: Math.round(rowRect.width),
        height: Math.round(rowRect.height),
        visible: true,
      };
      // 同行内子元素间移动 = 同坐标——跳过重渲（pointerover 每换子元素都发）。
      setState((s) =>
        s.visible && s.top === next.top && s.left === next.left && s.width === next.width && s.height === next.height
          ? s
          : next,
      );
      setSliding(shownRef.current);
      shownRef.current = true;
    };

    const hideIfDetached = () => {
      const row = hoveredRowRef.current;
      if (row === null) return;
      // 行被卸载（收起落地 / 过滤 / 换排序）或正在播收起淡出——都必须收起，
      // 否则 pill 会以旧几何残留在正在消失的行上。
      if (!root.contains(row) || row.closest(CLOSING_SELECTOR) !== null) hide();
    };

    const handleTarget = (target: HTMLElement | null) => {
      if (target === null) {
        hide();
        return;
      }
      const row = target.closest(ROW_SELECTOR) as HTMLElement | null;
      if (row !== null && root.contains(row)) {
        place(row);
        return;
      }
      // 组头/分隔线（可折叠结构行）不是行面：指针停上去即淡出——不能
      // 停在上一行，否则看起来像组头被高亮，滑动时与组头自身的 hover
      // 反馈"打架"。但**只暂停不重置滑行状态**（见 suspend 注释），否则
      // 分组模式每跨一条分隔线就丢一次位移动画。
      if (target.closest(STRUCTURAL_SELECTOR) !== null) {
        suspend();
        return;
      }
      // 行间隙/空白/空态：不动作（文件树同款语义：只认行；隐藏会在逐行
      // 滑过时闪断）。但锚定行已卸载/退场时必须收起（收起组后指针恰好
      // 停在间隙里就是这种情形）。
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
    const onLeave = () => {
      hide();
    };

    // 行的增删/位移（组收起、换排序、未读刷新）不会发 pointer 事件——
    // 跟 DOM 变更同步：锚定行没了/退场 → 收起；还在 → 跟着重新钉。
    let raf = 0;
    const resync = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const row = hoveredRowRef.current;
        if (row === null) return;
        if (!root.contains(row) || row.closest(CLOSING_SELECTOR) !== null) {
          hide();
          return;
        }
        place(row);
      });
    };
    const observer = new MutationObserver(resync);
    observer.observe(root, {
      attributeFilter: ["class"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    // 滚动重测独立排帧：不能和 resync 共用一个 raf（DOM 变更的 rAF 在途时
    // 若直接 return，滚轮只发一次 scroll 事件，pill 会停在已滚出视口的
    // 旧行上）。
    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf !== 0 || pointerRef.current === null) return;
      const { x, y } = pointerRef.current;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (hit === null || !root.contains(hit)) return;
        const row = hit.closest(ROW_SELECTOR) as HTMLElement | null;
        // 滚动后指针可能落在行间隙/组头/空白上：旧行可能已滚出视口，
        // 必须收起，不能按"间隙不动作"留在旧坐标。
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
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
      if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf);
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="session-list-hover-pill"
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
