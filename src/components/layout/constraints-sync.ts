import { Actions, Model, Orientation, RowNode, TabNode, TabSetNode, type Node as FLNode, type Node } from 'flexlayout-react'
import { PANE_TYPES, REGION_LIMITS, paneTypeOf, siblingMainZoneOf, stripVisibleOf, zoneConfigOf } from './pane-registry'
import { syncOpenAnchor } from './column-ops'
import { rootAvailPx } from './constraints'

/**
 * 约束应用器（docs/layout-design.md v7.0 §1/§5）：
 *   ①**语义戳重算**（tabset.region = 锚页签的语义 region——约束跟内容走，
 *     不跟位置走；"在哪栏分继承哪栏"废除）；
 *   ②min/max 按语义戳下发（左栏唯一有 max 420）；
 *   ③页签条显隐 ladder（hermes strip-visibility）；
 *   ④打开页锚/空白分栏清除由 syncOpenAnchor 管（column-ops）。
 * diff 门控：属性一致不发动作。
 */

/** tabset 的语义戳 = 第一个有语义页签的 region（锚页签，docs v7.0 §1）。
 *  external（打开文件/网页/子智能体占位）→ panels；无语义页签 → 保留
 *  现戳；无戳 → 'chat'（吸收者兜底）。 */
const semanticStampOf = (set: TabSetNode): 'left' | 'chat' | 'panels' => {
  for (const c of set.getChildren()) {
    if (!(c instanceof TabNode)) continue
    const t = paneTypeOf(c.getId())
    if (t) return PANE_TYPES[t].region
    if (c.getComponent?.() === 'external') return 'panels'
  }
  return zoneConfigOf(set)?.region ?? 'chat'
}

/** 语义戳重算（结构动作后同步跑 + sync 兜底；diff 门控——不在遍历中改
 *  模型，先收集 patch 再统一提交）。 */
export const syncSemanticStamps = (m: Model): void => {
  const patches: { id: string; region: 'left' | 'chat' | 'panels' }[] = []
  m.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    if (node.getChildren().length === 0) return
    const region = semanticStampOf(node)
    if (zoneConfigOf(node)?.region !== region) patches.push({ id: node.getId(), region })
  })
  for (const p of patches) {
    const node = m.getNodeById(p.id)
    if (!(node instanceof TabSetNode)) continue
    const stripMode = zoneConfigOf(node)?.stripMode
    m.doAction(
      Actions.updateNodeAttributes(p.id, {
        config: { region: p.region, ...(stripMode ? { stripMode } : {}) },
      }),
    )
  }
}

export const syncTabsetConstraints = (m: Model) => {
  // 语义戳先行（kidRegion/约束都按它）
  syncSemanticStamps(m)

  const rootRow = m.getRootRow()
  const rootKids = rootRow?.getChildren() ?? []

  // 根行子项的列 region = 子项第一个 tabset 的语义戳（已在上面重算）。
  // 无戳（异常）按位置兜底。
  const kidRegion = new Map<string, 'left' | 'chat' | 'panels'>()
  rootKids.forEach((k, i) => {
    let r: 'left' | 'chat' | 'panels' | undefined
    const walk = (n: FLNode): void => {
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

  syncOpenAnchor(m)

  // 可用宽（根行子项间 n-1 条缝）
  const avail = rootAvailPx() - 1 * Math.max(rootKids.length - 1, 0)

  m.visitNodes((node) => {
    if (node instanceof TabNode) {
      // 打开页锚（v6.0）：open 签不参与拖拽（旧档/异常兜底——出厂/重建
      // json 已带 enableDrag:false）
      if (node.getId() === 'open') {
        let drag: boolean | undefined
        try {
          drag = (node as unknown as { isEnableDrag?: () => boolean }).isEnableDrag?.()
        } catch {
          drag = undefined
        }
        if (drag !== false) m.doAction(Actions.updateNodeAttributes('open', { enableDrag: false }))
      }
      return
    }
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

    // v7.0：config.region 由语义戳管（syncSemanticStamps），这里不再按
    // 位置写 config——stripMode 随戳更新时由 syncSemanticStamps 保留。

    // 页签条显隐（hermes strip-visibility ladder）：左栏恒无条；搁浅（孤
    // 可关签）强制在位；手动 stripMode 次之；缺省自动；孤主会话页签在另
    // 一根对话分栏在场时条在位（siblingMainZone——双对话分栏各需把手）。
    // 测试替身的原型方法会因缺内部字段抛错——抛错等同"读不到"，不算差异。
    const stripOn = stripVisibleOf(node, region, undefined, siblingMainZoneOf(m))
    let stripNow: boolean | undefined
    try {
      stripNow = (node as unknown as { isEnableTabStrip?: () => boolean }).isEnableTabStrip?.()
    } catch {
      stripNow = undefined
    }
    if (stripNow !== undefined && stripNow !== stripOn) patch.enableTabStrip = stripOn

    // min/max 下发：沿宽度轴的直属子项才有宽约束（堆叠非首行跟随列宽）
    if (alongWidth) {
      const lim = REGION_LIMITS[region]
      let minW = lim.minW
      // 过承诺缩让（Σmin > avail 时按比例，底线 40）
      if (region === 'chat' || region === 'panels') {
        let nonChatMin = 0
        let chatCount = 0
        for (const k of rootKids) {
          const r = kidRegion.get(k.getId())
          if (r === 'chat') chatCount++
          else if (r !== undefined) nonChatMin += REGION_LIMITS[r].minW
        }
        const scaled = chatCount > 0 ? Math.floor((avail - nonChatMin) / chatCount) : lim.minW
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

/** 面板栏列子树里 depth-first 第一个 tabset（open 空态锚的宿主）。 */
const firstTabsetOf = (n: Node): TabSetNode | undefined => {
  if (n instanceof TabSetNode) return n
  for (const c of n.getChildren()) {
    const f = firstTabsetOf(c)
    if (f) return f
  }
  return undefined
}

/** 面板栏顶组 id：region=panels 的根行子项的第一个 tabset。 */
export const panelsKidTopSetId = (
  m: Model,
  kidRegion?: Map<string, 'left' | 'chat' | 'panels'>,
): string | undefined => {
  const rootRow = m.getRootRow()
  const rootKids = rootRow?.getChildren() ?? []
  const panelsKid = rootKids.find((k) => {
    const r = kidRegion?.get(k.getId()) ?? regionOfNodeShallow(k)
    return r === 'panels'
  })
  return panelsKid ? firstTabsetOf(panelsKid)?.getId() : undefined
}

/** 根行子项的 region（无 kidRegion 缓存时的独立读法）。 */
const regionOfNodeShallow = (n: Node): 'left' | 'chat' | 'panels' | undefined => {
  const walk = (x: Node): 'left' | 'chat' | 'panels' | undefined => {
    if (x instanceof TabSetNode) {
      const region = zoneConfigOf(x)?.region
      if (region) return region
    }
    for (const c of x.getChildren()) {
      const deep = walk(c)
      if (deep) return deep
    }
    return undefined
  }
  return walk(n)
}
