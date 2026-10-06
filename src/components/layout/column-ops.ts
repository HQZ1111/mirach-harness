/**
 * 大栏级布局动词（v6.0 应用菜单；docs/layout-design.md）——实现抄 hermes：
 *
 * - 互换/面板栏位置 = **根行子序调整**：moveNode 原生整列移动
 *   （applyMoveNode 支持 RowNode——整列=根行子项，row 或单 tabset），
 *   **零组件卸载**（不闪、内容/终端不死）；hermes 语义 = 根行（横向）
 *   子序反转（mirrorTreeHorizontal 同族，反转两次 = 恒等）。
 * - 隐藏/恢复 = **单次重采纳**：toJson 摘除/拼回列子树 → adopt（一帧完成，
 *   无逐签删除的多次中间布局）。快照存 localStorage（colstash.v1）——
 *   **adopt 成功才提交旗标/快照**（失败即整体放弃，状态不脱同步）；
 *   旗标为假时的残留快照 = 废弃（boot 判废不恢复——陈旧快照拼回会撞 id）。
 * - 旗标持久化 localStorage（**不能放根行 config**——flexlayout 0.11 的
 *   RowNode 运行时无 getConfig，实测 undefined）。
 * - 重采纳经 flex-layout 注册的 adopter（configure → sync → 同步配重 →
 *   setModel → persist），单次过渡、首帧即最终几何、错误可见。
 */
import { Actions, DockLocation, Model, Orientation, RowNode, TabNode, TabSetNode, type Node as FLNode } from 'flexlayout-react'

import { PANE_TYPES, paneTypeOf, siblingMainZoneOf, stripVisibleOf, zoneConfigOf } from './pane-registry'

export type ColRegion = 'left' | 'chat' | 'panels'

export interface ColumnFlags {
  colOrder: ColRegion[]
  leftHidden: boolean
  panelsHidden: boolean
}

// ── 持久化（旗标 + 列快照） ──────────────────────────────────────────────────

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
    console.error('[column-ops] 持久化失败', e)
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
      console.error('[column-ops] 栏旗标 JSON 解析失败——从默认起', e)
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

/** 列子树快照（隐藏期离场内容；show 拼回）。 */
interface ColStash {
  left?: JsonNode
  /** 面板栏全部语义列（根行子项，树序）——语义归属后面板子栏可多个 */
  panels?: JsonNode[]
}

interface JsonNode {
  type?: string
  id?: string
  component?: string
  name?: string
  enableClose?: boolean
  enableDrag?: boolean
  enableDeleteWhenEmpty?: boolean
  enableTabStrip?: boolean
  weight?: number
  minWidth?: number
  maxWidth?: number
  selected?: number
  config?: { region?: string; stripMode?: string }
  children?: JsonNode[]
}

const loadStash = (): ColStash => {
  const raw = safeGet(STASH_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as ColStash
    return {
      ...(parsed.left ? { left: parsed.left } : {}),
      ...(parsed.panels ? { panels: parsed.panels } : {}),
    }
  } catch (e) {
    console.error('[column-ops] 列快照 JSON 解析失败——丢弃', e)
    return {}
  }
}

const discardStash = (region: 'left' | 'panels'): void => {
  const stash = loadStash()
  delete stash[region]
  safeSet(STASH_KEY, stash.left || stash.panels ? JSON.stringify(stash) : '')
}

// ── 布局 JSON 工具 ───────────────────────────────────────────────────────────

interface LayoutJson {
  layout: JsonNode
}

/** 列（根行子项）的 region：子树第一个 tabset 的 config.region。 */
const colRegion = (kid: JsonNode | undefined): ColRegion | undefined => {
  const first = (n: JsonNode | undefined): JsonNode | undefined => {
    if (!n) return undefined
    if (n.type === 'tabset') return n
    for (const c of n.children ?? []) {
      const f = first(c)
      if (f) return f
    }
    return undefined
  }
  const region = first(kid)?.config?.region
  return region === 'left' || region === 'chat' || region === 'panels' ? region : undefined
}

const layoutJsonOf = (m: Model): LayoutJson => m.toJson() as { layout: JsonNode }

/** colOrder 语义插入位：colOrder 序里排在 region 前面的可见列数 =
 *  该列在根行里的下标（恢复列回到旗标序里的位置——隐藏前的互换/移位
 *  不丢）。 */
const colOrderInsertIndex = (order: ColRegion[], region: ColRegion, isHidden: (r: ColRegion) => boolean): number => {
  let at = 0
  for (const r of order) {
    if (r === region) return at
    if (!isHidden(r)) at++
  }
  return at
}

const model = (): Model | undefined => {
  const m = (globalThis as { __flModel?: Model }).__flModel
  if (!m) console.error('[column-ops] 活动布局模型不在场（__flModel 未挂载）')
  return m
}

// ── 模型侧列定位 ─────────────────────────────────────────────────────────────

/** 根行子项的 region：子树第一个 tabset 的 config.region。 */
const regionOfColumn = (kid: FLNode): ColRegion | undefined => {
  const first = (n: FLNode): TabSetNode | undefined => {
    if (n instanceof TabSetNode) return n
    for (const c of n.getChildren()) {
      const f = first(c)
      if (f) return f
    }
    return undefined
  }
  return first(kid) ? zoneConfigOf(first(kid))?.region : undefined
}

const rootKidsOf = (m: Model): FLNode[] => (m.getRootRow()?.getChildren() ?? []) as FLNode[]

const colIndexOf = (m: Model, region: ColRegion): number =>
  rootKidsOf(m).findIndex((kid) => regionOfColumn(kid) === region)

/** 根行子项（列节点本体——row 或单 tabset）的 id：moveNode 的 from/to
 *  都用它，drop 按 LEFT/RIGHT 边缘整列插入（非 CENTER 才不溶解）。 */
const colNodeIdAt = (m: Model, index: number): string | undefined => {
  const kid = rootKidsOf(m)[index]
  return kid?.getId()
}

const setFlagsColOrder = (m: Model): void => {
  const prev = columnFlagsOf()
  // 可见列按物理序重排，**隐藏列保持原槽位**（merge 回插：走原 colOrder，
  // 在场位从物理序取、缺席位原样保留——物理投影两种写法都成立时取保隐
  // 列相对位置的）。旧"缺席期整跳过"守卫会把 v4 物理移动后的重映射一并
  // 跳掉（colOrder 与物理脱节，v4 在左栏隐藏时实锤失效）。
  const firstIdx = new Map<ColRegion, number>()
  rootKidsOf(m).forEach((kid, i) => {
    const r = regionOfColumn(kid)
    if (r && !firstIdx.has(r)) firstIdx.set(r, i)
  })
  const visibleSorted = [...prev.colOrder]
    .filter((r) => firstIdx.has(r))
    .sort((x, y) => firstIdx.get(x)! - firstIdx.get(y)!)
  let vi = 0
  const order = prev.colOrder.map((r) => (firstIdx.has(r) ? visibleSorted[vi++]! : r))
  setFlags({ ...prev, colOrder: order })
}

// ── 重采纳桥（flex-layout 注册；hide/show 的整树恢复用） ─────────────────────

let adopter: ((json: LayoutJson) => boolean) | null = null

/** flex-layout 挂载时注册：configure → sync → 同步配重 → setModel →
 *  persist。返回 false = 采纳失败（调用方放弃旗标/快照提交）。 */
export const setColumnOpsAdopter = (fn: ((json: LayoutJson) => boolean) | null): void => {
  adopter = fn
}

const adopt = (json: LayoutJson): boolean => {
  if (!adopter) {
    console.error('[column-ops] 重采纳通道未注册（flex-layout 未挂载）')
    return false
  }
  return adopter(json)
}

// ── 动词 ─────────────────────────────────────────────────────────────────────

// ── 位置切换（v7.2：独立双切换，无交换——用户定稿"只切换左侧栏，只切换
//    面板栏"）────────────────────────────────────────────────────────────────
// 状态 = colOrder ∈ 4 种排列，**left 恒占一端**（[L,C,P] [L,P,C] [P,C,L]
// [C,P,L]；[P,L,C]/[C,L,P] 非法）。面板栏位置 = 紧挨左栏（内）或远端
// （外），**永不跨到左栏的端**（让位）；chat 自由填补剩余跨度（面板栏在
// 内位时 chat 自然靠边——"对话栏不用一直在中间"）。
// 切换 = colOrder 条目移动 + 在场列对齐投影；**隐藏列切换 = 纯记录**
// （可见投影不变，物理不动——面板栏不因隐藏的左栏切边而跳端）。

/** 左栏位置切换：colOrder 里 left 条目移到另一端（其余条目相对序不动，
 *  可见投影两种方向都不变）。`[L,C,P]→[C,P,L]`（左栏到面板栏右边，
 *  用户原话）`[L,P,C]→[P,C,L]`；反向同理。 */
export const leftPosToggle = (): void => {
  const m = model()
  if (!m) return
  const flags = columnFlagsOf()
  const order = [...flags.colOrder]
  const li = order.indexOf('left')
  if (li < 0) {
    console.error('[column-ops] colOrder 缺 left——位置切换放弃', order)
    return
  }
  order.splice(li, 1)
  if (li === 0) order.push('left')
  else order.unshift('left')
  setFlags({ ...flags, colOrder: order })
  // 左栏在场（未隐藏）才物理兑现；缺席态 = 纯记录（投影不变，重开按新位插回）
  if (!flags.leftHidden) alignVisibleToOrder(m)
}

/** 面板栏位置切换：colOrder 里 panels 与 chat 条目换位（= 跨过 chat 到
 *  另一侧，**不跨 left**——让位）。`[L,C,P]↔[L,P,C]`、`[P,C,L]↔[C,P,L]`。 */
export const panelsPosToggle = (): void => {
  const m = model()
  if (!m) return
  const flags = columnFlagsOf()
  const order = [...flags.colOrder]
  const pi = order.indexOf('panels')
  const ci = order.indexOf('chat')
  if (pi < 0 || ci < 0) {
    console.error('[column-ops] colOrder 缺列——面板栏位置切换放弃', order)
    return
  }
  ;[order[pi], order[ci]] = [order[ci], order[pi]]
  setFlags({ ...flags, colOrder: order })
  // 面板栏在场（未隐藏）才物理兑现；缺席态 = 纯记录（子栏是用户自己的
  // 独立分栏，不因缺席期的位置记录而跳位）
  if (!flags.panelsHidden) alignVisibleToOrder(m)
}

/** 菜单文案（v7.2 两行位置切换的自描述标签）。面板栏 = 两态（按当前在
 *  chat 哪一侧翻转）；让位在点击结算——目标侧被左栏占时面板栏落到该侧
 *  紧挨左栏、不占边缘。 */
export const leftPosLabel = (): string =>
  columnFlagsOf().colOrder.indexOf('left') === 0 ? '左侧栏移到最右侧' : '左侧栏移到最左侧'

export const panelsPosLabel = (): string => {
  const { colOrder } = columnFlagsOf()
  return colOrder.indexOf('panels') < colOrder.indexOf('chat') ? '面板栏移到右侧' : '面板栏移到左侧'
}

/** 隐藏/打开左侧栏（单次重采纳：JSON 摘除/拼回；adopt 成功才提交旗标与
 *  快照——失败整体放弃，状态不脱同步）。 */
export const setLeftHidden = (hidden: boolean): void => {
  const m = model()
  if (!m) return
  const json = layoutJsonOf(m)
  const kids = json.layout.children ?? []
  const stash = loadStash()
  const flags = columnFlagsOf()
  const ci = kids.findIndex((k) => colRegion(k) === 'chat')
  if (hidden) {
    const li = kids.findIndex((k) => colRegion(k) === 'left')
    if (li < 0) {
      console.error('[column-ops] 左栏不在场——隐藏放弃')
      return
    }
    const nextKids = kids.filter((_, i) => i !== li)
    const nextStash: ColStash = { ...stash, left: kids[li] }
    const nextFlags: ColumnFlags = { ...flags, leftHidden: true }
    if (!adopt({ layout: { ...json.layout, children: nextKids } })) return
    saveStashSafe(nextStash)
    setFlags(nextFlags)
  } else {
    const col = stash.left
    if (!col) {
      console.error('[column-ops] 左栏无快照——打开放弃')
      return
    }
    const nextKids = [...kids]
    // 恢复位 = colOrder 语义位（colOrder 恒含隐藏列——互换/移位的位置记忆在这）
    nextKids.splice(colOrderInsertIndex(flags.colOrder, 'left', (r) => r === 'panels' && flags.panelsHidden), 0, col)
    const nextStash: ColStash = { ...stash }
    delete nextStash.left
    // colOrder **原样保留**（恒 3 项含隐藏列）——插回已按语义位定位，投影
    // 一致；从物理树重算会把隐藏列挤掉（2 项 colOrder：位置记忆丢失 +
    // 重载校验 length===3 失败整表回退默认）
    const nextFlags: ColumnFlags = { ...flags, leftHidden: false }
    if (!adopt({ layout: { ...json.layout, children: nextKids } })) return
    saveStashSafe(nextStash)
    setFlags(nextFlags)
  }
}

/** 隐藏/打开面板栏（同上；恢复 = 原快照列拼回末位，含终端行）。 */
export const setPanelsHidden = (hidden: boolean): void => {
  const m = model()
  if (!m) return
  const json = layoutJsonOf(m)
  const kids = json.layout.children ?? []
  const stash = loadStash()
  const flags = columnFlagsOf()
  if (hidden) {
    // **只收根面板列**（v7.3.1 根面板唯一——打开页宿主那根；用户拖出的
    // 子栏是独立分栏，不随隐藏）
    const jsonHasAnchor = (k: JsonNode): boolean =>
      k.type === 'tabset' ? k.enableDeleteWhenEmpty === false : (k.children ?? []).some(jsonHasAnchor)
    let rootIdx = -1
    let fallbackIdx = -1
    kids.forEach((k, i) => {
      if (colRegion(k) !== 'panels') return
      fallbackIdx = fallbackIdx < 0 ? i : fallbackIdx
      if (rootIdx < 0 && jsonHasAnchor(k)) rootIdx = i
    })
    const li = rootIdx >= 0 ? rootIdx : fallbackIdx
    if (li < 0) {
      console.error('[column-ops] 面板栏不在场——隐藏放弃')
      return
    }
    const nextKids = kids.filter((_, i) => i !== li)
    const nextStash: ColStash = { ...stash, panels: [kids[li]] }
    const nextFlags: ColumnFlags = { ...flags, panelsHidden: true }
    if (!adopt({ layout: { ...json.layout, children: nextKids } })) return
    saveStashSafe(nextStash)
    setFlags(nextFlags)
  } else {
    const cols = stash.panels
    if (!cols || cols.length === 0) {
      // 无快照（关空收列后的重开）= **新打开页**（ZCode：toggle 重开、
      // state null → openTabLauncher；开出实签后打开页撤下）
      const fresh: JsonNode = {
        type: 'tabset',
        config: { region: 'panels' },
        enableDeleteWhenEmpty: false,
        children: [
          { type: 'tab', id: 'open', component: 'open', name: '打开', enableClose: false, enableDrag: false },
        ],
      }
      const nextKids = [...kids]
      let at = colOrderInsertIndex(flags.colOrder, 'panels', (r) => r === 'left' && flags.leftHidden)
      nextKids.splice(at, 0, fresh)
      const nextFlags: ColumnFlags = { ...flags, panelsHidden: false }
      if (!adopt({ layout: { ...json.layout, children: nextKids } })) return
      setFlags(nextFlags)
      return
    }
    const nextKids = [...kids]
    // 恢复位 = colOrder 语义位（隐藏前的互换/移位位置记忆在这）；整组按
    // 快照顺序连续插回
    let at = colOrderInsertIndex(flags.colOrder, 'panels', (r) => r === 'left' && flags.leftHidden)
    for (const col of cols) {
      nextKids.splice(at, 0, col)
      at++
    }
    const nextStash: ColStash = { ...stash }
    delete nextStash.panels
    const nextFlags: ColumnFlags = { ...flags, panelsHidden: false }
    if (!adopt({ layout: { ...json.layout, children: nextKids } })) return
    saveStashSafe(nextStash)
    setFlags(nextFlags)
  }
}

const saveStashSafe = (stash: ColStash): void => {
  if (stash.left || stash.panels) safeSet(STASH_KEY, JSON.stringify(stash))
  else safeSet(STASH_KEY, '')
}

/** boot 自愈：旗标与实际树脱同步时按旗标收敛（隐藏列在场 → 补藏；旗标
 *  未隐藏但快照在场 → **判废快照**（陈旧快照拼回会撞 id），列缺失属异常
 *  错误可见；列序 ≠ colOrder 可见序 → 逐列 moveNode 对齐）。
 *  一致性零动作。 */
export const normalizeColumns = (): void => {
  const m = model()
  if (!m) return
  const flags = columnFlagsOf()
  const actual = rootKidsOf(m).map((kid) => regionOfColumn(kid)).filter((r): r is ColRegion => !!r)
  const stash = loadStash()
  // 打开页锚先于列序对齐（列溶解/出厂缺 open → 此时重建，先于 moveNode
  // 避免锚重建后的列序再被对齐逻辑搬走）
  syncOpenAnchor(m, true)
  if (flags.leftHidden && actual.includes('left')) {
    setLeftHidden(true)
    return
  }
  if (!flags.leftHidden && stash.left) {
    console.error('[column-ops] 旗标未隐藏但左栏快照在场——判废（陈旧快照拼回会撞 id）')
    discardStash('left')
  }
  if (flags.panelsHidden && actual.includes('panels')) {
    setPanelsHidden(true)
    return
  }
  if (!flags.panelsHidden && stash.panels) {
    console.error('[column-ops] 旗标未隐藏但面板栏快照在场——判废')
    discardStash('panels')
    return
  }
  // 列序对齐 = 语义组展开版 alignVisibleToOrder（多根 panels 语义列整组
  // 跟移，见 alignVisibleToOrder 注释）
  alignVisibleToOrder(m)
  setFlagsColOrder(m)
  // 列序归位后补建打开页锚（面板列溶解场景；allowRecreate 只在 boot 开）
  syncOpenAnchor(m, true)
}

/** 关空收列（ZCode 原义，docs/layout-design.md §8）：DELETE_TAB/MOVE_NODE
 *  使面板栏最后一个实签消失（关掉或拖走）→ **整列关闭**——打开页随列消
 *  失，不回驻。ZCode 实锤链：closeSidePaneTab 末签关闭返回 null →
 *  syncSidePaneCollapsedWithTabs → setIsSidePaneCollapsed(true)；重开 =
 *  打开页（openTabLauncher）。面板列缺席（colOrder 仍记位）后菜单显
 *  示「打开面板栏」。 */
export const closePanelsColumnIfEmptied = (m: Model, action?: { type?: string; data?: unknown }): void => {
  if (anchorBusy || columnFlagsOf().panelsHidden) return
  const type = action?.type
  if (type !== 'FlexLayout_DeleteTab' && type !== Actions.MOVE_NODE) return
  const data = (action?.data ?? {}) as { node?: string; fromNode?: string }
  const departedId = data.node ?? data.fromNode ?? ''
  const t = paneTypeOf(departedId)
  if (!t || PANE_TYPES[t].region !== 'panels') return
  // 列已不在场（末签删除时 flexlayout tidy 先行收走空列/空行）→ 补缺席
  // 旗标即完成"关空收列"（colOrder 仍记位；重开 = 新打开页）
  if (colIndexOf(m, 'panels') < 0) {
    setFlags({ ...columnFlagsOf(), panelsHidden: true })
    return
  }
  // **根面板列**（唯一）内还有实签吗（横带 + 纵向行全算；open 不是实签）
  // ——子栏是独立分栏：它们的实签不算，它们自己拖空由 tidy 收（v7.3.1）
  const rootKid = rootPanelColumnKid(m)
  if (!rootKid) {
    setFlags({ ...columnFlagsOf(), panelsHidden: true })
    return
  }
  let hasReal = false
  const walk = (n: FLNode): void => {
    if (hasReal) return
    if (n instanceof TabSetNode) {
      for (const tab of n.getChildren()) {
        if (tab instanceof TabNode && tab.getId() !== 'open') {
          hasReal = true
          return
        }
      }
      return
    }
    for (const c of n.getChildren()) walk(c)
  }
  walk(rootKid)
  if (hasReal) return
  // 关根面板列（唯一）：逐子项翻 enableClose 后 deleteTabset（
  // applyDeleteTabset 只删 isCloseable 子签；open 也随列消失——这就是
  // 打开页"怎么消失的"）。子栏不动。
  anchorBusy = true
  try {
    const collectSets = (n: FLNode): TabSetNode[] => {
      if (n instanceof TabSetNode) return [n]
      return n.getChildren().flatMap((x) => collectSets(x))
    }
    for (const set of collectSets(rootKid)) {
      for (const tab of set.getChildren()) {
        if (tab instanceof TabNode && !tab.isEnableClose()) {
          m.doAction(Actions.updateNodeAttributes(tab.getId(), { enableClose: true }))
        }
      }
      m.doAction(Actions.deleteTabset(set.getId()))
    }
  } finally {
    anchorBusy = false
  }
  // 旗标 = 缺席标记（菜单显「打开面板栏」；无快照——重开 = 新打开页）
  setFlags({ ...columnFlagsOf(), panelsHidden: true })
}

/** 实签抵达面板栏 → 撤打开页（ZCode：任一实签开出，openTabLauncher 即被
 *  页签 UI 替换）。覆盖横带之外的落点——终端从打开页开出落纵向新行，横带
 *  判定够不到它。drag-out（到达列非 panels）不撤。 */
export const withdrawOpenOnPanelTabArrival = (m: Model, action?: { type?: string; data?: unknown }): void => {
  if (columnFlagsOf().panelsHidden) return
  if (!m.getNodeById('open')) return
  if (!action) return
  let arrivedId: string | undefined
  if (action.type === 'FlexLayout_AddTab') {
    const json = (action.data as { json?: { id?: string; component?: string } }).json
    arrivedId = json?.id
  } else if (action.type === Actions.MOVE_NODE) {
    arrivedId = (action.data as { fromNode?: string }).fromNode
  }
  if (!arrivedId) return
  const node = m.getNodeById(arrivedId)
  if (!node) return
  // **只有页签级到达才撤打开页**：栏级动词（互换/位置/列序对齐）的
  // moveNode fromNode = 列节点本体（row/tabset）——整列"到达自己"若被
  // 误判成实签抵达会删 open，嵌套 DELETE_TAB(open) 再进 onModelChange
  // 时关空收列见列已空 → 整列被带走（四动词 E2E 毁列根因）
  if (!(node instanceof TabNode)) return
  // 到达页签的所属列 = 面板栏吗（拖往 chat 的路过不撤）
  const root = m.getRootRow()
  if (!root) return
  let cur: FLNode = node
  for (;;) {
    const parent = cur.getParent()
    if (!parent || parent === root) break
    cur = parent
  }
  const first = (n: FLNode): TabSetNode | undefined => {
    if (n instanceof TabSetNode) return n
    for (const c of n.getChildren()) {
      const f = first(c)
      if (f) return f
    }
    return undefined
  }
  if (first(cur) ? zoneConfigOf(first(cur))?.region !== 'panels' : true) return
  const openTab = m.getNodeById('open')
  if (openTab instanceof TabNode) m.doAction(Actions.deleteTab('open'))
}

/** 页签条手动开关（hermes setTreeGroupTabStrip 同款 always/never）：
 *  enableTabStrip 同动作立即下发，不等 90ms 串行通道。 */
export const setTabStripVisible = (m: Model, tabsetId: string, visible: boolean): void => {
  const set = m.getNodeById(tabsetId)
  const region = set instanceof TabSetNode ? zoneConfigOf(set)?.region : undefined
  if (!set || !region) {
    console.error('[column-ops] 目标分栏无 region 戳——页签条开关放弃', tabsetId)
    return
  }
  m.doAction(
    Actions.updateNodeAttributes(tabsetId, {
      config: { region, stripMode: visible ? 'always' : 'never' },
      enableTabStrip: visible,
    }),
  )
}

/** 应用菜单「隐藏标签」行的预演（目标分栏可开关 + 搁浅 noop 判定）：
 *  undefined = 行不出现（无分栏/左栏）。 */
export const stripToggleInfoOf = (
  m: Model,
  tabsetId: string,
): { visible: boolean; noOp: boolean } | undefined => {
  const set = m.getNodeById(tabsetId)
  if (!(set instanceof TabSetNode)) return undefined
  const region = zoneConfigOf(set)?.region
  if (!region || region === 'left') return undefined
  if (set.getChildren().length === 0) return undefined
  const sibling = siblingMainZoneOf(m)
  return { visible: stripVisibleOf(set, region, undefined, sibling), noOp: stripVisibleOf(set, region, 'never', sibling) }
}

/** 面板栏列子树 depth-first 第一个 tabset 的 id（锚宿主）。 */
const firstPanelsTabsetId = (m: Model): string | undefined => {
  const root = m.getRootRow()
  if (!root) return undefined
  const find = (kid: FLNode): TabSetNode | undefined => {
    if (kid instanceof TabSetNode) return kid
    for (const c of kid.getChildren()) {
      const f = find(c)
      if (f) return f
    }
    return undefined
  }
  for (const kid of (root.getChildren() ?? []) as FLNode[]) {
    if (regionOfColumn(kid) === 'panels') return find(kid)?.getId()
  }
  return undefined
}

/** 在场列按 colOrder（去隐藏）物理对齐——**根面板唯一**（v7.3.1，用户
 *  定稿）：动词只作用于根面板那一根列（打开页宿主），用户拖出的子栏是
 *  独立分栏、不跟动词走。面板槽位 = 根面板列；left 槽位 = 左栏列；chat
 *  的位置由前两者的槽位自然补出（complement），永不需要显式移动。
 *  方向：curIdx > target → LEFT of 目标位kid；curIdx < target → RIGHT of
 *  末位 kid（"最右" = 全部列之后）。 */
const alignVisibleToOrder = (m: Model): void => {
  const flags = columnFlagsOf()
  const isVisible = (r: ColRegion): boolean =>
    r === 'left' ? !flags.leftHidden : r === 'panels' ? !flags.panelsHidden : true
  const moveRegionToSlot = (region: ColRegion): void => {
    let target = -1
    let at = 0
    for (const slot of flags.colOrder) {
      if (slot === region) {
        target = at
        break
      }
      if (isVisible(slot)) at++
    }
    if (target < 0) return
    const kid = region === 'panels' ? rootPanelColumnKid(m) : rootKidsOf(m).find((k) => regionOfColumn(k) === region)
    if (!kid) return
    const kids = rootKidsOf(m)
    const curIdx = kids.indexOf(kid)
    if (curIdx === target) return
    if (curIdx > target) {
      const anchor = kids[target]
      if (!anchor || anchor === kid) return
      m.doAction(Actions.moveNode(kid.getId(), anchor.getId(), DockLocation.LEFT, 0))
    } else {
      // 右移：插到目标位 kid 之后（槽位精确——RIGHT of 末位会越过目标槽）
      const anchor = kids[target]
      if (!anchor || anchor === kid) return
      m.doAction(Actions.moveNode(kid.getId(), anchor.getId(), DockLocation.RIGHT, 0))
    }
  }
  moveRegionToSlot('left')
  moveRegionToSlot('panels')
}

/** 根面板列（**唯一**，docs §2）：子树里含 enableDeleteWhenEmpty=false 锚
 *  tabset 的 panels 语义根行子项——打开页宿主定义"面板栏在哪"；锚缺席
 *  （理论不到场）回退第一根 panels 语义列。子栏不在此列。 */
const rootPanelColumnKid = (m: Model): FLNode | undefined => {
  let fallback: FLNode | undefined
  const hasAnchor = (n: FLNode): boolean => {
    if (n instanceof TabSetNode) {
      try {
        if (n.isEnableDeleteWhenEmpty?.() === false) return true
      } catch {
        // 测试替身无内部字段
      }
    }
    return (n.getChildren() as FLNode[]).some(hasAnchor)
  }
  for (const kid of rootKidsOf(m)) {
    if (regionOfColumn(kid) !== 'panels') continue
    fallback ??= kid
    if (hasAnchor(kid)) return kid
  }
  return fallback
}

/** chat 列第一个 tabset 的 id（打开页重建锚）。 */
const colNodeIdOfChat = (m: Model): string | undefined => {
  const root = m.getRootRow()
  if (!root) return undefined
  const find = (kid: FLNode): TabSetNode | undefined => {
    if (kid instanceof TabSetNode) return kid
    for (const c of kid.getChildren()) {
      const f = find(c)
      if (f) return f
    }
    return undefined
  }
  for (const kid of (root.getChildren() ?? []) as FLNode[]) {
    if (regionOfColumn(kid) === 'chat') return find(kid)?.getId()
  }
  return undefined
}

let anchorBusy = false

export const syncOpenAnchor = (m: Model, allowRecreate = false): void => {
  if (anchorBusy) return
  anchorBusy = true
  try {
    // **全模型空 tabset 清扫**（空白面板 = bug；ZCode 子栏拖空即关）：
    // 包括 enableDeleteWhenEmpty=false 的锚组——锚组空 = 打开页失去存在
    // 意义（关空收列已把列移走，这里兜底清扫残留）。skip 浮动布局。
    const blanks: TabSetNode[] = []
    m.visitNodes((n) => {
      if (!(n instanceof TabSetNode)) return
      try {
        // 测试替身无内部布局字段——getLayoutId 抛错按主布局处理
        if (n.getLayoutId() !== Model.MAIN_LAYOUT_ID) return
      } catch {
        return
      }
      if (n.getChildren().length === 0) blanks.push(n)
    })
    for (const b of blanks) m.doAction(Actions.deleteTabset(b.getId()))
    // 面板栏整列缺席（隐藏/关空收列）锚不参与
    if (columnFlagsOf().panelsHidden) return
    const root = m.getRootRow()
    if (!root) return
    const kidOf = (): FLNode | undefined =>
      rootKidsOf(m).find((k) => {
        const first = (n: FLNode): TabSetNode | undefined => {
          if (n instanceof TabSetNode) return n
          for (const c of n.getChildren()) {
            const f = first(c)
            if (f) return f
          }
          return undefined
        }
        return first(k) ? zoneConfigOf(first(k))?.region === 'panels' : false
      })
    const collect = (kid: FLNode): { sets: TabSetNode[]; tabs: TabNode[] } => {
      const sets: TabSetNode[] = []
      const tabs: TabNode[] = []
      const walk = (n: FLNode): void => {
        if (n instanceof TabSetNode) {
          sets.push(n)
          for (const t of n.getChildren()) {
            if (t instanceof TabNode) tabs.push(t)
          }
          return
        }
        for (const c of n.getChildren()) walk(c)
      }
      walk(kid)
      return { sets, tabs }
    }
    let host: TabSetNode | undefined
    const openTab = m.getNodeById('open')
    if (openTab instanceof TabNode) host = openTab.getParent() as TabSetNode
    if (!(host instanceof TabSetNode)) {
      const topId = firstPanelsTabsetId(m)
      host = topId ? ((m.getNodeById(topId) as unknown) as TabSetNode | undefined) : undefined
    }
    // **列全溶解** + allowRecreate（boot 归一）→ 按 colOrder 在 chat 旁重建
    // 顶组（**全局查重**：open 在任何位置在场 = 锚已在）
    if (!(host instanceof TabSetNode)) {
      if (!allowRecreate) return
      if (m.getNodeById('open')) return
      const chatId = colNodeIdOfChat(m)
      if (!chatId) {
        console.error('[column-ops] chat 列不在场——打开页重建放弃')
        return
      }
      const beforeChat = columnFlagsOf().colOrder.indexOf('panels') < columnFlagsOf().colOrder.indexOf('chat')
      m.doAction(
        Actions.addNode(
          { type: 'tab', id: 'open', component: 'open', name: '打开', enableClose: false, enableDrag: false },
          chatId,
          beforeChat ? DockLocation.LEFT : DockLocation.RIGHT,
          0,
          true,
        ),
      )
      const openSet = m.getNodeById('open')?.getParent()
      if (openSet instanceof TabSetNode) {
        m.doAction(Actions.updateNodeAttributes(openSet.getId(), { config: { region: 'panels' } }))
      }
      host = m.getNodeById('open')?.getParent() as TabSetNode
    }
    if (!(host instanceof TabSetNode)) return
    // **横带 = 宿主所在的水平行**（顶组左右分栏互为实签；终端行在纵向 VERT
    // 行的另一格——不算顶带实签，否则出厂树 [打开页|终端] 上下堆叠会把终端
    // 当实签，boot 就把打开页删掉）。宿主挂根行或挂在 VERT 行 → 横带 = 宿主。
    const parent = host.getParent()
    const isRoot = parent === m.getRootRow()
    const parentIsHorzRow = parent instanceof RowNode && parent.getOrientation() === Orientation.HORZ
    const band = !isRoot && parentIsHorzRow ? parent : host
    const { tabs } = collect(band)
    const open = tabs.find((t) => t.getId() === 'open')
    const realCount = tabs.length - (open ? 1 : 0)
    if (realCount > 0) {
      // 有实签：打开页撤下（ZCode：launcher 只在无可见页签时渲染）
      if (open) m.doAction(Actions.deleteTab('open'))
      return
    }
    // 横带无实签：宿主承载打开页（**窗口期**——显式打开面板后/出厂态；
    // 开出实签即撤下，最后一个实签再关 → 关空收列把整列带走的）
    let deleteWhenEmpty: boolean | undefined
    try {
      deleteWhenEmpty = (host as unknown as { isEnableDeleteWhenEmpty?: () => boolean }).isEnableDeleteWhenEmpty?.()
    } catch {
      deleteWhenEmpty = undefined
    }
    if (deleteWhenEmpty !== false) {
      m.doAction(Actions.updateNodeAttributes(host.getId(), { enableDeleteWhenEmpty: false }))
    }
    if (!open) {
      if (m.getNodeById('open')) return
      m.doAction(
        Actions.addNode(
          { type: 'tab', id: 'open', component: 'open', name: '打开', enableClose: false, enableDrag: false },
          host.getId(),
          DockLocation.CENTER,
          0,
          true,
        ),
      )
    }
  } finally {
    anchorBusy = false
  }
}
