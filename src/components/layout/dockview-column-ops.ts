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

import {
  createConstraintKeeper,
  NO_MAXIMUM,
  type ColumnConstraints,
  type ConstraintTarget,
} from './column-constraints'
import {
  CHAT_MIN_WIDTH,
  clampRailWidth,
  leftRailDefaultWidth,
  panelsRailDefaultWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from './rail-metrics'

export type ColRegion = 'left' | 'chat' | 'panels'

export interface ColumnFlags {
  colOrder: ColRegion[]
  leftHidden: boolean
  panelsHidden: boolean
}

// ── 出厂布局（三栏）：[左栏 | 主栏 | 面板栏] ─────────────────────────────────
// 左/主组 hideHeader（无标签条）；组约束走**面板级** minimumWidth/
// maximumWidth（GroupviewPanelState 字段，随序列化 round-trip——组的生效
// 约束回落到活动 panel 的同名值；leaf data 的 constraints/initialWidth 在
// 反序列化里被丢弃，实测勿用）。wrapper.size = 出厂列宽（px 值，fromJSON
// 按比例归一——精确 px 由 boot 后 setSize 钉回）。面板栏出厂单签 open
// （打开页宿主，tabComponent openTab = 无 ✕ 头，根面板不可关）。
// 2026-10-16 自 dockview-shell 迁入（「默认布局」复位动词的同源消费方）。
//
// **栏宽是定值**（2026-10-22 用户定稿）：两轨默认宽 300、许可 270–400，
// 不随窗口缩放（口径单源 rail-metrics.ts）。容器宽只用来算主栏吃多少。
export const factoryLayout = (containerWidth: number, containerHeight: number): SerializedDockview => {
  const width = Math.max(1, Math.round(containerWidth))
  const left = leftRailDefaultWidth()
  const panels = panelsRailDefaultWidth()
  // 主栏吃剩余（两侧栏是定值，剩下的都归它；极窄窗口下不低于主栏 min）
  const chat = Math.max(CHAT_MIN_WIDTH, width - left - panels)
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: 'g-left', views: ['leftrail'], hideHeader: true }, size: left },
          { type: 'leaf', data: { id: 'g-chat', views: ['workspace'], hideHeader: true }, size: chat },
          { type: 'leaf', data: { id: 'g-panels', views: ['open'] }, size: panels },
        ],
      },
      height: Math.max(1, Math.round(containerHeight)),
      width,
      orientation: Orientation.HORIZONTAL,
    },
    panels: {
      leftrail: {
        id: 'leftrail',
        contentComponent: 'leftrail',
        title: '',
        minimumWidth: RAIL_MIN_WIDTH,
        maximumWidth: RAIL_MAX_WIDTH,
        params: { region: 'left' },
      },
      workspace: {
        id: 'workspace',
        contentComponent: 'workspace',
        title: '',
        minimumWidth: CHAT_MIN_WIDTH,
        params: { region: 'chat' },
      },
      open: {
        id: 'open',
        contentComponent: 'open',
        title: '打开',
        tabComponent: 'openTab',
        minimumWidth: RAIL_MIN_WIDTH,
        maximumWidth: RAIL_MAX_WIDTH,
        params: { region: 'panels' },
      },
    },
  }
}

/** 布局存档键。**v10**（2026-10-22）：栏宽口径从写死 350 改成用户定稿的
 *  300 / min 270 / max 400（口径单源 rail-metrics.ts）。旧档里存的列宽是
 *  350 基准下的产物，沿用会让新默认值看不见——换键即等于让所有人拿到新的
 *  出厂几何（代价：旧的分栏形态不迁移）。
 *  改键的规矩与之前一致：语义真变了才换，不为了"清一下存档"换。 */
export const LAYOUT_KEY = 'mirach.harness.layout.v10'

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
 *  panels 语义组。**routines 单独成群时不算根**（2026-11-24）：旧存档
 *  第五列被补了 region 戳之后，若它是组序里第一个 panels 组，boot 迁移
 *  会把它当成宿主而"不并组"——优先选还含其它面板的组。 */
export const rootPanelsGroup = (a: DockviewApi): DockviewGroupPanel | undefined => {
  const open = a.getPanel('open')
  if (open) return open.group
  const groups = groupsOfRegion(a, 'panels')
  return groups.find((g) => g.panels.some((p) => p.id !== 'routines')) ?? groups[0]
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
  // **面板栏内有左右分栏（多个 panels 组）时不重排**（2026-11-24）：这里
  // 只该把"面板栏"整体钉到边，分栏组之间的先后是用户拖出来的；挑其中一个
  // 组 moveTo 到最右会把另一个组挤到左边，重载后左右顺序翻转。
  if (!flags.panelsHidden && groupsOfRegion(a, 'panels').length === 1) {
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

/** 收放期间的内容淡出标记（`data-dv-morph`）——CSS 只认它做 opacity 过渡。
 *  宽度**不靠 CSS**（见 tweenFrames 头注释：CSS 与 dockview 模型不同步）。 */
const markMorph = (g: DockviewGroupPanel, phase: 'show' | 'hide'): void => {
  g.element?.setAttribute('data-dv-morph', phase)
}

const clearMorph = (g: DockviewGroupPanel | undefined): void => {
  if (!g) return
  g.element?.removeAttribute('data-dv-morph')
}

/** ── 收放约束（状态机在 column-constraints.ts，此处只做 dockview 投影）──
 *
 * 两个实测 bug 的根因都在这里（详细机制见 column-constraints.ts 文件头）：
 *  ① 收起只放开 min、max 留在 MAX → 0 宽列对 dockview 仍是 flexible item，
 *    `Sizing.Distribute` 的 addPanel（分栏/开新签）会把它重新摊出宽度，
 *    而内容层还挂着 `data-dv-collapsed` → 面板栏位置一张空白卡；
 *  ② 收起收尾就把快照删了 → 展开拿不到原值，min/max 限制永久失效。
 *
 * 原值取**面板级**约束（panel.minimumWidth/maximumWidth，随 panels 存档
 * round-trip），不取组当前值——后者可能已经是收放态（刷新后按旗标自愈时
 * 列本来就是 0 宽），拿它当原值会把错误固化。
 *
 * **每个组必须复用同一个投影对象**（2026-10-22 实机实锤）：状态机的快照表
 * 以 target 为键（WeakMap），每次调用现造新对象会让快照永远命中不了——
 * 实测表现为展开后组约束停在补间盒 {0, MAX}（宽度限制确实失效），而修好
 * 键身份后才回到面板级 {240, MAX}。 */
interface ConstraintTargetView extends ConstraintTarget {
  readonly group: DockviewGroupPanel
}

const constraintKeeper = createConstraintKeeper()
const constraintTargets = new WeakMap<DockviewGroupPanel, ConstraintTargetView>()

const constraintTargetOf = (g: DockviewGroupPanel): ConstraintTargetView => {
  const existing = constraintTargets.get(g)
  if (existing) return existing
  const view: ConstraintTargetView = {
    id: g.id,
    group: g,
    // 两个 getter 都**现读**（面板集合与活动面板会变：分栏/切签），
    // 只有对象身份需要稳定。
    get currentMaximumWidth() {
      return g.maximumWidth
    },
    get panelConstraints() {
      const panel = g.activePanel ?? g.panels[0]
      if (!panel) {
        console.error('[dv-column-ops] 组内没有面板——无法取原约束', g.id)
        return { minimumWidth: 0, maximumWidth: NO_MAXIMUM }
      }
      return {
        minimumWidth: panel.minimumWidth ?? 0,
        maximumWidth: panel.maximumWidth ?? NO_MAXIMUM,
      }
    },
    apply(next) {
      const groupApi = g.api as unknown as {
        setConstraints?: (v: ColumnConstraints) => void
      }
      if (typeof groupApi.setConstraints !== 'function') {
        console.error('[dv-column-ops] group.api.setConstraints 不在场——收放约束无法下发', g.id)
        return
      }
      groupApi.setConstraints(next)
    },
  }
  constraintTargets.set(g, view)
  return view
}

const openTweenConstraints = (g: DockviewGroupPanel): void =>
  constraintKeeper.beginTween(constraintTargetOf(g))

const collapseConstraints = (g: DockviewGroupPanel): void =>
  constraintKeeper.settleCollapsed(constraintTargetOf(g))

const restoreConstraints = (g: DockviewGroupPanel): void =>
  constraintKeeper.settleExpanded(constraintTargetOf(g))

/** 逐帧驱动一组宽度（**JS 补间替代 CSS transition**）。
 *
 *  **为什么不用 CSS transition**（2026-10-18 实锤）：CSS 只改 DOM 的 inline
 *  width，dockview 的**模型**仍认为该列是原宽。两者不一致时库会按模型重新
 *  分配，把释放的宽度全塞给最后一列（实测：左栏收到 0 的过程中，面板栏被
 *  摊到原宽的两倍，收起后才回原值）——用户看到的就是"面板栏闪烁变大"。
 *  逐帧调用 `api.setSize` 则让**模型与 DOM 同步推进**，每次分配都落在我们
 *  指定的列上。
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
  // 动画帧之间还有一整帧（实测 ~380ms，旧运行时下更久），期间 dockview 会把
  // 刚插入的组按自己的分配显示出来——用户看到的就是"先跳到 min 宽再补间"。
  // 先同步设一遍起点，浏览器随后才绘制。
  //
  // **同一 tick 里把宽表全部设完**（2026-10-18 实测）：`setSize` 只改一列，
  // 差额由 dockview 推给邻居——单独设一列为 0 会把邻居顶到远超其原宽。
  // 因此首帧必须把**所有相关列**一起写（调用方已保证 widthAt 返回全表），
  // 且顺序无关（库按最终请求值结算）。
  apply(0)
  // **用 setTimeout 而非 rAF 驱动补间**（2026-10-22 在 wry/WebView2 下复测）：
  // 布局结算后 setTimeout(0) 实测 0ms，rAF 恒等下一帧（16ms @60fps）——
  // setTimeout 首帧更早、补间更跟手。旧运行时（CEF）下 rAF 还会在一次布局
  // 结算后停 400ms+（rafMs=412），那是切 setTimeout 的原始理由；该停摆在
  // WebView2 上**不复现**，但 setTimeout 仍然更快，故维持不变。
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
  // 展开方向的回落值：用户拖过的宽优先，否则用**默认宽 300**（2026-10-22
  // 用户定稿：栏宽是定值，不随容器缩放）。`savedColumnWidth` 只在收起时
  // 记不到宽（0 宽读不出原值），所以这是"没记忆时"的兜底目标。
  const region = regionOfGroup(group)
  const defaultWidth = region === 'panels' ? panelsRailDefaultWidth() : leftRailDefaultWidth()
  const targetWidth = hidden ? 0 : (savedColumnWidth.get(group.id) ?? defaultWidth)

  // 已经到位：只补一致性与标记。**约束也必须在这一支收敛**（2026-10-22）：
  // 刷新后按旗标自愈时列本来就是 0 宽（早退路径），若这里不把约束盒压成
  // 0..0，收起态就缺了"不可被摊宽"的那个许可撤销——分栏照样会摊出空白卡。
  // 展开方向同理：宽度已到目标但约束可能还停在收放态，必须还原。
  if (startWidth === targetWidth) {
    if (hidden) collapseConstraints(group)
    else restoreConstraints(group)
    // 约束变更会触发 dockview 按存档比例 relayout（收起期间该列比例是 0），
    // 把宽度钳到面板级 min——宽度已到目标也必须再钉一次，否则「打开」在
    // 隐藏期比例为 0 的场景下会停在 min（实测 240 而非比例目标宽）。
    group.api.setSize({ width: targetWidth })
    applyCollapsedMarker(group, hidden)
    onDone?.()
    return
  }

  // 让出/收回宽度的邻居：chat 域第一个组（会话分栏的其余组不动）
  const chat = groupsOfRegion(a, 'chat')[0]
  const chatStart = chat ? Math.round(chat.width) : 0
  const delta = targetWidth - startWidth // >0 展开、<0 收起

  morphBusy = true
  // 补间窗口的约束：min 放开到 0（出厂 min=240 会钳住），max 保留原值
  // （补间要在 0..原宽 连续取值，任何上限都会让首帧被 clamp 跳变）。
  openTweenConstraints(group)
  // **展开方向：补间开始前就摘掉 `data-dv-collapsed`**（2026-10-18 用户报
  // "展开时容器有动画、内容没有，等容器展开完瞬间出现"）——它里面的
  // `visibility: hidden` 会让整栏内容在整段补间里都不可见，等收尾才一次性
  // 恢复。此刻组宽仍是 0（overflow 裁切），摘掉不会提前露出内容，只是让
  // 内容跟着宽度一起入场（CSS 走 [data-dv-morph='show']）。
  if (!hidden) setCollapsedAttr(group, false)
  markMorph(group, hidden ? 'hide' : 'show')

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
      // **顺序即语义**（2026-10-22 逐帧实机采样后定）：先还原/压紧约束，
      // 再钉最终宽度。
      // dockview 的 `setConstraints` 会走 `_onDidChange` → 父 branch 的
      // relayout，而 relayout 按**存档比例**重算各列（收起期间 panels 的
      // 比例是 0），于是宽度被钳到面板级 min（实测打开方向停在 240 而不是
      // 记忆的目标宽）。把 setSize 放在约束之后，显式宽度才是最后一次写入。
      if (hidden) {
        // 收起态：约束盒归 0..0（不只是 min=0）——max 留着就等于给 dockview
        // 留了一个"这列可以被摊宽"的许可，任何 Sizing.Distribute 的
        // addPanel（分栏/开新签）都会把它重新摊出宽度（空白卡片，见
        // collapseConstraints 注释）。快照**不在这里消费**，隐藏期一直
        // 留着给展开方向还原。
        collapseConstraints(group)
        group.api.setSize({ width: targetWidth })
        if (chat) chat.api.setSize({ width: chatStart - delta })
      } else {
        // 展开收尾：还原收放前的 min/max（0..0 若留在身上，用户就再也
        // 拖不宽了——「宽度限制失效」的另一半）。还原后再钉一次宽度。
        restoreConstraints(group)
        group.api.setSize({ width: targetWidth })
        if (chat) chat.api.setSize({ width: chatStart - delta })
      }
      // 收尾：标记落定（applyCollapsedMarker 只写 data-dv-collapsed——
      // 贴边内缩那套随 MainTint 于 2026-10-21 整体退役）
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
}

/** 用户的列宽记忆（0 宽时读不到 group.width，只能自己存）。
 *  键 = 组 id（'g-left' / 'g-panels'），跨会话不持久——重启后回到快照值。 */
const savedColumnWidth = new Map<string, number>()

/** 两轨的**目标宽**（用户意图 / 出厂默认），跨窗口缩放保持不变。
 *
 *  为什么需要单独记（2026-10-22 实锤）：dockview 的序列化**按比例**记列宽。
 *  窗口从 1760 缩到 1400 时，存档里 300/1748 的比例摊到新宽度只剩 270——
 *  栏宽"自己变窄"了，与"默认 300 / min 270"的语义冲突。所以两轨的宽度
 *  必须由我们按**绝对值**维护：窗口尺寸变化后重新钉回这个目标宽（被 clamp
 *  到当前许可区间），主栏吃剩余。用户拖 sash 会更新目标宽（onDidLayoutChange
 *  里同步，见 dockview-shell）。 */
const railTargetWidth = new Map<string, number>()

/** 记录/读取两轨目标宽（'left' / 'panels'）。 */
export const setRailTargetWidth = (region: ColRegion, width: number): void => {
  if (region === 'chat') return
  railTargetWidth.set(region, clampRailWidth(width))
}

export const railTargetWidthOf = (region: ColRegion): number =>
  railTargetWidth.get(region) ?? RAIL_DEFAULT_WIDTH

/** 窗口尺寸变化后把两轨钉回目标宽（主栏吃剩余）。收起态（宽 0）跳过。
 *
 *  调用时机：dockview 容器尺寸变化（窗口 resize / 侧栏收放结束 / 拖出分栏）。
 *  幂等：宽度已等于目标时不动，避免无谓的 relayout。
 *
 *  **自带重入护栏**（2026-10-22 实锤）：`setSize` 会同步触发
 *  `onDidLayoutChange`，调用方若在该回调里再调本函数就会无限递归——
 *  实测直接把主线程冻死（应用"卡死动不了"，只能强杀）。这里用模块级
 *  标志挡住重入，任何调用方都不会踩坑。
 *
 *  **垂直分栏后 width 不是尺寸轴**：上下分栏会把根 gridview 转成 VERTICAL，
 *  此时左栏组的 `setSize({width})` 不生效——它的 size 轴是高度。这里同时给
 *  width/height（height 用当前值，等于不动），让 dockview 按自己的
 *  orientation 挑轴。 */
let repinInFlight = false

export const repinRailWidths = (): void => {
  if (repinInFlight) return
  const a = api()
  if (!a) return
  const left = groupsOfRegion(a, 'left')[0]
  const panels = groupsOfRegion(a, 'panels')[0]
  // 收起中的列宽度为 0——它的目标宽在展开时用，这里不钉（钉了会把隐藏的
  // 栏又撑出来）
  const pin = (g: DockviewGroupPanel | undefined, region: ColRegion) => {
    if (!g) return
    const current = Math.round(g.width)
    if (current <= 0) return
    const target = clampRailWidth(railTargetWidthOf(region))
    if (Math.abs(current - target) <= 1) return
    // 带上 height（当前值）——垂直分栏下 width 不是尺寸轴，只给 width 是空操作
    g.api.setSize({ width: target, height: Math.round(g.height) })
  }
  repinInFlight = true
  try {
    pin(left, 'left')
    pin(panels, 'panels')
  } finally {
    repinInFlight = false
  }
}

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

/** 隐藏/打开面板栏（根面板列唯一；恢复位 = colOrder 语义位）
 *
 *  **ZCode 语义对齐**（2026-11-01 用户："zcode打开页是没有标签的，只有
 *  一个标签的时候是关闭是会关闭面板栏的"）：
 *  - 隐藏时组可能已被 dockview 收走（末签关闭路径）——栏在视觉上已消失，
 *    此时只记账（panelsHidden = true），不要求组在场；
 *  - 打开时组不在场（末签关闭后被重新打开）→ 先重建打开页锚组
 *    （ensurePanelsAnchor），再收约束盒展开。 */
export const setPanelsHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.panelsHidden) return
  let root = rootPanelsGroup(a)
  if (!root) {
    if (hidden) {
      // 组已被 dockview 收走：栏已消失，只落旗标（boot normalize 不再误报）
      setFlags({ ...flags, panelsHidden: true })
      return
    }
    ensurePanelsAnchor(a)
    root = rootPanelsGroup(a)
    if (!root) {
      console.error('[dv-column-ops] 面板栏锚重建失败——切换放弃')
      return
    }
  }
  setFlags({ ...flags, panelsHidden: hidden })
  setColumnCollapsed(root, hidden)
  if (!hidden) {
    // 重建/展开后把两轨钉回目标宽（rAF——不在布局回调栈里 setSize；重建
    // 组的初始宽是 dockview 的比例摊分，不在 270–400 许可内）
    requestAnimationFrame(() => repinRailWidths())
  }
}

/** 重建面板栏锚（打开页宿主）。面板组被 dockview 收走后的「打开面板栏」
 *  路径用；组与锚都在场时不做任何事。工厂布局的 open 面板形状与此同源
 *  （factoryLayout.panels.open——**min+max 都带**：漏 max 会让重建组吃到
 *  比例摊分宽 766，实测 2026-11-01）。 */
export const ensurePanelsAnchor = (a: DockviewApi): void => {
  if (a.getPanel('open')) return
  if (rootPanelsGroup(a)) return
  a.addPanel({
    id: 'open',
    component: 'open',
    title: '面板',
    tabComponent: 'openTab',
    minimumWidth: RAIL_MIN_WIDTH,
    maximumWidth: RAIL_MAX_WIDTH,
    params: { region: 'panels' },
    position: { referencePanel: 'workspace', direction: 'right' },
  })
}

// ── boot 自愈（normalizeColumns 的 dockview 版） ─────────────────────────────

/** 旗标与实际几何脱同步时按旗标收敛（**判据 = 宽度**，2026-10-18 改）：
 *  收放现在"只改宽度、从不摘组"，所以"组在不在"不再是隐藏判据——要看
 *  宽度是不是 0。列序对齐仍是每次都做。
 *
 *  **约束盒也必须一起收敛**（2026-10-22）：dockview 的组级显式约束不随
 *  存档 round-trip（组 state 只有 id/locked/hideHeader/headerPosition/
 *  views），刷新后隐藏列回到"宽度 0 + 面板级 min 240/max MAX"——宽度对了
 *  但许可还在，于是下一次分栏照样把它摊出宽度（空白卡片）。故无论走哪一
 *  支，收起态都必须落成 0..0 的约束盒。 */
export const normalizeColumns = (): boolean => {
  const a = api()
  if (!a) return false
  let migrated = false
  const flags = columnFlagsOf()
  // 旧存档里 routines 可能是独立的第五列（100px 被窗口裁掉）；它是面板栏
  // 的标签，启动时并回面板组，避免新插件面板没有列宽约束。
  // **但面板栏内的上下分栏是用户合法布局**（2026-11-24 用户："把定时任务
  //  标签拉出在面板栏进行分栏"）：routines 组位于根 branch 的嵌套 branch 内
  //  = 同列堆叠，不要并回；只有根级直挂 leaf 的旧第五列才迁移。
  const panelHost = rootPanelsGroup(a)
  const routines = a.getPanel('routines')
  // 旧存档的 routines 面板没有 region 戳：独立成组时 regionOfGroup 认不出
  // 它是面板栏，组级 270–400 约束就补不上。先补戳再并组。
  if (routines && routines.params?.region !== 'panels') {
    try {
      routines.api.updateParameters({ ...(routines.params ?? {}), region: 'panels' })
    } catch (e) {
      console.error('[dv-column-ops] routines 区域标记补写失败', e)
    }
  }
  const layout = toLoose(a)
  const nestedLeafGroups = new Set<string>()
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; data?: unknown }
    if (n.type === 'leaf') {
      const leaf = n.data as { id?: string } | undefined
      if (depth > 0 && leaf?.id) nestedLeafGroups.add(leaf.id)
      return
    }
    if (Array.isArray(n.data)) n.data.forEach((child) => walk(child, depth + 1))
  }
  for (const child of layout.grid.root.data ?? []) walk(child, 0)
  const stackedInSameColumn = !!routines && nestedLeafGroups.has(routines.group.id)
  // 旧第五列的识别信号 = 宽度 < 270（历史上被挤成 100px）。用户自己拖出的
  // 左右分栏是 ≥270 的根级 leaf（2026-11-24 用户："左右分栏"）——不能当成
  // 旧档并掉，否则一重载就消失。
  const legacyFifthColumn = !!routines && Math.round(routines.group.width) < RAIL_MIN_WIDTH
  if (
    panelHost &&
    routines &&
    routines.group.id !== panelHost.id &&
    !stackedInSameColumn &&
    legacyFifthColumn
  ) {
    try {
      routines.api.moveTo({ group: panelHost, position: 'center', skipSetActive: true })
      migrated = true
    } catch (e) {
      console.error('[dv-column-ops] routines 面板并回面板栏失败', e)
    }
  }
  // 存档只能恢复 panel 的 minimumWidth/maximumWidth；组级约束不 round-trip。
  // 启动时按区域统一补一次，否则新标签成为 active 后右栏就没有 270–400 限制。
  for (const g of a.groups) {
    const region = regionOfGroup(g)
    if (!region) continue
    const write = (g.api as unknown as { setConstraints?: (v: { minimumWidth: number; maximumWidth: number }) => void }).setConstraints
    if (typeof write !== 'function') continue
    const bounds =
      region === 'chat'
        ? { minimumWidth: CHAT_MIN_WIDTH, maximumWidth: Number.MAX_SAFE_INTEGER }
        : { minimumWidth: RAIL_MIN_WIDTH, maximumWidth: RAIL_MAX_WIDTH }
    try {
      write.call(g.api, bounds)
    } catch (e) {
      console.error('[dv-column-ops] 组宽约束写入失败', g.id, e)
    }
  }
  // 旧版的 colstash 快照在新机制下已无意义（不再摘组）——启动时清掉遗留键
  if (safeGet(STASH_KEY)) {
    console.info('[dv-column-ops] 布局快照机制已退役（收放改为纯宽度）——清理旧快照')
    safeSet(STASH_KEY, '')
  }
  const converge = (g: DockviewGroupPanel, hidden: boolean): void => {
    const collapsed = Math.round(g.width) === 0
    if (collapsed !== hidden) {
      withoutColumnMorph(() => setColumnCollapsed(g, hidden))
      return
    }
    // 宽度已是目标态：只收敛约束盒 + 标记（组常驻后 DOM 是新的，
    // data-dv-collapsed 不会自己回来）
    if (hidden) collapseConstraints(g)
    else restoreConstraints(g)
    applyCollapsedMarker(g, hidden)
  }
  // 左栏
  const lg = groupsOfRegion(a, 'left')[0]
  if (lg) converge(lg, flags.leftHidden)
  else if (!flags.leftHidden) {
    console.error('[dv-column-ops] 左栏组不在树里——旗标未隐藏但无法恢复（布局存档异常）')
  }
  // 面板栏同理
  const root = rootPanelsGroup(a)
  if (root) converge(root, flags.panelsHidden)
  else if (!flags.panelsHidden) {
    console.error('[dv-column-ops] 面板栏组不在树里——旗标未隐藏但无法恢复（布局存档异常）')
  }
  alignVisibleToOrder(a)
  persistFlagsColOrder(a)
  return migrated
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

/** 布局回出厂形态：fromJSON(factoryLayout(容器宽,高))（内部先 clear——会话
 *  分栏/打开页全收，三栏 [左|主|面板] 重建，open 锚在场）+ 旗标复位
 *  （colOrder 出厂序、栏显隐归 false；旧 colstash 判废——隐藏期快照对复位
 *  后的树已无意义）+ 双轨钉回 300（同 boot 出厂钉法：fromJSON 的 size 按
 *  比例归一，不是 px）+ 出厂布局存档（覆盖 v10 键，reload 后不回旧形态）。
 *  挂载页签的会话不丢：会话真相在 pi，重开走侧栏/列表。失败 = console.error
 *  可见（规矩 12）。 */
export const resetLayoutToFactory = (): void => {
  const a = api()
  if (!a) return
  try {
    const factory = factoryLayout(a.width, a.height)
    holdLayoutSurgery(() => a.fromJSON(factory))
    // 旗标复位 + 快照清理（隐藏语义清零）
    setFlags({ colOrder: ['left', 'chat', 'panels'], leftHidden: false, panelsHidden: false })
    safeSet(STASH_KEY, '')
    // 复位后所有列都回到非 0 宽：清掉 0 宽标记与被记住的折叠宽
    for (const g of a.groups) applyCollapsedMarker(g, false)
    savedColumnWidth.clear()
    // 双轨钉回 300（两轮互挤后收敛——boot 出厂同款；rAF 后树已稳）。
    // 钉宽放复位护栏之外：rAF/150ms 回调跑时 depth 已归零，不受让位影响。
    const pin = () => {
      const lg = groupsOfRegion(a, 'left')[0]
      const pg = groupsOfRegion(a, 'panels')[0]
      const left = leftRailDefaultWidth()
      const panels = panelsRailDefaultWidth()
      for (let i = 0; i < 3; i++) {
        pg?.api.setSize({ width: panels })
        lg?.api.setSize({ width: left })
      }
    }
    requestAnimationFrame(pin)
    setTimeout(pin, 150)
    // 出厂存档（onDidLayoutChange 防抖 250ms 也会写——这里先写一次
    // 让持久化即时收敛，防 debounce 窗口内进程退出留下旧档）
    safeSet(LAYOUT_KEY, JSON.stringify(factory))
    console.info('[dv-column-ops] 布局已复位为出厂形态')
  } catch (e) {
    console.error('[dv-column-ops] 布局复位失败', e)
  }
}
