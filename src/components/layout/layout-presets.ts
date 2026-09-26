/**
 * 布局预设 —— 逐字对照 hermes app/contrib/layout-presets.ts 的五套模板。
 * hermes 用 group/split 树（app/pane-shell/tree/model），这里译成 flexlayout
 * JSON。嵌套 row 方向自动交替（根水平）：hermes 的 split('row')=本层水平、
 * split('column')=嵌套 row。weight 全按 hermes 原值换算成百分比。
 * 各栏限制不写死在共享函数里——每个预设的 tabset 按住着的页签带上自己的
 * 约束（sessions 237-360、files/review 160-320、主区 22vw、终端 80vh 上限），
 * 页签被拖走后约束跟着 tabset 走（与 hermes 的 pane 注册语义一致）。
 * split id 沿用 hermes 的命名（spl-root/spl-right/spl-rail）：双击分隔条
 * 回默认尺寸时按 id 在已应用预设树里查原始权重（hermes presetSplitWeights）。
 */

// hermes 各栏限制常量（store/layout.ts + controller.tsx 逐值）：
// SIDEBAR_DEFAULT_WIDTH 237 / SIDEBAR_MAX_WIDTH 360、
// FILE_BROWSER: default 237 / min 10rem(160) / max 20rem(320)、
// 终端 height 20vh（默认 weight）/ maxHeight 80vh / 无 minHeight、
// 主区 minWidth 22vw。
// flexlayout 高度语义：tabset 的 minHeight/maxHeight 是**内容高度**，
// 实际渲染 = attr + 页签条（dark.css 实测 29px）——按整栏 80vh 控制，attr 减 29。

export const TAB_STRIP_H = 28
/** hermes COLLAPSED_ZONE_PX：拖到这个高度就折叠进轨道 */
export const COLLAPSED_ZONE_PX = 28
/** hermes app/layout-constants.ts：两根侧栏撤出网格变 overlay 的断点 */
export const SIDEBAR_COLLAPSE_MEDIA_QUERY = '(max-width: 639.98px)'

// ── 固定 px 轨道（hermes 的 zone 声明式尺寸 + 用户覆盖：默认宽 350） ────────
// 大栏约束数值（用户 2026-09-26 定稿，docs/layout-design.md §2）：
// 左栏 240-420 / 主栏 仅 min 395（无上限）/ 右栏 240-420。
// 左右栏默认宽 350（区间内）。高度：堆叠分栏 min = 标题栏（28）、max 无
// （v2.1 删除了终端 80vh 上限——"最大高度没限制"，白带类 bug 随之消失）。
export const SIDEBAR_DEFAULT_WIDTH = 350

/** 各 region 的 zone 宽度约束（flex-layout 约束引擎按此分发） */
export const REGION_LIMITS: Record<string, { minW: number; maxW: number | null }> = {
  left: { minW: 240, maxW: 420 },
  main: { minW: 395, maxW: null },
  right: { minW: 240, maxW: 420 },
}

/** 左栏 tabset（logo 带在上、标签条紧随其下）：宽度钳制 + 标签条自定义类
 *  （styles/flexlayout.css 给 .rail-tabstrip 顶部让出 logo 带高度） */
export const RAIL_TABSET_ATTRS = { minWidth: 240, maxWidth: 420, classNameTabStrip: 'rail-tabstrip' }

/** 主栏 zone 约束（仅 min 395，无上限） */
export const MAIN_ZONE_ATTRS = { minWidth: 395 }

/** 右栏 zone 约束（min 240 / max 420） */
export const RIGHT_ZONE_ATTRS = { minWidth: 240, maxWidth: 420 }

/** 堆叠分栏高度下限（内容高；"挤压到最小只保留标题栏"） */
export const STACKED_MIN_H = 0

const tab = (id: string, name: string, enableClose = true) => ({
  type: 'tab' as const,
  id,
  component: id,
  name,
  enableClose,
})

const tabset = (weight: number, tabs: ReturnType<typeof tab>[], attrs: Record<string, unknown> = {}) => ({
  type: 'tabset' as const,
  weight,
  selected: 0,
  ...attrs,
  children: tabs,
})

const row = (weight: number, children: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: 'row' as const,
  weight,
  ...attrs,
  children,
})

// Default：根行水平 [左栏 | 主栏 | 右栏]；右栏垂直 [上排(检查|文件) / 终端]。
// 宽度：左 350（240-420）/ 主吃剩余（min 395）/ 检查、文件各 350（240-420）。
// 高度：终端默认 20vh（weight 制，无 max——"最大高度没限制"）。

/** flexlayout 分隔条占位：视觉是 1px 发丝线（--flexlayout-splitter-size），
 *  内部算宽同样按它扣（实测：8px 时代 237 精确、改 1px 后同权重漂到 240）；
 *  8px 命中带由 ::before 提供，不占布局。 */
export const SPLITTER_PX = 1
/** 网格高（宿主 = 视口 − 标题栏 36 − 状态栏 20；空边框轨道已 autoHide） */
const GRID_H = () => window.innerHeight - 36 - 20

/** zone 的 region 配置（约束继承与双形态的载体，docs/layout-design.md §2/§5） */
const zoneCfg = (region: 'left' | 'main' | 'right') => ({ config: { region, rail: false } })

// Default：根行水平 [左栏 | 主栏 | 右栏]；右栏垂直 [上排(检查|文件) / 终端]
const DEFAULT_TREE = () => {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const H = GRID_H()
  const rail = SIDEBAR_DEFAULT_WIDTH
  const railTop = SIDEBAR_DEFAULT_WIDTH * 2 + S // 检查|文件并排：350+350+中缝
  const rootAvail = W - 2 * S
  const main = rootAvail - rail - railTop
  const rightAvailH = H - S
  // 终端默认高度 20vh（weight 制；v2.1 无 maxHeight——最大高度没限制）
  const term = Math.round(window.innerHeight * 0.2)
  return row(100, [
    tabset((rail / rootAvail) * 100, [tab('sessions', '会话列表', false), tab('bots', '机器人', true)], { ...RAIL_TABSET_ATTRS, ...zoneCfg('left') }),
    tabset((main / rootAvail) * 100, [tab('workspace', '主会话', false)], { minWidth: 395, ...zoneCfg('main') }),
    row((railTop / rootAvail) * 100, [
      row(((rightAvailH - term) / rightAvailH) * 100, [
        tabset(50, [tab('review', '检查')], { minWidth: 240, maxWidth: 420, ...zoneCfg('right') }),
        tabset(50, [tab('files', '文件树')], { minWidth: 240, maxWidth: 420, ...zoneCfg('right') }),
      ], { id: 'spl-rail' }),
      tabset((term / rightAvailH) * 100, [tab('terminal', '终端')], { ...zoneCfg('right') }),
    ], { id: 'spl-right', ...zoneCfg('right') }),
  ], { id: 'spl-root' })
}

// Focus：sessions | 一个 tabset 塞 主会话/文件/检查/终端（主区吃剩余）
const FOCUS_TREE = () => {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const rail = SIDEBAR_DEFAULT_WIDTH
  const rootAvail = W - S
  return row(100, [
    tabset((rail / rootAvail) * 100, [tab('sessions', '会话列表', false), tab('bots', '机器人', true)], { ...RAIL_TABSET_ATTRS, ...zoneCfg('left') }),
    tabset(100 - (rail / rootAvail) * 100, [tab('workspace', '主会话', false), tab('files', '文件树', false), tab('review', '检查'), tab('terminal', '终端')], {
      minWidth: 395,
      ...zoneCfg('main'),
    }),
  ], { id: 'spl-focus-root' })
}

// Basic：sessions | 主会话（引导期预设——新用户先不用认识终端/文件/检查）
const BASIC_TREE = () => {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const rail = SIDEBAR_DEFAULT_WIDTH
  const rootAvail = W - S
  return row(100, [
    tabset((rail / rootAvail) * 100, [tab('sessions', '会话列表', false), tab('bots', '机器人', true)], { ...RAIL_TABSET_ATTRS, ...zoneCfg('left') }),
    tabset(100 - (rail / rootAvail) * 100, [tab('workspace', '主会话', false)], { minWidth: 395, ...zoneCfg('main') }),
  ], { id: 'spl-basic-root' })
}

// Terminal deck：上排 会话列表|主会话|文件+检查，底部通栏终端 20vh。
const TERMINAL_TREE = () => {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const H = GRID_H()
  const rail = SIDEBAR_DEFAULT_WIDTH
  const deckSide = SIDEBAR_DEFAULT_WIDTH
  const topAvail = W - 2 * S
  const main = topAvail - rail - deckSide
  const colAvailH = H - S
  const term = Math.round(window.innerHeight * 0.2)
  return row(100, [
    row(100, [
      row(((colAvailH - term) / colAvailH) * 100, [
        tabset((rail / topAvail) * 100, [tab('sessions', '会话列表', false), tab('bots', '机器人', true)], { ...RAIL_TABSET_ATTRS, ...zoneCfg('left') }),
        tabset((main / topAvail) * 100, [tab('workspace', '主会话', false)], { minWidth: 395, ...zoneCfg('main') }),
        tabset((deckSide / topAvail) * 100, [tab('files', '文件树', false), tab('review', '检查')], { minWidth: 240, maxWidth: 420, ...zoneCfg('right') }),
      ], { id: 'spl-deck-top' }),
      tabset((term / colAvailH) * 100, [tab('terminal', '终端')], { ...zoneCfg('right') }),
    ], { id: 'spl-deck-col' }),
  ], { id: 'spl-deck-root' })
}

// Quad：上排 [会话列表 | 主会话]，下排 [终端 | 检查]——上 80vh/下 20vh
const QUAD_TREE = () => {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const H = GRID_H()
  const rail = SIDEBAR_DEFAULT_WIDTH
  const review = SIDEBAR_DEFAULT_WIDTH
  const topAvail = W - S
  const bottomAvail = W - S
  const colAvailH = H - S
  const term = Math.round(window.innerHeight * 0.2)
  return row(100, [
    row(100, [
      row(((colAvailH - term) / colAvailH) * 100, [
        tabset((rail / topAvail) * 100, [tab('sessions', '会话列表', false), tab('bots', '机器人', true), tab('files', '文件树', false)], { ...RAIL_TABSET_ATTRS, ...zoneCfg('left') }),
        tabset(100 - (rail / topAvail) * 100, [tab('workspace', '主会话', false)], { minWidth: 395, ...zoneCfg('main') }),
      ], { id: 'spl-quad-top' }),
      row((term / colAvailH) * 100, [
        tabset(100 - (review / bottomAvail) * 100, [tab('terminal', '终端')], { ...zoneCfg('right') }),
        tabset((review / bottomAvail) * 100, [tab('review', '检查')], { minWidth: 240, maxWidth: 420, ...zoneCfg('right') }),
      ], { id: 'spl-quad-bottom' }),
    ], { id: 'spl-quad-col' }),
  ], { id: 'spl-quad-root' })
}

export interface LayoutPreset {
  id: string
  title: string
  build: () => unknown
}

/** hermes layouts area 的注册项（basic 是引导期项，order 对齐） */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'default', title: 'Default', build: DEFAULT_TREE },
  { id: 'basic', title: 'Basic', build: BASIC_TREE },
  { id: 'focus', title: 'Focus', build: FOCUS_TREE },
  { id: 'terminal-deck', title: 'Terminal deck', build: TERMINAL_TREE },
  { id: 'quad', title: 'Quad', build: QUAD_TREE },
]

export const GLOBAL_ATTRS = {
  tabEnableClose: true,
  tabEnableDrag: true,
  tabEnableRename: true,
  tabEnablePin: true,
  tabSetEnableDivide: true,
  tabSetEnableMaximize: true,
  tabSetEnableTabStrip: true,
  // 单页签 zone 拉伸成头栏（hermes 单窗格 zone 的视觉）
  tabSetEnableSingleTabStretch: true,
  // 浮动窗口（Q6 要）：tab 级 enableFloat 开启，浮动图标进页签尾部；
  // flexlayout 原生 FloatingWindow 承载（拖动/停靠回布局均为内建能力）
  tabEnableFloat: true,
  // 关掉"拖到布局外缘就 dock 成新列/新行"（hermes 的分区不变量：
  // 页签只进已有 tabset 或内部分裂，不允许在骨架外缘开新区域）
  enableEdgeDock: false,
  // 空的边框轨道自动隐藏——否则四条空轨道各吃 31px，整圈啃掉网格
  // （实测 1280×720 网格只剩 1218×596；hermes 没有这种空轨道占位）
  borderEnableAutoHide: true,
}

// 四条边框（fold-to-rail 的轨道）：空声明让模型可收页签；
// 左/右两条在窄屏时切 overlay 模式（hermes 边缘抽屉）。
// 注意 flexlayout 忽略 JSON 里的 border id，固定按位置生成：
// border_left/right/bottom/top——fold/overlay 都用这套 id。
const BORDER_IDS = { left: 'border_left', right: 'border_right', bottom: 'border_bottom', top: 'border_top' }
export const BORDER_ID = BORDER_IDS

/** 四条空边框（fold-to-rail 轨道 / 窄屏 overlay 抽屉）——zone 编辑器也复用 */
export const makeBordersJson = () => [
  { type: 'border', location: 'left', children: [] },
  { type: 'border', location: 'right', children: [] },
  { type: 'border', location: 'bottom', children: [] },
  { type: 'border', location: 'top', children: [] },
]

const bordersJson = makeBordersJson

/** 预设树 → 完整 model JSON（global 属性；各栏约束已写进预设 JSON） */
export const presetToModelJson = (preset: LayoutPreset): import('flexlayout-react').IJsonModel =>
  ({
    global: GLOBAL_ATTRS,
    borders: bordersJson(),
    layout: preset.build(),
  }) as import('flexlayout-react').IJsonModel

// ── 镜像翻转（hermes tree/model.ts mirrorTreeHorizontal，⌘\） ────────────────
// hermes：orientation 'row'（水平）→ children 与 weights 反转；'column' 不变。
// flexlayout 行方向按深度交替：深度偶数=水平 → 反转 children（weight 跟着
// children 走，无需单独反转）。

export const mirrorLayoutJson = (json: any): any => {
  const walk = (node: any, depth: number): any => {
    if (node.type === 'row') {
      const children = (node.children ?? []).map((c: any) => walk(c, depth + 1))
      return depth % 2 === 0 ? { ...node, children: [...children].reverse() } : { ...node, children }
    }
    return node
  }
  return { ...json, layout: walk(json.layout, 0) }
}

// ── 用户自定义预设（hermes tree/presets.ts 的 saveCurrentLayoutAs /
// deleteUserPreset / isUserPreset：存 localStorage，id 前缀 user-） ────────────

const USER_PRESETS_KEY = 'mirach.layout.presets.v1'

export interface StoredPreset {
  id: string
  title: string
  json: unknown
}

export const isUserPreset = (id: string) => id.startsWith('user-')

export const readUserPresets = (): StoredPreset[] => {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY)
    return raw ? (JSON.parse(raw) as StoredPreset[]) : []
  } catch {
    return []
  }
}

export const saveUserPreset = (title: string, json: unknown): StoredPreset[] => {
  const preset: StoredPreset = { id: `user-${Date.now()}`, title, json }
  const next = [...readUserPresets(), preset]
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(next))
  } catch {}
  return next
}

export const deleteUserPreset = (id: string): StoredPreset[] => {
  const next = readUserPresets().filter((p) => p.id !== id)
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(next))
  } catch {}
  return next
}
