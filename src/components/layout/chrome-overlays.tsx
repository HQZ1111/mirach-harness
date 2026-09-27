/**
 * 宿主层装饰叠片（flexlayout tabset DOM 不可注入，全部走宿主绝对定位）：
 *
 * - MainTint：主区（workspace tabset）上的调色叠层，E9EEEF @ 40%，
 *   pointer-events:none——纯视觉调色用，点击穿透。
 * - RailLogo：左栏（sessions/bots 所在 tabset）顶部的 logo 带，高 40px；
 *   左栏 tabset 设 tabLocation:"bottom"（标签在带下方），窗格经
 *   .rail-pane-pad 让出带高。
 *
 * 测量模式与 edit-veils 相同：layoutRev/resize 后按 data-layout-path 现量。
 */

import { useEffect, useState } from 'react'
import { Model, TabSetNode } from 'flexlayout-react'

import { useLayoutStore } from '@/store/layout-store'

function tabsetRectOf(model: Model, tabIds: string[]): { left: number; top: number; width: number; height: number } | null {
  for (const tabId of tabIds) {
    const t = model.getNodeById(tabId)
    const set = t?.getParent()
    if (set instanceof TabSetNode) {
      const el = document.querySelector(`.flexlayout__tabset[data-layout-path="${set.getPath()}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        // 转宿主相对坐标（叠片画在宿主层，viewport 坐标会整体偏移宿主原点）
        const hr = document.querySelector('.flexlayout-host')?.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && hr) {
          return { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height }
        }
      }
    }
  }
  return null
}

function useTabsetRect(model: Model, tabIds: string[]) {
  const layoutRev = useLayoutStore(s => s.layoutRev)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useEffect(() => {
    const measure = () => setRect(tabsetRectOf(model, tabIds))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
    // tabIds 由调用方常量传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, layoutRev])
  return rect
}

/** 主区调色层：颜色/圆角走令牌 --main-tint-*；顶部避开 100 页签带
 *  （calc + --logo-strip-h，横向形态避条、竖轨形态避标题栏/logo 带——
 *  用户 2026-09-27 定稿两形态都避）；z -1 垫到文字组件下面（overlays.css）。
 *  偏移不用 100px 字面量而挂令牌：改条高一处即全跟。 */
export function MainTint({ model }: { model: Model }) {
  const rect = useTabsetRect(model, ['workspace'])
  if (!rect) return null
  return (
    <div
      aria-hidden
      className="main-tint"
      style={{
        left: rect.left,
        top: `calc(${rect.top}px + var(--logo-strip-h))`,
        width: rect.width,
        height: `calc(${rect.height}px - var(--logo-strip-h))`,
      }}
    />
  )
}
