import { Model, Orientation, RowNode, TabSetNode, type Node } from 'flexlayout-react'
import { SPLITTER_PX } from './layout-presets'
import { TRACK_W, zoneConfigOf, type Region } from './pane-registry'

/**
 * 约束几何（纯函数，docs/layout-design.md §2/§2.3）：行/tabset 树沿宽高
 * 两轴的聚合界限（MIN/MAX/Σ）、拖拽权重钳制（保险网）、根行可用宽量测、
 * 顶带判定、region 读取。不含 React、不含动作提交。
 */
export const regionCfgOfNode = (n: Node): { region: Region; track: boolean } | undefined => {
  if (n instanceof TabSetNode) {
    const cfg = zoneConfigOf(n)
    return cfg ? { region: cfg.region, track: cfg.track === true } : undefined
  }
  if (n instanceof RowNode) {
    // flexlayout 的行属性**不含 config**（JSON 里的 row.config 被解析丢弃，
    // 2026-09-26 实测踩过：右列 row 被当无身份 → px=0 → 主栏吸收区吃下
    // 全部富余）——下钻子树取第一个带配置的 tabset
    const walk = (kids: Node[]): { region: Region; track: boolean } | undefined => {
      for (const c of kids) {
        if (c instanceof TabSetNode) {
          const cfg = zoneConfigOf(c)
          if (cfg) return { region: cfg.region, track: cfg.track === true }
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

/** 根行子节点的实测 px 宽：**直接取 flexlayout 布局矩形**（getRect 由库
 *  在布局时维护，与 getSplitterBounds 同源），不再查 DOM——行/页签集通
 *  用，且天然规避 data-layout-path 选择器的转义与失效风险。布局未就绪
 *  （rect 为空）时返回 0，由调用方的就绪守卫兜住。 */
export const measuredPxWidth = (n: Node): number => {
  try {
    const r = (n as { getRect?: () => { width: number } }).getRect?.()
    return r?.width ?? 0
  } catch {
    return 0
  }
}

/** 根行可用宽：宿主宽 − 可见左右边框轨条（折叠轨占位；autoHide 空轨为
 *  0/不渲染）。window.innerWidth 会把壳边框与折叠轨条都算进去，配重就
 *  会多出一条缝（AGENTS 记载的 +6px 偏置同源）。 */
export const rootAvailPx = (): number => {
  const host = document.querySelector('.flexlayout-host') as HTMLElement | null
  if (!host) return 0
  let avail = host.clientWidth
  for (const side of ['left', 'right']) {
    const bar = document.querySelector(`.flexlayout__border_${side}`) as HTMLElement | null
    if (bar) avail -= bar.offsetWidth
  }
  return avail
}

/** 子树沿宽度轴的聚合约束：tabset=大栏 min（轨=20 固定，**v4.0：栏无
 *  上限，max 恒 99999**）；行按方向聚合——垂直行（子项横跨整行）宽
 *  min=MAX(子)，水平行（并排）宽 min=Σ。行的方向按深度交替（根=水平，
 *  子行=垂直）。max 侧不再聚合（v4.0：上限废除；行内无轨——轨是根行
 *  直接子项，嵌套 max 无从产生）。 */
export const widthBounds = (n: Node, vert: boolean): { min: number; max: number } => {
  if (n instanceof TabSetNode) {
    const cfg = zoneConfigOf(n)
    if (cfg?.track) return { min: TRACK_W, max: TRACK_W }
    // 读节点**实际生效**的 min（sync 已按堆叠语境清过：垂直堆叠分栏宽度
    // 跟随所在列 [0,∞]——不能回头按大栏限制表钳）
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

/** 分栏是否在窗口顶带（条 100 高的双重身份=标题栏拖拽区/窗口按钮让位，
 *  只属于窗口顶带）：沿父链上行——VERT 行只有第一个孩子在顶带（其余被
 *  堆在下方）；HORZ 行孩子并排同高、全体都算。到达根行 = 顶带。
 *  上下分栏的非顶部分栏（如终端）条降到 --strip-low-height（用户
 *  2026-09-27："分栏如果是上下分栏，100 就太高了"）。 */
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

/** 根行装下所需的最小宽：Σ(各列聚合 min) + Σ(轨 20) + 缝 */
export const rootNeededMin = (m: Model): number => {
  const kids = m.getRootRow()?.getChildren() ?? []
  let sum = 0
  for (const k of kids) {
    const cfg = regionCfgOfNode(k)
    if (cfg?.track) {
      sum += TRACK_W
      continue
    }
    sum += widthBounds(k, k instanceof RowNode).min
  }
  return sum + SPLITTER_PX * Math.max(kids.length - 1, 0)
}
