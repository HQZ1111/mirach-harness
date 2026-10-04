/**
 * rebalance.ts 模型级操作单测（docs/layout-design.md §9/§2.4/§2.5/§2.6）：
 * 富余兜底 absorbSurplus、根行解析式配重 applyRootWeights、自适应窗宽
 * fitWindowWidth、动态窄屏判定 updateNarrowViewport——§9 的几何不变量
 * （Σ各列 px + Σ轨 20 + 缝 = 可用宽、吸收者唯一）此前全靠手工 CDP 回归。
 *
 * 范式照 constraints.test.ts：假节点 = Object.create(真原型) + 只覆盖被测
 * 函数实际读取的方法；假 Model 记录 doAction（不执行，断言写入的权重）。
 * node 环境没有 window/document——文件内置替身（rootAvailPx 查
 * .flexlayout-host）；tauri-window 用 vi.mock（rebalance 静态导入它，真
 * 模块在 import 时就读 window）。rootPxMem 是模块态，唯一写者
 * measureRootPx 本文件不调用——各用例依赖出厂默认
 * {left:350, main:746, right:700}，新增用例勿调 measureRootPx。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Actions, BorderNode, RowNode, TabNode, TabSetNode, type Model, type Node } from 'flexlayout-react'

import {
  DESIGN_WIDTH,
  MIN_WINDOW_WIDTH,
  absorbSurplus,
  applyRootWeights,
  fitWindowWidth,
  rootPxMem,
  updateNarrowViewport,
} from './rebalance'
import { useLayoutStore } from '@/store/layout-store'

// ── 环境替身（node 环境无 window/document） ──────────────────────────────────

interface WinStub {
  innerWidth: number
  outerWidth: number
  outerHeight: number
  innerHeight: number
  screen: { availWidth: number }
}
const win: WinStub = { innerWidth: 1800, outerWidth: 1800, outerHeight: 1000, innerHeight: 1000, screen: { availWidth: 1920 } }
;(globalThis as unknown as { window: WinStub }).window = win

const hostEl = { clientWidth: 1800, offsetWidth: 0 }
;(globalThis as unknown as { document: unknown }).document = {
  querySelector: (sel: string) => (sel === '.flexlayout-host' ? hostEl : null),
}

const tauri = vi.hoisted(() => ({
  inTauri: false,
  // 真 API 返回 Promise（rebalance 里 .catch()），替身保真；参数 = LogicalSize
  setSize: vi.fn((_size?: { width: number; height: number }) => Promise.resolve()),
}))
vi.mock('@/lib/tauri-window', () => ({
  get inTauri() {
    return tauri.inTauri
  },
  get appWindow() {
    return tauri.inTauri
      ? { setSize: tauri.setSize, isMaximized: async () => false }
      : null
  },
}))

beforeEach(() => {
  win.innerWidth = 1800
  win.outerWidth = 1800
  win.outerHeight = 1000
  win.innerHeight = 1000
  win.screen.availWidth = 1920
  hostEl.clientWidth = 1800
  tauri.inTauri = false
  tauri.setSize.mockReset()
  useLayoutStore.setState({ narrowViewport: false })
  // absorbSurplus 的非主栏 base 读记忆 px（与 applyRootWeights 同源，
  // 2026-10-03）——重置模块态防用例间泄漏；需要"量测已跑"前置的用例
  // 显式覆写（模拟 measureRootPx 已把渲染真值写入记忆）。
  rootPxMem.left = 350
  rootPxMem.main = 746
  rootPxMem.right = 700
})

// ── 假节点（只覆盖被测函数实际读取的方法） ────────────────────────────────────

type Region = 'left' | 'main' | 'right'
type FN = Record<string, unknown>

interface TabOpts {
  region?: Region // undefined = 无 config 戳
  rail?: boolean
  track?: boolean
  minW?: number
  maxW?: number
  weight?: number
  /** measuredPxWidth 读的 getRect().width */
  measured?: number
}

function fakeTabset(id: string, o: TabOpts = {}) {
  const n = Object.create(TabSetNode.prototype) as FN
  n.getId = () => id
  n.getConfig = () =>
    o.region === undefined ? undefined : { region: o.region, rail: o.rail === true, track: o.track === true }
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getWeight = () => o.weight ?? 100
  n.getRect = () => ({ width: o.measured ?? 0, height: 0, x: 0, y: 0 })
  return n
}

function fakeRow(id: string, children: FN[], measured = 0) {
  const n = Object.create(RowNode.prototype) as FN
  n.getId = () => id
  n.getChildren = () => children
  n.getRect = () => ({ width: measured, height: 0, x: 0, y: 0 })
  return n
}

function fakeTab(id: string, parent: FN) {
  const n = Object.create(TabNode.prototype) as FN
  n.getId = () => id
  n.getParent = () => parent
  return n
}

// ── 假 Model：记录 doAction（不执行） ────────────────────────────────────────

interface RecAction {
  type: string
  data?: { node?: string; toNode?: string; json?: Record<string, unknown> }
}

function fakeModel(rootRow: FN, nodes: FN[] = []) {
  const actions: RecAction[] = []
  const m = {
    getRootRow: () => rootRow,
    visitNodes: (cb: (n: Node) => void) => nodes.forEach((n) => cb(n as unknown as Node)),
    doAction: (a: RecAction) => {
      actions.push({ type: a.type, data: a.data })
    },
  }
  return { m: m as unknown as Model, actions }
}

/** 写入权重 → 目标 px（配重以 (px/可用宽)×100 落 updateNodeAttributes） */
const decode = (a: RecAction | undefined, avail: number): number =>
  (((a?.data?.json as { weight?: number } | undefined)?.weight ?? NaN) / 100) * avail

const actsFor = (actions: RecAction[], id: string) => actions.filter((a) => a.data?.node === id)

/** Actions.updateNodeAttributes(id, { weight }) */
const UPD = Actions.UPDATE_NODE_ATTRIBUTES

// ── absorbSurplus（§9 富余兜底） ─────────────────────────────────────────────

describe('absorbSurplus（§9 富余兜底：吸收者唯一、根行 Σ=可用宽）', () => {
  it('①有主栏：非吸收者按记忆原位（v4 无 max 钳制），富余全部进主栏分栏（Σ=可用宽）', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 350, weight: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 500, weight: 100 })
    const right = fakeTabset('right', { region: 'right', minW: 240, maxW: 420, measured: 700, weight: 100 })
    const root = fakeRow('root', [left, main, right])
    const { m, actions } = fakeModel(root)
    absorbSurplus(m)
    // 3 kids → avail = 1800 − 2×1 缝 = 1798；右栏目标 = 记忆 700（不再钳 420）
    expect(actions).toHaveLength(3)
    expect(actions.map((a) => a.data?.node)).toEqual(['left', 'main', 'right'])
    expect(decode(actions[0], 1798)).toBeCloseTo(350, 6) // 左栏原位（量测即目标）
    expect(decode(actions[1], 1798)).toBeCloseTo(748, 6) // 主栏 = 1798−350−700
    expect(decode(actions[2], 1798)).toBeCloseTo(700, 6) // 右栏原位（v4 无上限）
    const sum = actions.reduce((s, a) => s + decode(a, 1798), 0)
    expect(sum).toBeCloseTo(1798, 6) // 根行不变式：Σ = 可用宽
  })

  it('②无主栏：第一个非轨列当吸收者（钳制份额归还总账，Σ=可用宽）', () => {
    // 旧档残留 maxW 420（v4 语义下无害）：非吸收者按记忆原位，无 max 可钳
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 350, weight: 100 })
    const right = fakeTabset('right', { region: 'right', minW: 240, maxW: 420, measured: 700, weight: 100 })
    const root = fakeRow('root', [left, right])
    const { m, actions } = fakeModel(root)
    absorbSurplus(m)
    // avail = 1799；吸收者 = 第一个非轨列（左栏）：350 原位归还 + 富余 749
    expect(actions).toHaveLength(2)
    expect(decode(actions[0], 1799)).toBeCloseTo(1099, 6) // 350 + 1799−1050
    expect(decode(actions[1], 1799)).toBeCloseTo(700, 6) // 右栏记忆原位
    expect(decode(actions[0], 1799) + decode(actions[1], 1799)).toBeCloseTo(1799, 6)
  })

  it('③亏空（Σmin > avail）：差额落在吸收者（主栏低于自身 min），Σ=可用宽', () => {
    hostEl.clientWidth = 800
    // Σmin = 240+395+240 = 875 > avail 798（host 800）
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 240, weight: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 400, weight: 100 })
    const right = fakeTabset('right', { region: 'right', minW: 240, maxW: 420, measured: 240, weight: 100 })
    const root = fakeRow('root', [left, main, right])
    const { m, actions } = fakeModel(root)
    // 缩让后的渲染真值已入记忆（measureRootPx 前置）——base=mem=240
    rootPxMem.left = 240
    rootPxMem.right = 240
    absorbSurplus(m)
    // avail = 798；左右钳回 min 240，剩余 318 全部归主栏（< 其 min 395——
    // 240 底线不让，亏空只能归吸收者）
    expect(actions).toHaveLength(3)
    expect(decode(actions[0], 798)).toBeCloseTo(240, 6)
    expect(decode(actions[1], 798)).toBeCloseTo(318, 6)
    expect(decode(actions[2], 798)).toBeCloseTo(240, 6)
    expect(decode(actions[0], 798) + decode(actions[1], 798) + decode(actions[2], 798)).toBeCloseTo(798, 6)
  })

  it('③b亏空到非吸收者 min 已占满可用宽（rest ≤ 0）：整体放弃不写权重', () => {
    hostEl.clientWidth = 400
    // 左栏 min 399 = 可用宽 400−1 缝；主栏 min 395 装不下 → 240 底线不让 → 无解即放弃
    const left = fakeTabset('left', { region: 'left', minW: 399, maxW: 420, measured: 399, weight: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 50, weight: 100 })
    const root = fakeRow('root', [left, main])
    const { m, actions } = fakeModel(root)
    absorbSurplus(m)
    expect(actions).toHaveLength(0)
  })

  it('④Σ非主栏目标超可用宽（v4 无 max 收不回）：rest ≤ 0 整体放弃不写权重', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 350, weight: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 500, weight: 100 })
    const review = fakeTabset('review', { region: 'right', minW: 240, maxW: 420 })
    const files = fakeTabset('files', { region: 'right', minW: 240, maxW: 420 })
    const terminal = fakeTabset('terminal', { region: 'right', minW: 0, maxW: 99999 })
    const band = fakeRow('band', [review, files]) // 检查|文件并排（hermes Default 右列上半）
    const col = fakeRow('col', [band, terminal], 1100) // 右列 VERT 行，实测 1100
    const root = fakeRow('root', [left, main, col])
    const { m, actions } = fakeModel(root)
    // 记忆目标 350 + 1100 = 1450 > 可用宽（host 1200 → avail 1198）：
    // v4 无聚合上限可收回，rest < 0 → 无富余可分配，整体放弃
    hostEl.clientWidth = 1200
    rootPxMem.right = 1100
    absorbSurplus(m)
    expect(actions).toHaveLength(0)
  })

  it('量测未就绪（任一列 rect 宽 ≤ 0）：整体放弃', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 0 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 500 })
    const root = fakeRow('root', [left, main])
    const { m, actions } = fakeModel(root)
    absorbSurplus(m)
    expect(actions).toHaveLength(0)
  })

  it('窗口不可信（可用宽 < 300）：整体放弃', () => {
    hostEl.clientWidth = 250
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, measured: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, measured: 100 })
    const root = fakeRow('root', [left, main])
    const { m, actions } = fakeModel(root)
    absorbSurplus(m)
    expect(actions).toHaveLength(0)
  })
})

// ── applyRootWeights（§9 根行解析式配重） ────────────────────────────────────

describe('applyRootWeights（轨固定 / 主栏下限取实际生效 min / 非主栏记忆托底）', () => {
  it('轨 20 固定不参与；非主栏按记忆宽（v4 无 max 钳）；主栏吃剩余（Σ=可用宽）', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 300, weight: 100 }) // 旧档 maxW 300 在 v4 无效：目标 = 记忆 350
    const track = fakeTabset('track', { region: 'left', rail: true, track: true })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999, weight: 100 })
    const root = fakeRow('root', [left, track, main])
    const { m, actions } = fakeModel(root)
    applyRootWeights(m)
    // avail = 1798；左 = max(记忆350, min240) = 350；轨 = 20 固定；主 = 1428
    expect(actions).toHaveLength(3)
    expect(actions.map((a) => a.data?.node)).toEqual(['left', 'track', 'main'])
    expect(decode(actions[0], 1798)).toBeCloseTo(350, 6)
    expect(decode(actions[1], 1798)).toBeCloseTo(20, 6) // 轨不吃富余也不被钳
    expect(decode(actions[2], 1798)).toBeCloseTo(1428, 6)
    const sum = actions.reduce((s, a) => s + decode(a, 1798), 0)
    expect(sum).toBeCloseTo(1798, 6)
  })

  it('主栏下限取实际生效 minWidth（缩让态 40）：亏空缩让后主栏不再被顶回 395', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, weight: 100 }) // 记忆 350
    const track = fakeTabset('track', { region: 'left', rail: true, track: true })
    const r1 = fakeTabset('r1', { region: 'right', minW: 240, maxW: 420, weight: 100 }) // 记忆 700（v4 无钳）
    const r2 = fakeTabset('r2', { region: 'right', minW: 240, maxW: 420, weight: 100 })
    const r3 = fakeTabset('r3', { region: 'right', minW: 240, maxW: 420, weight: 100 })
    const main = fakeTabset('main', { region: 'main', minW: 40, maxW: 99999, weight: 100 }) // sync 缩让后的生效 min
    const root = fakeRow('root', [left, track, r1, r2, r3, main])
    const { m, actions } = fakeModel(root)
    applyRootWeights(m)
    // 6 kids → avail = 1795；Σ非主栏记忆 = 350+20+700×3 = 2470 > avail
    // → 亏空防护按比例缩让非主栏（floor）：350×0.7327=256、700×0.7327=512×3
    // → 主栏份额为负，下限取生效 min 40（写死 395 会顶回再溢出再缩让拉锯）
    expect(actions).toHaveLength(6)
    expect(decode(actsFor(actions, 'main')[0], 1795)).toBeCloseTo(40, 6)
    expect(decode(actsFor(actions, 'r1')[0], 1795)).toBeCloseTo(512, 6) // 缩让、非 max 钳
    expect(decode(actsFor(actions, 'left')[0], 1795)).toBeCloseTo(256, 6)
  })

  it('单列（kids < 2）：不动作', () => {
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999 })
    const root = fakeRow('root', [main])
    const { m, actions } = fakeModel(root)
    applyRootWeights(m)
    expect(actions).toHaveLength(0)
  })

  it('窗口不可信（可用宽 < 300）：不动作', () => {
    hostEl.clientWidth = 250
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999 })
    const root = fakeRow('root', [left, main])
    const { m, actions } = fakeModel(root)
    applyRootWeights(m)
    expect(actions).toHaveLength(0)
  })

  it('未布局冷启动（v4 无 max 守卫）：min 全 0 也有记忆托底，不再产生 0 目标', () => {
    // fromJson 后未布局：v3 时代 bounds {0,0} 把目标钳成 0、主栏吃满；
    // v4 目标 = max(记忆, min)——min 0 也有记忆 350 托底，权重合理
    const left = fakeTabset('left', { region: 'left', minW: 0, maxW: 0 })
    const main = fakeTabset('main', { region: 'main', minW: 395, maxW: 99999 })
    const root = fakeRow('root', [left, main])
    const { m, actions } = fakeModel(root)
    applyRootWeights(m)
    expect(actions).toHaveLength(2)
    expect(decode(actions[0], 1799)).toBeCloseTo(350, 6)
    expect(decode(actions[1], 1799)).toBeCloseTo(1449, 6)
  })
})

// ── fitWindowWidth（§2.6 自适应窗宽） ────────────────────────────────────────

describe('fitWindowWidth（自适应窗宽：长到 need / 回设计宽 / 600 下限 / 钳屏幕）', () => {
  const ts = (id: string, region: Region, minW: number) => fakeTabset(id, { region, minW, maxW: 99999 })

  it('need > 当前宽：窗宽长到 need（高度不变）', () => {
    tauri.inTauri = true
    win.innerWidth = 800
    win.outerWidth = 800
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    expect(tauri.setSize).toHaveBeenCalledTimes(1)
    const arg = tauri.setSize.mock.calls[0][0] as { width: number; height: number }
    expect(arg.width).toBe(879) // Σmin 875 + 缝 2 + 壳边框 2
    expect(arg.height).toBe(1000)
  })

  it('轨按 20 计入需求', () => {
    tauri.inTauri = true
    win.innerWidth = 600
    win.outerWidth = 600
    const root = fakeRow('root', [ts('left', 'left', 240), fakeTabset('track', { region: 'left', rail: true, track: true }), ts('main', 'main', 395)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    const arg = tauri.setSize.mock.calls[0][0] as { width: number }
    expect(arg.width).toBe(659) // 240 + 20 + 395 + 缝 2 + 壳 2
  })

  it('钳到屏幕可用宽', () => {
    tauri.inTauri = true
    win.innerWidth = 800
    win.outerWidth = 800
    win.screen.availWidth = 850
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    const arg = tauri.setSize.mock.calls[0][0] as { width: number }
    expect(arg.width).toBe(850) // need 879 > avail 850
  })

  it('600 下限', () => {
    tauri.inTauri = true
    win.innerWidth = 800
    win.outerWidth = 800
    win.screen.availWidth = 500
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    const arg = tauri.setSize.mock.calls[0][0] as { width: number }
    expect(arg.width).toBe(MIN_WINDOW_WIDTH) // avail 500 装不下，钳 600
  })

  it('need ≤ 设计宽且当前超 1802：回 1800 设计宽', () => {
    tauri.inTauri = true
    win.innerWidth = 1900
    win.outerWidth = 1900
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    const arg = tauri.setSize.mock.calls[0][0] as { width: number; height: number }
    expect(arg.width).toBe(DESIGN_WIDTH) // need 879 ≤ 1800 → 回设计宽
    expect(arg.height).toBe(1000)
  })

  it('纯浏览器（非 Tauri）：跳过不 setSize', () => {
    win.innerWidth = 800
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    expect(tauri.setSize).not.toHaveBeenCalled()
  })

  it('窄屏抽屉态：不参与', () => {
    tauri.inTauri = true
    useLayoutStore.setState({ narrowViewport: true })
    win.innerWidth = 800
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    expect(tauri.setSize).not.toHaveBeenCalled()
  })

  it('allowGrowRevert=false（手动缩窗）：不长窗', () => {
    tauri.inTauri = true
    win.innerWidth = 800
    win.outerWidth = 800
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, false)
    expect(tauri.setSize).not.toHaveBeenCalled()
  })

  it('±4px 容差：不动作', () => {
    tauri.inTauri = true
    win.innerWidth = 1803
    win.outerWidth = 1805 // need 879 ≤ 1800 → target = 1800+2 = 1802，|1802−1805| = 3 ≤ 4
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    fitWindowWidth(m, true)
    expect(tauri.setSize).not.toHaveBeenCalled()
  })
})

// ── updateNarrowViewport（动态窄屏判定） ─────────────────────────────────────

describe('updateNarrowViewport（needed+2 判据，唯一写者）', () => {
  const ts = (id: string, region: Region, minW: number) => fakeTabset(id, { region, minW, maxW: 99999 })

  it('宽窄两态：needed+1 → 窄，needed+2 → 不窄', () => {
    // needed = Σmin 875 + 2 缝 = 877
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    useLayoutStore.setState({ narrowViewport: true }) // 先置窄，证明宽态调用真的翻回
    win.innerWidth = 879
    updateNarrowViewport(m)
    expect(useLayoutStore.getState().narrowViewport).toBe(false)
    win.innerWidth = 878
    updateNarrowViewport(m)
    expect(useLayoutStore.getState().narrowViewport).toBe(true)
  })

  it('折叠在边框轨的侧栏页签按 region min 计入需求；主区/非 border 页签不计', () => {
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const border = Object.create(BorderNode.prototype) as FN
    const sessionsTab = fakeTab('sessions', border) // left 侧栏 → +240
    const workspaceTab = fakeTab('workspace', border) // main 区页签 → 不计
    const tsChild = fakeTabset('ts-child', { region: 'main' })
    const sessionTab = fakeTab('session-1', tsChild) // 父不是 border → 不计
    const { m } = fakeModel(root, [sessionsTab, workspaceTab, sessionTab])
    // needed = 877 + 240 = 1117
    win.innerWidth = 1118
    updateNarrowViewport(m)
    expect(useLayoutStore.getState().narrowViewport).toBe(true)
    win.innerWidth = 1119
    updateNarrowViewport(m)
    expect(useLayoutStore.getState().narrowViewport).toBe(false)
  })

  it('最小化瞬态（视口高 ≤ 240）：不改判', () => {
    const root = fakeRow('root', [ts('left', 'left', 240), ts('main', 'main', 395), ts('right', 'right', 240)])
    const { m } = fakeModel(root)
    useLayoutStore.setState({ narrowViewport: false })
    win.innerHeight = 200
    win.innerWidth = 100 // 本应判窄
    updateNarrowViewport(m)
    expect(useLayoutStore.getState().narrowViewport).toBe(false)
    win.innerHeight = 1000
  })
})
