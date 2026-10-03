/**
 * 窗格类型注册表（v2.1 · docs/layout-design.md §6）——窗格从单例 id 改为
 * **类型化多实例**：类型决定名字/宿主大栏/实例数/关闭语义；实例 id =
 * `${type}-${seq}`（单例类型 id = 类型名）。
 *
 * 大栏（region）：'left' | 'main' | 'right' —— 约束继承与拖拽归属的依据
 * （docs/layout-design.md §2/§8）。一级窗格（primary）不可关闭、关闭 =
 * 回家（§7）。
 */

import { Actions, DockLocation, BorderNode, RowNode, TabNode, TabSetNode, type Model, type Node as FLNode } from 'flexlayout-react'

export type PaneType = 'sessions' | 'bots' | 'workspace' | 'session' | 'files' | 'review' | 'terminal' | 'preview'
export type Region = 'left' | 'main' | 'right'

export interface PaneTypeDef {
  type: PaneType
  name: string
  region: Region
  /** single = 全局唯一实例（id = 类型名）；multi = 可多开（id = type-N） */
  multi: boolean
  /** 一级窗格：不可关闭；非家乡位置的关闭 = 回家 */
  primary: boolean
  /** 真关闭后可经 + 重新打开（single 关闭型 / multi 永可新建） */
  reopenable: boolean
}

/** 逐项对照用户 2026-09-26 规范（docs/layout-design.md §6 表） */
export const PANE_TYPES: Record<PaneType, PaneTypeDef> = {
  sessions: { type: 'sessions', name: '会话列表', region: 'left', multi: false, primary: true, reopenable: false },
  bots: { type: 'bots', name: '机器人', region: 'left', multi: false, primary: false, reopenable: true },
  workspace: { type: 'workspace', name: '主会话', region: 'main', multi: false, primary: true, reopenable: false },
  session: { type: 'session', name: '会话', region: 'main', multi: true, primary: false, reopenable: true },
  files: { type: 'files', name: '文件树', region: 'right', multi: false, primary: true, reopenable: false },
  review: { type: 'review', name: '检查', region: 'right', multi: false, primary: false, reopenable: true },
  terminal: { type: 'terminal', name: '终端', region: 'right', multi: true, primary: false, reopenable: true },
  preview: { type: 'preview', name: '预览', region: 'right', multi: true, primary: false, reopenable: true },
}

export const paneDef = (type: string): PaneTypeDef | undefined =>
  PANE_TYPES[type as PaneType]

/** 实例 id → 类型（单例 id = 类型名；多实例 id = type-N） */
export const paneTypeOf = (paneId: string): PaneType | undefined => {
  if (PANE_TYPES[paneId as PaneType]) return paneId as PaneType
  const t = paneId.replace(/-\d+$/, '') as PaneType
  return PANE_TYPES[t] ? t : undefined
}

/** 大栏约束（docs/layout-design.md §2 数值） */
export const REGION_LIMITS: Record<Region, { minW: number; maxW: number | null }> = {
  left: { minW: 240, maxW: 420 },
  main: { minW: 395, maxW: null },
  right: { minW: 240, maxW: 420 },
}

/** 大栏默认宽（新建/预设用） */
export const REGION_DEFAULT_W: Record<Region, number> = { left: 350, main: 746, right: 700 }

/** 各大栏的一级窗格类型（+ 号与回家语义的锚点） */
export const PRIMARY_PANE: Record<Region, PaneType> = { left: 'sessions', main: 'workspace', right: 'files' }

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

// ── region 读取/继承（config 载体，JSON 持久化） ─────────────────────────────

export interface ZoneConfig {
  region: Region
  /** 竖轨形态（横向条隐藏；区域级——任一分栏 rail 即整栏竖轨） */
  rail: boolean
  /** 停车轨（竖轨形态大栏的那条 20px 独立轨：页签折进来，点行开成一栏） */
  track?: boolean
  /** 页签条模式（hermes group.tabStrip 同构：'always'/'never' 显式选择，
   *  undefined = auto 由内容推导——constraints-sync 的阶梯 resolver） */
  tabStripMode?: 'always' | 'never'
}

export const zoneConfigOf = (node: FLNode | undefined): ZoneConfig | undefined => {
  if (!(node instanceof TabSetNode)) return undefined
  const cfg = node.getConfig() as Partial<ZoneConfig> | undefined
  if (!cfg || (cfg.region !== 'left' && cfg.region !== 'main' && cfg.region !== 'right')) return undefined
  // tabStripMode 必须透传——阶梯 resolver（constraints-sync）读它判显式
  // mode；截掉后 mode 分支永远死，"切换标签"写的 'always' 会被 sync 按
  // auto 立即打回（2026-10-04 用户实测开关无效的根因）
  return {
    region: cfg.region,
    rail: cfg.rail === true,
    track: cfg.track === true,
    tabStripMode: cfg.tabStripMode,
  }
}

/** 竖轨宽（独立停车轨的列宽，用户定值 20） */
export const TRACK_W = 20

/** 找某大栏的竖轨（20px 导航轨；fold 建立快照还原消失） */
export const findRailTabset = (m: Model, region: Region): TabSetNode | undefined => {
  let found: TabSetNode | undefined
  m.visitNodes((n) => {
    if (found || !(n instanceof TabSetNode)) return
    const cfg = zoneConfigOf(n)
    if (cfg?.track && cfg.region === region) found = n
  })
  return found
}

/** 分栏成员的类型集合（跨类型混合的 zone 以第一个窗格的类型为准判 region） */
export const zonePaneTypes = (m: Model, tabset: TabSetNode): PaneType[] =>
  tabset
    .getChildren()
    .filter((c): c is TabNode => c instanceof TabNode)
    .map((c) => paneTypeOf(c.getId()))
    .filter((t): t is PaneType => !!t)

// ── 回家（一级窗格的关闭 = 返回所属大栏的一级栏） ─────────────────────────────

/** 回家：把一级窗格移回其大栏的一级栏（有则并入堆叠，无则在大栏边缘重建）。 */
export const sendPaneHome = (m: Model, paneId: string): boolean => {
  const type = paneTypeOf(paneId)
  const def = type ? PANE_TYPES[type] : undefined
  if (!def || !def.primary) return false
  const tab = m.getNodeById(paneId)
  if (!(tab instanceof TabNode)) return false

  // 家乡大栏里、非本窗格所在的分栏（region 相同的其他 zone）
  const current = tab.getParent()
  let homeZone: TabSetNode | undefined
  m.visitNodes((n) => {
    if (homeZone || !(n instanceof TabSetNode) || n === current) return
    const cfg = zoneConfigOf(n)
    if (cfg?.region !== def.region) return
    if (n.getChildren().length > 0) homeZone = n
  })
  if (homeZone) {
    m.doAction(Actions.moveNode(paneId, (homeZone as TabSetNode).getId(), DockLocation.CENTER, (homeZone as TabSetNode).getChildren().length))
    return true
  }

  // 家乡大栏没有分栏了（被 tidy）→ 在大栏边缘重建一个分栏。
  // 锚点 region 感知（用户 2026-09-26 定稿："主栏就是中间栏"）：
  // 左栏贴最左、右栏贴最右；主栏走 §5 回退链（见下方分支注释）。
  const root = m.getRootRow()
  // 锚点候选**排除竖轨**（轨是 20px 导航特殊子项，不参与列身份/锚点——
  // 否则"贴最左"会贴到轨的外侧）
  const kids = root?.getChildren().filter((c) => (c instanceof TabSetNode || c instanceof RowNode) && !(c instanceof TabSetNode && zoneConfigOf(c)?.track)) ?? []
  if (kids.length === 0) return false
  const kidRegion = (n: FLNode): Region | undefined => {
    if (n instanceof TabSetNode) {
      const c = zoneConfigOf(n)
      return c?.track ? undefined : c?.region
    }
    if (n instanceof RowNode) {
      for (const c of n.getChildren()) {
        const r = kidRegion(c)
        if (r) return r
      }
    }
    return undefined
  }
  let anchor: FLNode
  let dock: DockLocation
  if (def.region === 'right') {
    anchor = kids[kids.length - 1]
    dock = DockLocation.RIGHT
  } else if (def.region === 'main') {
    // 主栏的家永远在中间（§5 回退链，与右栏是否隐藏/被拖走无关——
    // "主栏的家只由左栏内容在哪结束"决定）：
    // ① 最后一个左栏列（列 identity = left）的右缘 → ② 第一个右栏列的
    // 左缘 → ③ 根行第一个非轨子项的左缘（左右栏均不存在时主栏贴最左，
    // 其余列依次排其后）。此前只查第一个 right 列、缺 ①，左栏多列时
    // 主会话回家被插到第一个左栏列旁边。
    const leftKids = kids.filter((k) => kidRegion(k) === 'left')
    const lastLeft = leftKids[leftKids.length - 1]
    if (lastLeft) {
      anchor = lastLeft
      dock = DockLocation.RIGHT
    } else {
      const firstRight = kids.find((k) => kidRegion(k) === 'right')
      if (firstRight) {
        anchor = firstRight
        dock = DockLocation.LEFT
      } else {
        anchor = kids[0]
        dock = DockLocation.LEFT
      }
    }
  } else {
    anchor = kids[0]
    dock = DockLocation.LEFT
  }
  m.doAction(Actions.moveNode(paneId, (anchor as FLNode).getId(), dock, 0))
  const newSet = tab.getParent()
  if (newSet instanceof TabSetNode) {
    m.doAction(
      Actions.updateNodeAttributes(newSet.getId(), {
        config: { region: def.region, rail: false },
      }),
    )
  }
  return true
}

// ── 关闭（一级 = 回家；其余 = 真关闭） ───────────────────────────────────────

export const closePane = (m: Model, paneId: string): 'closed' | 'sent-home' | 'refused' => {
  const type = paneTypeOf(paneId)
  const def = type ? PANE_TYPES[type] : undefined
  if (!def) return 'refused'
  const tab = m.getNodeById(paneId)
  if (!(tab instanceof TabNode)) return 'refused'

  // 一级窗格：回家（已在家 → 拒绝，一级栏至少保留一级窗格）
  if (def.primary) {
    const set = tab.getParent()
    const cfg = zoneConfigOf(set)
    if (cfg?.region === def.region) return 'refused' // 已在家：不可关闭
    if (sendPaneHome(m, paneId)) return 'sent-home'
    return 'refused'
  }

  // 其他窗格：真关闭（分栏最后一签关闭 → 分栏消失，tidy 语义）
  m.doAction(Actions.deleteTab(paneId))
  return 'closed'
}
