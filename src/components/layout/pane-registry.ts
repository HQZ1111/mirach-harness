/**
 * 窗格类型注册表（v5.0 · docs/layout-design.md §1/§3/§6）——三栏固定：
 * 页签不可跨栏改列身份，region 由所在列静态决定；无回家语义。
 *
 * 大栏（region）：'left' | 'chat' | 'panels' —— 拖拽归属与约束的依据。
 */

import { Actions, RowNode, TabNode, TabSetNode, type Model, type Node as FLNode } from 'flexlayout-react'

export type PaneType = 'leftrail' | 'workspace' | 'session' | 'open' | 'files' | 'review' | 'terminal' | 'preview'
export type Region = 'left' | 'chat' | 'panels'

export interface PaneTypeDef {
  type: PaneType
  name: string
  region: Region
  /** single = 全局唯一实例（id = 类型名）；multi = 可多开（id = type-N） */
  multi: boolean
  /** 常驻窗格：不可关闭（主会话/打开页/左侧栏） */
  primary: boolean
  /** 真关闭后可重新打开（单例关闭型 / multi 永可新建） */
  reopenable: boolean
}

/** v5.0 三栏表（docs/layout-design.md §1/§6） */
export const PANE_TYPES: Record<PaneType, PaneTypeDef> = {
  leftrail: { type: 'leftrail', name: '左侧栏', region: 'left', multi: false, primary: true, reopenable: false },
  workspace: { type: 'workspace', name: '主会话', region: 'chat', multi: false, primary: true, reopenable: false },
  session: { type: 'session', name: '会话', region: 'chat', multi: true, primary: false, reopenable: true },
  open: { type: 'open', name: '打开', region: 'panels', multi: false, primary: true, reopenable: false },
  files: { type: 'files', name: '文件树', region: 'panels', multi: false, primary: false, reopenable: true },
  review: { type: 'review', name: '检查', region: 'panels', multi: false, primary: false, reopenable: true },
  terminal: { type: 'terminal', name: '终端', region: 'panels', multi: false, primary: false, reopenable: true },
  preview: { type: 'preview', name: '预览', region: 'panels', multi: true, primary: false, reopenable: true },
}

export const paneDef = (type: string): PaneTypeDef | undefined =>
  PANE_TYPES[type as PaneType]

/** 实例 id → 类型（单例 id = 类型名；多实例 id = type-N） */
export const paneTypeOf = (paneId: string): PaneType | undefined => {
  if (PANE_TYPES[paneId as PaneType]) return paneId as PaneType
  const t = paneId.replace(/-\d+$/, '') as PaneType
  return PANE_TYPES[t] ? t : undefined
}

/** 大栏约束（docs/layout-design.md §2）。左栏是唯一有最大宽的栏。 */
export const REGION_LIMITS: Record<Region, { minW: number; maxW?: number }> = {
  left: { minW: 240, maxW: 420 },
  chat: { minW: 395 },
  panels: { minW: 240 },
}

/** 大栏默认宽（出厂用） */
export const REGION_DEFAULT_W: Record<Region, number> = { left: 350, chat: 746, panels: 700 }

/** 各大栏的常驻窗格类型（打开页/主会话/左侧栏——三栏各一，不可关闭） */
export const PRIMARY_PANE: Record<Region, PaneType> = { left: 'leftrail', chat: 'workspace', panels: 'open' }

// ── 实例 id 分配 ─────────────────────────────────────────────────────────────

/** 模型里某类型已存在的实例 id 列表 */
export const instancesOfType = (m: Model, type: PaneType): string[] => {
  const out: string[] = []
  m.visitNodes((n) => {
    if (n instanceof TabNode && paneTypeOf(n.getId()) === type) out.push(n.getId())
  })
  return out
}

/** 下一个多实例 id（session-3 / terminal-2 …） */
export const nextInstanceId = (m: Model, type: PaneType): string => {
  const ids = instancesOfType(m, type)
  let max = 0
  for (const id of ids) {
    const n = Number(id.replace(/^\D+-/, ''))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${type}-${max + 1}`
}

// ── 页签 JSON ────────────────────────────────────────────────────────────────

export const paneTabJson = (paneId: string) => {
  const type = paneTypeOf(paneId)
  const def = type ? PANE_TYPES[type] : undefined
  return {
    type: 'tab' as const,
    id: paneId,
    // 工厂按**类型**分发组件（多实例共用）；未知 id 兜底用 id 本身
    component: type ?? paneId,
    name: def?.name ?? paneId,
    enableClose: def ? !def.primary : true,
  }
}

// ── region 读取（config 载体，JSON 持久化） ─────────────────────────────────

export interface ZoneConfig {
  region: Region
  /** 会话页签绑定的会话 id（仅 session-* 页签携带） */
  threadId?: string
}

export const zoneConfigOf = (node: FLNode | undefined): ZoneConfig | undefined => {
  if (!(node instanceof TabSetNode)) return undefined
  const cfg = node.getConfig() as Partial<ZoneConfig> | undefined
  if (!cfg || (cfg.region !== 'left' && cfg.region !== 'chat' && cfg.region !== 'panels')) return undefined
  return { region: cfg.region, threadId: cfg.threadId }
}

/** 分栏成员的类型集合（跨类型混合的 zone 以第一个窗格的类型为准判 region） */
export const zonePaneTypes = (m: Model, tabset: TabSetNode): PaneType[] =>
  tabset
    .getChildren()
    .filter((c): c is TabNode => c instanceof TabNode)
    .map((c) => paneTypeOf(c.getId()))
    .filter((t): t is PaneType => !!t)

/** 关闭窗格（v5.0：无回家语义——页签不可跨栏，primary 恒在家）。常驻
 *  窗格（primary）拒绝关闭；其余真关闭（分栏最后一签关闭 → 分栏消失）。 */
export const closePane = (m: Model, paneId: string): 'closed' | 'refused' => {
  const type = paneTypeOf(paneId)
  const def = type ? PANE_TYPES[type] : undefined
  if (!def) return 'refused'
  if (def.primary) return 'refused'
  const tab = m.getNodeById(paneId)
  if (!(tab instanceof TabNode)) return 'refused'
  m.doAction(Actions.deleteTab(paneId))
  return 'closed'
}
