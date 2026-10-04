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
import { BorderNode, Model, TabNode, TabSetNode } from 'flexlayout-react'

import { useLayoutStore } from '@/store/layout-store'
import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import { ChatTabLabel } from './chat-tab-label'
import { zoneConfigOf } from './pane-registry'

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
  // dragRev：分隔条拖拽的 adjusting 帧模型不变（快路径直写 DOM）——
  // 订阅它逐帧重测，颜色层/双行块拖拽中跟随容器（否则松手才跳）
  const dragRev = useLayoutStore(s => s.dragRev)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number; stripH: number } | null>(null)
  useEffect(() => {
    const measure = () => setRect(tabsetRectOf(model, tabIds))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
    // tabIds 由调用方常量传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, layoutRev, dragRev])
  return rect
}

/** 主区调色层：颜色/圆角走令牌 --main-tint-*；顶部**自动贴真实页签栏
 *  下缘**（现量 tabbar_outer 高度——顶带 100 / 低条 36 自适应，用户
 *  2026-09-29：高度不该用固定数值）；z -1 垫到文字组件下面（overlays.css）。 */
export function MainTint({ model }: { model: Model }) {
  const rect = useTabsetRect(model, ['workspace'])
  if (!rect) return null
  // 条被「切换标签」隐藏时 outer 不渲染（rect.stripH=0）——顶带仍按
  // --logo-strip-h 保留（双行块占位，与左栏 logo 同构），tint 从顶带下开始。
  const stripH = rect.stripH > 0 ? rect.stripH : 100
  return (
    <div
      aria-hidden
      className="main-tint"
      style={{
        left: rect.left,
        top: rect.top + stripH,
        width: rect.width,
        height: rect.height - stripH,
      }}
    />
  )
}

/** 主对话双行块宿主叠层（用户 2026-10-03 定稿）：相对 workspace tabset
 *  **顶带**（--logo-strip-h 100px）定位——项目名顶部与左栏 MIRACH 文字
 *  顶部同线（tabset 顶 + --logo-leading-pad），会话名底部与页签行底部
 *  对齐（页签行沉顶带底 15px）。stretch 头栏内无法到达（tabset_header
 *  25px 把 stretch 顶压到 62，MIRACH 在 21）——必须宿主层叠片。内容 =
 *  ChatTabLabel（store 订阅，assistant-ui 数据经 chatTabLabelStore 单向
 *  进入 layout 层）。 */
export function ChatLabelOverlay({ model }: { model: Model }) {
  const rect = useTabsetRect(model, ['workspace'])
  // 主区折叠成竖轨（宽 < 100）时双行块无空间承载——隐藏（与左栏竖轨
  // 的 railform logo 同语义：形态不承载时不硬塞）。
  if (!rect || rect.width < 100) return null
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

/** 条隐藏形态标记（「切换标签」后）：遍历主布局 tabset 打 data-strip-hidden
 *  （CSS 顶带保留的钩子；左栏跳过——railform logo 自带顶带）与
 *  data-chat-zone（主对话区多签中线起排钩子）。**不渲染任何可见内容**——
 *  v3.1 时代的右栏"活动页签名"浮层已按用户 2026-10-04 定稿删除（顶带
 *  保留但空着；hermes 对应形态同样无 chrome）。 */
export function StripHiddenTitleOverlay({ model }: { model: Model }) {
  const layoutRev = useLayoutStore(s => s.layoutRev)
  useEffect(() => {
    const measure = () => {
      model.visitNodes((n) => {
        if (!(n instanceof TabSetNode) || n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
        // border 里的 tabset（栏折叠进边框轨）DOM 在窗口边缘——标记无意义
        if (n.getParent() instanceof BorderNode) return
        const cfg = zoneConfigOf(n)
        if (!cfg || n.getChildren().length === 0) return
        if (cfg.track) return // 轨（20px）无条无顶带语义
        const el = document.querySelector<HTMLElement>(`.flexlayout__tabset[data-layout-path="${n.getPath()}"]`)
        if (!el) return
        const hidden = n.isEnableTabStrip() === false
        el.setAttribute('data-strip-hidden', hidden && cfg.region !== 'left' ? 'true' : 'false')
        // 主对话区标记：标在**当前收容 workspace 的 tabset**上——
        // [data-chat-lead] 只在 workspace 页签激活时在 DOM（切到别的页签
        // 内容卸载，:has 上探失灵、页签跳回最左），tab 级存在性不受激活态影响
        const chatHere = n.getChildren().some((c) => c instanceof TabNode && c.getId() === 'workspace')
        el.setAttribute('data-chat-zone', chatHere ? 'true' : 'false')
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [model, layoutRev])
  return null
}
