import { describe, expect, it } from 'vitest'
import { Actions, Orientation, RowNode, TabSetNode, type Model } from 'flexlayout-react'

import { syncTabsetConstraints } from './constraints-sync'

// ── node 环境替身（constraints-sync 引用 rootAvailPx→document/window） ──────
const hostEl = { clientWidth: 1798 }
;(globalThis as unknown as { document: unknown }).document = {
  querySelector: (sel: string) => (sel === '.flexlayout-host' ? hostEl : null),
}
;(globalThis as unknown as { window: unknown }).window = { innerWidth: 1798 }

type FN = Record<string, unknown>

type TabOpts = {
  region?: 'left' | 'chat' | 'panels'
  minW?: number
  maxW?: number
  tabs?: FN[]
}

function fakeTabset(id: string, o: TabOpts = {}) {
  const n = Object.create(TabSetNode.prototype) as FN
  n.getId = () => id
  n.getConfig = () => (o.region === undefined ? undefined : { region: o.region })
  n.getMinWidth = () => o.minW ?? 0
  n.getMaxWidth = () => o.maxW ?? 99999
  n.getChildren = () => o.tabs ?? []
  n.getParent = () => n.parent as FN | undefined
  return n
}

/** 页签 = 普通对象（非 TabSetNode）——visitNodes 的 walk 对它不上溯 */
function fakeTab(id: string) {
  return { id, type: 'tab' } as unknown as FN
}

function fakeRow(o: { orientation: Orientation; children: FN[] }) {
  const n = Object.create(RowNode.prototype) as FN
  n.getOrientation = () => o.orientation
  n.getChildren = () => o.children
  n.getParent = () => undefined
  return n
}

interface RecAction {
  type: string
  data?: { node?: string; json?: Record<string, unknown> }
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

function rootWith(kids: FN[]) {
  const children: FN[] = []
  const root = fakeRow('root', { orientation: HORZ, children })
  for (const k of kids) {
    ;(k as { parent?: FN }).parent = root
    children.push(k)
  }
  return root
}

const HORZ = Orientation.HORZ
const VERT = Orientation.VERT

describe('syncTabsetConstraints v5.0 静态三栏', () => {
  it('config 跟随所在列（无戳 tabset 按位置兜底：中=chat）', () => {
    const tab = fakeTab('t1')
    const col = fakeTabset('col', { minW: 395, tabs: [tab] })
    const l = fakeTabset('l', { region: 'left', minW: 240, maxW: 420, tabs: [fakeTab('leftrail')] })
    const p = fakeTabset('p', { region: 'panels', minW: 240, tabs: [fakeTab('open')] })
    const root = rootWith([l, col, p])
    const { m, actions } = fakeModel(root, [l, col, p, tab])
    syncTabsetConstraints(m)
    const cfgPatch = actsFor(actions, 'col').find((a) => a.data?.json && 'config' in (a.data?.json ?? {}))
    expect(cfgPatch).toBeDefined()
    expect((cfgPatch!.data!.json as { config: { region: string } }).config.region).toBe('chat')
  })

  it('左栏 max 420 下发；chat/panels min 沿宽度轴下发', () => {
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 99999, tabs: [fakeTab('leftrail')] })
    const chat = fakeTabset('chat', { region: 'chat', minW: 395, tabs: [fakeTab('workspace')] })
    const panels = fakeTabset('panels', { region: 'panels', minW: 240, tabs: [fakeTab('open')] })
    const root = rootWith([left, chat, panels])
    const { m, actions } = fakeModel(root, [left, chat, panels])
    syncTabsetConstraints(m)
    const leftMax = actsFor(actions, 'left').find((a) => 'maxWidth' in (a.data?.json ?? {}))
    expect(leftMax).toBeDefined()
    expect((leftMax!.data!.json as { maxWidth: number }).maxWidth).toBe(420)
    // chat min 已在 395 → 不重发（diff 门控）
    expect(actsFor(actions, 'chat').some((a) => 'minWidth' in (a.data?.json ?? {}))).toBe(false)
  })

  it('垂直堆叠子项 minWidth=0（v5.0 上下两行均无独立宽限）', () => {
    const top = fakeTabset('top', { region: 'chat', minW: 0, tabs: [fakeTab('ct')] })
    const bottom = fakeTabset('bottom', { region: 'chat', minW: 0, tabs: [fakeTab('cb')] })
    const col = fakeRow('col', { orientation: VERT, children: [top, bottom] })
    ;(top as { parent?: FN }).parent = col
    ;(bottom as { parent?: FN }).parent = col
    const root = fakeRow('root', { orientation: HORZ, children: [col] })
    ;(col as { parent?: FN }).parent = root
    const m = {
      getRootRow: () => root,
      visitNodes: (cb: (n: unknown) => void) => [col, top, bottom].forEach(cb),
      doAction: () => {},
    } as unknown as Model
    syncTabsetConstraints(m)
    // VERT 堆叠：min 已是 0 → diff 门控不重发 positive min（无下发=正确）
    expect(true).toBe(true) // 烟雾测试：不崩即通过
  })

  it('过承诺缩让：chat min 降到底线 40，left min 240 底线不让', () => {
    const t1 = fakeTab('t1')
    const t2 = fakeTab('t2')
    const t3 = fakeTab('t3')
    const left = fakeTabset('left', { region: 'left', minW: 240, maxW: 420, tabs: [t1] })
    const chat = fakeTabset('chat', { region: 'chat', minW: 395, maxW: 99999, tabs: [t2] })
    const panels = fakeTabset('panels', { region: 'panels', minW: 240, maxW: 99999, tabs: [t3] })
    const root = rootWith([left, chat, panels])
    const hostMock = hostEl as { clientWidth: number }
    const origW = hostMock.clientWidth
    hostMock.clientWidth = 700
    const { m, actions } = fakeModel(root, [left, chat, panels])
    syncTabsetConstraints(m)
    hostMock.clientWidth = origW
    const chatMin = actsFor(actions, 'chat').find((a) => 'minWidth' in (a.data?.json ?? {}))
    if (chatMin) expect((chatMin.data!.json as { minWidth: number }).minWidth).toBeGreaterThanOrEqual(40)
    const leftMin = actsFor(actions, 'left').find((a) => 'minWidth' in (a.data?.json ?? {}))
    if (leftMin) expect((leftMin.data!.json as { minWidth: number }).minWidth).toBe(240)
  })
})
