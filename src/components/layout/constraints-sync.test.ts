/**
 * constraints-sync.ts syncTabsetConstraints 单测（docs/layout-design.md
 * §2.1 列 identity 四步优先级 / §2.4 无主栏 max 放开 / §2.5 过承诺缩让 /
 * §4.2 轨形态 / §8 浮动隔离 / 空区竖轨清理）——identity 推导与 diff 门控
 * 此前零覆盖，"主会话拖到左栏旁被邻居抢锚"（P1-2）类回归靠它锁住。
 *
 * 范式照 constraints.test.ts：假节点 = Object.create(真原型) + 只覆盖被测
 * 函数实际读取的方法；假 Model 记录 doAction（不执行），断言落到分栏/
 * 页签上的属性补丁（updateNodeAttributes 的 data = { node, json }）。
 * node 环境无 window/document——文件内置替身（sync 读 window.innerWidth
 * 与 rootAvailPx 的 .flexlayout-host）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Actions, Model, Orientation, RowNode, TabNode, TabSetNode } from 'flexlayout-react'

import { syncTabsetConstraints } from './constraints-sync'

// ── 环境替身 ─────────────────────────────────────────────────────────────────

const win = { innerWidth: 1800 }
;(globalThis as unknown as { window: typeof win }).window = win

const hostEl = { clientWidth: 1800, offsetWidth: 0 }
;(globalThis as unknown as { document: unknown }).document = {
  querySelector: (sel: string) => (sel === '.flexlayout-host' ? hostEl : null),
}

beforeEach(() => {
  win.innerWidth = 1800
  hostEl.clientWidth = 1800
})

// ── 假节点（只覆盖被测函数实际读取的方法） ────────────────────────────────────

type Region = 'left' | 'main' | 'right'
type FN = Record<string, unknown>

interface TabSetOpts {
  region?: Region // undefined = 无 config 戳
  rail?: boolean
  track?: boolean
  minW?: number
  maxW?: number
  tabs?: FN[]
  layoutId?: string
  enableTabStrip?: boolean
  classNameTabStrip?: string | undefined
}

function fakeTabset(id: string, o: TabSetOpts = {}) {
  const n = Object.create(TabSetNode.prototype) as FN
  n.getId = () => id
  n.getConfig = () =>
    o.region === undefined ? undefined : { region: o.region, rail: o.rail === true, track: o.track === true }
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getLayoutId = () => o.layoutId ?? Model.MAIN_LAYOUT_ID
  n.getChildren = () => o.tabs ?? []
  // 读节点自身的 parent（rootWith 后挂）——isTopBand 沿父链上行要用
  n.getParent = () => n.parent as FN | undefined
  n.isEnableTabStrip = () => o.enableTabStrip ?? true
  n.getClassNameTabStrip = () => o.classNameTabStrip
  // 主对话标记读端（syncTabsetConstraints 用 getAttributeOwn 通用读——
  // 假节点无 _attributes，返回 undefined = 未打标）
  n.getAttributeOwn = () => undefined
  return n
}

function fakeTab(id: string, o: { enableClose?: boolean; className?: string } = {}) {
  const n = Object.create(TabNode.prototype) as FN
  n.getId = () => id
  n.isEnableClose = () => o.enableClose ?? false
  n.getClassName = () => o.className
  return n
}

function fakeRow(o: { orientation: Orientation; children: FN[] }) {
  const n = Object.create(RowNode.prototype) as FN
  n.getOrientation = () => o.orientation
  n.getChildren = () => o.children
  n.getParent = () => undefined
  return n
}

// ── 假 Model：记录 doAction（不执行） ────────────────────────────────────────

interface RecAction {
  type: string
  data?: { node?: string; toNode?: string; json?: Record<string, unknown> }
}

function fakeModel(rootRow: FN, nodes: FN[]) {
  const actions: RecAction[] = []
  const m = {
    getRootRow: () => rootRow,
    visitNodes: (cb: (n: unknown) => void) => nodes.forEach(cb),
    doAction: (a: RecAction) => {
      actions.push({ type: a.type, data: a.data })
    },
  }
  return { m: m as unknown as Model, actions }
}

const actsFor = (actions: RecAction[], id: string) => actions.filter((a) => a.data?.node === id)

const HORZ = Orientation.HORZ

/** 建一根行 + 把各列 parent 指回根行 */
function rootWith(kids: FN[]) {
  const children: FN[] = []
  const root = fakeRow({ orientation: HORZ, children })
  for (const k of kids) {
    ;(k as { parent?: FN }).parent = root
    children.push(k)
  }
  return root
}

// ── 列 identity 四步优先级（§2.1） ───────────────────────────────────────────

describe('syncTabsetConstraints 列 identity 四步优先级', () => {
  it('①带戳列保持：列内被拖入别的一级窗格也不改身份（左栏戳 + 主会话在内 → 仍 left）', () => {
    const workspace = fakeTab('workspace')
    const colA = fakeTabset('colA', { region: 'left', minW: 395, maxW: 420, tabs: [workspace] })
    const root = rootWith([colA])
    const { m, actions } = fakeModel(root, [colA, workspace])
    syncTabsetConstraints(m)
    // 列身份 = left（戳保持）：min 回 240；无主栏在场 → 非主栏 max 放开
    const a = actsFor(actions, 'colA')
    expect(a).toHaveLength(1)
    expect(a[0].type).toBe(Actions.UPDATE_NODE_ATTRIBUTES)
    expect(a[0].data?.json).toEqual({ minWidth: 240, maxWidth: 99999 }) // 不含 config——戳不重写
    // 主会话离家：✕（点击=回家）+ fl-tab-away 语义标记
    const t = actsFor(actions, 'workspace')
    expect(t.map((x) => x.data?.json)).toEqual([{ enableClose: true }, { className: 'fl-tab-away' }])
  })

  it('②无戳列由一级窗格家乡锚定：主会话拖出的新列 = main（而非邻居的 left）', () => {
    // 防回归（P1-2）：② 必须先于 ③ 邻居传播，否则新列被左邻抢锚成 left
    const sessions = fakeTab('sessions')
    const colA = fakeTabset('colA', { region: 'left', minW: 240, maxW: 420, tabs: [sessions] })
    const workspace = fakeTab('workspace')
    const colB = fakeTabset('colB', { minW: 0, maxW: 99999, tabs: [workspace] })
    const root = rootWith([colA, colB])
    const { m, actions } = fakeModel(root, [colA, colB, sessions, workspace])
    syncTabsetConstraints(m)
    expect(actsFor(actions, 'colA')).toHaveLength(0) // diff 门控：属性一致不发动作
    const b = actsFor(actions, 'colB')
    expect(b).toHaveLength(1)
    expect(b[0].data?.json).toEqual({ config: { region: 'main', rail: false }, minWidth: 395 }) // main 395，非 left 240
  })

  it('③无 primary 的新列向最近邻传播（左邻优先）', () => {
    const bots = fakeTab('bots')
    const colA = fakeTabset('colA', { region: 'left', minW: 240, maxW: 420, tabs: [bots] })
    const session = fakeTab('session-1')
    const colB = fakeTabset('colB', { minW: 0, maxW: 99999, tabs: [session] }) // session 非一级
    const review = fakeTab('review')
    const colC = fakeTabset('colC', { region: 'right', minW: 240, maxW: 420, tabs: [review] })
    const root = rootWith([colA, colB, colC])
    const { m, actions } = fakeModel(root, [colA, colB, colC, bots, session, review])
    syncTabsetConstraints(m)
    const b = actsFor(actions, 'colB')
    expect(b).toHaveLength(1)
    expect(b[0].data?.json).toEqual({ config: { region: 'left', rail: false }, minWidth: 240 }) // 继承左邻
  })

  it('③b无左邻时向右邻传播', () => {
    const session = fakeTab('session-1')
    const colB = fakeTabset('colB', { minW: 0, maxW: 99999, tabs: [session] })
    const review = fakeTab('review')
    const colC = fakeTabset('colC', { region: 'right', minW: 240, maxW: 420, tabs: [review] })
    const root = rootWith([colB, colC])
    const { m, actions } = fakeModel(root, [colB, colC, session, review])
    syncTabsetConstraints(m)
    const b = actsFor(actions, 'colB')
    expect(b[0].data?.json).toEqual({ config: { region: 'right', rail: false }, minWidth: 240 }) // 继承右邻
  })

  it('④全无锚定来源 → main', () => {
    const session = fakeTab('session-1')
    const colB = fakeTabset('colB', { minW: 0, maxW: 99999, tabs: [session] })
    const root = rootWith([colB])
    const { m, actions } = fakeModel(root, [colB, session])
    syncTabsetConstraints(m)
    const b = actsFor(actions, 'colB')
    expect(b).toHaveLength(1)
    expect(b[0].data?.json).toEqual({ config: { region: 'main', rail: false }, minWidth: 395 })
  })
})

// ── 形态与特例 ───────────────────────────────────────────────────────────────

describe('syncTabsetConstraints 轨/浮动/缩让/拆轨', () => {
  it('轨 tabset 跳过重钉（track 身份不被 config 整对象替换抹掉）；分栏条形态随轨隐藏', () => {
    const sessions = fakeTab('sessions')
    const colA = fakeTabset('colA', { region: 'left', minW: 240, maxW: 420, tabs: [sessions] })
    const track = fakeTabset('track', { region: 'left', rail: true, track: true, minW: 20, maxW: 20, enableTabStrip: false, tabs: [] })
    const root = rootWith([colA, track])
    const { m, actions } = fakeModel(root, [colA, track, sessions])
    syncTabsetConstraints(m)
    expect(actsFor(actions, 'track')).toHaveLength(0) // 轨不被重钉/不改形态
    const a = actsFor(actions, 'colA')
    expect(a).toHaveLength(1)
    expect(a[0].data?.json).toEqual({ maxWidth: 99999, enableTabStrip: false }) // railByRegion.left=true → 条隐藏
  })

  it('浮动布局（getLayoutId ≠ 主布局）整体跳过：不重钉、不参与竖轨形态判定', () => {
    const files = fakeTab('files')
    const mainCol = fakeTabset('mainCol', { region: 'right', minW: 240, maxW: 420, tabs: [files] })
    const review = fakeTab('review')
    // 浮窗里的"轨"若不被隔离，会把 right 形态点成竖轨并吃一次 20px 重钉
    const floating = fakeTabset('floating', { region: 'right', rail: true, track: true, minW: 500, maxW: 500, layoutId: 'floating-win-1', tabs: [review] })
    const root = rootWith([mainCol])
    const { m, actions } = fakeModel(root, [mainCol, floating, files, review])
    syncTabsetConstraints(m)
    expect(actsFor(actions, 'floating')).toHaveLength(0)
    const a = actsFor(actions, 'mainCol')
    expect(a).toHaveLength(1)
    expect(a[0].data?.json).toEqual({ maxWidth: 99999 }) // 无 enableTabStrip——浮动的轨没把 right 点成竖轨
  })

  it('过承诺缩让：主栏 min 按比例缩让、底线 40', () => {
    win.innerWidth = 600
    hostEl.clientWidth = 520
    const sessions = fakeTab('sessions')
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, tabs: [sessions] })
    const workspace = fakeTab('workspace')
    const mainA = fakeTabset('mainA', { region: 'main', minW: 395, maxW: 99999, tabs: [workspace] })
    const session = fakeTab('session-1')
    const mainB = fakeTabset('mainB', { region: 'main', minW: 395, maxW: 99999, tabs: [session] })
    const files = fakeTab('files')
    const right = fakeTabset('right', { region: 'right', minW: 240, maxW: 420, tabs: [files] })
    const root = rootWith([left, mainA, mainB, right])
    const { m, actions } = fakeModel(root, [left, mainA, mainB, right, sessions, workspace, session, files])
    syncTabsetConstraints(m)
    // avail = 520 − 3 缝 = 517；非主栏 Σmin 480；scaled = floor(37/2) = 18 < 395
    // → 主栏 min = max(18, 40) = 40（左右栏 240 底线不让）
    expect(actsFor(actions, 'mainA').map((x) => x.data?.json)).toEqual([{ minWidth: 40 }])
    expect(actsFor(actions, 'mainB').map((x) => x.data?.json)).toEqual([{ minWidth: 40 }])
    expect(actsFor(actions, 'left')).toHaveLength(0)
    expect(actsFor(actions, 'right')).toHaveLength(0)
  })

  it('空区竖轨清理：某区已无任何分栏 → 拆轨（假页签建轨即删）', () => {
    const sessions = fakeTab('sessions')
    const colA = fakeTabset('colA', { region: 'left', minW: 240, maxW: 420, tabs: [sessions] })
    const track = fakeTabset('track', { region: 'right', rail: true, track: true, minW: 20, maxW: 20, enableTabStrip: false, tabs: [] })
    const root = rootWith([colA, track])
    const { m, actions } = fakeModel(root, [colA, track, sessions])
    syncTabsetConstraints(m)
    // right 区无任何分栏 → 轨拆解三连：开删属性 + 假页签建入 + 删假页签
    expect(actions).toHaveLength(4)
    expect(actions[0].type).toBe(Actions.UPDATE_NODE_ATTRIBUTES)
    expect(actions[0].data?.node).toBe('track')
    expect(actions[0].data?.json).toEqual({ enableDeleteWhenEmpty: true, enableClose: true })
    expect(actions[1].type).toBe(Actions.ADD_TAB)
    expect(actions[1].data?.toNode).toBe('track')
    expect(actions[1].data?.json?.id).toBe('right-prune-spacer')
    expect(actions[2].type).toBe(Actions.DELETE_TAB)
    expect(actions[2].data?.node).toBe('right-prune-spacer')
    // 尾随的 colA 正常补丁（无主栏 → max 放开）；轨自身不再吃任何动作
    expect(actions[3].data?.node).toBe('colA')
    expect(actions[3].data?.json).toEqual({ maxWidth: 99999 })
  })
})
