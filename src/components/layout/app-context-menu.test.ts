/**
 * app 右键菜单（hermes shellSections 移植）的纯投影单测：段结构/项序/
 * 图标/文案（hermes zh catalog 逐字）、裁剪行确实缺席、图标字形表齐全、
 * 切换标签的纯规划（轨/竖轨形态大栏不在切换面 + "toggle against what is
 * ON SCREEN" 两态语义）、命令面板命令与菜单动作同源、状态栏可见性严格
 * 解析。node 环境（context-menu-scope.test.ts 同款）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildShellMenuSections,
  CODICON_GLYPHS,
  PALETTE_COMMANDS,
  planTabStripToggle,
  runShellAction,
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

describe('planTabStripToggle（hermes toggleTargetZoneTabStrip 的 app 级等价物）', () => {
  const set = (id: string, stripVisible: boolean, opts: Partial<TabStripSetSnapshot> = {}): TabStripSetSnapshot => ({
    id,
    stripVisible,
    track: false,
    ...opts,
  })

  it('任一目标可见 → 全部隐藏（toggle against what is ON SCREEN）；已在目标态的分栏不出补丁', () => {
    const patches = planTabStripToggle([set('a', true), set('b', false), set('c', true)])
    expect(patches).toEqual([
      { id: 'a', enableTabStrip: false },
      { id: 'c', enableTabStrip: false },
    ])
  })

  it('全部不可见 → 全部显示；全部可见 → 全部隐藏', () => {
    expect(planTabStripToggle([set('a', false), set('b', false)])).toEqual([
      { id: 'a', enableTabStrip: true },
      { id: 'b', enableTabStrip: true },
    ])
    expect(planTabStripToggle([set('a', true), set('b', true)])).toEqual([
      { id: 'a', enableTabStrip: false },
      { id: 'b', enableTabStrip: false },
    ])
  })

  it('轨（20px 导航轨）不在切换面', () => {
    const patches = planTabStripToggle([set('track', false, { track: true, region: 'left' }), set('a', true)])
    expect(patches).toEqual([{ id: 'a', enableTabStrip: false }])
  })

  it('竖轨形态大栏（存在轨的 region）的分栏不在切换面', () => {
    const patches = planTabStripToggle([
      set('rail-track', false, { track: true, region: 'main' }),
      set('main-zone', false, { region: 'main' }),
      set('right-zone', true, { region: 'right' }),
    ])
    expect(patches).toEqual([{ id: 'right-zone', enableTabStrip: false }])
  })

  it('无可切换分栏 = 空补丁（调用方不发动作）', () => {
    expect(planTabStripToggle([set('t', false, { track: true })])).toEqual([])
    expect(planTabStripToggle([])).toEqual([])
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
