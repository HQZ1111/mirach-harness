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

/** 读栏旗标。**每次从 localStorage 现读，不缓存**（2026-10-18 实锤）：
 *  旧实现有模块级 `flagsCache`，但 vite HMR 会同时存在新旧两个模块实例
 *  （旧实例的 handler 还挂着），两份 cache 各自演化——收放写入 true 之后，
 *  旧实例的 `persistFlagsColOrder` 拿着自己的 false 又写回存储，隐藏态
 *  1.3s 后复活（实测）。旗标读极廉价（同步读一个小 JSON），不值得为它
 *  引入跨实例不一致。 */
export const columnFlagsOf = (): ColumnFlags => {
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
  return {
    colOrder: order as ColRegion[],
    leftHidden: parsed.leftHidden === true,
    panelsHidden: parsed.panelsHidden === true,
  }
}

const setFlags = (next: ColumnFlags): void => {
  safeSet(FLAGS_KEY, JSON.stringify(next))
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
  // split 容器上的 `data-dv-morph='col'`：给"跟随列移动的装饰层"（主对话
  // 颜色层的贴边内缩、列头内边距）开过渡——它们的状态在补间开始时按目标
  // 态翻转，没有过渡就是硬跳 20px（用户报"颜色层直接到边缘/再闪回来"）。
  // 只在补间期间存在，boot 期自愈走 withoutColumnMorph 不会挂上。
  const view = viewOfGroup(g)
  const split = view ? splitOfView(view) : undefined
  split?.setAttribute('data-dv-morph', 'col')
}

const clearMorph = (g: DockviewGroupPanel | undefined): void => {
  if (!g) return
  g.element?.removeAttribute('data-dv-morph')
  const view = viewOfGroup(g)
  const split = view ? splitOfView(view) : undefined
  split?.removeAttribute('data-dv-morph')
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

/** 还原 min 约束。`minOverride` 用于"收起到 0 后仍保持可展开"——
 *  此时 min 必须留在 0，否则用户下次拖/补间又会被钳回出厂 240。 */
const restoreMinWidth = (g: DockviewGroupPanel, minOverride?: number): void => {
  const saved = savedConstraints.get(g)
  if (!saved) return
  savedConstraints.delete(g)
  const api = g.api as unknown as {
    setConstraints?: (v: { minimumWidth?: number; maximumWidth?: number }) => void
  }
  api.setConstraints?.({
    minimumWidth: minOverride ?? saved.minimumWidth,
    maximumWidth: saved.maximumWidth,
  })
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
/** 收放一列：**只改宽度，从不摘除组**（2026-10-18 根因修复）。
 *
 *  ## 为什么之前的做法必然闪烁
 *
 *  旧实现走"序列化摘除 / fromJSON 或 addGroup+addPanel 重建"。用户展开侧栏
 *  时，dockview 必须**重新挂载整棵左栏 React 树**（整张会话列表）——实测
 *  一次 **391ms 的 long task**。这段时间主线程被占死：任何 JS 补间都排不
 *  进来，用户先看到"chat 撑满、左栏还是一条缝"，然后再一帧跳到位。
 *  这不是补间写得不对，是**架构上把渲染和动画串行**了。
 *
 *  ## 现在的做法
 *
 *  组始终在场、面板始终挂载，收放 = 逐帧 setSize 把宽度推到 0 / 推回来。
 *  - 展开时不需要渲染任何新东西（树一直在），补间全程可跑；
 *  - 实测 0 宽时只剩一条 `dv-sash.dv-minimum`（left:-2px，在列内部），
 *    不挡内容、不可误拖；
 *  - 组宽 0 时给 groupview 打 `data-dv-collapsed`（CSS 隐藏内容 + 屏蔽
 *    命中），避免 0 宽里残留的焦点/滚动参与 tab 序。
 *
 *  ## 状态语义
 *
 *  `leftHidden` 仍是"用户意图"（持久化 + 菜单文案），但**不再对应树上有没有
 *  组**——只对应宽度。这样 boot 自愈的判据也要跟着改：检查宽度而不是存在性。
 */
const setColumnCollapsed = (
  group: DockviewGroupPanel,
  hidden: boolean,
  onDone?: () => void,
): void => {
  if (morphBusy) {
    console.error('[dv-column-ops] 收放动画进行中——本次调用忽略')
    return
  }
  const a = api()
  if (!a) return

  const startWidth = Math.round(group.width)
  // 记住用户的原始宽度（展开时还原；0 宽时不能从 group.width 读）
  if (startWidth > 0) savedColumnWidth.set(group.id, startWidth)
  const targetWidth = hidden ? 0 : (savedColumnWidth.get(group.id) ?? RAIL_W)

  // 已经到位：只补一致性与标记
  if (startWidth === targetWidth) {
    applyCollapsedMarker(group, hidden)
    onDone?.()
    return
  }

  // 让出/收回宽度的邻居：chat 域第一个组（会话分栏的其余组不动）
  const chat = groupsOfRegion(a, 'chat')[0]
  const chatStart = chat ? Math.round(chat.width) : 0
  const delta = targetWidth - startWidth // >0 展开、<0 收起

  morphBusy = true
  // 收到 0 时必须放开 min 约束（出厂 min=240，否则钳住）
  if (hidden) releaseMinWidth(group)
  // **补间开始前就要处理两件"内容侧"的事**（2026-10-18 用户报"展开时容器
  // 有动画、内容没有，等容器展开完瞬间出现"）：
  //  ① 展开方向：摘掉 `data-dv-collapsed`——它里面的 `visibility: hidden`
  //     会让整栏内容在整段补间里都不可见，等收尾才一次性恢复（"瞬间冒
  //     出来"）。此刻组宽仍是 0（overflow 裁切），摘掉不会提前露出内容，
  //     只是让内容跟着宽度一起入场（CSS 走 [data-dv-morph='show']）。
  //  ② 两个方向都按**目标态**重算贴边标记：补间期间组宽还没到位，按实际
  //     宽度算会得出旧结论，tint 的 20px 内缩就会在补间结束的一刻硬跳
  //     （用户报"颜色层直接到边缘/再闪回来"）。用 override 按意图声明，
  //     配合 panes.css 里 tint 的 left/right 过渡，内缩与列同步滑。
  if (!hidden) setCollapsedAttr(group, false)
  // 先挂补间标记（含 split 容器的 `[data-dv-morph='col']`）**再**翻贴边
  // 状态——顺序反了的话，属性翻转与 transition 规则出现在同一次样式结算
  // 里，起始值可能取到"新值"，20px 内缩就变成硬跳而不是滑（见 panes.css）。
  markMorph(group, hidden ? 'hide' : 'show')
  refreshChatEdgeMarkers({ group, visible: !hidden })

  tweenFrames(
    MORPH_DUR_MS,
    (eased) => {
      const w = Math.round(startWidth + delta * eased)
      const out = [{ group, width: w }]
      // chat 反向吸收：列变宽多少，chat 就窄多少——总宽守恒，其它列不动
      if (chat) out.push({ group: chat, width: Math.round(chatStart - delta * eased) })
      return out
    },
    () => {
      // 收尾钉一次（取整残差 / 库内部微调）
      group.api.setSize({ width: targetWidth })
      if (chat) chat.api.setSize({ width: chatStart - delta })
      if (hidden) {
        // 0 宽后仍要保住"下次能展开"：min 约束回到 0（否则再展开会被
        // 钳回 240，但那时用户本来就是从 0 拉到 350，无需 min）
        restoreMinWidth(group, 0)
      } else {
        restoreMinWidth(group)
      }
      // **先落 morphBusy 再打标记**：refreshChatEdgeMarkers 在补间期间会让位
      // （见其注释），顺序反了这次最终收敛会变成空操作，贴边标记停留在补间
      // 起点声明的目标态上——若期间用户拖过 sash，结果就是错的（2026-10-18
      // 实测：split 列的 data-edge 校准丢失）。
      morphBusy = false
      applyCollapsedMarker(group, hidden)
      clearMorph(group)
      onDone?.()
    },
  )
}

/** 0 宽组的视觉与命中处理：CSS 认这个属性隐藏内容并屏蔽 pointer。 */
const setCollapsedAttr = (g: DockviewGroupPanel, collapsed: boolean): void => {
  if (collapsed) g.element?.setAttribute('data-dv-collapsed', '')
  else g.element?.removeAttribute('data-dv-collapsed')
}

const applyCollapsedMarker = (g: DockviewGroupPanel, collapsed: boolean): void => {
  setCollapsedAttr(g, collapsed)
  refreshChatEdgeMarkers()
}

/** 给 chat 组打"这一侧没有**可见**邻居"标记（CSS 用它决定颜色层是否内缩）。
 *
 *  **为什么需要 JS**（2026-10-18 实锤）：侧栏收起后组仍常驻（0 宽），DOM 序
 *  里它还是 firstChild——chat 不再是 first-child，`.main-tint--dockview` 的
 *  左内缩 20px 失效，颜色层直接贴到窗口边缘（用户报"隐藏之后主对话到边缘
 *  的间距没了"）。CSS 没有"跳过 0 宽兄弟后的第一个"这种选择器，而 :has()
 *  数不了"前面有几个可见列"——只能在收放后由 JS 算。
 *
 *  判据 = 物理序里 chat 前后各有没有**宽度 > 0** 的组。
 *
 *  **组常驻改造后这条从"收放兜底"变成"唯一判据"**：左栏组永远在 DOM 里，
 *  chat 永远不是 first-child，`.dv-view:first-child` 结构性规则已退役
 *  （见 panes.css）。所以本函数必须在 boot 与每次收放后都跑。
 *
 *  `override` 供展开补间期使用：此刻组宽仍是 0，但**意图**是可见——按实际
 *  宽度算会把"马上要出现的邻居"当成不存在，tint 会在补间中途多出一条
 *  20px 缝再消失（闪一下）。
 *
 *  **补间期间只认 override**：`onDidLayoutChange` 的防抖回调也会调本函数
 *  （用户拖 sash 把某列拖到 0 时得靠它），而它在补间中每帧都会排队——
 *  若用"实际宽度"覆盖补间开始时声明的目标态，tint 会在补间末段闪一下。
 *  故 morphBusy 且无 override 时直接返回，补间结束的 applyCollapsedMarker
 *  会做最终收敛。 */
export const refreshChatEdgeMarkers = (override?: {
  group: DockviewGroupPanel
  visible: boolean
}): void => {
  if (morphBusy && !override) return
  const a = api()
  if (!a) return
  const visual = visualOrderOf(a)
  const groupById = new Map(a.groups.map((g) => [g.id, g] as const))
  const isVisible = (id: string): boolean => {
    if (override && override.group.id === id) return override.visible
    return Math.round(groupById.get(id)?.width ?? 0) > 0
  }
  for (const chat of groupsOfRegion(a, 'chat')) {
    const at = visual.indexOf(chat.id)
    if (at < 0) continue
    const visibleBefore = visual.slice(0, at).some(isVisible)
    const visibleAfter = visual.slice(at + 1).some(isVisible)
    if (visibleBefore) chat.element?.removeAttribute('data-edge-left')
    else chat.element?.setAttribute('data-edge-left', '')
    if (visibleAfter) chat.element?.removeAttribute('data-edge-right')
    else chat.element?.setAttribute('data-edge-right', '')
  }
}

/** 用户的列宽记忆（0 宽时读不到 group.width，只能自己存）。
 *  键 = 组 id（'g-left' / 'g-panels'），跨会话不持久——重启后回到快照值。 */
const savedColumnWidth = new Map<string, number>()

/** 隐藏/打开左侧栏（全隐藏语义：宽度归 0，不做 icon rail）。 */
export const setLeftHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.leftHidden) return
  const lg = groupsOfRegion(a, 'left')[0]
  if (!lg) {
    console.error('[dv-column-ops] 左栏不在场——切换放弃')
    return
  }
  setFlags({ ...flags, leftHidden: hidden })
  setColumnCollapsed(lg, hidden)
}

/** 隐藏/打开面板栏（根面板列唯一；恢复位 = colOrder 语义位） */
export const setPanelsHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.panelsHidden) return
  const root = rootPanelsGroup(a)
  if (!root) {
    console.error('[dv-column-ops] 面板栏不在场——切换放弃')
    return
  }
  setFlags({ ...flags, panelsHidden: hidden })
  setColumnCollapsed(root, hidden)
}

// ── boot 自愈（normalizeColumns 的 dockview 版） ─────────────────────────────

/** 旗标与实际几何脱同步时按旗标收敛（**判据 = 宽度**，2026-10-18 改）：
 *  收放现在"只改宽度、从不摘组"，所以"组在不在"不再是隐藏判据——要看
 *  宽度是不是 0。列序对齐仍是每次都做。 */
export const normalizeColumns = (): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  // 旧版的 colstash 快照在新机制下已无意义（不再摘组）——启动时清掉遗留键
  if (safeGet(STASH_KEY)) {
    console.info('[dv-column-ops] 布局快照机制已退役（收放改为纯宽度）——清理旧快照')
    safeSet(STASH_KEY, '')
  }
  // 左栏：旗标说隐藏但仍有宽度 → 收到 0（boot 期无动画）
  const lg = groupsOfRegion(a, 'left')[0]
  if (lg) {
    const collapsed = Math.round(lg.width) === 0
    if (flags.leftHidden !== collapsed) {
      withoutColumnMorph(() => setColumnCollapsed(lg, flags.leftHidden))
    }
  } else if (!flags.leftHidden) {
    console.error('[dv-column-ops] 左栏组不在树里——旗标未隐藏但无法恢复（布局存档异常）')
  }
  // 面板栏同理
  const root = rootPanelsGroup(a)
  if (root) {
    const collapsed = Math.round(root.width) === 0
    if (flags.panelsHidden !== collapsed) {
      withoutColumnMorph(() => setColumnCollapsed(root, flags.panelsHidden))
    }
  } else if (!flags.panelsHidden) {
    console.error('[dv-column-ops] 面板栏组不在树里——旗标未隐藏但无法恢复（布局存档异常）')
  }
  alignVisibleToOrder(a)
  // 贴边标记每次收敛后都要重算（组常驻改造后它是唯一判据，见函数注释）
  refreshChatEdgeMarkers()
  persistFlagsColOrder(a)
}

/** 可见列按物理序重排 colOrder（拖拽/手动改序后的记账）。
 *
 *  **只改 colOrder，绝不覆盖 leftHidden/panelsHidden**（2026-10-18 实锤）：
 *  本函数由 `onDidLayoutChange` 的 250ms 防抖调用，而该事件在**收放补间的
 *  每一帧**都会触发。旧写法 `setFlags({ ...prev })` 用的是 `columnFlagsOf()`
 *  的**当时快照**——若某个防抖回调在 `setLeftHidden` 写入 true **之前**
 *  就取了 `prev`，它会在 250ms 后把 `leftHidden:false` 写回存储，隐藏态
 *  丢失（实测：点隐藏 → 宽度到 0 → 1.3s 后 flag 复活成 false → 刷新后
 *  侧栏又展开了）。
 *  → 现在从**当前缓存**读最新值，只替换 colOrder 字段。 */
export const persistFlagsColOrder = (a: DockviewApi): void => {
  const cur = columnFlagsOf()
  const vis = visualOrderOf(a)
  const firstIdx = new Map<ColRegion, number>()
  a.groups.forEach((g) => {
    const r = regionOfGroup(g)
    if (!r || firstIdx.has(r)) return
    const at = vis.indexOf(g.id)
    if (at >= 0) firstIdx.set(r, at)
  })
  const visibleSorted = [...cur.colOrder]
    .filter((r) => firstIdx.has(r))
    .sort((x, y) => firstIdx.get(x)! - firstIdx.get(y)!)
  let vi = 0
  const order = cur.colOrder.map((r) => (firstIdx.has(r) ? visibleSorted[vi++]! : r))
  setFlags({ ...cur, colOrder: order })
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
    // 旗标复位 + 快照清理（隐藏语义清零）
    setFlags({ colOrder: ['left', 'chat', 'panels'], leftHidden: false, panelsHidden: false })
    safeSet(STASH_KEY, '')
    // 复位后所有列都回到非 0 宽：清掉 0 宽标记与被记住的折叠宽
    for (const g of a.groups) applyCollapsedMarker(g, false)
    savedColumnWidth.clear()
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
