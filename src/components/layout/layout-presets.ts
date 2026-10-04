/**
 * 出厂布局（v5.0 三栏固定——docs/layout-design.md §1/§2）。
 *
 * v4 及以前的五套预设/用户预设/镜像全部废除（§8 已废弃清单）；本文件只剩
 * 一棵出厂树 + 分隔条/条高常量。旧存档键不迁移（v6 作废）。
 */

// ── 固定常量 ────────────────────────────────────────────────────────────────
// 大栏约束单一来源 = pane-registry.ts 的 REGION_LIMITS / REGION_DEFAULT_W。
// 高度：堆叠分栏 min = 标题条（0），无上限。

export const TAB_STRIP_H = 28

export const SIDEBAR_DEFAULT_WIDTH = 350

/** 左栏 tabset：无页签条（enableTabStrip=false 由 sync 按恒无条规则下发；
 *  Mirach 文字行由 leftrail 组件内容自带） */
export const LEFT_TABSET_ATTRS = { minWidth: 240, maxWidth: 420 }

/** 对话栏 zone 约束（仅 min 395，无上限） */
export const CHAT_ZONE_ATTRS = { minWidth: 395 }

/** 面板栏 zone 约束（min 240，无上限） */
export const PANELS_ZONE_ATTRS = { minWidth: 240 }

/** flexlayout 分隔条占位：视觉 0（描边已去），内部仍按 1px 扣缝 */
export const SPLITTER_PX = 1

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

const zoneCfg = (region: 'left' | 'chat' | 'panels') => ({ config: { region, rail: false } })

/** 出厂三栏树：[左栏 350 | 对话栏 吃剩余 | 面板栏 700（上页签组+下终端 20vh）] */
export function defaultLayout() {
  const S = SPLITTER_PX
  const W = window.innerWidth
  const H = window.innerHeight - 36 - 20
  const left = SIDEBAR_DEFAULT_WIDTH
  const panels = 700
  const chat = W - 2 * S - left - panels
  const term = Math.round(window.innerHeight * 0.2)
  return row(100, [
    tabset((left / W) * 100, [tab('leftrail', '左侧栏', false)], { ...LEFT_TABSET_ATTRS, ...zoneCfg('left') }),
    tabset((chat / W) * 100, [tab('workspace', '主会话', false)], { ...CHAT_ZONE_ATTRS, ...zoneCfg('chat') }),
    row((panels / W) * 100, [
      tabset(((H - term) / H) * 100, [tab('open', '打开', false), tab('files', '文件树', true), tab('review', '检查', true), tab('preview', '预览', true)], { ...PANELS_ZONE_ATTRS, ...zoneCfg('panels') }),
      tabset((term / H) * 100, [tab('terminal', '终端', true)], { ...zoneCfg('panels') }),
    ], { id: 'spl-panels', ...zoneCfg('panels') }),
  ], { id: 'spl-root' })
}
