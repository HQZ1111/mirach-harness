import { Model, Orientation, RowNode, TabSetNode, type Node } from 'flexlayout-react'
import { SPLITTER_PX } from './layout-presets'
import { zoneConfigOf, type Region } from './pane-registry'

/**
 * 约束几何（纯函数，docs/layout-design.md v5.0 §2/§3）：行/tabset 树沿宽度
 * 轴的聚合界限（min）、根行可用宽量测、顶带判定、region 读取。
 * 不含 React、不含动作提交。
 */
export const regionCfgOfNode = (n: Node): { region: Region; track: boolean } | undefined => {
  if (n instanceof TabSetNode) {
    const cfg = zoneConfigOf(n)
    return cfg ? { region: cfg.region, track: false } : undefined
  }
  if (n instanceof RowNode) {
    const walk = (kids: Node[]): { region: Region; track: boolean } | undefined => {
      for (const c of kids) {
        if (c instanceof TabSetNode) {
          const cfg = zoneConfigOf(c)
          if (cfg) return { region: cfg.region, track: false }
        } else if (c instanceof RowNode) {
          const deep = walk(c.getChildren())
          if (deep) return deep
        }
      }
      return undefined
    }
    return walk(n.getChildren())
  }
  return undefined
}

/** 根行子节点的实测 px 宽：直接取 flexlayout 布局矩形。 */
export const measuredPxWidth = (n: Node): number => {
  try {
    const r = (n as { getRect?: () => { width: number } }).getRect?.()
    return r?.width ?? 0
  } catch {
    return 0
  }
}

/** 根行可用宽：宿主宽。 */
export const rootAvailPx = (): number => {
  const host = document.querySelector('.flexlayout-host') as HTMLElement | null
  if (!host) return 0
  return host.clientWidth
}

/** 子树沿宽度轴的聚合 min：tabset=自身 min；行按方向聚合——垂直行 min=MAX(子)，
 *  水平行 min=Σ(子)+缝。max 恒 99999（v5.0：无上限）。 */
export const widthBounds = (n: Node, vert: boolean): { min: number; max: number } => {
  if (n instanceof TabSetNode) {
    return { min: n.getMinWidth(), max: 99999 }
  }
  if (n instanceof RowNode) {
    const kids = n.getChildren()
    const gaps = 1 * Math.max(kids.length - 1, 0)
    let min = 0
    if (vert) {
      for (const c of kids) min = Math.max(min, widthBounds(c, false).min)
    } else {
      for (const c of kids) min += widthBounds(c, true).min
      min += gaps
    }
    return { min, max: 99999 }
  }
  return { min: 0, max: 99999 }
}

/** 分栏是否在窗口顶带（沿父链上行——VERT 行只有第一个孩子在顶带）。 */
export const isTopBand = (rootRow: RowNode | undefined, n: Node): boolean => {
  let cur: Node = n
  for (;;) {
    const p = cur.getParent()
    if (!(p instanceof RowNode)) return false
    if (p.getOrientation() === Orientation.VERT && p.getChildren()[0] !== cur) return false
    if (p === rootRow) return true
    cur = p
  }
}

/** 根行装下所需的最小宽：Σ(各列聚合 min) + 缝 */
export const rootNeededMin = (m: Model): number => {
  const kids = m.getRootRow()?.getChildren() ?? []
  let sum = 0
  for (const k of kids) {
    sum += widthBounds(k, k instanceof RowNode).min
  }
  return sum + SPLITTER_PX * Math.max(kids.length - 1, 0)
}
