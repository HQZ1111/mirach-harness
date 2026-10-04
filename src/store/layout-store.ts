/**
 * 布局状态层 —— Zustand 单 store（v5.0 三栏固定：本 store 只剩拖拽提示/
 * 拖拽态/布局版本等轻量投影；预设/编辑器/窄屏/整侧收起均已随 v5 废除）。
 *
 * 约定：组件用 useLayoutStore(selector) 订阅；事件回调等非 React 上下文用
 * useLayoutStore.getState()/setState()；写入一律走本文件导出的 action。
 */

import { create } from 'zustand'

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

// 已应用预设记录已废（v5.0 无预设概念）

export interface LayoutStore {
  /** 活动树版本号：flexlayout 在自己子树内改模型不触发壳重渲，
   * 壳/菜单依赖模型派生状态（徽标）时订阅它，onModelChange/adopt 后 bump */
  layoutRev: number
  /** 拖拽帧版本号：分隔条拖拽的 adjusting 帧 flexlayout 直写 DOM、模型
   * 不变（layoutRev 不动）——宿主层量测叠片（MainTint/双行块）订阅它
   * 逐帧跟随容器。轻消费者专用，壳不订阅（churn 隔离契约）。 */
  dragRev: number
  /** 拖拽高亮提示（overlay 订阅；壳不订阅——per-move churn 隔离契约） */
  dropHint: DropHint | null
  /** 拖拽中的页签 id（overlay/光标等轻组件订阅；壳不订阅） */
  treeDragging: string | null

  bumpLayoutRev(): void
  bumpDragRev(): void
  setDropHint(hint: DropHint | null): void
  setTreeDragging(paneId: string | null): void
}

export const useLayoutStore = create<LayoutStore>()((set, get) => ({
  layoutRev: 0,
  dragRev: 0,
  dropHint: null,
  treeDragging: null,

  bumpLayoutRev: () => set({ layoutRev: get().layoutRev + 1 }),
  bumpDragRev: () => set({ dragRev: get().dragRev + 1 }),
  setDropHint: (hint) => set({ dropHint: hint }),
  setTreeDragging: (paneId) => set({ treeDragging: paneId }),
}))

export const bumpLayoutRev = () => useLayoutStore.getState().bumpLayoutRev()
export const bumpDragRev = () => useLayoutStore.getState().bumpDragRev()
