/**
 * 窗格右键菜单纯逻辑单测（pane-context-menu.tsx v5.0：关闭类动作）。
 * node 环境跑真 flexlayout Model（Model.fromJson/doAction 纯模型运算）。
 */
import { Model, TabSetNode } from 'flexlayout-react'
import { describe, expect, it } from 'vitest'

import { buildPaneMenuItems, runPaneMenuAction, zoneMenuFlags } from './pane-context-menu'

const json = (): Parameters<typeof Model.fromJson>[0] =>
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
          config: { region: 'chat' },
          children: [
            { type: 'tab', id: 'workspace', component: 'workspace', name: '主会话', enableClose: false },
            { type: 'tab', id: 'session-1', component: 'session', name: '会话 1' },
            { type: 'tab', id: 'session-2', component: 'session', name: '会话 2' },
          ],
        },
        {
          type: 'tabset',
          id: 'tsB',
          config: { region: 'panels' },
          children: [
            { type: 'tab', id: 'review', component: 'review', name: '检查' },
          ],
        },
      ],
    },
  }) as never

describe('zoneMenuFlags', () => {
  it('primary 页签 closeDisabled=true', () => {
    const model = Model.fromJson(json())
    const flags = zoneMenuFlags(model, 'workspace')
    expect(flags?.closeDisabled).toBe(true)
  })

  it('非 primary 页签可关；同栏可关计数正确', () => {
    const model = Model.fromJson(json())
    const flags = zoneMenuFlags(model, 'session-1')
    expect(flags?.closeDisabled).toBeFalsy()
    expect(flags?.allCloseable).toBe(2)
    expect(flags?.othersCloseable).toBe(1)
  })
})

describe('buildPaneMenuItems', () => {
  it('primary 页签：关闭钮 disabled', () => {
    const model = Model.fromJson(json())
    const flags = zoneMenuFlags(model, 'workspace')!
    const items = buildPaneMenuItems(flags)
    const close = items.find((i) => i.kind === 'item' && 'closeDisabled' in i)
    expect(close).toBeDefined()
  })
})

describe('runPaneMenuAction', () => {
  it('关闭非 primary 页签后页签消失', () => {
    const model = Model.fromJson(json())
    runPaneMenuAction('close', model, 'session-1')
    expect(model.getNodeById('session-1')).toBeUndefined()
  })

  it('primary 页签关闭被拒', () => {
    const model = Model.fromJson(json())
    runPaneMenuAction('close', model, 'workspace')
    expect(model.getNodeById('workspace')).toBeDefined()
  })
})
