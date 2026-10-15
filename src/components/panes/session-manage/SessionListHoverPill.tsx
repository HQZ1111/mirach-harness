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
 */
import { useEffect, useRef, useState } from "react";

import { EASE_OUT_CSS } from "@/lib/ease";

interface PillState {
  top: number;
  left: number;
  width: number;
  height: number;
  visible: boolean;
}

const HIDDEN: PillState = { top: 0, left: 0, width: 0, height: 33, visible: false };

export function SessionListHoverPill() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PillState>(HIDDEN);
  /** 上一帧 pill 是否已钉在某行上（决定本轮样式是否带位移过渡——见头注）。 */
  const shownRef = useRef(false);
  /** 渲染侧读的"本轮是否滑行"（事件侧不阻塞；直读 ref 无法触发重渲）。 */
  const [sliding, setSliding] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const root = el?.parentElement ?? null;
    if (!root) return;
    const onOver = (e: Event) => {
      const row = (e.target as HTMLElement | null)?.closest(
        '[data-slot="aui_thread-list-item"]',
      ) as HTMLElement | null;
      // 非行面（1px 行间隙/分隔线/组头/空白）不隐藏也不动作（文件树同款
      // 语义：只认行、离开容器才灭——行间隙处理成隐藏会在逐行滑过时闪断）。
      if (!row || !root.contains(row)) return;
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
    const onLeave = () => {
      shownRef.current = false;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };
    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
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
          ? `top 180ms ${EASE_OUT_CSS}, left 140ms ${EASE_OUT_CSS}, width 140ms ${EASE_OUT_CSS}, height 140ms ${EASE_OUT_CSS}, opacity 80ms ${EASE_OUT_CSS}`
          : `opacity 100ms ${EASE_OUT_CSS}`,
      }}
    />
  );
}
