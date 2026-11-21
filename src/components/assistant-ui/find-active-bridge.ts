/**
 * 转录轮次挂载门（真虚拟化的最小实现）：
 * 每轮的 wrapper div 恒在（轮导航器 rect / 滚动锚定依赖它），内部内容
 * 由 IntersectionObserver 按视口距离挂载/卸载。卸载时用**实测高度**的
 * 占位 div 保持布局稳定（滚动不跳）。查找打开时全部强制挂载（全文可搜）。
 *
 * 高度缓存 = sessionKey:turnKey → px（模块级 Map，跨切换保留——二次切换
 * 直接用缓存高度出占位符，无需重测）。
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand'

/** 视口外挂载缓冲（rootMargin）：±2500px ≈ 前后各几屏。 */
const GATE_ROOT_MARGIN = '2500px 0px 2500px 0px'

/** 高度缓存（sessionKey:turnKey → px）。 */
const heightCache = new Map<string, number>()

interface FindActiveState {
  active: boolean
  setActive: (active: boolean) => void
}

export const findActiveBridge = createStore<FindActiveState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}))

export const useFindActive = () => useStore(findActiveBridge, (s) => s.active)
