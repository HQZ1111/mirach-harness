/**
 * app 右键菜单（hermes shellSections 移植）的纯投影单测：段结构/项序/
 * 图标/文案（hermes zh catalog 逐字）、裁剪行确实缺席、图标字形表齐全、
 * 切换标签的纯规划（hermes toggleTargetZoneTabStrip 同构：单一目标分栏 +
 * "toggle against what is ON SCREEN" 两态语义 + 轨/竖轨形态大栏不在切换面）
 * 与资格阶梯回退（active → workspace 主区）、命令面板命令与菜单动作同源、
 * 状态栏可见性严格解析。node 环境（context-menu-scope.test.ts 同款）。
 */
import { Actions, Model, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { describe, expect, it, vi } from 'vitest'

import {
  buildShellMenuSections,
  CODICON_GLYPHS,
  PALETTE_COMMANDS,
  planTabStripToggle,
  runShellAction,
  stripTargetFallback,
  type TabStripSetSnapshot,
} from './app-context-menu'
import { parseStatusbarVisible } from '@/app/shell/statusbar'

const flatten = (sections: ReturnType<typeof buildShellMenuSections>) => sections.flat()

describe('buildShellMenuSections（hermes shellSections 纯投影）', () => {
  it('段结构与项序 = hermes shellSections 裁剪后：[新建会话, 命令面板] | [切换状态栏, 切换标签, 设置]', () => {
    const sections = buildShellMenuSections()
    expect(sections.length).toBe(2)
    expect(sections[0].map((i) => i.id)).toEqual(['shell-new-chat', 'shell-palette'])
    expect(sections[1].map((i) => i.id)).toEqual(['shell-statusbar', 'shell-tabstrip', 'shell-settings'])
  })

  it('文案逐字 = hermes zh catalog', () => {
    const labels = new Map(flatten(buildShellMenuSections()).map((i) => [i.id, i.label] as const))
    // t.commandCenter.nav.newChat.title / t.commandCenter.paletteTitle
    expect(labels.get('shell-new-chat')).toBe('新建会话')
    expect(labels.get('shell-palette')).toBe('命令面板')
    // t.keybinds.actions['view.toggleStatusbar'/'view.toggleTabStrip'] / t.commandCenter.settings
    expect(labels.get('shell-statusbar')).toBe('切换状态栏')
    expect(labels.get('shell-tabstrip')).toBe('切换标签')
    expect(labels.get('shell-settings')).toBe('设置')
  })

  it('图标 = hermes codicon 名，且字形表逐个可渲染', () => {
    for (const item of flatten(buildShellMenuSections())) {
      expect(CODICON_GLYPHS[item.icon], `字形表缺 ${item.icon}`).toBeDefined()
      expect(CODICON_GLYPHS[item.icon].d.length).toBeGreaterThan(0)
    }
    expect(flatten(buildShellMenuSections()).map((i) => i.icon)).toEqual([
      'add',
      'search',
      'layout-statusbar',
      'layout-menubar',
      'settings-gear',
    ])
  })

  it('Tauri 裁剪行缺席：新建窗口 / 切换配置档案栏 / 更新 Hermes', () => {
    const ids = flatten(buildShellMenuSections()).map((i) => i.id)
    expect(ids).not.toContain('shell-new-window')
    expect(ids).not.toContain('shell-profile-rail')
    expect(ids).not.toContain('shell-update')
  })
})

describe('runShellAction（未知项 = 错误可见）', () => {
  it('未知 id console.error 不动作', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    runShellAction('shell-nope')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('planTabStripToggle（hermes toggleTargetZoneTabStrip：作用于单一目标分栏）', () => {
  const set = (id: string, stripVisible: boolean, opts: Partial<TabStripSetSnapshot> = {}): TabStripSetSnapshot => ({
    id,
    stripVisible,
    track: false,
    ...opts,
  })

  it('目标可见 → 隐藏它（toggle against what is ON SCREEN）；只出目标一个补丁', () => {
    expect(planTabStripToggle('a', [set('a', true), set('b', true)])).toEqual([{ id: 'a', enableTabStrip: false }])
  })

  it('目标已隐藏 → 显示（strip 隐藏分栏的指针唯一找回途径语义）', () => {
    expect(planTabStripToggle('b', [set('a', false), set('b', false)])).toEqual([{ id: 'b', enableTabStrip: true }])
  })

  it('轨（20px 导航轨）不在切换面', () => {
    expect(planTabStripToggle('track', [set('track', false, { track: true, region: 'left' })])).toEqual([])
  })

  it('竖轨形态大栏（存在轨的 region）的分栏不在切换面', () => {
    expect(
      planTabStripToggle('main-zone', [
        set('rail-track', false, { track: true, region: 'main' }),
        set('main-zone', false, { region: 'main' }),
        set('right-zone', true, { region: 'right' }),
      ]),
    ).toEqual([])
  })

  it('目标不在快照中 = 空补丁（调用方报错可见）', () => {
    expect(planTabStripToggle('ghost', [set('a', true)])).toEqual([])
    expect(planTabStripToggle('a', [])).toEqual([])
  })
})

describe('stripTargetFallback（hermes tabTargetGroup 回退梯级：active → workspace）', () => {
  const modelJson = (): IJsonModel =>
    ({
      global: {},
      borders: [],
      layout: {
        type: 'row',
        id: 'r0',
        children: [
          { type: 'tabset', id: 'tsA', children: [{ type: 'tab', id: 'sessions', component: 'sessions', name: 's' }] },
          {
            type: 'tabset',
            id: 'tsB',
            children: [
              { type: 'tab', id: 'workspace', component: 'workspace', name: 'w' },
              { type: 'tab', id: 'review', component: 'review', name: 'r' },
            ],
          },
        ],
      },
    }) as unknown as IJsonModel

  it('active 梯级：返回活动分栏（setActiveTabset 指向者），优先于 workspace', () => {
    const model = Model.fromJson(modelJson())
    model.doAction(Actions.setActiveTabset('tsA'))
    expect(stripTargetFallback(model)?.getId()).toBe('tsA')
  })

  it('workspace 梯级：无活动分栏（fromJson 未标 active）→ 返回主区所在分栏', () => {
    const model = Model.fromJson(modelJson())
    const target = stripTargetFallback(model)
    expect(target).toBeInstanceOf(TabSetNode)
    expect(target?.getId()).toBe('tsB')
    expect(target?.getChildren().some((c) => c instanceof TabNode && c.getId() === 'workspace')).toBe(true)
  })

  it('workspace 梯级对嵌套行同样成立（真实布局 = 根行 → 列行 → tabset）', () => {
    const model = Model.fromJson({
      global: {},
      borders: [],
      layout: {
        type: 'row',
        id: 'r0',
        children: [
          { type: 'tabset', id: 'tsA', children: [{ type: 'tab', id: 'sessions', component: 'sessions', name: 's' }] },
          {
            type: 'row',
            id: 'r1',
            children: [
              {
                type: 'tabset',
                id: 'tsB',
                children: [{ type: 'tab', id: 'workspace', component: 'workspace', name: 'w' }],
              },
            ],
          },
        ],
      },
    } as unknown as IJsonModel)
    const target = stripTargetFallback(model)
    expect(target?.getId()).toBe('tsB')
  })
})

describe('PALETTE_COMMANDS（命令面板最小开关的命令清单）', () => {
  it('id ⊆ 菜单动作面，文案逐字同菜单', () => {
    const menuLabels = new Map(flatten(buildShellMenuSections()).map((i) => [i.id, i.label] as const))
    expect(PALETTE_COMMANDS.length).toBeGreaterThan(0)
    for (const command of PALETTE_COMMANDS) {
      expect(menuLabels.get(command.id), `命令 ${command.id} 不在菜单动作面`).toBeDefined()
      expect(command.label).toBe(menuLabels.get(command.id))
    }
  })
})

describe('parseStatusbarVisible（状态栏可见性严格解析）', () => {
  it('缺失 = 默认可见', () => {
    expect(parseStatusbarVisible(null)).toBe(true)
  })

  it("'true'/'false' 直读", () => {
    expect(parseStatusbarVisible('true')).toBe(true)
    expect(parseStatusbarVisible('false')).toBe(false)
  })

  it('非法形状 console.error 回默认可见（不冒充旧数据）', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseStatusbarVisible('1')).toBe(true)
    expect(parseStatusbarVisible('yes')).toBe(true)
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })
})
