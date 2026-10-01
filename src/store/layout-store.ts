/**
 * 布局状态层 —— Zustand 单 store（2026-09-26 从 nanostores 迁移，状态库
 * 定稿见 AGENTS「待办 3」L1）。flexlayout Model 只是渲染器持有的活动树；
 * 这里持 UI 投影态（编辑模式/激活预设/用户预设/拖拽态/窄视口/整侧收起），
 * 活动树仍归 flex-layout（Model 是 flexlayout 的渲染契约，不搬进 store）。
 * v2.1：窗格尺寸记忆/隐藏记录已随旧架构移除（约束走 tabset.config，
 * 关闭语义见 pane-registry.ts）。
 *
 * 约定：组件用 useLayoutStore(selector) 订阅；事件回调等非 React 上下文用
 * useLayoutStore.getState()/setState()；写入一律走本文件导出的 action
 * （持久化副作用集中在 action 内）。
 */

import { create } from 'zustand'

import {
  deleteUserPreset,
  readUserPresets,
  saveUserPreset,
  type StoredPreset,
} from '@/components/layout/layout-presets'

/** 径向投放位置（hermes tree/model.ts DropPosition） */
export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom'

/** 拖拽高亮提示：groupId=主投放 zone（tabset id），groupIds=高亮集合
 * （Shift 跨区时 >1），stack=页签条插入槽（before=插到该页签前，null=追加） */
export interface DropHint {
  kind: 'group'
  groupId: string
  groupIds: string[]
  pos: DropPosition
  stack?: { before: null | string }
}

const SIDES_KEY = 'mirach.layout.sides.v1'

// 已应用预设记录（P2-9）：{presetId, appliedTreeJson}——内存 appliedTree
// 重载即丢，此前重载后双击分隔条回退均分而非预设原始权重；记录落盘后
// boot 水合回 appliedTree + activePresetId。
const APPLIED_KEY = 'mirach.harness.layout.applied.v1'

const readApplied = (): { presetId: string | null; json: unknown } | null => {
  try {
    const raw = localStorage.getItem(APPLIED_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const r = parsed as Record<string, unknown>
    return { presetId: typeof r.presetId === 'string' ? r.presetId : null, json: r.json ?? null }
  } catch (e) {
    console.error('[layout-store] read applied layout failed', e)
    return null
  }
}

/** 写已应用预设记录（applied.v1）：setActivePreset（预设标记变化）与
 *  setAppliedTree（应用预设成功）两个入口都落盘——重载后双击分隔条按
 *  预设原始权重回退、激活预设徽标恢复。失败 console.error（铁律 12）。 */
const writeAppliedRecord = (presetId: string | null, json: unknown) => {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify({ presetId, json }))
  } catch (e) {
    console.error('[layout-store] persist applied layout failed', e)
  }
}

const readSides = (): { left: boolean; right: boolean } => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIDES_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return { left: false, right: false }
    const r = parsed as Record<string, unknown>
    return { left: r.left === true, right: r.right === true }
  } catch {
    return { left: false, right: false }
  }
}

export interface LayoutStore {
  /** 布局编辑模式（hermes：layout.editMode keybind 开关） */
  editMode: boolean
  /** 当前激活预设 id（应用预设时记下；手动拖动后清空——hermes $activePresetId） */
  activePresetId: string | null
  /** 用户自定义预设清单（hermes tree/presets.ts 的 store 职责） */
  userPresets: StoredPreset[]
  /** 活动树版本号：flexlayout 在自己子树内改模型不触发壳重渲，
   * 壳/菜单依赖模型派生状态（徽标）时订阅它，onModelChange/adopt 后 bump */
  layoutRev: number
  /** 已应用的预设树（flexlayout JSON）——双击分隔条回默认尺寸时按 split id
   * 查原始权重（hermes presetSplitWeights） */
  appliedTree: unknown
  /** Zone 编辑器（hermes「New grid layout」） */
  zoneEditorOpen: boolean
  /** 窄视口（hermes $narrowViewport：两根侧栏撤出网格变 overlay 的断点）。
   *  **唯一写者 = rebalance 的动态判据 updateNarrowViewport**（640
   *  matchMedia 写者已删，P1-3：双写者窄窗收/展横跳）；boot 由
   *  flex-layout 挂载 effect 先写一次初值。 */
  narrowViewport: boolean
  /** 拖拽高亮提示（overlay 订阅；壳不订阅——per-move churn 隔离契约） */
  dropHint: DropHint | null
  /** 拖拽中的页签 id（overlay/光标等轻组件订阅；壳不订阅） */
  treeDragging: string | null
  /** 整侧收起（hermes positional toggles 驱动的 $collapsedTreeSides） */
  sideCollapsed: { left: boolean; right: boolean }

  openEditMode(): void
  closeEditMode(): void
  toggleEditMode(): void
  setActivePreset(id: string | null): void
  storeUserPreset(title: string, json: unknown): void
  removeUserPreset(id: string): void
  bumpLayoutRev(): void
  setAppliedTree(json: unknown): void
  openZoneEditor(): void
  closeZoneEditor(): void
  setDropHint(hint: DropHint | null): void
  setTreeDragging(paneId: string | null): void
  setSideCollapsed(side: 'left' | 'right', collapsed: boolean): void
}

// 模块级 action 导出：与迁移前同名的稳定 API 面（事件回调/测试等
// 非 hook 上下文直接调用，组件内也可解构使用）。
export const openEditMode = () => useLayoutStore.getState().openEditMode()
export const closeEditMode = () => useLayoutStore.getState().closeEditMode()
export const toggleEditMode = () => useLayoutStore.getState().toggleEditMode()
export const setActivePreset = (id: string | null) => useLayoutStore.getState().setActivePreset(id)
export const storeUserPreset = (title: string, json: unknown) => useLayoutStore.getState().storeUserPreset(title, json)
export const removeUserPreset = (id: string) => useLayoutStore.getState().removeUserPreset(id)
export const bumpLayoutRev = () => useLayoutStore.getState().bumpLayoutRev()
export const setAppliedTree = (json: unknown) => useLayoutStore.getState().setAppliedTree(json)
export const openZoneEditor = () => useLayoutStore.getState().openZoneEditor()
export const closeZoneEditor = () => useLayoutStore.getState().closeZoneEditor()
export const setSideCollapsed = (side: 'left' | 'right', collapsed: boolean) =>
  useLayoutStore.getState().setSideCollapsed(side, collapsed)

const applied0 = readApplied()

export const useLayoutStore = create<LayoutStore>()((set, get) => ({
  editMode: false,
  activePresetId: applied0?.presetId ?? null,
  userPresets: readUserPresets(),
  layoutRev: 0,
  appliedTree: applied0?.json ?? null,
  zoneEditorOpen: false,
  narrowViewport: false, // 真值由 updateNarrowViewport（rebalance 动态判据）驱动，唯一写者
  dropHint: null,
  treeDragging: null,
  sideCollapsed: readSides(),

  openEditMode: () => set({ editMode: true }),
  closeEditMode: () => set({ editMode: false }),
  toggleEditMode: () => set({ editMode: !get().editMode }),
  setActivePreset: (id) => {
    set({ activePresetId: id })
    // 预设标记进 applied.v1 记录（json 不动）——手动拖动清标记后重载，
    // 徽标语义与内存一致（json 仍留作双击回退的权重来源）
    writeAppliedRecord(id, get().appliedTree)
  },
  storeUserPreset: (title, json) => set({ userPresets: saveUserPreset(title, json) }),
  removeUserPreset: (id) => set({ userPresets: deleteUserPreset(id) }),
  bumpLayoutRev: () => set({ layoutRev: get().layoutRev + 1 }),
  setAppliedTree: (json) => {
    set({ appliedTree: json })
    // 应用预设/重置成功后写记录（presetId 取当前值——applyJson 先
    // setActivePreset 再这里，两次写收敛到同一条记录）
    writeAppliedRecord(get().activePresetId, json)
  },
  openZoneEditor: () => set({ zoneEditorOpen: true }),
  closeZoneEditor: () => set({ zoneEditorOpen: false }),
  setDropHint: (hint) => set({ dropHint: hint }),
  setTreeDragging: (paneId) => set({ treeDragging: paneId }),
  setSideCollapsed: (side, collapsed) => {
    const next = { ...get().sideCollapsed, [side]: collapsed }
    set({ sideCollapsed: next })
    try {
      localStorage.setItem(SIDES_KEY, JSON.stringify(next))
    } catch (e) {
      console.error('[layout-store] persist sides failed', e)
    }
  },
}))

// 窄视口判定不再有 640 matchMedia 写者（P1-3，2026-10-01 审查）：它与
// rebalance.updateNarrowViewport 的动态判据（"根行装不下合并后各列 min
// → 左右栏撤成 overlay"）双写者打架，窄窗收/展横跳——动态判据为准。
// 写者唯一后：boot 由 flex-layout 挂载 effect 调 updateNarrowViewport 写
// 初值；resize/结构动作后由串行重排通道刷新。最小化守卫（视口高 ≤240
// 不改判）在 updateNarrowViewport 内，语义不变。
