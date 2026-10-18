/**
 * 大栏级布局动词（v8.0 dockview 版，docs/architecture.md §2/§6）——语义
 * 照搬 column-ops.ts（flexlayout 版，v7.2 定稿），载体换成 dockview api：
 *
 * - 位置切换 = colOrder 条目移动 + 在场组 groupApi.moveTo 物理归位
 *   （**零组件卸载**——dockview 移组只重挂 DOM，panel 实例不死）；
 * - 隐藏/恢复 = **序列化手术**：toJSON 摘除/拼回组 leaf + panels 记录条目
 *   → fromJSON（一帧完成；dockview 无整树 moveNode，fromJSON 是唯一
 *   整列搬运路径——panel 组件重挂，与 flexlayout adopt 同代价）；
 * - 复位 = fromJSON(出厂)（2026-10-16：右键菜单「默认布局」动词——见
 *   resetLayoutToFactory）；
 * - colOrder 恒 3 项（含隐藏列）、colstash 快照、adopt 失败整体放弃——
 *   语义与旗标存储键（colflags.v1/colstash.v1）原样保留；
 * - v8 简化（用户定稿"布局去除多余的语义"）：页签条开关/搁浅 ladder
 *   不再存在——左/主栏组 hideHeader 恒无条，面板栏组唯一条恒显。
 */
import { Orientation } from 'dockview-core'
import type { DockviewApi, DockviewGroupPanel, SerializedDockview } from 'dockview-react'

export type ColRegion = 'left' | 'chat' | 'panels'

export interface ColumnFlags {
  colOrder: ColRegion[]
  leftHidden: boolean
  panelsHidden: boolean
}

// ── 出厂布局（三栏）：[左栏 350 | 主栏 | 面板栏 350] ────────────────────────
// 左/主组 hideHeader（无标签条）；组约束走**面板级** minimumWidth/
// maximumWidth（GroupviewPanelState 字段，随序列化 round-trip——组的生效
// 约束回落到活动 panel 的同名值；leaf data 的 constraints/initialWidth 在
// 反序列化里被丢弃，实测勿用）。wrapper.size = 出厂列宽（px 值，fromJSON
// 按比例归一——精确 px 由 boot 后 setSize 钉回）。面板栏出厂单签 open
// （打开页宿主，tabComponent openTab = 无 ✕ 头，根面板不可关）。
// 2026-10-16 自 dockview-shell 迁入（「默认布局」复位动词的同源消费方）。
export const RAIL_W = 350

export const FACTORY_LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { id: 'g-left', views: ['leftrail'], hideHeader: true }, size: RAIL_W },
        { type: 'leaf', data: { id: 'g-chat', views: ['workspace'], hideHeader: true }, size: 1100 },
        { type: 'leaf', data: { id: 'g-panels', views: ['open'] }, size: RAIL_W },
      ],
    },
    height: 1000,
    width: 1800,
    orientation: Orientation.HORIZONTAL,
  },
  panels: {
    leftrail: {
      id: 'leftrail',
      contentComponent: 'leftrail',
      title: '',
      minimumWidth: 240,
      maximumWidth: 420,
      params: { region: 'left' },
    },
    workspace: {
      id: 'workspace',
      contentComponent: 'workspace',
      title: '',
      minimumWidth: 395,
      params: { region: 'chat' },
    },
    open: {
      id: 'open',
      contentComponent: 'open',
      title: '打开',
      tabComponent: 'openTab',
      minimumWidth: 240,
      params: { region: 'panels' },
    },
  },
}

export const LAYOUT_KEY = 'mirach.harness.layout.v9'

// ── 持久化（旗标 + 列快照——键与语义照 column-ops 原样） ─────────────────────

const FLAGS_KEY = 'mirach.harness.layout.colflags.v1'
const STASH_KEY = 'mirach.harness.layout.colstash.v1'

const safeGet = (key: string): string | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

const safeSet = (key: string, value: string): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch (e) {
    console.error('[dv-column-ops] 持久化失败', e)
  }
}

let flagsCache: ColumnFlags | null = null

export const columnFlagsOf = (): ColumnFlags => {
  if (flagsCache) return flagsCache
  let parsed: Partial<ColumnFlags> = {}
  const raw = safeGet(FLAGS_KEY)
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<ColumnFlags>
    } catch (e) {
      console.error('[dv-column-ops] 栏旗标 JSON 解析失败——从默认起', e)
    }
  }
  const order =
    Array.isArray(parsed.colOrder) && parsed.colOrder.length === 3 && parsed.colOrder.every((r) => r === 'left' || r === 'chat' || r === 'panels')
      ? parsed.colOrder
      : (['left', 'chat', 'panels'] as ColRegion[])
  flagsCache = {
    colOrder: order as ColRegion[],
    leftHidden: parsed.leftHidden === true,
    panelsHidden: parsed.panelsHidden === true,
  }
  return flagsCache
}

const setFlags = (next: ColumnFlags): void => {
  flagsCache = next
  safeSet(FLAGS_KEY, JSON.stringify(next))
}

/** 组 leaf 快照（dockview 序列化格式的隐藏期离场内容）。 */
interface GroupStash {
  leaf: Record<string, unknown>
  panels: Record<string, Record<string, unknown>>
}

const loadStash = (): { left?: GroupStash; panels?: GroupStash } => {
  const raw = safeGet(STASH_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { left?: GroupStash; panels?: GroupStash }
    return {
      ...(parsed.left ? { left: parsed.left } : {}),
      ...(parsed.panels ? { panels: parsed.panels } : {}),
    }
  } catch (e) {
    console.error('[dv-column-ops] 列快照 JSON 解析失败——丢弃', e)
    return {}
  }
}

const saveStashSafe = (stash: { left?: GroupStash; panels?: GroupStash }): void => {
  safeSet(STASH_KEY, stash.left || stash.panels ? JSON.stringify(stash) : '')
}

const discardStash = (region: 'left' | 'panels'): void => {
  const stash = loadStash()
  delete stash[region]
  saveStashSafe(stash)
}

// ── api/组定位 ────────────────────────────────────────────────────────────────

const api = (): DockviewApi => {
  const a = (globalThis as { __dvApi?: DockviewApi }).__dvApi
  if (!a) console.error('[dv-column-ops] 布局 api 不在场（__dvApi 未挂载）')
  return a as DockviewApi
}

/** 组的 region 戳：组内第一个带 region params 的 panel。 */
export const regionOfGroup = (g: DockviewGroupPanel): ColRegion | undefined => {
  for (const p of g.panels) {
    const r = p.params?.region
    if (r === 'left' || r === 'chat' || r === 'panels') return r
  }
  return undefined
}

const groupsOfRegion = (a: DockviewApi, region: ColRegion): DockviewGroupPanel[] =>
  a.groups.filter((g) => regionOfGroup(g) === region)

/** 根面板组（唯一，docs §2）：含 open panel 的组；锚缺席回退第一根
 *  panels 语义组。 */
export const rootPanelsGroup = (a: DockviewApi): DockviewGroupPanel | undefined => {
  const open = a.getPanel('open')
  if (open) return open.group
  return groupsOfRegion(a, 'panels')[0]
}

/** dockview 序列化的手术视图（严格类型与自建手术不匹配——统一经 unknown
 *  落到本视图再改；fromJSON 接受本形状）。 */
interface LooseLayout {
  grid: { root: { type: string; data?: Record<string, unknown>[] } }
  panels: Record<string, Record<string, unknown>>
}

const toLoose = (a: DockviewApi): LooseLayout => a.toJSON() as unknown as LooseLayout

/** branch 子项双层形状（{type:'leaf', data:{id,views,…}}）的组状态解包。 */
const leafStateOf = (wrapper: Record<string, unknown>): Record<string, unknown> | undefined =>
  wrapper.type === 'leaf' ? (wrapper.data as Record<string, unknown> | undefined) : wrapper

/** 根行可见序：toJSON 的 grid root branch data（leaf id = 组 id）。只读
 *  用于定位；物理移动走 groupApi.moveTo（零卸载）。 */
const visualOrderOf = (a: DockviewApi): string[] => {
  const root = toLoose(a).grid.root
  if (root.type === 'leaf') return [String(leafStateOf(root)?.id ?? '')]
  return (root.data ?? []).map((wrapper) => String(leafStateOf(wrapper)?.id ?? ''))
}

/** colOrder 语义插入位：colOrder 序里排在 region 前面的可见列数。 */
const colOrderInsertIndex = (order: ColRegion[], region: ColRegion, isHidden: (r: ColRegion) => boolean): number => {
  let at = 0
  for (const r of order) {
    if (r === region) return at
    if (!isHidden(r)) at++
  }
  return at
}

// ── 物理归位（v7.3.2 规则，dockview moveTo 版） ──────────────────────────────

/** 在场组按 colOrder 物理归位：①左栏恒在物理端；②根面板贴住 chat 跨度
 *  边界（同侧让位——左栏第一、根面板第二；异侧占远端）。壳的打开页锚重建
 *  后也调用（导出共享）。 */
export const alignVisibleToOrder = (a: DockviewApi): void => {
  const flags = columnFlagsOf()
  const visual = visualOrderOf(a)
  const groupById = new Map(a.groups.map((g) => [g.id, g] as const))
  // ① 左栏端位
  if (!flags.leftHidden) {
    const lg = groupsOfRegion(a, 'left')[0]
    if (lg) {
      const leftFirst = flags.colOrder.indexOf('left') === 0
      const idx = visual.indexOf(lg.id)
      const atEdge = leftFirst ? idx === 0 : idx === visual.length - 1
      if (!atEdge) {
        const anchorId = leftFirst ? visual[0] : visual[visual.length - 1]
        const anchor = anchorId ? groupById.get(anchorId) : undefined
        if (anchor && anchor.id !== lg.id) {
          lg.api.moveTo({ group: anchor, position: leftFirst ? 'left' : 'right', skipSetActive: true })
        }
      }
    }
  }
  // ② 根面板贴 chat 边界
  if (!flags.panelsHidden) {
    const root = rootPanelsGroup(a)
    const chatGroups = groupsOfRegion(a, 'chat')
    if (root && chatGroups.length > 0) {
      const vis = visualOrderOf(a)
      const panelsSide = flags.colOrder.indexOf('panels') < flags.colOrder.indexOf('chat') ? 'L' : 'R'
      const leftEdge = flags.colOrder.indexOf('left') === 0 ? 'L' : 'R'
      const curIdx = vis.indexOf(root.id)
      // 同侧让位只在左栏在场时成立（缺席 = 面板栏直接占该侧边缘）
      const targetIdx =
        panelsSide === leftEdge && !flags.leftHidden
          ? leftEdge === 'L'
            ? 1
            : vis.length - 2
          : panelsSide === 'L'
            ? 0
            : vis.length - 1
      if (curIdx !== targetIdx && curIdx >= 0) {
        const anchor = groupById.get(vis[targetIdx] ?? '')
        if (anchor && anchor.id !== root.id) {
          root.api.moveTo({ group: anchor, position: curIdx < targetIdx ? 'right' : 'left', skipSetActive: true })
        }
      }
    }
  }
}

// ── 位置切换（v7.2 独立双切换，无交换） ─────────────────────────────────────
//
// 位置切换的 FLIP 动画（withFlip/runFlip）定义在文件后部「收放动画」段之后
// ——它依赖 viewOfGroup/morphAnimated/MORPH_DUR_MS，而 const 有 TDZ（函数
// 在调用时求值，但**模块顶层**的 const 初始化顺序必须早于任何调用；这些
// 函数只在用户动词里调用，故放在其后即可，见下方左栏/面板栏切换的两个
// `withFlip(...)` 调用点）。

/** 左栏位置切换：colOrder 里 left 条目移到另一端。隐藏态 = 纯记录。 */
export const leftPosToggle = (): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  const order = [...flags.colOrder]
  const li = order.indexOf('left')
  if (li < 0) {
    console.error('[dv-column-ops] colOrder 缺 left——位置切换放弃', order)
    return
  }
  order.splice(li, 1)
  if (li === 0) order.push('left')
  else order.unshift('left')
  setFlags({ ...flags, colOrder: order })
  if (!flags.leftHidden) withFlip(a, () => alignVisibleToOrder(a))
}

/** 面板栏位置切换：colOrder 里 panels 与 chat 条目换位（不跨 left）。 */
export const panelsPosToggle = (): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  const order = [...flags.colOrder]
  const pi = order.indexOf('panels')
  const ci = order.indexOf('chat')
  if (pi < 0 || ci < 0) {
    console.error('[dv-column-ops] colOrder 缺列——面板栏位置切换放弃', order)
    return
  }
  ;[order[pi], order[ci]] = [order[ci], order[pi]]
  setFlags({ ...flags, colOrder: order })
  if (!flags.panelsHidden) withFlip(a, () => alignVisibleToOrder(a))
}

export const leftPosLabel = (): string =>
  columnFlagsOf().colOrder.indexOf('left') === 0 ? '左侧栏移到最右侧' : '左侧栏移到最左侧'

export const panelsPosLabel = (): string => {
  const { colOrder } = columnFlagsOf()
  return colOrder.indexOf('panels') < colOrder.indexOf('chat') ? '面板栏移到右侧' : '面板栏移到左侧'
}

// ── 收放动画（2026-10-18，抄 beui.dev motion/animated-sidebar 的 morph） ────
//
// 用户口径：侧栏收放要"有动画"，且"隐藏后不要它变成工具栏的效果，就是全
// 隐藏"——栏宽归 0，不做 icon rail。dockview 的列宽载体 = split 容器下每个
// `.dv-view` 的 inline width/left，库本身不插值（实测 transition-duration
// 0s）；给这两个属性挂 CSS transition（ui-primitives.css，只在
// `[data-dv-morph='col']` 容器上生效）后可逐帧平滑收敛（实测 17 帧，
// chat 列同步位移）。
//
// 流程（隐藏）：打标记 → 强制 reflow → 解除 min 约束 → setSize(0) → 等
// 过渡结束 → 序列化手术（此时组已 0 宽，摘除不可见）→ 摘标记。
// 流程（显示）：先手术插回组 → 立刻压到 0（同帧，不闪）→ 下一帧解除约束
// 并把宽度补间回快照值 → 恢复约束 → 摘标记。
//
// 时序令牌唯一源头 = tokens.css `--sidebar-morph-dur`（此处常量仅供 JS
// 计时，必须与 CSS 同值；改一处改两处）。
const MORPH_DUR_MS = 320

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** 收放动画进行中（二次点击让位——手术与补间不能交错）。 */
let morphBusy = false
export const columnMorphInProgress = (): boolean => morphBusy

/** boot 自愈等非用户动作的面：期间关掉动画（首帧不该看到"栏滑进来"）。 */
let morphSuppressed = false
export const withoutColumnMorph = (fn: () => void): void => {
  const prev = morphSuppressed
  morphSuppressed = true
  try {
    fn()
  } finally {
    morphSuppressed = prev
  }
}

const morphAnimated = (): boolean => !morphSuppressed && !prefersReducedMotion()

/** 组的宽度载体（`dv-groupview` 的父节点 `.dv-view`，inline width/left）。 */
const viewOfGroup = (g: DockviewGroupPanel): HTMLElement | undefined => {
  const el = g.element?.parentElement
  return el instanceof HTMLElement ? el : undefined
}

/** 宽度载体所在的 split 容器（`.dv-view` → `.dv-view-container` →
 *  `.dv-split-view-container`）。 */
const splitOfView = (view: HTMLElement): HTMLElement | undefined => {
  const el = view.parentElement?.parentElement
  return el instanceof HTMLElement ? el : undefined
}

/** 收放期间的内容淡出标记（`data-dv-morph`）——CSS 只认它做 opacity 过渡。
 *  宽度**不靠 CSS**（见 tweenFrames 头注释：CSS 与 dockview 模型不同步）。 */
const markMorph = (g: DockviewGroupPanel, phase: 'show' | 'hide'): void => {
  g.element?.setAttribute('data-dv-morph', phase)
}

const clearMorph = (g: DockviewGroupPanel | undefined): void => {
  if (!g) return
  g.element?.removeAttribute('data-dv-morph')
}

/** 组快照约束（暂时解除 min-宽，0 宽才可达）。
 *  **必须存原值并在收放结束后还原**——早期版本按 region 硬编码回落
 *  240，把出厂 left maximumWidth=420 永久丢了（用户可以把左栏拖到任意宽）。
 *  `g.minimumWidth/maximumWidth` 是公开 getter（dockviewGroupPanel.d.ts）。 */
interface SavedConstraints {
  minimumWidth: number
  maximumWidth: number
}

const savedConstraints = new WeakMap<DockviewGroupPanel, SavedConstraints>()

const releaseMinWidth = (g: DockviewGroupPanel): void => {
  if (savedConstraints.has(g)) return
  const api = g.api as unknown as {
    setConstraints?: (v: { minimumWidth?: number; maximumWidth?: number }) => void
  }
  if (typeof api.setConstraints !== 'function') {
    console.error('[dv-column-ops] group.api.setConstraints 不在场——收放将受 min 宽限制', g.id)
    return
  }
  savedConstraints.set(g, { minimumWidth: g.minimumWidth, maximumWidth: g.maximumWidth })
  api.setConstraints({ minimumWidth: 0, maximumWidth: Number.MAX_SAFE_INTEGER })
}

const restoreMinWidth = (g: DockviewGroupPanel): void => {
  const saved = savedConstraints.get(g)
  if (!saved) return
  savedConstraints.delete(g)
  const api = g.api as unknown as {
    setConstraints?: (v: { minimumWidth?: number; maximumWidth?: number }) => void
  }
  api.setConstraints?.({ minimumWidth: saved.minimumWidth, maximumWidth: saved.maximumWidth })
}

/** 逐帧驱动一组宽度（**JS 补间替代 CSS transition**）。
 *
 *  **为什么不用 CSS transition**（2026-10-18 实锤）：CSS 只改 DOM 的 inline
 *  width，dockview 的**模型**仍认为该列是原宽。两者不一致时库会按模型重新
 *  分配，把释放的宽度全塞给最后一列（实测：左栏 350→0 的过程中 panels
 *  350→700，收起后才回 350）——用户看到的就是"面板栏闪烁变大"。逐帧调用
 *  `api.setSize` 则让**模型与 DOM 同步推进**，每次分配都落在我们指定的列上。
 *
 *  调用方负责：① 先解除被收列的 min 约束（否则钳在 240，实测）；
 *  ② 给出每帧的目标宽度函数 `widthAt(eased)`。
 *
 *  `easeOutQuart` = `1-(1-p)^4`，与 `--sidebar-morph-ease` 的抽屉曲线近形
 *  （CSS 令牌仍是视觉唯一源头，此处是它的 JS 等价实现）。
 */
const tweenFrames = (
  durationMs: number,
  widthAt: (eased: number) => { group: DockviewGroupPanel; width: number }[],
  done: () => void,
): void => {
  const apply = (eased: number) => {
    for (const { group, width } of widthAt(eased)) group.api.setSize({ width })
  }
  if (!morphAnimated()) {
    apply(1)
    done()
    return
  }
  // **第 0 帧同步落地**（2026-10-18 实锤）：只排 rAF 的话，调用返回后到首个
  // 动画帧之间还有一整帧（实测 ~380ms，CEF 下更久），期间 dockview 会把刚
  // 插入的组按自己的分配显示出来——用户看到的就是"先跳到 min 宽再补间"。
  // 先同步设一遍起点，浏览器随后才绘制。
  //
  // **同一 tick 里把宽表全部设完**（2026-10-18 实测）：`setSize` 只改一列，
  // 差额由 dockview 推给邻居——单独设 left=0 会把 panels 从 350 顶到 1190。
  // 因此首帧必须把**所有相关列**一起写（调用方已保证 widthAt 返回全表），
  // 且顺序无关（库按最终请求值结算）。
  apply(0)
  // **用 setTimeout 而非 rAF 驱动**（2026-10-18 实测）：CEF 窗口模式下
  // `requestAnimationFrame` 在一次布局结算后会停 400ms+（实测 rafMs=412，
  // 期间 setTimeout(0) 只要 2ms）。若用 rAF，补间首帧就落在 412ms 后，那时
  // dockview 已把宽度摊到终点——动画被整个吞掉。
  const t0 = performance.now()
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / durationMs)
    const eased = 1 - Math.pow(1 - p, 4)
    apply(eased)
    if (p < 1) window.setTimeout(step, 16)
    else done()
  }
  window.setTimeout(step, 0)
}

// ── 位置切换的 FLIP 动画（2026-10-18，用户报"移动面板位置为什么没有动画"）──
//
// **为什么不能用 CSS transition**：位置切换走 `groupApi.moveTo`，dockview 把
// 组 DOM **重新挂载**到另一侧——CSS transition 不跨 re-parent 生效（新节点
// 没有"旧值"），所以必须在 JS 里做 FLIP：
//   ① 切换前测每列 `.dv-view` 的 rect（First）
//   ② 执行 moveTo 触发的 alignVisibleToOrder（Last）
//   ③ 对位移的列：先 无过渡 设 transform 为「旧位置−新位置」的反向偏移，
//      强制结算，再下一帧开过渡清成 0 —— 视觉上是滑过去而不是瞬移。
// 只动 transform（GPU 合成层），不参与 dockview 的宽度协商。
//
// 定义位置说明：依赖 viewOfGroup / morphAnimated / MORPH_DUR_MS，故放在收放
// 段之后；调用点在文件前部的位置切换动词里（函数体内的引用在调用时求值，
// 那时模块已初始化完毕，无 TDZ 问题）。
const FLIP_ATTR = 'data-dv-flip'

interface FlipSnapshot {
  /** 组 id → 切换前的视口坐标 */
  rects: Map<string, { x: number; y: number }>
}

const snapshotRects = (a: DockviewApi): FlipSnapshot => {
  const rects: FlipSnapshot['rects'] = new Map()
  for (const g of a.groups) {
    const view = viewOfGroup(g)
    if (!view) continue
    const r = view.getBoundingClientRect()
    rects.set(g.id, { x: r.x, y: r.y })
  }
  return { rects }
}

const runFlip = (a: DockviewApi, before: FlipSnapshot): void => {
  if (!morphAnimated()) return
  const moved: { el: HTMLElement; dx: number; dy: number }[] = []
  for (const g of a.groups) {
    const prev = before.rects.get(g.id)
    const view = viewOfGroup(g)
    if (!prev || !view) continue
    const r = view.getBoundingClientRect()
    const dx = prev.x - r.x
    const dy = prev.y - r.y
    // 亚像素位移不处理（不给没动的列挂空动画）
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    moved.push({ el: view, dx, dy })
  }
  if (moved.length === 0) return
  for (const m of moved) {
    m.el.style.transition = 'none'
    m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`
    m.el.setAttribute(FLIP_ATTR, '')
  }
  // 强制结算：反向位移必须先被认作起始值，清 0 才会走过渡
  void moved[0]!.el.offsetWidth
  requestAnimationFrame(() => {
    for (const m of moved) {
      m.el.style.transition = 'transform var(--sidebar-morph-dur) var(--sidebar-morph-ease)'
      m.el.style.transform = ''
    }
    window.setTimeout(() => {
      for (const m of moved) {
        m.el.style.transition = ''
        m.el.style.transform = ''
        m.el.removeAttribute(FLIP_ATTR)
      }
    }, MORPH_DUR_MS + 40)
  })
}

/** 带 FLIP 动画地执行一次布局变更（位置切换 / 归位）。 */
const withFlip = (a: DockviewApi, mutate: () => void): void => {
  if (!morphAnimated()) {
    mutate()
    return
  }
  const before = snapshotRects(a)
  mutate()
  runFlip(a, before)
}

// ── 隐藏/恢复（序列化手术：toJSON 摘除/拼回 → fromJSON） ────────────────────

/** 组 leaf（branch 包装对象）+ 其 panels 记录条目的序列化摘除。 */
const extractLeaf = (json: LooseLayout, groupId: string): GroupStash | null => {
  const root = json.grid.root
  if (root.type !== 'branch') return null
  const data = root.data ?? []
  const idx = data.findIndex((wrapper) => leafStateOf(wrapper)?.id === groupId)
  if (idx < 0) return null
  const wrapper = data[idx]!
  const state = leafStateOf(wrapper)!
  const views = (state.views as string[] | undefined) ?? []
  const panels: Record<string, Record<string, unknown>> = {}
  for (const pid of views) {
    const entry = json.panels[pid]
    if (entry) panels[pid] = entry
    delete json.panels[pid]
  }
  data.splice(idx, 1)
  return { leaf: wrapper, panels }
}

// ── 布局手术护栏（2026-10-16 泛化）────────────────────────────────────────

/** 布局手术进行中护栏（shell 的面板生命周期 handler 消费）：fromJSON 内部
 *  先 clear（逐面板 onDidRemovePanel **同步**外发）再重建——手术中途的
 *  「末签关闭」事件不是用户动作，生命周期反应（restoreOpenAnchor 等）
 *  必须让位。两类实锤：
 *  ①「默认布局」复位（2026-10-16 早）：清场期 restoreOpenAnchor 把
 *    addPanel 打进半清树（referencePanel 'workspace' does not exist）；
 *  ②「隐藏面板栏」带实签（2026-10-16 晚用户报 bug）：面板列里有 files
 *    实签时隐藏 — extractLeaf + fromJSON 手术期，files 的 onDidRemovePanel
 *    同步触发 handlePanelRemoved → restoreOpenAnchor → 同一个
 *    referencePanel 'workspace' 异常 + 整树搅成空 g-panels。
 *  holdLayoutSurgery(fn) 包住一切 fromJSON 手术（隐藏/打开/复位）。 */
let layoutResetDepth = 0

export const layoutResetInProgress = (): boolean => layoutResetDepth > 0

/** 手术执行壳：depth++ → fn() → depth--（finally 保证）。 */
export const holdLayoutSurgery = (fn: () => void): void => {
  layoutResetDepth++
  try {
    fn()
  } finally {
    layoutResetDepth--
  }
}

/** 隐藏/打开左侧栏。adopt（fromJSON）失败即整体放弃。
 *
 * 带收放动画（2026-10-18）：隐藏 = 先把组宽补间到 0（CSS transition 逐帧），
 * 过渡结束再做序列化摘除（组已 0 宽，摘除无视觉跳变）；打开 = 先手术插回
 * 组、同帧压到 0，下一帧补间回快照宽度。**全隐藏语义**（用户口径）：宽度
 * 归 0，不留 icon rail。 */
export const setLeftHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.leftHidden) return
  if (morphBusy) {
    console.error('[dv-column-ops] 收放动画进行中——本次左栏切换忽略')
    return
  }
  if (hidden) {
    const lg = groupsOfRegion(a, 'left')[0]
    if (!lg) {
      console.error('[dv-column-ops] 左栏不在场——隐藏放弃')
      return
    }
    // **先确认能摘**（快照形状自检在补间之前做，失败就不动布局）
    const probe = toLoose(a)
    if (!extractLeaf(probe, lg.id)) {
      console.error('[dv-column-ops] 左栏 leaf 不在根行——隐藏放弃')
      return
    }
    const removedWidth = lg.width
    const chat = groupsOfRegion(a, 'chat')[0]
    const chatBefore = chat?.width ?? 0
    morphBusy = true
    // 解除被收列的 min 约束（否则钳在 240，实测）
    releaseMinWidth(lg)
    // 内容淡出（宽度由下面逐帧 setSize 驱动，CSS 不碰宽度）
    markMorph(lg, 'hide')
    // 左栏收多少，chat 就长多少；panels 完全不动（用户报的"面板栏闪烁变大"
    // 就是没钉住这一条）
    tweenFrames(
      MORPH_DUR_MS,
      (eased) => {
        const lw = Math.round(removedWidth * (1 - eased))
        const out = [{ group: lg, width: lw }]
        if (chat) out.push({ group: chat, width: Math.round(chatBefore + (removedWidth - lw)) })
        return out
      },
      () => {
        try {
          // 补间结束后再摘除：此时左栏已 0 宽，摘除无视觉跳变
          const json = toLoose(a)
          const stash = extractLeaf(json, lg.id)
          if (!stash) {
            console.error('[dv-column-ops] 补间后左栏 leaf 不在根行——放弃摘除（宽度已收）')
            return
          }
          holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
          saveStashSafe({ ...loadStash(), left: stash })
          setFlags({ ...flags, leftHidden: true })
        } finally {
          clearMorph(lg)
          restoreMinWidth(lg)
          morphBusy = false
        }
      },
    )
  } else {
    const stash = loadStash().left
    if (!stash) {
      console.error('[dv-column-ops] 左栏无快照——打开放弃')
      return
    }
    // 插回时的目标宽 = 快照里的列宽
    const targetWidth =
      typeof stash.leaf.size === 'number' && stash.leaf.size > 0 ? stash.leaf.size : RAIL_W
    // **不在场两列的当前几何**（作为补间起点）
    const chatPre = groupsOfRegion(a, 'chat')[0]
    const panelsPre = rootPanelsGroup(a)
    const chatPreWidth = chatPre?.width ?? 0
    const panelsPreWidth = panelsPre?.width ?? RAIL_W
    // **走 addPanel 而不是 fromJSON**（2026-10-18 实锤）：整树 fromJSON 会
    // 触发一次 200~300ms 的同步布局结算（CEF 实测），期间主线程被占住，
    // 任何 JS 补间都排不进来——用户看到"等半天，然后宽度直接跳到终点"。
    // addPanel 是增量插入，结算代价低一个量级，补间能真正逐帧跑。
    const leftFirst = flags.colOrder.indexOf('left') === 0
    // **锚点必须是"物理端位组"**（2026-10-18 实锤）：`direction:'left'` 是
    // 相对**锚组**的方向，不是相对整行。若锚取第一个 chat 组、而物理序里
    // 它不在边缘，左栏会插到中间（实测：加了会话分栏后左栏跑到最右）。
    // 正解：leftFirst → 取物理最左的组、direction 'left'；
    //       反之 → 取物理最右的组、direction 'right'。
    const visual = visualOrderOf(a)
    const groupById = new Map(a.groups.map((g) => [g.id, g] as const))
    const edgeGroup = leftFirst
      ? groupById.get(visual[0] ?? '')
      : groupById.get(visual[visual.length - 1] ?? '')
    const anchor = edgeGroup ?? panelsPre ?? chatPre
    if (!anchor) {
      console.error('[dv-column-ops] 无可用参照组——左栏打开放弃')
      return
    }
    const firstPanel = (stash.leaf as { data?: { views?: string[] } }).data?.views?.[0]
    const panelEntry = firstPanel ? stash.panels[firstPanel] : undefined
    if (!firstPanel || !panelEntry) {
      console.error('[dv-column-ops] 快照缺 panel 记录——左栏打开放弃', firstPanel)
      return
    }
    morphBusy = true
    const created = a.addPanel({
      id: firstPanel,
      component: String(panelEntry.contentComponent),
      title: String(panelEntry.title ?? ''),
      minimumWidth: 0,
      params: panelEntry.params as Record<string, unknown> | undefined,
      position: {
        referenceGroup: anchor.id,
        direction: leftFirst ? 'left' : 'right',
      },
    })    // 同组其它面板（左栏通常只有一个，但按快照补齐）
    for (const pid of ((stash.leaf as { data?: { views?: string[] } }).data?.views ?? []).slice(1)) {
      const e = stash.panels[pid]
      if (!e) continue
      a.addPanel({
        id: pid,
        component: String(e.contentComponent),
        title: String(e.title ?? ''),
        params: e.params as Record<string, unknown> | undefined,
        position: { referencePanel: firstPanel },
      })
    }
    const lg = created.group
    const rest = loadStash()
    delete rest.left
    saveStashSafe(rest)
    setFlags({ ...flags, leftHidden: false })
    if (!morphAnimated()) {
      lg.api.setSize({ width: targetWidth })
      morphBusy = false
      return
    }
    // 入场：先 0 宽，再逐帧长大，chat 同步让出
    releaseMinWidth(lg)
    clearMorph(lg)
    // **只让"贴左栏的 chat 组"让宽度**：chat 域可能有多个组（会话分栏），
    // 若平均分配会把分栏也挤动（用户口径：分栏不该跟着变）。
    const chat = groupsOfRegion(a, 'chat')[0]
    const panelsNow = rootPanelsGroup(a)
    // **目标几何按"守恒总宽"算，别用 addPanel 后的实测值**（2026-10-18
    // 实锤）：addPanel 插入后 dockview 立刻把三列**等分**，此时读 chat.width
    // 得到的是等分值而非隐藏态的值——拿它当补间起点，第一帧就会"先塌一下"。
    // chatPreWidth / panelsPreWidth 已在 addPanel 之前取好。
    const totalTarget = chatPreWidth + panelsPreWidth // = 隐藏态时两者之和
    tweenFrames(
      MORPH_DUR_MS,
      (eased) => {
        const lw = Math.round(targetWidth * eased)
        // chat 让出左栏占的宽；panels 恒为原宽
        const chatW = Math.max(0, totalTarget - panelsPreWidth - lw)
        const out = [
          { group: lg, width: lw },
          ...(chat ? [{ group: chat, width: chatW }] : []),
          ...(panelsNow && panelsNow.id !== lg.id && panelsNow.id !== chat?.id
            ? [{ group: panelsNow, width: panelsPreWidth }]
            : []),
        ]
        return out
      },
      () => {
        restoreMinWidth(lg)
        clearMorph(lg)
        morphBusy = false
        // 组重建后 colOrder 记账
        const na = api()
        if (na) {
          alignVisibleToOrder(na)
          persistFlagsColOrder(na)
        }
      },
    )
  }
}

/** 隐藏/打开面板栏（根面板列唯一；恢复位 = colOrder 语义位；无快照重开 =
 *  新打开页）。与 setLeftHidden 同款收放动画（全隐藏，无 icon rail）。 */
export const setPanelsHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.panelsHidden) return
  if (morphBusy) {
    console.error('[dv-column-ops] 收放动画进行中——本次面板栏切换忽略')
    return
  }
  if (hidden) {
    const root = rootPanelsGroup(a)
    if (!root) {
      console.error('[dv-column-ops] 面板栏不在场——隐藏放弃')
      return
    }
    // 形状自检先做（失败不动布局）
    if (!extractLeaf(toLoose(a), root.id)) {
      console.error('[dv-column-ops] 面板栏 leaf 不在根行——隐藏放弃')
      return
    }
    const removedWidth = root.width
    const chat = groupsOfRegion(a, 'chat')[0]
    const chatBefore = chat?.width ?? 0
    morphBusy = true
    releaseMinWidth(root)
    markMorph(root, 'hide')
    // 与左栏同款：面板栏收多少、chat 长多少；左栏完全不动
    tweenFrames(
      MORPH_DUR_MS,
      (eased) => {
        const pw = Math.round(removedWidth * (1 - eased))
        const out = [{ group: root, width: pw }]
        if (chat) out.push({ group: chat, width: Math.round(chatBefore + (removedWidth - pw)) })
        return out
      },
      () => {
        try {
          // 补间之后才抓快照（同 setLeftHidden）
          const json = toLoose(a)
          const stash = extractLeaf(json, root.id)
          if (!stash) {
            console.error('[dv-column-ops] 补间后面板栏 leaf 不在根行——放弃摘除（宽度已收）')
            return
          }
          holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
          saveStashSafe({ ...loadStash(), panels: stash })
          setFlags({ ...flags, panelsHidden: true })
        } finally {
          clearMorph(root)
          restoreMinWidth(root)
          morphBusy = false
        }
      },
    )
  } else {
    const json = toLoose(a)
    const rootJson = json.grid.root
    if (rootJson.type !== 'branch') {
      console.error('[dv-column-ops] 根非 branch——面板栏打开放弃')
      return
    }
    const stash = loadStash().panels
    // branch 子项 = 双层包装（{type:'leaf', data:{…}}）——无快照重开的
    // 新打开页也按包装形状拼回
    const leaf: Record<string, unknown> =
      stash?.leaf ?? {
        type: 'leaf',
        data: {
          id: 'g-panels',
          views: ['open'],
          // 出厂组属性（无快照重开 = 新打开页，组属性补齐防丢约束）
          constraints: { minimumWidth: 240 },
          initialWidth: 350,
        },
      }
    const panelEntries: Record<string, Record<string, unknown>> =
      stash?.panels ?? {
        open: { id: 'open', contentComponent: 'open', title: '打开', tabComponent: 'openTab', minimumWidth: 240, params: { region: 'panels' } },
      }
    const data = rootJson.data ?? []
    const at = Math.min(colOrderInsertIndex(flags.colOrder, 'panels', (r) => r === 'left' && flags.leftHidden), data.length)
    const targetWidth =
      typeof leaf.size === 'number' && leaf.size > 0 ? leaf.size : RAIL_W
    // 插入时按 0 宽（同 setLeftHidden 的显示路径：避免一帧全宽闪现）
    data.splice(at, 0, { ...leaf, size: 0 })
    Object.assign(json.panels, panelEntries)
    morphBusy = true
    holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
    if (stash) {
      const rest = loadStash()
      delete rest.panels
      saveStashSafe(rest)
    }
    setFlags({ ...flags, panelsHidden: false })
    const na = api()
    if (na) alignVisibleToOrder(na)
    const pg = na ? rootPanelsGroup(na) : undefined
    if (!pg) {
      console.error('[dv-column-ops] 面板栏插回后组不在场——动画放弃')
      morphBusy = false
      return
    }
    if (!morphAnimated()) {
      pg.api.setSize({ width: targetWidth })
      morphBusy = false
      return
    }
    // 入场：0 宽入树后逐帧长大，chat 同步让出（与收起完全对称）
    releaseMinWidth(pg)
    clearMorph(pg)
    const chat2 = groupsOfRegion(na!, 'chat')[0]
    // 同 setLeftHidden：基数反推最终几何（此刻新列刚 0 宽入树，当前几何不稳）
    const totalWidth = na!.groups.reduce((sum, g) => sum + g.width, 0)
    const othersWidth = na!.groups
      .filter((g) => g.id !== pg.id && g.id !== chat2?.id)
      .reduce((sum, g) => sum + g.width, 0)
    const chatTarget = Math.round(totalWidth - targetWidth - othersWidth)
    tweenFrames(
      MORPH_DUR_MS,
      (eased) => {
        const pw = Math.round(targetWidth * eased)
        const out = [{ group: pg, width: pw }]
        if (chat2) out.push({ group: chat2, width: chatTarget + (targetWidth - pw) })
        return out
      },
      () => {
        restoreMinWidth(pg)
        clearMorph(pg)
        morphBusy = false
        pg.api.setSize({ width: targetWidth })
        chat2?.api.setSize({ width: chatTarget })
      },
    )
  }
}

// ── boot 自愈（normalizeColumns 的 dockview 版） ─────────────────────────────

/** 旗标与实际树脱同步时按旗标收敛：隐藏列在场 → 补藏；未隐藏但快照在场 →
 *  判废快照；面板列缺失 → 缺席旗标。一致性零动作。 */
export const normalizeColumns = (): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  const stash = loadStash()
  if (flags.leftHidden && groupsOfRegion(a, 'left').length > 0) {
    setLeftHidden(true)
    return
  }
  if (!flags.leftHidden && stash.left) {
    console.error('[dv-column-ops] 旗标未隐藏但左栏快照在场——判废')
    discardStash('left')
  }
  const panelsPresent = rootPanelsGroup(a) !== undefined
  if (flags.panelsHidden && panelsPresent) {
    setPanelsHidden(true)
    return
  }
  if (!flags.panelsHidden && stash.panels) {
    console.error('[dv-column-ops] 旗标未隐藏但面板栏快照在场——判废')
    discardStash('panels')
    return
  }
  if (!flags.panelsHidden && !panelsPresent) {
    // 面板列缺失（上次会话关空收列后持久化）→ 缺席旗标（重开 = 新打开页）
    setFlags({ ...flags, panelsHidden: true })
    return
  }
  alignVisibleToOrder(a)
  persistFlagsColOrder(a)
}

/** 可见列按物理序重排 colOrder、隐藏列保持原槽位（column-ops setFlagsColOrder
 *  同语义——拖拽/手动改序后的记账）。 */
export const persistFlagsColOrder = (a: DockviewApi): void => {
  const prev = columnFlagsOf()
  const vis = visualOrderOf(a)
  const firstIdx = new Map<ColRegion, number>()
  a.groups.forEach((g) => {
    const r = regionOfGroup(g)
    if (!r || firstIdx.has(r)) return
    const at = vis.indexOf(g.id)
    if (at >= 0) firstIdx.set(r, at)
  })
  const visibleSorted = [...prev.colOrder]
    .filter((r) => firstIdx.has(r))
    .sort((x, y) => firstIdx.get(x)! - firstIdx.get(y)!)
  let vi = 0
  const order = prev.colOrder.map((r) => (firstIdx.has(r) ? visibleSorted[vi++]! : r))
  setFlags({ ...prev, colOrder: order })
}

// ── 复位（用户 2026-10-16：右键菜单「默认布局」）────────────────────────────

/** 布局回出厂形态：fromJSON(FACTORY_LAYOUT)（内部先 clear——会话分栏/
 *  打开页全收，三栏 [左|主|面板] 重建，open 锚在场）+ 旗标复位（colOrder
 *  出厂序、栏显隐归 false；旧 colstash 判废——隐藏期快照对复位后的树已无
 *  意义）+ 双轨 350 两轮钉回（同 boot 出厂钉法：fromJSON 的 size 按比例
 *  归一，不是 px）+ 出厂布局存档（覆盖 v9 键，reload 后不回旧形态）。挂载
 *  页签的会话不丢：会话真相在 pi，重开走侧栏/列表。失败 = console.error
 *  可见（规矩 12）。 */
export const resetLayoutToFactory = (): void => {
  const a = api()
  if (!a) return
  try {
    holdLayoutSurgery(() => a.fromJSON(FACTORY_LAYOUT))
    // 旗标复位 + 快照判废（隐藏语义清零）
    setFlags({ colOrder: ['left', 'chat', 'panels'], leftHidden: false, panelsHidden: false })
    saveStashSafe({})
    // 双轨钉回 350（两轮互挤后收敛——boot 出厂同款；rAF 后树已稳）。
    // 钉宽放复位护栏之外：rAF/150ms 回调跑时 depth 已归零，不受让位影响。
    const pin = () => {
      const lg = groupsOfRegion(a, 'left')[0]
      const pg = groupsOfRegion(a, 'panels')[0]
      for (let i = 0; i < 3; i++) {
        pg?.api.setSize({ width: RAIL_W })
        lg?.api.setSize({ width: RAIL_W })
      }
    }
    requestAnimationFrame(pin)
    setTimeout(pin, 150)
    // 出厂存档（onDidLayoutChange 防抖 250ms 也会写——这里先写一次
    // 让持久化即时收敛，防 debounce 窗口内进程退出留下旧档）
    safeSet(LAYOUT_KEY, JSON.stringify(FACTORY_LAYOUT))
    console.info('[dv-column-ops] 布局已复位为出厂形态')
  } catch (e) {
    console.error('[dv-column-ops] 布局复位失败', e)
  }
}
