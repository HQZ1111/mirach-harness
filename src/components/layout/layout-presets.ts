/**
 * 出厂布局（v6.0 三栏固定——docs/layout-design.md §1/§2）。
 *
 * 预设/镜像/编辑器全部废除（§9 已废弃清单）；本文件只剩一棵出厂树 +
 * 分隔条/条高常量。存储键 v8，旧档不迁移。
 */

// ── 固定常量 ────────────────────────────────────────────────────────────────
// 大栏约束单一来源 = pane-registry.ts 的 REGION_LIMITS / REGION_DEFAULT_W。
// 高度：堆叠分栏 min = 标题条（0），无上限。

export const TAB_STRIP_H = 28

export const SIDEBAR_DEFAULT_WIDTH = 350

/** 左栏 tabset：无页签条（Mirach 文字行由 leftrail 组件内容自带）+ 240-420 */
export const LEFT_TABSET_ATTRS = { minWidth: 240, maxWidth: 420, enableTabStrip: false }

/** 对话栏 zone 约束（仅 min 395，无上限） */
export const CHAT_ZONE_ATTRS = { minWidth: 395 }

/** 面板栏 zone 约束（min 240，无上限） */
export const PANELS_ZONE_ATTRS = { minWidth: 240 }

/** flexlayout 分隔条占位：视觉 0（描边已去），内部仍按 1px 扣缝 */
export const SPLITTER_PX = 1

const tab = (id: string, name: string, enableClose = true, extra: Record<string, unknown> = {}) => ({
  type: 'tab' as const,
  id,
  component: id,
  name,
  enableClose,
  ...extra,
})

const tabset = (weight: number, tabs: unknown[], attrs: Record<string, unknown> = {}) => ({
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

const zoneCfg = (region: 'left' | 'chat' | 'panels') => ({ config: { region } })

/** 出厂三栏树（docs/layout-design.md v7.0 §1/§2/§8）：
 *  [左栏 350 | 对话栏 吃剩余 | 面板栏 350（单页签组：打开页空态锚）]
 *  打开页 = ZCode 空态：无实签时显示（文件树/终端/预览经按钮开出后自动
 *  撤下，syncOpenAnchor 管；终端也是页签组一员，不再有底行）。
 *  返回 Model.fromJson 的完整形状（{ layout }）。 */
export function defaultLayout(): { layout: unknown } {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const left = SIDEBAR_DEFAULT_WIDTH
  const panels = SIDEBAR_DEFAULT_WIDTH
  const chat = W - 2 * S - left - panels
  return {
    layout: row(100, [
      tabset((left / W) * 100, [tab('leftrail', '左侧栏', false)], { ...LEFT_TABSET_ATTRS, ...zoneCfg('left') }),
      tabset((chat / W) * 100, [tab('workspace', '主会话', false)], { ...CHAT_ZONE_ATTRS, ...zoneCfg('chat') }),
      tabset((panels / W) * 100, [tab('open', '打开', false, { enableDrag: false })], { ...PANELS_ZONE_ATTRS, ...zoneCfg('panels'), enableDeleteWhenEmpty: false }),
    ], { id: 'spl-root' }),
  }
}

