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
import { paneTypeOf, zoneConfigOf } from './pane-registry'
import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
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
      // 回退值须与令牌同步（85，用户 2026-10-05：100→85）
      const stripH = rect.stripH > 0 ? rect.stripH : 85
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

/** 主对话双行块宿主叠层（用户 2026-10-03 定稿；2026-10-05 改**跟随激活
 *  对话页签**）：锚定 = 「选中的对话页签」（workspace 或 session-*）所在
 *  tabset——哪个对话标签激活，双行块就显示在哪条顶带；非对话页签激活时
 *  隐藏（顶带 chrome 跟随激活页签，与 logo 互斥，见 onRenderTabSet）。
 *  内容 = ChatTabLabel（store 订阅，assistant-ui 数据经 chatTabLabelStore
 *  单向进入 layout 层）。 */
export function ChatLabelOverlay({ model }: { model: Model }) {
  const layoutRev = useLayoutStore(s => s.layoutRev)
  // dragRev：分隔条拖拽 adjusting 帧模型不变——订阅它逐帧跟随容器
  const dragRev = useLayoutStore(s => s.dragRev)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  useEffect(() => {
    const measure = () => {
      // 找**选中态**的对话页签（跨 tabset 找；折叠在 border 的不算——
      // 折叠页签不可见，顶带无空间承载）
      let setPath: string | null = null
      model.visitNodes((n) => {
        if (setPath || !(n instanceof TabNode)) return
        if (n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
        const id = n.getId()
        if (id !== 'workspace' && paneTypeOf(id) !== 'session') return
        const p = n.getParent()
        if (
          p instanceof TabSetNode &&
          p.getSelectedNode()?.getId() === id &&
          !(p.getParent() instanceof BorderNode)
        ) {
          setPath = p.getPath()
        }
      })
      if (setPath === null) {
        setRect(null)
        return
      }
      const el = setPath === null ? null : document.querySelector(`.flexlayout__tabset[data-layout-path="${setPath}"]`)
      const hr = document.querySelector('.flexlayout-host')?.getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      // 主区折叠成竖轨（宽 < 100）时双行块无空间承载——隐藏
      if (!el || !hr || !r || !(r.width >= 100 && r.height > 0)) {
        setRect(null)
        return
      }
      setRect({ left: r.left - hr.left, top: r.top - hr.top, width: r.width })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [model, layoutRev, dragRev])
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
        // 对话区标记：**激活页签是对话页签**的 tabset 才标（顶带 chrome
        // 跟随激活页签——双行块/列宽中线的 CSS 钩子随之切换，用户
        // 2026-10-05 定稿"哪个标签激活显示哪个"）
        const sel = n.getSelectedNode()
        const chatHere = !!sel && (sel.getId() === 'workspace' || paneTypeOf(sel.getId()) === 'session')
        el.setAttribute('data-chat-zone', chatHere ? 'true' : 'false')
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [model, layoutRev])
  return null
}
