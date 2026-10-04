import { Actions, BorderNode, DockLocation, Model, RowNode, TabNode, TabSetNode, type Node } from 'flexlayout-react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { SPLITTER_PX } from './layout-presets'
import { PANE_TYPES, PRIMARY_PANE, REGION_LIMITS, TRACK_W, paneTypeOf, zonePaneTypes, type Region } from './pane-registry'
import { useLayoutStore } from '@/store/layout-store'
import { appWindow, inTauri } from '@/lib/tauri-window'
import { measuredPxWidth, regionCfgOfNode, rootAvailPx, rootNeededMin, widthBounds } from './constraints'

/**
 * 串行重排通道的模型级操作（docs/layout-design.md §9）：自适应窗宽、
 * 挤压合并、动态窄屏判定、根行解析式配重与富余兜底、px 记忆。
 * 全部只改 Model（doAction），由 flex-layout.tsx 的 scheduleRebalance
 * 统一调度（90ms 防抖、固定顺序），自身不设定时器。
 */
/** 设计窗宽（与 src-tauri/main.rs 的 DESIGN_W、tauri.conf 一致） */
export const DESIGN_WIDTH = 1800

/** 最小窗宽（用户 2026-09-27 定稿：挤压级联到底=600；高度 min 600 上不限
 *  在 tauri.conf）。与 tauri.conf minWidth 同步。 */
export const MIN_WINDOW_WIDTH = 600

/** 自适应窗宽（用户 2026-09-26 定稿）：Σ(各列聚合 min) + 轨 + 缝 > 当前
 *  窗宽（装不下新栏/约束溢出）→ 窗宽自动长到 need（钳到屏幕可用宽）；
 *  关栏/合并腾出空间（need ≤ 设计宽 1800，且仅结构动作触发）→ 回 1800。
 *  仅 Tauri 生效；窄屏抽屉模式不参与（窄屏下侧栏撤成 overlay，根行 Σmin
 *  本来就小）。allowGrowRevert = 结构动作触发（手动缩窗走挤压级联，不长
 *  窗）。 */
/** 最大化同步标志（fitWindowWidth 顶部判定用；由 flex-layout 的
 *  onResized 监听维护——isMaximized 是异步查询，只能换成标志）。 */
let windowMaximized = false

export const setWindowMaximized = (v: boolean): void => {
  windowMaximized = v
}

export const fitWindowWidth = (m: Model, allowGrowRevert: boolean) => {
  if (!inTauri || !appWindow) return
  if (useLayoutStore.getState().narrowViewport) return
  // 最大化窗口不受自适应窗宽管辖（用户最大化 = 独占工作区的意图，
  // revert/grow 都会把几何砸回 1800）。
  if (windowMaximized) return
  const rootRow = m.getRootRow()
  const kids = rootRow?.getChildren() ?? []
  if (kids.length === 0) return
  let minSum = 0
  for (const k of kids) {
    const cfg = regionCfgOfNode(k)
    if (cfg?.track) {
      minSum += TRACK_W
      continue
    }
    minSum += widthBounds(k, k instanceof RowNode).min
  }
  const gaps = SPLITTER_PX * Math.max(kids.length - 1, 0)
  const need = minSum + gaps + 2 /*壳 1px 边框 ×2 = 所需 inner 宽*/
  const curInner = window.innerWidth
  const outerDelta = Math.max(window.outerWidth - window.innerWidth, 0)
  let target: number
  if (allowGrowRevert && need > curInner) {
    target = need + outerDelta
  } else if (allowGrowRevert && curInner > DESIGN_WIDTH + 2 && need <= DESIGN_WIDTH) {
    target = DESIGN_WIDTH + outerDelta
  } else {
    return
  }
  const availW = window.screen?.availWidth ?? target
  const finalW = Math.max(MIN_WINDOW_WIDTH, Math.min(target, availW))
  if (Math.abs(finalW - window.outerWidth) <= 4) return
  void appWindow
    .setSize(new LogicalSize(finalW, window.outerHeight))
    .catch((e) => console.error('[rebalance] 自适应窗宽 setSize 失败', e))
}

// ── 根行解析式配重（竖轨引入的 20px 节点会触发权重归一化重排——
// 富余被顶到各分栏 max 钳制后 flexbox 无人吸收 → 白带）。按记忆 px
// 直接定根行权重：track=20、左右栏=记忆值（钳进约束）、主栏吃剩余。
export const rootPxMem: Record<Region, number> = { left: 350, main: 746, right: 700 }

/** 记忆根行各列的当前 px（onModelChange/boot/resize 时刷新）。
 *  **钉回挂起期（pinPending）不得调用**——渲染中间态（钳制值）会污染
 *  记忆（hidePin 契约，见 flex-layout pinAfterLayout）。 */
export const measureRootPx = (m: Model) => {
  const root = m.getRootRow()
  for (const k of root?.getChildren() ?? []) {
    const cfg = regionCfgOfNode(k)
    if (!cfg || cfg.track) continue
    const w = measuredPxWidth(k)
    if (w > 40) rootPxMem[cfg.region] = w
  }
}

/** 根行解析式配重（竖轨引入的 20px 节点会触发权重归一化重排——
 *  富余被顶到各分栏 max 钳制后 flexbox 无人吸收 → 白带）。按记忆 px
 *  直接定根行权重：track=20、左右栏=记忆值（钳进约束）、主栏吃剩余。
 *  返回是否实际施加（守卫拦截 = false，调用方可顺延重试——
 *  整侧收起/恢复的 pinAfterLayout 依赖此值）。
 *
 *  语义照抄 hermes 的**声明式固定轨道**（controller.tsx：zone 宽度是
 *  声明 px，不参与兄弟再分配）+ ZCode 的 expandedSize 记忆
 *  （useAnimatedResizablePanel：panel.expand() 时 resize 回记忆尺寸）：
 *  flexlayout 删列从不归一化剩余兄弟权重（RowNode.tidy 只删空子行），
 *  渲染按 weight/Σ 比例膨胀——整侧收起后必须显式把在场固定轨钉回
 *  记忆宽，禁止默认再归一结果裸露到渲染。 */
export const applyRootWeights = (m: Model): boolean => {
  const root = m.getRootRow()
  const kids = root?.getChildren() ?? []
  if (!root || kids.length < 2) return false
  const avail = rootAvailPx() - SPLITTER_PX * (kids.length - 1)
  if (avail < 300) return false // 窗口不可信（最小化/CDP 伪影），配重会烙进存档
  // （v4.0 清理：原"布局未就绪"守卫依赖聚合 max 的有限性——上限废除后
  // 恒 99999，守卫永真；min 侧目标有记忆 px 托底，0 目标失败模式不存在）
  const px: number[] = kids.map(() => 0)
  let rest = avail
  kids.forEach((k, i) => {
    const cfg = regionCfgOfNode(k)
    if (cfg?.track) {
      px[i] = TRACK_W
      rest -= TRACK_W
      return
    }
    if (cfg?.region === 'main') return // 主栏吃剩余
    // v4.0：max 上限已废除——目标 = 记忆宽、不低于聚合 min
    const b = widthBounds(k, k instanceof RowNode)
    const mem = cfg ? rootPxMem[cfg.region] : 700
    px[i] = Math.max(mem, b.min)
    rest -= px[i]
  })
  const mainKids = kids.filter((k) => {
    const c = regionCfgOfNode(k)
    return c?.region === 'main' && !c.track
  })
  // 亏空防护（审查 A-2）：clamp 后 Σ非主栏 > avail（窄窗 min 底线让不出）
  // 时按比例收缩非主栏目标，主栏份额下限取 min(minW, max(rest,40))——
  // 否则写出 Σpx > avail 的权重，右栏被 flexbox min-width 挤出窗口
  // （§2.5 缩让要根治的 bug 类；与 absorbSurplus 的整体放弃语义对齐）。
  const nonMainPx = px.reduce((s, v, i) => {
    const c = regionCfgOfNode(kids[i])
    return c && c.region !== 'main' && !c.track ? s + v : s
  }, 0)
  if (nonMainPx > avail) {
    const scale = avail / nonMainPx
    kids.forEach((k, i) => {
      const c = regionCfgOfNode(kids[i])
      if (c && c.region !== 'main' && !c.track) px[i] = Math.floor(px[i] * scale)
    })
  }
  if (mainKids.length > 0) {
    // 主栏（可能多分栏并列）按当前权重比例分吃剩余，每栏不低于**实际生效
    // min**（sync 过承诺缩让后的动态值 40-395，从节点约束读——写死 395
    // 会把缩让顶回去，再溢出再缩让来回拉锯，2026-10-01 审查 P2-7）；
    // rest 为负（亏空）时下限取 min(minW, max(rest,40)) 与 absorbSurplus
    // 的整体放弃语义对齐（审查 A-2）。
    const weightOf = (k: Node) => (k as unknown as { getWeight?: () => number }).getWeight?.() ?? 100
    const wSum = mainKids.reduce((s, k) => s + (weightOf(k) > 0 ? weightOf(k) : 100), 0)
    const restNow = avail - px.reduce((s, v, i) => {
      const c = regionCfgOfNode(kids[i])
      // main 列不计（px 未设=0）；轨（TRACK_W）计入扣减——否则主栏多吃轨宽
      return c && c.region === 'main' && !c.track ? s : s + v
    }, 0)
    for (const k of mainKids) {
      const i = kids.indexOf(k)
      // widthBounds 读节点实际生效的 minWidth（tabset）或子项聚合（row），
      // 与 sync 落的属性同一来源；40 = §2.5 缩让底线
      const minW = Math.max(widthBounds(k, k instanceof RowNode).min, 40)
      px[i] = Math.max((restNow * weightOf(k)) / wSum, Math.min(minW, Math.max(restNow, 40)))
    }
  } else {
    // 主栏整栏折叠（无吸收者）：富余给第一个非轨列——根行不变式由这里的
    // 显式分配保证（v4.0：无 max 可言，列间不再有"由上限接管"的次级机制）
    let last = kids.length - 1
    while (last >= 0 && regionCfgOfNode(kids[last])?.track) last--
    if (last >= 0) px[last] += Math.max(rest, 0)
  }
  // 逐节点显式设 weight（Actions.adjustWeights 的数组映射实测会把权重
  // 写到错误的兄弟头上——2026-09-26 吸收区被加上右列权重的复现）
  if (typeof window !== 'undefined' && (window as { __flDbg?: boolean }).__flDbg) {
    console.log('[applyRootWeights] kids=', kids.map((k, i) => `${k.getId().slice(0, 6)}:${regionCfgOfNode(k)?.region ?? '?'}${regionCfgOfNode(k)?.track ? 'T' : ''}=${Math.round(px[i])}`).join(' '), 'avail=', avail)
  }
  kids.forEach((k, i) => {
    const w = (px[i] / avail) * 100
    if (Number.isFinite(w) && w > 0) {
      if (typeof window !== 'undefined' && (window as { __flDbg?: boolean }).__flDbg) {
        console.log('[applyRootWeights] set', k.getId().slice(0, 6), '->', Math.round(w * 100) / 100)
      }
      m.doAction(Actions.updateNodeAttributes(k.getId(), { weight: w }))
    }
  })
  return true
}

/** 富余兜底（常跑版）：量测根行各列实际 px，非主栏列钳到不低于聚合
 *  min（v4.0：max 上限已废除）后把差额全部交给主栏分栏。入口：
 *  Σ < 可用宽（无人吸收的富余/行尾留白）。写入权重与渲染真相对齐，
 *  消掉 flexbox 的 min 钉住态；变化 <2px 的列不动（防噪声 churn）。 */
export const absorbSurplus = (m: Model) => {
  const root = m.getRootRow()
  const kids = root?.getChildren() ?? []
  if (!root || kids.length < 2) return
  const availTotal = rootAvailPx()
  if (availTotal < 300) return // 窗口不可信（最小化/CDP 伪影）
  const avail = availTotal - SPLITTER_PX * (kids.length - 1)
  // 布局未就绪守卫（boot 冷启动实测踩过）：flexlayout 要到首次布局才算
  // calculatedMin（fromJson 后全 0），DOM 也可能未量得——此时量测整体
  // 放弃，等下一次触发（90ms/resize/rAF）再做。
  // （v4.0 清理：原 boundsOk 守卫检查聚合 max 有限性——上限废除后恒
  // 99999 永真，删除；min 侧目标有记忆 px 托底。）
  const measured = kids.map((k) => measuredPxWidth(k))
  if (measured.some((w) => w <= 0)) return
  const weightOf = (k: Node) => (k as unknown as { getWeight?: () => number }).getWeight?.() ?? 100
  // 目标 px：轨=20 固定；主栏=-1（吸收者标记）；其余列不低于聚合 min
  // （v4.0：max 上限废除，目标=记忆宽托底）。
  // **base 用记忆 px 而非 measured**（2026-10-03 实锤）：结构动作后本函数
  // 与 applyRootWeights 同帧串跑，此刻渲染还是 stale 权重的旧帧（关 review
  // 后左栏 measured=420）——用 measured 会把 applyRootWeights 刚按记忆钉
  // 下去的权重（350）立刻覆盖回 stale 值（420），左栏跟着关列漂移的整条
  // 修复链失效。记忆 px 与 applyRootWeights 同源：拖拽/resize/boot 由
  // measureRootPx 维护，结构动作由 onModelChange 同步量测维护。
  const px = kids.map((k, i) => {
    const c = regionCfgOfNode(k)
    if (c?.track) return TRACK_W
    if (c?.region === 'main' && !c.track) return -1
    const b = widthBounds(k, k instanceof RowNode)
    const memW = c ? rootPxMem[c.region] : undefined
    const base = typeof memW === 'number' && memW > 40 ? memW : measured[i]
    return Math.max(base, b.min)
  })
  let rest = avail - px.reduce((s, v) => s + Math.max(v, 0), 0)
  // 吸收者：主栏分栏按当前权重比例分吃 rest（各不低于实际生效 min——
  // sync 的过承诺缩让值）；没有主栏分栏 → 第一个非轨列兜底
  // （右栏的 20px 轨贴在行尾，不能当吸收者）
  let mains: number[] = []
  kids.forEach((_, i) => {
    if (px[i] === -1) mains.push(i)
  })
  if (mains.length === 0) {
    let cand = -1
    for (let i = 0; i < kids.length; i++) {
      if (regionCfgOfNode(kids[i])?.track) continue
      cand = i
      break
    }
    if (cand === -1) {
      cand = kids.length - 1
      while (cand >= 0 && regionCfgOfNode(kids[cand])?.track) cand--
    }
    if (cand >= 0) {
      mains = [cand]
      // 【2026-10-01 单测轮修复】候选吸收者先前按非吸收者钳制、其份额已计入
      // rest 的扣减——只翻 -1 标记不归还，写入权重 Σ = 可用宽 − 吸收者原钳制
      // 宽，根行不变式（§9 Σ=可用宽）被破坏（行内留白/与渲染真相对不齐）。
      // 与 applyRootWeights 无主栏分支的 px[last] += rest 同构：先归还份额。
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

/** 挤压合并（用户定稿）：窗口装不下各列 min 时，每一大栏把所有分栏
 *  合并进家乡一级窗格所在分栏的页签组（一级不在家 → 并入第一个分栏），
 *  空分栏 tidy——"左栏中有了三个栏"的逆操作，单向（不自动拆回）。 */
export const mergeZonesPerColumn = (m: Model) => {
  const columns = m.getRootRow()?.getChildren() ?? []
  for (const col of columns) {
    if (regionCfgOfNode(col)?.track) continue
    const zones: TabSetNode[] = []
    const walkZ = (n: Node) => {
      if (n instanceof TabSetNode && n.getChildren().length > 0) zones.push(n)
      for (const c of n.getChildren()) walkZ(c)
    }
    walkZ(col)
    if (zones.length < 2) continue
    const region = regionCfgOfNode(col)?.region ?? 'main'
    const target =
      zones.find((z) => zonePaneTypes(m, z).includes(PRIMARY_PANE[region])) ?? zones[0]
    for (const z of zones) {
      if (z.getId() === target.getId()) continue
      for (const t of [...z.getChildren()]) {
        if (t instanceof TabNode) {
          m.doAction(Actions.moveNode(t.getId(), target.getId(), DockLocation.CENTER, target.getChildren().length))
        }
      }
    }
  }
}

/** 动态窄屏判定（替代 640 matchMedia）：根行装不下"合并后各列 min"→
 *  左右栏自动隐藏（撤成 overlay 抽屉）。最小化瞬态（innerHeight ≤ 240）
 *  不改判；折叠在边框轨里的侧栏页签按其 region min 计入需求。 */
export const updateNarrowViewport = (m: Model) => {
  if (window.innerHeight <= 240) return
  const rootRow = m.getRootRow()
  if (!rootRow) return
  let needed = widthBounds(rootRow, false).min
  // 折叠在边框轨里的侧栏页签也计入（回归时需要空间），避免隐藏态反复横跳
  m.visitNodes((n) => {
    if (!(n instanceof TabNode)) return
    if (!(n.getParent() instanceof BorderNode)) return
    const t = paneTypeOf(n.getId())
    const def = t ? PANE_TYPES[t] : undefined
    if (def && (def.region === 'left' || def.region === 'right')) needed += REGION_LIMITS[def.region].minW
  })
  useLayoutStore.setState({ narrowViewport: window.innerWidth < needed + 2 })
}
