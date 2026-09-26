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
  SIDEBAR_COLLAPSE_MEDIA_QUERY,
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
  /** 窄视口（hermes $narrowViewport：两根侧栏撤出网格变 overlay 的断点） */
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

export const useLayoutStore = create<LayoutStore>()((set, get) => ({
  editMode: false,
  activePresetId: null,
  userPresets: readUserPresets(),
  layoutRev: 0,
  appliedTree: null,
  zoneEditorOpen: false,
  narrowViewport: false, // 真值由下方 narrowNow() 在模块加载后同步（见守卫注释）
  dropHint: null,
  treeDragging: null,
  sideCollapsed: readSides(),

  openEditMode: () => set({ editMode: true }),
  closeEditMode: () => set({ editMode: false }),
  toggleEditMode: () => set({ editMode: !get().editMode }),
  setActivePreset: (id) => set({ activePresetId: id }),
  storeUserPreset: (title, json) => set({ userPresets: saveUserPreset(title, json) }),
  removeUserPreset: (id) => set({ userPresets: deleteUserPreset(id) }),
  bumpLayoutRev: () => set({ layoutRev: get().layoutRev + 1 }),
  setAppliedTree: (json) => set({ appliedTree: json }),
  openZoneEditor: () => set({ zoneEditorOpen: true }),
  closeZoneEditor: () => set({ zoneEditorOpen: false }),
  setDropHint: (hint) => set({ dropHint: hint }),
  setTreeDragging: (paneId) => set({ treeDragging: paneId }),
  setSideCollapsed: (side, collapsed) => {
    const next = { ...get().sideCollapsed, [side]: collapsed }
    set({ sideCollapsed: next })
    try {
      localStorage.setItem(SIDES_KEY, JSON.stringify(next))
    } catch {}
  },
}))

// 窄视口断点监听（hermes $narrowViewport 的 matchMedia 驱动）。
// **最小化守卫**：Windows 最小化时 WebView2 视口报 160×28——宽度塌过
// 断点但高度不是真的；误判成窄屏会把两侧栏抽成 overlay 抽屉，恢复后
// 收编重排 = 用户实测的"最小化再打开，竖栏标签位置/栏位置自己变"。
// 视口高度 ≤240 一律视为最小化瞬态，保持现状不动。
const narrowNow = (): boolean =>
  typeof window !== 'undefined' &&
  window.innerHeight > 240 &&
  (window.matchMedia?.(SIDEBAR_COLLAPSE_MEDIA_QUERY).matches ?? false)

if (typeof window !== 'undefined') {
  useLayoutStore.setState({ narrowViewport: narrowNow() })
  window.matchMedia?.(SIDEBAR_COLLAPSE_MEDIA_QUERY).addEventListener('change', () => {
    useLayoutStore.setState({ narrowViewport: narrowNow() })
  })
}
