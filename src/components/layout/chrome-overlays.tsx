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
import { ChatTabLabel } from './chat-tab-label'

function tabsetRectOf(
  model: Model,
  tabIds: string[],
): { left: number; top: number; width: number; height: number; stripH: number } | null {
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
          // 真实页签栏高度（顶带 100 / 低条 36 / 无条 0）——颜色层顶边自动
          // 贴条底，不用固定数值（用户 2026-09-29：低条时固定 100 让出
          // 64px 不铺色，标签看着像悬在错位）
          const bar = el.querySelector('.flexlayout__tabset_tabbar_outer')
          const stripH = bar ? bar.getBoundingClientRect().height : 0
          return { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height, stripH }
        }
      }
    }
  }
  return null
}

function useTabsetRect(model: Model, tabIds: string[]) {
  const layoutRev = useLayoutStore(s => s.layoutRev)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number; stripH: number } | null>(null)
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

/** 主区调色层：颜色/圆角走令牌 --main-tint-*；顶部**自动贴真实页签栏
 *  下缘**（现量 tabbar_outer 高度——顶带 100 / 低条 36 自适应，用户
 *  2026-09-29：高度不该用固定数值）；z -1 垫到文字组件下面（overlays.css）。 */
export function MainTint({ model }: { model: Model }) {
  const rect = useTabsetRect(model, ['workspace'])
  if (!rect) return null
  return (
    <div
      aria-hidden
      className="main-tint"
      style={{
        left: rect.left,
        top: rect.top + rect.stripH,
        width: rect.width,
        height: rect.height - rect.stripH,
      }}
    />
  )
}

/** 主对话双行块宿主叠层（用户 2026-10-03 定稿）：相对 workspace tabset
 *  **顶带**（--logo-strip-h 100px）定位——项目名顶部与左栏 MIRACH 文字
 *  顶部同线（tabset 顶 + --logo-leading-pad），会话名底部与页签行底部
 *  对齐（页签行沉顶带底 18px）。stretch 头栏内无法到达（tabset_header
 *  25px 把 stretch 顶压到 62，MIRACH 在 21）——必须宿主层叠片。内容 =
 *  ChatTabLabel（store 订阅，assistant-ui 数据经 chatTabLabelStore 单向
 *  进入 layout 层）。 */
export function ChatLabelOverlay({ model }: { model: Model }) {
  const rect = useTabsetRect(model, ['workspace'])
  if (!rect) return null
  return (
    <div
      className="chat-tab-label-anchor"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: 'var(--logo-strip-h)',
      }}
    >
      <ChatTabLabel />
    </div>
  )
}
