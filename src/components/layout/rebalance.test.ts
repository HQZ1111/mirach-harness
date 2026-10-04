import { describe, expect, it } from 'vitest'
import { Actions, RowNode, TabSetNode, type Model, type Node } from 'flexlayout-react'

import { absorbSurplus, applyRootWeights, rootPxMem } from './rebalance'

const hostEl = { clientWidth: 1798 }
;(globalThis as unknown as { document: unknown }).document = {
  querySelector: (sel: string) => (sel === '.flexlayout-host' ? hostEl : null),
}

type FN = Record<string, unknown>

function fakeTabset(id: string, o: { region?: string; minW?: number; maxW?: number; measured?: number; weight?: number } = {}) {
  const n = Object.create(TabSetNode.prototype) as FN
  n.getId = () => id
  n.getConfig = () => (o.region === undefined ? undefined : { region: o.region })
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

function fakeModel(rootRow: FN, nodes: FN[] = []) {
  const actions: { type: string; data?: { node?: string; json?: Record<string, unknown> } }[] = []
  const m = {
    getRootRow: () => rootRow,
    visitNodes: (cb: (n: unknown) => void) => nodes.forEach((n) => cb(n as never)),
    doAction: (a: { type: string; data?: { node?: string; json?: Record<string, unknown> } }) => {
      actions.push({ type: a.type, data: a.data })
    },
  }
  return { m: m as unknown as Model, actions }
}

const decode = (a: { data?: { json?: { weight?: number } } } | undefined, avail: number): number =>
  (((a?.data?.json as { weight?: number } | undefined)?.weight ?? NaN) / 100) * avail

describe('rebalance v5.0 三栏固定', () => {
  describe('absorbSurplus', () => {
    it('有对话栏：非吸收者按记忆原位，富余全部进对话栏', () => {
      const left = fakeTabset('left', { region: 'left', minW: 240, measured: 350, weight: 100 })
      const chat = fakeTabset('chat', { region: 'chat', minW: 395, measured: 500, weight: 100 })
      const panels = fakeTabset('panels', { region: 'panels', minW: 240, measured: 700, weight: 100 })
      const root = fakeRow('root', [left, chat, panels])
      const { m, actions } = fakeModel(root)
      absorbSurplus(m)
      expect(actions).toHaveLength(3)
      const avail = 1798 - 2 // 3 kids = 2 gaps
      expect(decode(actions[0], avail)).toBeCloseTo(350, 0)
      expect(decode(actions[1], avail)).toBeCloseTo(avail - 350 - 700, 0)
      expect(decode(actions[2], avail)).toBeCloseTo(700, 0)
      const sum = actions.reduce((s, a) => s + decode(a, avail), 0)
      expect(sum).toBeCloseTo(avail, 0)
    })

    it('无对话栏：第一个非对话列兜底', () => {
      const left = fakeTabset('left', { region: 'left', minW: 240, measured: 350, weight: 100 })
      const panels = fakeTabset('panels', { region: 'panels', minW: 240, measured: 700, weight: 100 })
      const root = fakeRow('root', [left, panels])
      const { m, actions } = fakeModel(root)
      absorbSurplus(m)
      const avail = 1797 // 2 kids = 1 gap
      expect(actions).toHaveLength(2)
      expect(decode(actions[0], avail)).toBeCloseTo(avail - 700, 0)
      expect(decode(actions[1], avail)).toBeCloseTo(700, 0)
    })

    it('量测未就绪（rect 宽 ≤ 0）：整体放弃', () => {
      const left = fakeTabset('left', { region: 'left', minW: 240, measured: 0 })
      const chat = fakeTabset('chat', { region: 'chat', minW: 395, measured: 500 })
      const root = fakeRow('root', [left, chat])
      const { m, actions } = fakeModel(root)
      absorbSurplus(m)
      expect(actions).toHaveLength(0)
    })
  })

  describe('applyRootWeights', () => {
    it('三栏配重：非对话栏按记忆宽、对话栏吃剩余', () => {
      const left = fakeTabset('left', { region: 'left', minW: 240, weight: 100 })
      const chat = fakeTabset('chat', { region: 'chat', minW: 395, weight: 100 })
      const panels = fakeTabset('panels', { region: 'panels', minW: 240, weight: 100 })
      const root = fakeRow('root', [left, chat, panels])
      const { m, actions } = fakeModel(root)
      applyRootWeights(m)
      expect(actions).toHaveLength(3)
      const avail = 1798 - 2
      expect(decode(actions[0], avail)).toBeCloseTo(350, 0)
      expect(decode(actions[2], avail)).toBeCloseTo(700, 0)
      const sum = actions.reduce((s, a) => s + decode(a, avail), 0)
      expect(sum).toBeCloseTo(avail, 0)
    })

    it('未布局冷启动：min 全 0 也有记忆托底', () => {
      const left = fakeTabset('left', { region: 'left', minW: 0 })
      const chat = fakeTabset('chat', { region: 'chat', minW: 0 })
      const root = fakeRow('root', [left, chat])
      const { m, actions } = fakeModel(root)
      applyRootWeights(m)
      expect(actions).toHaveLength(2)
      const avail = 1798 - 1
      expect(decode(actions[0], avail)).toBeCloseTo(350, 0)
      expect(decode(actions[1], avail)).toBeCloseTo(avail - 350, 0)
    })
  })
})
