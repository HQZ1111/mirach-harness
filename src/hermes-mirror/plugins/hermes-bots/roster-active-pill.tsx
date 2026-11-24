/**
 * 机器人名单的滑动选中块（2026-11-23，用户："机器人页也用这个组件选择"）。
 *
 * 语义 = 设置页左栏的 selected pill：**唯一一条**底色在 [data-roster-active]
 * 行之间滑动，切机器人/群聊时不是瞬间换底。挂载点 = 名单滚动容器
 * `[data-slot="bots-roster"]`（abs 子元素随内容滚动 → top 要加 scrollTop）。
 *
 * 行的选中底已从行 class 里移除（bot-row / canonical-group-row 的
 * `bg-(--ui-row-active-background)`）——两处都画会叠色且 pill 永远被行底
 * 盖住。行补了 `relative`，绘制在 pill 之上。
 *
 * 纯视觉层：不动点击/拖拽/右键/键盘。active 行由 React 写属性，这里只读；
 * 行卸载（分组收起/过滤）或增删（排序/搜索）由 MutationObserver 重测。
 */
import { useEffect, useRef, useState } from 'react'

import { SLIDE_EASE_CSS } from '@/lib/ease'

interface PillState {
  top: number
  left: number
  width: number
  height: number
  visible: boolean
}

const HIDDEN: PillState = { top: 0, left: 0, width: 0, height: 32, visible: false }

const EASE_OUT = SLIDE_EASE_CSS

export function RosterActivePill() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<PillState>(HIDDEN)
  /** 已钉住过一次才开位移过渡（首次出现/重新出现只淡入，不从 0,0 飞来）。 */
  const shownRef = useRef(false)
  const [sliding, setSliding] = useState(false)

  useEffect(() => {
    const el = ref.current
    const root = el?.parentElement ?? null
    if (!root) return

    let raf = 0
    const sync = () => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const row = root.querySelector<HTMLElement>('[data-roster-active]')
        if (row === null || !root.contains(row)) {
          shownRef.current = false
          setState((s) => (s.visible ? { ...s, visible: false } : s))
          return
        }
        const rootRect = root.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const next: PillState = {
          top: Math.round(rowRect.top - rootRect.top + root.scrollTop),
          left: Math.round(rowRect.left - rootRect.left),
          width: Math.round(rowRect.width),
          height: Math.round(rowRect.height),
          visible: true,
        }
        setState((s) =>
          s.visible &&
          s.top === next.top &&
          s.left === next.left &&
          s.width === next.width &&
          s.height === next.height
            ? s
            : next,
        )
        setSliding(shownRef.current)
        shownRef.current = true
      })
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      attributeFilter: ['data-roster-active'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    // 分组展开/改名/行高变化（图片加载、字体）不保证发 childList/属性
    // 变更；尺寸观察兜住"底比行矮/偏"。
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    resize?.observe(root)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      resize?.disconnect()
      window.removeEventListener('resize', sync)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-slot="bots-roster-active-pill"
      style={{
        background: 'var(--ui-row-active-background)',
        borderRadius: 6,
        height: state.height,
        left: state.left,
        opacity: state.visible ? 1 : 0,
        pointerEvents: 'none',
        position: 'absolute',
        top: state.top,
        transition: sliding
          ? `top 260ms ${EASE_OUT}, left 200ms ${EASE_OUT}, width 200ms ${EASE_OUT}, height 200ms ${EASE_OUT}, opacity 120ms ${EASE_OUT}`
          : `opacity 120ms ${EASE_OUT}`,
        width: state.width,
        zIndex: 0,
      }}
    />
  )
}
