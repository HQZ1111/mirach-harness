/**
 * app 右键菜单（hermes shellSections 移植）的纯投影单测：段结构/项序/
 * 图标/文案、命令面板命令与菜单动作同源、状态栏可见性解析。node 环境。
 * v5.0：「切换标签」链已删，菜单项和 PALETTE_COMMANDS 同步缩减。
 */
import { describe, expect, it } from 'vitest'

import {
  buildShellMenuSections,
  CODICON_GLYPHS,
  PALETTE_COMMANDS,
  runShellAction,
} from './app-context-menu'
import { parseStatusbarVisible } from '@/app/shell/statusbar'

const flatten = (sections: ReturnType<typeof buildShellMenuSections>) => sections.flat()

describe('buildShellMenuSections', () => {
  it('段结构与项序：[新建会话, 命令面板] | [切换状态栏, 设置]', () => {
    const sections = buildShellMenuSections()
    expect(sections.length).toBe(2)
    expect(sections[0].map((i) => i.id)).toEqual(['shell-new-chat', 'shell-palette'])
    expect(sections[1].map((i) => i.id)).toEqual(['shell-statusbar', 'shell-settings'])
  })

  it('文案逐字', () => {
    const labels = new Map(flatten(buildShellMenuSections()).map((i) => [i.id, i.label]))
    expect(labels.get('shell-new-chat')).toBe('新建会话')
    expect(labels.get('shell-palette')).toBe('命令面板')
    expect(labels.get('shell-statusbar')).toBe('切换状态栏')
    expect(labels.get('shell-settings')).toBe('设置')
  })

  it('图标字形表齐全', () => {
    for (const item of flatten(buildShellMenuSections())) {
      expect(CODICON_GLYPHS[item.icon].d.length).toBeGreaterThan(0)
    }
    expect(flatten(buildShellMenuSections()).map((i) => i.icon)).toEqual([
      'add',
      'search',
      'layout-statusbar',
      'layout-menubar',
    ])
  })

  it('裁剪行确实缺席（shell-tabstrip 已废）', () => {
    const ids = flatten(buildShellMenuSections()).map((i) => i.id)
    expect(ids).not.toContain('shell-tabstrip')
  })
})

describe('PALETTE_COMMANDS', () => {
  it('命令与菜单动作同源（shell-tabstrip 已废）', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    expect(ids).not.toContain('shell-tabstrip')
    expect(ids).toContain('shell-new-chat')
  })
})

describe('runShellAction', () => {
  it('unknown 动作走 default 分支不炸', () => {
    expect(() => runShellAction('nonexistent')).not.toThrow()
  })
})
