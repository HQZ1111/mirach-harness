import { Actions, Model, Orientation, RowNode, TabSetNode, type Node } from 'flexlayout-react'
import { REGION_LIMITS, zoneConfigOf } from './pane-registry'
import { rootAvailPx } from './constraints'

/**
 * 约束应用器 syncTabsetConstraints（docs/layout-design.md v5.0 §2/§3）——
 * **静态三栏校验**：三栏固定后，这里只剩三件事：
 *   ①min/max 下发（左栏唯一有 max 420）；
 *   ②上下行数限制（≤2，竖分不可再分）——超限的冗余竖分结构不存在于出厂树，
 *     拖拽投放层已拒，此处仅防御；
 *   ③config 跟随所在列（页签不会跨栏，但防御旧档/异常）。
 * diff 门控：属性一致不发动作。
 */
export const syncTabsetConstraints = (m: Model) => {
  const rootRow = m.getRootRow()
  const rootKids = rootRow?.getChildren() ?? []

  // 每个根行子项的列 region：沿父链上溯 = 根行直接子项，读 config.region；
  // 无戳（异常）按位置兜底——中间=chat，最右=panels，最左=left
  const kidRegion = new Map<string, 'left' | 'chat' | 'panels'>()
  rootKids.forEach((k, i) => {
    let r: 'left' | 'chat' | 'panels' | undefined
    const walk = (n: Node): void => {
      if (r) return
      if (n instanceof TabSetNode) {
        const cfg = zoneConfigOf(n)
        if (cfg) { r = cfg.region; return }
      }
      const kids = typeof n.getChildren === 'function' ? n.getChildren() : []
      for (const c of kids) walk(c)
    }
    walk(k)
    if (!r) r = rootKids.length === 3 ? (i === 0 ? 'left' : i === 1 ? 'chat' : 'panels') : i === rootKids.length - 1 ? 'panels' : 'chat'
    kidRegion.set(k.getId(), r)
  })

  // 可用宽（三栏间 2 条缝）
  const avail = rootAvailPx() - 1 * Math.max(rootKids.length - 1, 0)

  m.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    if (node.getChildren().length === 0) return
    const parent = node.getParent()
    const parentRow = parent instanceof RowNode ? parent : undefined
    const alongWidth = parentRow ? parentRow.getOrientation() === Orientation.HORZ : true

    let rootKid: Node = node
    for (;;) {
      const p = rootKid.getParent()
      if (!p || p === rootRow) break
      rootKid = p
    }
    const region = kidRegion.get(rootKid.getId()) ?? 'chat'
    const patch: Record<string, unknown> = {}

    // config 跟随所在列（防御旧档；diff 门控下常态零动作）
    const oldCfg = zoneConfigOf(node)
    if (!oldCfg || oldCfg.region !== region) {
      patch.config = { region }
    }

    // min/max 下发：沿宽度轴的直属子项才有宽约束（堆叠非首行跟随列宽）
    if (alongWidth) {
      const lim = REGION_LIMITS[region]
      let minW = lim.minW
      // 过承诺缩让（Σmin > avail 时按比例，底线 40）
      if (region === 'chat' || region === 'panels') {
        let nonChatMin = 0
        let chatTabs = 0
        for (const k of rootKids) {
          const r = kidRegion.get(k.getId())
          if (r === 'chat') chatTabs++
          else if (r !== undefined) nonChatMin += REGION_LIMITS[r].minW
        }
        const scaled = chatTabs > 0 ? Math.floor((avail - nonChatMin) / chatTabs) : lim.minW
        if (scaled < minW) minW = Math.max(scaled, 40)
      }
      if (node.getMinWidth() !== minW) patch.minWidth = minW
      if (region === 'left' && node.getMaxWidth() !== REGION_LIMITS.left.maxW) patch.maxWidth = REGION_LIMITS.left.maxW
    } else {
      if (node.getMinWidth() !== 0) patch.minWidth = 0
    }

    // 高度：垂直堆叠不设限（min 由标题条天然保证）
    if (parentRow && parentRow.getOrientation() === Orientation.VERT) {
      if (node.getMinHeight() !== 0) patch.minHeight = 0
      if (node.getMaxHeight() !== 99999) patch.maxHeight = 99999
    }

    if (Object.keys(patch).length > 0) {
      m.doAction(Actions.updateNodeAttributes(node.getId(), patch))
    }
  })
}
