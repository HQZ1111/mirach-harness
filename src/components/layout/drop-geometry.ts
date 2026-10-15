/**
 * 拖拽落点几何（hermes radial 判定移植，2026-10-15）——面板标签拖出分栏的
 * 「上下判定不灵敏」修复与会话条拖出分栏共用同一份几何。
 *
 * 背景（CDP 实测）：dockview 内置 quadrant = 固定 20% 带 + **先横后纵**
 * （calculateQuadrantAsPercentage 里 left→right→top→bottom 的短路序）——
 * 左下角 (15%, 90%) 实测判 `left`，用户要的上下分栏几乎点不中。hermes 的
 * drag-session.ts radialPosition 是径向判定：中心椭圆（CENTER_RADIUS 0.62）
 * 内 = center；椭圆外按**主轴主导**（|dx| >= |dy| 取左右，否则取上下）——
 * 角区沿象限对角线自然倒向最近边，边界随目标宽高比弯曲而非固定像素带。
 *
 * 两份消费：
 * ① dockview `dropPositionResolver`（dockview-shell 注入）——替换面板标签
 *    拖拽对组内容区/布局边缘目标的默认 quadrant；
 * ② 会话行跨面拖拽（session-drag.ts）——手动 showOverlay 前先算方位。
 *
 * zones 语义：dockview 的 PositionResolverArgs 带「本目标当前接受的方位集」
 * （如内容目标 = 五方位全收；某些内部目标只收左右）——主轴不在集内时回退
 * 次轴，再回退 center，全不可达 = null（该帧无落点预览，与 hermes 一致：
 * 无合法方位即无提示）。
 */
import type { Position, PositionResolver } from 'dockview-react'

/** 中心椭圆半径（hermes drag-session.ts:49 CENTER_RADIUS 逐字值）。 */
export const CENTER_RADIUS = 0.62

/** 五方位全集（会话条拖拽的组内容目标恒收全部方位）。 */
export const ALL_DROP_ZONES: ReadonlySet<Position> = new Set([
  'top',
  'bottom',
  'left',
  'right',
  'center',
])

/**
 * 径向判定（hermes radialPosition 语义 + 受限 zones 回退）。x/y = 目标元素
 * 内坐标（px，左上原点）；width/height = 目标尺寸。返回 null = 无可用方位。
 */
export function radialResolve(
  zones: ReadonlySet<Position>,
  x: number,
  y: number,
  width: number,
  height: number,
  centerRadius = CENTER_RADIUS,
): Position | null {
  // 目标中心坐标系：±1 = 边缘中点（hermes 同款归一化）。
  const dx = (x / Math.max(1, width)) * 2 - 1
  const dy = (y / Math.max(1, height)) * 2 - 1

  if (Math.hypot(dx, dy) < centerRadius && zones.has('center')) return 'center'

  // 主轴主导（|dx| >= |dy| → 水平轴），主轴不在集内回退次轴，再回退 center。
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const primary: Position = horizontal ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
  const secondary: Position = horizontal ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right'

  if (zones.has(primary)) return primary
  if (zones.has(secondary)) return secondary
  if (zones.has('center')) return 'center'
  return null
}

/**
 * dockview dropPositionResolver 实例（模块级常量 = 稳定身份，不随渲染换）。
 * 挂 dockview-shell 的 DockviewReact props——组内容目标与整布局边缘目标
 * **共享同一 resolver**（源码实证：DockviewGroupPanel 的 html5/pointer
 * dropTarget 与 RootDropTargetService 都读 host.options.dropPositionResolver），
 * 所以必须自行区分「谁在问」：
 *
 * **只覆盖组内容目标（.dv-content-container），其余（root 整布局目标）
 * 回 null = 放弃覆盖**。CDP 实锤（2026-10-16）：不区分时 root 也按径向解，
 * 整个窗口被 root 抢成「布局边缘投放」——标签拖到对话列下缘松手变成
 * 整行全宽底栏（dockToLayoutEdge），而非对话列内的上下分栏。root 原生
 * 语义 = 窗口外缘 10px 像素带的整布局停靠（DEFAULT_ROOT_OVERLAY_MODEL
 * activationSize:pixels 10）；本应用三栏定式 + hermes 语义（分栏只相对
 * 悬停组）不需要它 → root 一律放弃。
 *
 * 区分依据 = `event.currentTarget`（HTML5 后端：handler 注册在目标元素上，
 * 分发期间 currentTarget = 该元素；内容目标 = .dv-content-container，
 * root = 宿主元素）。pointer 后端（触屏）其 currentTarget 不可靠（窗口级
 * 监听分发）→ classList 检查不命中即 null，触屏回退 dockview 默认 quadrant
 * （不劣于引入本 resolver 之前）。
 */
export const radialDropResolver: PositionResolver = {
  resolve: (args) => {
    const current = args.event.currentTarget as HTMLElement | null
    if (!current || !current.classList.contains('dv-content-container')) return null
    const position = radialResolve(args.zones, args.x, args.y, args.width, args.height)
    return position ? { position } : null
  },
}
