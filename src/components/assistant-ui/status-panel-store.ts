/**
 * 活动状态面板的共享态（2026-11-01 用户："活动状态面板在一定宽度的时候
 * 不是能把对话区往左挤吗"）。
 *
 * ZCode 的让位链（conversationLayout.ts）：面板展开（非 mini）时对话内容列
 * 在容器 ≥1280 时整体左移 -168px（`-translate-x-42`），给右缘的 w-80 浮层
 * 让出正文；面板消失/收胶囊即回位。宿主同构：
 *
 * - store 持**显示策略**（auto/panel/mini，localStorage
 *   `mirach:status-panel-variant` 持久化——原在面板组件本地的 state 上移到
 *   这里，因为消费方有两个：面板本体 + 对话内容列）；
 * - `mounted` = 面板组件在场（挂载 = 有活动会话且非 draft），由面板组件
 *   写入；内容列只读它决定顶部余隙。≥1280 的宽度条件由 CSS 容器查询
 *   承担（`@min-[1280px]/thread:`），不进 store——React 不翻译容器宽度
 *   （上游同纪律）。
 */
import { createStore } from 'zustand'

export type StatusPanelVariant = 'auto' | 'panel' | 'mini'

const KEY = 'mirach:status-panel-variant'

const readOverride = (): StatusPanelVariant | null => {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === 'panel' || raw === 'mini' || raw === 'auto' ? raw : null
  } catch {
    return null
  }
}

interface StatusPanelState {
  /** 用户钉死的显示策略；null = auto（容器查询裁决）。 */
  readonly override: StatusPanelVariant | null
  /** 面板组件**在场**（挂载 = 有活动会话且非 draft）——面板组件写入。
   *  mini 胶囊在场也算在场（顶部余隙的判定依据）。 */
  readonly mounted: boolean
  setOverride(variant: StatusPanelVariant | null): void
  setMounted(mounted: boolean): void
}

export const statusPanelStore = createStore<StatusPanelState>((set) => ({
  override: readOverride(),
  mounted: false,
  setOverride: (variant) => {
    try {
      if (variant === null) window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, variant)
    } catch (e) {
      console.error('[status-panel] 显示策略持久化失败', e)
    }
    set({ override: variant })
  },
  setMounted: (mounted) =>
    set((s) => (s.mounted === mounted ? s : { mounted })),
}))
