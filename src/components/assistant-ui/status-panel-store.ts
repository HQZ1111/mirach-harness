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
  /** composer 徽标的展开请求（ZCode handleOpenRunningBackgroundWorks 对偶）：
   *  面板组件消费一次后由面板清空。`sections` = 要展开的分区；面板本体
   *  只在「请求非空且 nonce 变化」时应用，避免徽标连点重复置位。 */
  readonly expandRequest: {
    readonly terminal: boolean
    readonly agent: boolean
    readonly workflow: boolean
    readonly nonce: number
  } | null
  setOverride(variant: StatusPanelVariant | null): void
  setMounted(mounted: boolean): void
  requestExpandSections(sections: { terminal: boolean; agent: boolean; workflow: boolean }): void
  consumeExpandRequest(): void
}

let expandNonce = 0

export const statusPanelStore = createStore<StatusPanelState>((set) => ({
  override: readOverride(),
  mounted: false,
  expandRequest: null,
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
  requestExpandSections: (sections) =>
    set({ expandRequest: { ...sections, nonce: ++expandNonce } }),
  consumeExpandRequest: () =>
    set((s) => (s.expandRequest === null ? s : { expandRequest: null })),
}))

/**
 * 让位形态（与 ZCode `conversationLayout.ts` 逐条对账）：
 *
 * - `offset`：内容列/dock 的横向平移。上游 `getConversationStatusPanelOffsetClassName`
 *   对 auto 与 inline **返回同一个类**（`@min-[1280px]/conversation:-translate-x-42`）
 *   —— 平移只在对话列 ≥1280 生效；上游无断点的 INLINE 常量是死代码。
 * - `topClearance`：胶囊形态下首屏给右上悬浮胶囊留的高度（上游 pt-14 同语义）。
 *   - `'always'`：mini 钉死收起 —— 任何宽度都是胶囊；
 *   - `'below-wide'`：auto 在 <1280 收胶囊（≥1280 是展开面板，不需要顶部余隙）。
 *
 * 面板**没真的渲染**（draft / 无内容）时两者都为 none —— override 只是偏好，
 * 不能拿它决定让位（否则"面板没出现还在左边"，2026-11-18 报障）。
 */
export function resolveStatusPanelShift(params: {
  scoped: boolean
  present: boolean
  variant: StatusPanelVariant
}): { offset: boolean; topClearance: 'none' | 'always' | 'below-wide' } {
  if (params.scoped || !params.present) {
    return { offset: false, topClearance: 'none' }
  }
  if (params.variant === 'mini') {
    return { offset: false, topClearance: 'always' }
  }
  if (params.variant === 'auto') {
    return { offset: true, topClearance: 'below-wide' }
  }
  // 'panel'：钉死展开形态，横向让位即可，不需要顶部余隙。
  return { offset: true, topClearance: 'none' }
}
