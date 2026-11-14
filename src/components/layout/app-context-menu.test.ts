/**
 * app 右键菜单（hermes shellSections 移植）的纯投影单测：段结构/项序/
 * 图标/文案、布局段的 ctx 门控、命令面板命令与菜单动作同源。node 环境
 * （无 DOM——布局段在 __flModel 缺席时整段缺席，见
 * buildShellMenuSections 的 flModel 守卫）。
 * v6.0：布局动词入菜单（隐藏标签/栏显隐/互换/面板栏位置）；「隐藏标签」
 * 行按 ctx.tabsetId 出席——测试里无模型 = 布局段恒空，只验 shell 段。
 * 2026-10-19：底栏整条撤除（用户"底栏不要了"），「切换状态栏」行与
 * 命令面板项随之删——本文件相应收窄。
 */
import { describe, expect, it } from 'vitest'

import {
  buildShellMenuSections,
  CODICON_GLYPHS,
  PALETTE_COMMANDS,
  runShellAction,
} from './app-context-menu'

const flatten = (sections: ReturnType<typeof buildShellMenuSections>) => sections.flat()

describe('buildShellMenuSections', () => {
  it('段结构与项序（无模型：strip 行缺席）', () => {
    const sections = buildShellMenuSections()
    expect(sections.length).toBe(3)
    expect(sections[0].map((i) => i.id)).toEqual(['shell-new-chat', 'shell-palette'])
    expect(sections[1].map((i) => i.id)).toEqual([
      'shell-left',
      'shell-panels',
      'shell-left-pos',
      'shell-panels-pos',
      'shell-reset-layout',
    ])
    expect(sections[2].map((i) => i.id)).toEqual(['shell-settings'])
  })

  it('文案逐字', () => {
    const labels = new Map(flatten(buildShellMenuSections()).map((i) => [i.id, i.label]))
    expect(labels.get('shell-new-chat')).toBe('新建会话')
    expect(labels.get('shell-palette')).toBe('命令面板')
    expect(labels.get('shell-settings')).toBe('设置')
    expect(labels.get('shell-left')).toBe('隐藏左侧栏')
    expect(labels.get('shell-panels')).toBe('隐藏面板栏')
    // v7.2 独立双位置切换：出厂序 [L,C,P] → 面板栏在 chat 右侧
    expect(labels.get('shell-left-pos')).toBe('左侧栏移到最右侧')
    expect(labels.get('shell-panels-pos')).toBe('面板栏移到左侧')
    // 2026-10-16 用户定稿：布局段第四个动词 = 一键复位
    expect(labels.get('shell-reset-layout')).toBe('默认布局')
  })

  it('图标字形表齐全', () => {
    for (const item of flatten(buildShellMenuSections())) {
      expect(CODICON_GLYPHS[item.icon].d.length).toBeGreaterThan(0)
    }
    expect(flatten(buildShellMenuSections()).map((i) => i.icon)).toEqual([
      'add',
      'search',
      'layout-sidebar-left',
      'layout-sidebar-right',
      'arrow-both',
      'layout-panel',
      'refresh',
      'layout-menubar',
    ])
  })

  it('布局段图标在字形表内', () => {
    for (const icon of ['layout-sidebar-left', 'layout-sidebar-right', 'arrow-both', 'layout-panel', 'refresh']) {
      expect(CODICON_GLYPHS[icon].d.length).toBeGreaterThan(0)
    }
  })

  it('「隐藏标签」行按 ctx.tabsetId + live 模型门控：node 环境无模型 → 缺席', () => {
    // 行内开关/搁浅 noop 态由 column-ops 的 stripToggleInfoOf 决定（CDP 冒烟覆盖）
    const ids = flatten(buildShellMenuSections({ tabsetId: 'chat-set' })).map((i) => i.id)
    expect(ids).not.toContain('shell-tabstrip')
  })
})

describe('PALETTE_COMMANDS', () => {
  it('命令与菜单动作同源', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    expect(ids).toContain('shell-new-chat')
    expect(ids).toContain('shell-settings')
  })
})

describe('runShellAction', () => {
  it('unknown 动作走 default 分支不炸', () => {
    expect(() => runShellAction('nonexistent')).not.toThrow()
  })
})
