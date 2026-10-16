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
  if (!flags.leftHidden) alignVisibleToOrder(a)
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
  if (!flags.panelsHidden) alignVisibleToOrder(a)
}

export const leftPosLabel = (): string =>
  columnFlagsOf().colOrder.indexOf('left') === 0 ? '左侧栏移到最右侧' : '左侧栏移到最左侧'

export const panelsPosLabel = (): string => {
  const { colOrder } = columnFlagsOf()
  return colOrder.indexOf('panels') < colOrder.indexOf('chat') ? '面板栏移到右侧' : '面板栏移到左侧'
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

/** 隐藏/打开左侧栏。adopt（fromJSON）失败即整体放弃。 */
export const setLeftHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.leftHidden) return
  if (hidden) {
    const lg = groupsOfRegion(a, 'left')[0]
    if (!lg) {
      console.error('[dv-column-ops] 左栏不在场——隐藏放弃')
      return
    }
    const json = toLoose(a)
    const stash = extractLeaf(json, lg.id)
    if (!stash) {
      console.error('[dv-column-ops] 左栏 leaf 不在根行——隐藏放弃')
      return
    }
    holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
    saveStashSafe({ ...loadStash(), left: stash })
    setFlags({ ...flags, leftHidden: true })
  } else {
    const stash = loadStash().left
    if (!stash) {
      console.error('[dv-column-ops] 左栏无快照——打开放弃')
      return
    }
    const json = toLoose(a)
    const root = json.grid.root
    if (root.type !== 'branch') {
      console.error('[dv-column-ops] 根非 branch——左栏打开放弃')
      return
    }
    const data = root.data ?? []
    const visCount = data.length
    const at = Math.min(colOrderInsertIndex(flags.colOrder, 'left', (r) => r === 'panels' && flags.panelsHidden), visCount)
    data.splice(at, 0, stash.leaf)
    Object.assign(json.panels, stash.panels)
    holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
    const rest = loadStash()
    delete rest.left
    saveStashSafe(rest)
    setFlags({ ...flags, leftHidden: false })
  }
}

/** 隐藏/打开面板栏（根面板列唯一；恢复位 = colOrder 语义位；无快照重开 =
 *  新打开页）。 */
export const setPanelsHidden = (hidden: boolean): void => {
  const a = api()
  if (!a) return
  const flags = columnFlagsOf()
  if (hidden === flags.panelsHidden) return
  if (hidden) {
    const root = rootPanelsGroup(a)
    if (!root) {
      console.error('[dv-column-ops] 面板栏不在场——隐藏放弃')
      return
    }
    const json = toLoose(a)
    const stash = extractLeaf(json, root.id)
    if (!stash) {
      console.error('[dv-column-ops] 面板栏 leaf 不在根行——隐藏放弃')
      return
    }
    holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
    saveStashSafe({ ...loadStash(), panels: stash })
    setFlags({ ...flags, panelsHidden: true })
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
    data.splice(at, 0, leaf)
    Object.assign(json.panels, panelEntries)
    holdLayoutSurgery(() => a.fromJSON(json as unknown as SerializedDockview))
    if (stash) {
      const rest = loadStash()
      delete rest.panels
      saveStashSafe(rest)
    }
    setFlags({ ...flags, panelsHidden: false })
    const na = api()
    if (na) alignVisibleToOrder(na)
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
