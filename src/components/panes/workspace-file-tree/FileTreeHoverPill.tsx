/**
 * 文件树悬停滑动指示块（beUI SharedLayoutBg 的样式语义移植，2026-10-14）。
 *
 * **纯视觉层**：不动虚拟列表/点击/右键/键盘任何逻辑——挂进列表容器
 * （position:relative 的全高 div）做首子节点；事件委托监听 `[role=treeitem]`
 * 行 hover，把绝对定位的指示块移到悬停行（top = 行 top − 列表 top，虚拟行
 * 绝对定位故该差值稳定不随滚动变）；滑行过渡用 beUI EASE_OUT_CSS——
 * SPRING_LAYOUT(360/32/0.6) 的 CSS 近似。行自身原 hover 洗底已移除（防
 * 瞬时底色盖住滑动动画）。
 *
 * 与 beUI SharedLayoutBg 的差别（同语义不同实现）：beUI 版 cloneElement
 * 逐子挂 onMouseEnter（子元素受控渲染场景）；ZCode 树行是虚拟化绝对定位项
 * （行集由虚拟滚动派生），故改"事件委托 + 单指示块"——零组件侵入。
 */
import { useEffect, useRef, useState } from 'react'

import { EASE_OUT_CSS } from '@/lib/ease'

/** 行高（与 constants.ts 的 WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX=28 同值；
 *  该常量经 useFileTreeVirtualizer 深层引用，此处独立取值免拆包环）。 */
const ROW_H = 28

export function FileTreeHoverPill() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<{ top: number; visible: boolean }>({ top: 0, visible: false })

  useEffect(() => {
    const el = ref.current
    const root = el?.parentElement ?? null
    if (!root) return
    const onOver = (e: Event) => {
      const row = (e.target as HTMLElement | null)?.closest('[role="treeitem"]') as HTMLElement | null
      if (!row || !root.contains(row)) return
      const rootRect = root.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      setState({ top: Math.round(rowRect.top - rootRect.top), visible: true })
    }
    const onLeave = () => setState((s) => (s.visible ? { ...s, visible: false } : s))
    root.addEventListener('pointerover', onOver)
    root.addEventListener('pointerleave', onLeave)
    return () => {
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="file-tree-hover-pill"
      style={{
        top: state.top,
        height: ROW_H,
        opacity: state.visible ? 1 : 0,
        transition: `top 180ms ${EASE_OUT_CSS}, opacity 120ms ${EASE_OUT_CSS}`,
      }}
    />
  )
}
