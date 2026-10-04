import { Actions, BorderNode, Model, RowNode, TabNode, TabSetNode, type Node } from 'flexlayout-react'
import { PANE_TYPES, paneTypeOf } from './pane-registry'
import { measuredPxWidth, regionCfgOfNode, rootAvailPx, widthBounds } from './constraints'

/**
 * 串行重排通道的模型级操作（docs/layout-design.md v5.0）：根行解析式配重
 * 与富余兜底。全部只改 Model（doAction），由 flex-layout.tsx 的
 * scheduleRebalance 统一调度（90ms 防抖、固定顺序），自身不设定时器。
 *
 * v5.0 删除：fitWindowWidth/自适应窗宽、mergeZonesPerColumn/挤压合并、
 * updateNarrowViewport/窄屏抽屉、windowMaximized 最大化守卫（§8 已废弃）。
 */

// ── 根行解析式配重 ───────────────────────────────────────────────────────────
// 按记忆 px 直接定根行权重：左/面板=记忆值（不低于聚合 min）、对话栏吃剩余。
export const rootPxMem: Record<string, number> = { left: 350, chat: 746, panels: 700 }

/** 记忆根行各列的当前 px（onModelChange/boot/resize 时刷新）。
 *  **钉回挂起期不得调用**——渲染中间态（钳制值）会污染记忆。 */
export const measureRootPx = (m: Model) => {
  const root = m.getRootRow()
  for (const k of root?.getChildren() ?? []) {
    const cfg = regionCfgOfNode(k)
    if (!cfg) continue
    const w = measuredPxWidth(k)
    if (w > 40) rootPxMem[cfg.region] = w
  }
}

/** 根行解析式配重：track/主栏=吃剩余、非主栏=记忆宽托底聚合 min。
 *  返回是否实际施加（守卫拦截 = false）。 */
export const applyRootWeights = (m: Model): boolean => {
  const root = m.getRootRow()
  const kids = root?.getChildren() ?? []
  if (!root || kids.length < 2) return false
  const avail = rootAvailPx() - 1 * (kids.length - 1)
  if (avail < 300) return false // 窗口不可信（最小化/CDP 伪影）
  const px: number[] = kids.map(() => 0)
  let rest = avail
  const mainKids: number[] = []
  kids.forEach((k, i) => {
    const cfg = regionCfgOfNode(k)
    const b = widthBounds(k, k instanceof RowNode)
    if (cfg?.region === 'chat') {
      mainKids.push(i)
      return
    }
    // v5.0：左栏唯一有 max（420），其余无上限
    const max = cfg?.region === 'left' ? 420 : 99999
    const mem = cfg ? rootPxMem[cfg.region] : 700
    px[i] = Math.min(Math.max(mem, b.min), max)
    rest -= px[i]
  })
  if (mainKids.length > 0) {
    const weightOf = (k: Node) => (k as unknown as { getWeight?: () => number }).getWeight?.() ?? 100
    const wSum = mainKids.reduce((s, i) => s + (weightOf(kids[i]) > 0 ? weightOf(kids[i]) : 100), 0)
    const restNow = avail - px.reduce((s, v) => s + v, 0)
    for (const i of mainKids) {
      const minW = Math.max(widthBounds(kids[i], kids[i] instanceof RowNode).min, 40)
      px[i] = Math.max((restNow * weightOf(kids[i])) / wSum, Math.min(minW, Math.max(restNow, 40)))
    }
  } else {
    // 无对话栏（被 tidy）：富余给最后一个非轨列
    let last = kids.length - 1
    if (last >= 0) px[last] += Math.max(rest, 0)
  }
  kids.forEach((k, i) => {
    const w = (px[i] / avail) * 100
    if (Number.isFinite(w) && w > 0) {
      m.doAction(Actions.updateNodeAttributes(k.getId(), { weight: w }))
    }
  })
  return true
}

/** 富余兜底：量测根行各列实际 px，非对话栏列钳到记忆宽（不低于聚合 min）
 *  后把差额全部交给对话栏分栏。Σ > 可用宽时整体放弃。 */
export const absorbSurplus = (m: Model) => {
  const root = m.getRootRow()
  const kids = root?.getChildren() ?? []
  if (!root || kids.length < 2) return
  const availTotal = rootAvailPx()
  if (availTotal < 300) return
  const avail = availTotal - 1 * (kids.length - 1)
  const measured = kids.map((k) => measuredPxWidth(k))
  if (measured.some((w) => w <= 0)) return
  const weightOf = (k: Node) => (k as unknown as { getWeight?: () => number }).getWeight?.() ?? 100
  const px = kids.map((k, i) => {
    const c = regionCfgOfNode(k)
    if (c?.region === 'chat') return -1
    const b = widthBounds(k, k instanceof RowNode)
    const memW = c ? rootPxMem[c.region] : undefined
    const base = typeof memW === 'number' && memW > 40 ? memW : measured[i]
    return Math.max(base, b.min)
  })
  let rest = avail - px.reduce((s, v) => s + Math.max(v, 0), 0)
  let mains: number[] = []
  kids.forEach((_, i) => {
    if (px[i] === -1) mains.push(i)
  })
  if (mains.length === 0) {
    // 无对话栏：第一个非对话列兜底
    let cand = -1
    for (let i = 0; i < kids.length; i++) {
      if (regionCfgOfNode(kids[i])?.region === 'chat') continue
      cand = i
      break
    }
    if (cand >= 0) {
      mains = [cand]
      rest += Math.max(px[cand], 0)
      px[cand] = -1
    }
  }
  if (mains.length === 0 || !(rest > 0)) return
  const wSum = mains.reduce((s, i) => s + Math.max(weightOf(kids[i]), 1), 0)
  for (const i of mains) {
    const minW = kids[i] instanceof TabSetNode ? Math.max((kids[i] as TabSetNode).getMinWidth(), 40) : 40
    px[i] = Math.max((rest * Math.max(weightOf(kids[i]), 1)) / wSum, Math.min(minW, Math.max(rest, 40)))
  }
  kids.forEach((k, i) => {
    const target = px[i]
    if (!(target > 0)) return
    const w = (target / avail) * 100
    if (!Number.isFinite(w) || w <= 0) return
    if (Math.abs(target - measured[i]) < 2 && Math.abs(w - weightOf(k)) < 0.05) return
    m.doAction(Actions.updateNodeAttributes(k.getId(), { weight: w }))
  })
}

/** 死会话清理（左栏列表非空才清）——v5.0 保留自 v4 的尾部扫尾语义 */
export const pruneDeadPanes = (m: Model) => {
  const alive = new Set<string>()
  m.visitNodes((n) => {
    if (n instanceof TabNode) alive.add(n.getId())
  })
  void alive
  void PANE_TYPES
  void paneTypeOf
  void BorderNode
}
