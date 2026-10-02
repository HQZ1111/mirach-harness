/**
 * 窗格右键菜单纯逻辑单测（pane-context-menu.tsx 的状态推导/项清单/动作映射）。
 * node 环境跑真 flexlayout Model（Model.fromJson/doAction 纯模型运算，无 DOM——
 * rebalance/constraints 系列先例）；菜单只测逻辑不测渲染（Radix 渲染面归
 * CDP 黑盒验证）。
 *
 * 项清单 = hermes ZoneMenu 实锤（tree-group.tsx：关闭组/隐藏标签/最小化还原；
 * **无四向分栏/最大化/重命名**——2026-10-02 用户纠错后删除自创项）。
 */
import { Model, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { describe, expect, it } from 'vitest'

import { buildPaneMenuItems, isCloseableTabNode, runPaneMenuAction, zoneMenuFlags, type ZoneMenuFlags } from './pane-context-menu'

const json = (tsAConfig: Record<string, unknown> = { region: 'main', rail: false }): IJsonModel =>
  ({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      id: 'r0',
      children: [
        {
          type: 'tabset',
          id: 'tsA',
          config: tsAConfig,
          children: [
            { type: 'tab', id: 'workspace', component: 'workspace', name: '主会话', enableClose: false },
            { type: 'tab', id: 'session-1', component: 'session', name: '会话 1' },
            { type: 'tab', id: 'session-2', component: 'session', name: '会话 2' },
          ],
        },
        {
          type: 'tabset',
          id: 'tsB',
          config: { region: 'right', rail: false },
          children: [
            { type: 'tab', id: 'review', component: 'review', name: '检查' },
          ],
        },
      ],
    },
  }) as unknown as IJsonModel

const flags = (model: Model, tabId: string): ZoneMenuFlags => {
  const f = zoneMenuFlags(model, tabId)
  if (!f) throw new Error('flags missing: ' + tabId)
  return f
}

describe('zoneMenuFlags', () => {
  it('counts closeable siblings for a normal main-column session tab', () => {
    const model = Model.fromJson(json())
    const f = flags(model, 'session-1')
    expect(f.closeDisabled).toBe(false)
    expect(f.othersCloseable).toBe(1) // session-2（workspace 一级不计）
    expect(f.rightCloseable).toBe(1)
    expect(f.allCloseable).toBe(2)
    expect(f.stripVisible).toBe(true)
    expect(f.stripLocked).toBe(false)
  })

  it('disables close for a primary pane at its home region (已在家)', () => {
    const model = Model.fromJson(json())
    const f = flags(model, 'workspace')
    expect(f.closeDisabled).toBe(true)
  })

  it('zeroes right-count when the tab is last among siblings', () => {
    const model = Model.fromJson(json())
    const f = flags(model, 'session-2')
    expect(f.rightCloseable).toBe(0)
    expect(f.othersCloseable).toBe(1)
  })

  it('locks the strip toggle for rail-form (竖轨) columns', () => {
    const model = Model.fromJson(json({ region: 'main', rail: true }))
    expect(flags(model, 'session-1').stripLocked).toBe(true)
  })

  it('returns undefined for a vanished tab', () => {
    const model = Model.fromJson(json())
    expect(zoneMenuFlags(model, 'ghost')).toBeUndefined()
  })

  it('treats unregistered tabs as closeable', () => {
    const model = Model.fromJson(json())
    const ext = model.getNodeById('session-1') as TabNode
    expect(isCloseableTabNode(ext)).toBe(true)
    const ws = model.getNodeById('workspace') as TabNode
    expect(isCloseableTabNode(ws)).toBe(false)
  })
})

describe('buildPaneMenuItems（hermes ZoneMenu 项清单）', () => {
  it('emits exactly the hermes zone items: close group then strip toggle, zh labels', () => {
    const model = Model.fromJson(json())
    const items = buildPaneMenuItems(flags(model, 'session-1'))
    const seq = items.map((i) => (i.kind === 'sep' ? '|' : `${i.id}${i.disabled ? '!' : ''}`))
    expect(seq).toEqual(['close', 'close-others', 'close-right', 'close-all', '|', 'hide-strip'])
    const labels = Object.fromEntries(items.filter((i) => i.kind === 'item').map((i) => [i.id, (i as { label: string }).label]))
    expect(labels['close']).toBe('关闭')
    expect(labels['close-others']).toBe('关闭其他')
    expect(labels['close-right']).toBe('关闭右侧')
    expect(labels['close-all']).toBe('全部关闭')
    expect(labels['hide-strip']).toBe('隐藏标签')
  })

  it('carries NO invented items (split/maximize/rename removed per hermes 实锤)', () => {
    const model = Model.fromJson(json())
    const ids = buildPaneMenuItems(flags(model, 'session-1'))
      .filter((i) => i.kind === 'item')
      .map((i) => (i as { id: string }).id)
    for (const banned of ['split-left', 'split-right', 'split-top', 'split-bottom', 'maximize', 'restore', 'rename']) {
      expect(ids).not.toContain(banned)
    }
  })

  it('mirrors flag-driven disabled states (primary-at-home close, zero-count verbs)', () => {
    const model = Model.fromJson(json())
    const items = buildPaneMenuItems(flags(model, 'workspace'))
    const byId = Object.fromEntries(items.filter((i) => i.kind === 'item').map((i) => [i.id, i]))
    expect(byId['close'].disabled).toBe(true)
    const review = buildPaneMenuItems(flags(model, 'review'))
    const rById = Object.fromEntries(review.filter((i) => i.kind === 'item').map((i) => [i.id, i]))
    expect(rById['close-others'].disabled).toBe(true)
    expect(rById['close-right'].disabled).toBe(true)
    expect(rById['close-all'].disabled).toBe(false) // review 自身可关（非一级）
  })

  it('flips strip label with visibility state', () => {
    const model = Model.fromJson(json())
    const f = { ...flags(model, 'session-1'), stripVisible: false }
    const ids = buildPaneMenuItems(f).map((i) => (i.kind === 'sep' ? '|' : i.id))
    expect(ids).toContain('show-strip')
    expect(ids).not.toContain('hide-strip')
  })
})

describe('runPaneMenuAction — flexlayout 动作映射', () => {
  it('close routes through the registry (closeOthers skips primary tabs)', () => {
    const model = Model.fromJson(json())
    runPaneMenuAction('close-others', model, 'session-1')
    expect(model.getNodeById('session-2')).toBeUndefined()
    expect(model.getNodeById('workspace')).toBeInstanceOf(TabNode) // 一级窗格不在目标里
    expect(model.getNodeById('session-1')).toBeInstanceOf(TabNode)
  })

  it('hide-strip toggles the target tabset only', () => {
    const model = Model.fromJson(json())
    runPaneMenuAction('hide-strip', model, 'session-1')
    const tsA = model.getNodeById('tsA') as TabSetNode
    const tsB = model.getNodeById('tsB') as TabSetNode
    expect(tsA.isEnableTabStrip()).toBe(false)
    expect(tsB.isEnableTabStrip()).toBe(true) // 别的栏不动
  })

  it('unknown item ids fail visibly (规矩 12, no silent fallback)', () => {
    const model = Model.fromJson(json())
    const errors: unknown[] = []
    const spy = (msg: unknown, ...args: unknown[]) => errors.push([msg, ...args])
    const original = console.error
    console.error = spy as unknown as typeof console.error
    try {
      runPaneMenuAction('no-such-item', model, 'session-1')
      runPaneMenuAction('close', model, 'ghost')
    } finally {
      console.error = original
    }
    expect(errors.length).toBe(2)
  })
})
