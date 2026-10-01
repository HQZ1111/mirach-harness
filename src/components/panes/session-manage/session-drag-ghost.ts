/**
 * 会话行拖拽的整行克隆浮层（dnd-kit DragOverlay 观感的 pointer-capture
 * 等价物，不引新依赖）：engage 时整行 cloneNode 快照成 fixed 定位浮层——
 * 尺寸=原行 rect、位置=按下点对原行的抓取偏移（光标按住行的哪一点，浮层
 * 就以那一点跟手）、内容=圆点/标题/⋯ 全量（快照即所见）；原行由调用方
 * （session-drag.ts）隐藏占位，浮层在任何路径（列表插入符 / 主页签 /
 * 拒绝区）都全程跟手，Esc/松手同步拆除。
 *
 * 纯 DOM（无 React）——与 lib/drag-ghost.ts 同一纪律：pointer capture
 * 拖拽期间不重渲染，拆除同步无闪帧。clone 剥掉行标记属性
 * （SESSION_ROW_ATTR 契约：按行标记找行的地方永不撞上浮层替身），并挂
 * aria-hidden（浮层是视觉替身，可访问性语义仍属原行）。
 *
 * 定位纯函数（rowGhostOffset / rowGhostTransform）导出供单测。
 */
import type { DragGhost } from '@/lib/drag-ghost'

/** 浮层抓取偏移：按下点到原行左上角的差（engage 时快照一次）。 */
export interface RowGhostOffset {
  dx: number
  dy: number
}

/** 纯函数：指针位置 → 抓取偏移（按下点 − 行左上角）。 */
export function rowGhostOffset(sx: number, sy: number, rect: { left: number; top: number }): RowGhostOffset {
  return { dx: sx - rect.left, dy: sy - rect.top }
}

/** 纯函数：指针位置 + 抓取偏移 → 浮层 transform（抓取点恒在光标下）。 */
export function rowGhostTransform(x: number, y: number, offset: RowGhostOffset): string {
  return `translate3d(${x - offset.dx}px, ${y - offset.dy}px, 0)`
}

/** 行元素上会被行查找逻辑消费的标记（与 session-drag.ts 的
 *  SESSION_ROW_ATTR / SESSION_ROW_GROUP_ATTR 同源——clone 上必须剥掉）。 */
const ROW_MARKER_DATASET_KEYS = ['sessionRowId', 'sessionRowGroup'] as const

/**
 * 从原行造浮层。样式走令牌：底=--surface（侧栏行的承载面——浮层扫过
 * 主区时透出的是不透明行面，hermes「Opaque surface while lifted」）、
 * 影=--shadow-pop；圆角/内边距随 className 快照自带。opacity 恒 1——
 * 调用方在 engage 时先把原行置 opacity:0 再走本工厂，快照会带上该内联
 * 值，浮层作为"被举起的那一行"必须显式压回不透明（CDP 实测踩过：
 * 浮层随源行一起透明 = 看不见跟手）。pointer-events none：浮层之下的
 * 事件全部按"浮层不在"处理，落点命中不被替身截胡。
 */
export function createRowDragGhost(row: HTMLElement, sx: number, sy: number): DragGhost {
  const rect = row.getBoundingClientRect()
  const offset = rowGhostOffset(sx, sy, rect)

  const el = row.cloneNode(true) as HTMLElement
  for (const key of ROW_MARKER_DATASET_KEYS) delete el.dataset[key]
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('data-session-drag-clone', '')
  el.style.cssText +=
    `;position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;` +
    'margin:0;opacity:1;pointer-events:none;z-index:9999;background:var(--surface);' +
    'box-shadow:var(--shadow-pop);will-change:transform'
  el.style.transform = rowGhostTransform(sx, sy, offset)
  document.body.appendChild(el)

  return {
    moveTo(x, y) {
      el.style.transform = rowGhostTransform(x, y, offset)
    },
    destroy() {
      el.remove()
    },
  }
}
