/**
 * 会话行跨面拖拽（v8.2 落点感知版，2026-10-15 重写）——用户两连报的修复：
 * ①"没有落点遮罩"——旧版反馈 = 内容容器上的 inset box-shadow，被面板的
 *    不透明内容盖住，实际不可见（CDP 实锤：boxShadow 写在 .dv-content-
 *    container 上，但子内容铺满整层）。**改用 dockview 原生落点预览**
 *    （group.model.contentDropTarget.showOverlay(position)，与面板标签
 *    拖拽同一个 overlay 组件：半幅 sheet + accent 虚线框，CSS 变量已重映射
 *    回旧设计）；方位判定走 drop-geometry.ts 径向几何（与 dropPosition-
 *    Resolver 同一份，会话条不经过 dockview 的 DnD 管线所以手动算）。
 * ②"无法拖拽出来在其他栏进行分栏"——旧版提交恒 addPanel right of
 *    workspace（拖到左半边/上下半边也开右侧、拖到别的对话分栏也不落那）。
 *    **落点感知提交**：悬停的组 + 径向方位 → openSessionTabBridge(threadId,
 *    { referenceGroup, direction })，shell 侧 addPanel 按落点落位。
 *
 * 目标面 = **chat 域组的内容区**（regionOfGroup==='chat' 的组；含主栏
 * workspace 与各 session 分栏）；其余区面（侧栏/面板栏/标题栏）拒绝。
 * 拖入 = 原生 overlay 预览（center=堆叠进该组；四边=向该边分栏）。
 *
 * 机器形态沿用旧版（4px 阈值 / rAF 合帧 / pointer capture / Esc 顶层逃生
 * 层 / engaged 后吞合成 click），源行压暗 0.45（hermes 实锤值）。
 */
import type { PointerEvent as ReactPointerEvent } from 'react'
import { positionToDirection, type DockviewApi, type DockviewGroupPanel, type Position } from 'dockview-react'

import { regionOfGroup } from '@/components/layout/dockview-column-ops'
import { ALL_DROP_ZONES, radialResolve } from '@/components/layout/drop-geometry'
import { ESCAPE_PRIORITY, pushEscapeLayer } from '@/lib/escape-layers'
import { createDragGhost, type DragGhost } from '@/lib/drag-ghost'
import type { SessionTabDropPosition } from './session-tab-bridge'

const DRAG_THRESHOLD_PX = 4

/** 拖起源行的压暗值（hermes session-drag.ts:120 逐字）。 */
const SOURCE_DIM_OPACITY = '0.45'

/** hideHeader 组（主栏 workspace）的可用方位 = 四边（无 center）：stack 进
 *  无条组 = 不可见也不可切的隐形标签死结（壳的 denyStackIntoHeaderless
 *  同款判据，面板标签拖拽走原生 DnD 由此守卫拦；本机器绕开 DnD 管线，
 *  须自行排除——中心的径向判定在无 center 集下按主轴倒向四边，死区归零，
 *  且正中点（dx=dy=0 → |dx|>=|dy| → dx 不 <0 → right）恰回旧版默认
 *  「右侧分栏」语义）。 */
const EDGE_ONLY_ZONES: ReadonlySet<Position> = new Set(['top', 'bottom', 'left', 'right'])

export interface SessionRowDragSpec {
  /** 松手在对话栏（region=chat）任一内容区上 → 按落点开该会话分栏。 */
  onCommitOpenTab(position: SessionTabDropPosition): void
  /** 指针跟随 chip 的标签（会话标题）——"鼠标上是空的"修复（2026-10-16，
   *  hermes createDragGhost 语义：来源行不像页签那样被拎起，chip 承载
   *  "手里拿着什么"）。 */
  ghostLabel: string
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

/** 活动布局 api（shell onReady 挂的 __dvApi 通道——column-ops 同款生产用法）。
 *  不在场 = 目标不可用，错误可见。 */
const dvApi = (): DockviewApi | undefined => {
  const a = (globalThis as { __dvApi?: DockviewApi }).__dvApi
  if (!a) console.error('[session-drag] 布局 api 不在场（__dvApi 未挂载）——跨面目标不可用')
  return a
}

interface DragTarget {
  group: DockviewGroupPanel
  rect: Rect
}

/** engage 快照：对话栏各组的**内容区**矩形（拖拽中布局不重组，全程纯数学）。 */
const chatTargets = (): DragTarget[] => {
  const a = dvApi()
  if (!a) return []
  const out: DragTarget[] = []
  for (const g of a.groups) {
    if (regionOfGroup(g) !== 'chat') continue
    const el = document.getElementById(g.model.contentContainerId)
    if (!(el instanceof HTMLElement)) continue
    const r = el.getBoundingClientRect()
    out.push({ group: g, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
  }
  return out
}

/** engaged 松手后吞掉恰一个合成 click（照抄旧版：commit 与 abort 的 click
 *  到达时机不同，disarm 分别对齐）。 */
function suppressDragClick(committed: boolean) {
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })

  const disarm = () => window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)

  if (committed) {
    disarm()
  } else {
    window.addEventListener('pointerup', disarm, { capture: true, once: true })
    window.addEventListener('pointercancel', disarm, { capture: true, once: true })
  }
}

/**
 * 起一次会话行跨面拖拽。阈值内松开 = 普通点击（切会话照常，机器不干预）；
 * 越阈值后落点与提交全由本会话接管，Esc 随时中止（dnd-kit 一侧的排序拖
 * 由 PointerSensor 原生 Esc 取消，两边同一次按键各自回到静止态）。
 */
export function startSessionRowDrag(e: ReactPointerEvent<Element>, spec: SessionRowDragSpec) {
  if (e.button !== 0) return

  // 把手（[data-reorder-handle]，自带 dnd-kit 完整监听）与行操作簇
  // （[data-row-actions]）/输入框/已打开的菜单：原生交互优先，行壳不重复起拖
  // （hermes session-row.tsx:385 同款豁免选择器）。
  const pressTarget = e.target as HTMLElement | null
  if (
    pressTarget?.closest(
      '[data-reorder-handle], [data-row-actions], input, textarea, [role="menu"], [role="dialog"]',
    )
  )
    return

  const handle = e.currentTarget as HTMLElement
  const { pointerId } = e
  const sx = e.clientX
  const sy = e.clientY
  const restoreCursor = document.body.style.cursor
  const restoreSelect = document.body.style.userSelect
  let engaged = false
  let releaseEscapeLayer: (() => void) | null = null
  // 源行内联 opacity 的恢复快照（还原到原行自身样式，不是硬写 ''）
  let restoreRowOpacity = ''
  let cursor: string | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null
  // 指针跟随 chip（engage 创建、finish 销毁——hermes drag-session 同款：
  // 来源行不像页签那样被拎起，chip 是"手里拿着什么"的可供性）
  let ghost: DragGhost | null = null

  // engage 快照：对话栏内容区（拖拽中布局不重组，全程纯数学）
  let targets: DragTarget[] = []
  // 当前悬停：目标 + 方位（null=拒绝区）。方位在悬停组内随指针变化，
  // 同组换方位也要重画 overlay。
  let hover: { target: DragTarget; position: Position } | null = null

  const setCursor = (value: string) => {
    if (cursor !== value) {
      cursor = value
      document.body.style.cursor = value
    }
  }

  const clearOverlay = () => {
    if (!hover) return
    // 只清本机器画过的组（overlay 是组级单例——不碰别人的）
    try {
      hover.target.group.model.contentDropTarget.clearOverlay()
    } catch (err) {
      // 组已销毁（拖拽中布局重组）——清场失败不拦提交，记录可见
      console.error('[session-drag] 落点预览清场失败', err)
    }
    hover = null
  }

  const publish = (next: { target: DragTarget; position: Position } | 'deny' | null) => {
    // 拒绝区：no-drop 光标，松手什么都不提交。光标每帧对齐（值变守卫）。
    setCursor(next && next !== 'deny' ? 'grabbing' : 'no-drop')
    if (next === 'deny') {
      clearOverlay()
      return
    }
    if (next && hover && next.target.group.id === hover.target.group.id && next.position === hover.position) return
    clearOverlay()
    if (!next) return
    hover = next
    // dockview 原生落点预览（半幅 sheet + 虚线框；CSS 变量已重映射旧设计）
    next.target.group.model.contentDropTarget.showOverlay(next.position)
  }

  const engage = () => {
    engaged = true

    try {
      handle.setPointerCapture?.(pointerId)
    } catch {
      // 合成事件（自动化）没有活动指针
    }

    setCursor('grabbing')
    document.body.style.userSelect = 'none'
    releaseEscapeLayer = pushEscapeLayer(ESCAPE_PRIORITY.drag)
    // 源行压暗 0.45 = 「picked up」反馈（hermes session-drag.ts:120 逐字）
    restoreRowOpacity = handle.style.opacity
    handle.style.setProperty('opacity', SOURCE_DIM_OPACITY)

    // 指针跟随 chip（hermes createDragGhost——「鼠标上是空的」修复）
    ghost = createDragGhost(spec.ghostLabel)
    ghost.moveTo(sx, sy)

    targets = chatTargets()
  }

  const resolve = (x: number, y: number) => {
    // 对话栏内容区 = 提交面；其余拒绝。
    const hit = targets.find((t) => rectContains(t.rect, x, y))
    if (!hit) {
      publish(null)
      return
    }
    // 径向几何（与面板标签拖拽同一份）：中心椭圆 = 堆叠，边缘 = 向该边分栏。
    // 无条组（主栏 workspace，hideHeader）收 center = 隐形标签死结 → 只收
    // 四边（EDGE_ONLY_ZONES，正中点自然倒向 right = 旧版默认分栏位）。
    const zones = hit.group.model.header.hidden ? EDGE_ONLY_ZONES : ALL_DROP_ZONES
    const position = radialResolve(
      zones,
      x - hit.rect.left,
      y - hit.rect.top,
      hit.rect.right - hit.rect.left,
      hit.rect.bottom - hit.rect.top,
    )
    if (!position) {
      publish('deny')
      return
    }
    publish({ target: hit, position })
  }

  const processMove = (x: number, y: number) => {
    if (!engaged) {
      if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) return
      engage()
    }

    resolve(x, y)
  }

  const flushMove = () => {
    raf = 0
    if (pending) {
      const { x, y } = pending
      pending = null
      processMove(x, y)
    }
  }

  const onMove = (ev: PointerEvent) => {
    pending = { x: ev.clientX, y: ev.clientY }
    // chip 跟手（悬停目标变化下一帧处理；chip 每帧直贴指针——hermes
    // drag-session 的 ghost.moveTo 在 processMove 里，但合帧后延迟可见，
    // 直贴更跟手且写的是同一个 el）
    ghost?.moveTo(ev.clientX, ev.clientY)
    raf ||= requestAnimationFrame(flushMove)
  }

  const finish = (commit: boolean) => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }

    // 落点按最终指针位置算，不是最后一帧的——提交前冲刷 pending move。
    // 中止（Esc / pointercancel）直接丢弃。
    if (commit && engaged) {
      flushMove()
    }

    document.body.style.cursor = restoreCursor
    document.body.style.userSelect = restoreSelect
    handle.style.opacity = restoreRowOpacity
    ghost?.destroy()
    ghost = null
    releaseEscapeLayer?.()
    releaseEscapeLayer = null

    try {
      handle.releasePointerCapture?.(pointerId)
    } catch {
      // 镜像 capture 守卫
    }

    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('keydown', onKey, true)

    if (engaged) {
      suppressDragClick(commit)

      if (commit && hover) {
        spec.onCommitOpenTab({
          referenceGroup: hover.target.group.id,
          direction: positionToDirection(hover.position),
        })
      }
      clearOverlay()
    }
  }

  const onUp = () => finish(true)
  const onCancel = () => finish(false)

  // Esc = 拖拽独占的"不要了"：高亮消失、什么都不提交（顶层逃生层）。
  // 不 stopPropagation：dnd-kit PointerSensor 的 Esc 取消挂在 document 冒泡段，
  // 捕获段阻断会连排序侧的取消一起杀死（实测踩过）。
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      finish(false)
    }
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('keydown', onKey, true)
}
