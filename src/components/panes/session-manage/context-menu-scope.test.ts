/**
 * 全局右键范围裁定单测（main.tsx capture 监听消费的纯函数）。node 环境
 * 无 DOM：入参是结构化接口（closest/isContentEditable），桩元素只按
 * 预登记的选择器应答 closest。
 */
import { describe, expect, it } from 'vitest'

import {
  CONTEXT_MENU_EDITABLE_SELECTOR,
  CONTEXT_MENU_OWNER_SELECTOR,
  resolveContextMenuScope,
  type ContextMenuScopeTarget,
} from './context-menu-scope'

/** 桩元素：matchedSelector 命中时 closest 返回自身（祖先命中同形）。 */
const stubEl = (matchedSelector: string | null, isContentEditable = false): ContextMenuScopeTarget => ({
  closest: (selectors: string) => (matchedSelector !== null && selectors === matchedSelector ? stubEl(matchedSelector, isContentEditable) : null),
  isContentEditable,
})

/** 多选择器桩（pane 内容同时命中 pane 与更具体面的场景）。 */
const stubElMatching = (matched: string[], isContentEditable = false): ContextMenuScopeTarget => ({
  closest: (selectors: string) => (matched.includes(selectors) ? stubElMatching(matched, isContentEditable) : null),
  isContentEditable,
})

describe('resolveContextMenuScope', () => {
  it('puts plain chrome in the app scope (preventDefault)', () => {
    expect(resolveContextMenuScope(stubEl(null))).toBe('app')
  })

  it('returns app scope for a null target', () => {
    expect(resolveContextMenuScope(null)).toBe('app')
  })

  it('keeps the native edit menu inside inputs and textareas', () => {
    expect(resolveContextMenuScope(stubEl(CONTEXT_MENU_EDITABLE_SELECTOR))).toBe('editable')
  })

  it('treats contenteditable subtrees as editable via the DOM property', () => {
    expect(resolveContextMenuScope(stubEl(null, true))).toBe('editable')
  })

  it('lets self-managed surfaces keep the whole gesture (session rows)', () => {
    expect(resolveContextMenuScope(stubEl(CONTEXT_MENU_OWNER_SELECTOR))).toBe('owned')
  })

  it('机器人行根（data-roster-key，2026-11-07 移植）→ owned', () => {
    // 行根右键自管（bots-pane.tsx 的 onContextMenu 开行菜单）——全局监听早退
    expect(
      resolveContextMenuScope(stubElMatching(['[data-roster-key]', CONTEXT_MENU_OWNER_SELECTOR])),
    ).toBe('owned')
  })

  it('终端窗格根（data-slot="terminal-pane"，2026-11-18）→ owned', () => {
    // 右键 = ZCode TerminalSession 的复制/粘贴菜单（terminal-pane.tsx 自管）
    expect(
      resolveContextMenuScope(
        stubElMatching(['[data-slot="terminal-pane"]', CONTEXT_MENU_OWNER_SELECTOR]),
      ),
    ).toBe('owned')
  })

  it('editable wins over owned (a field inside an owned surface stays native)', () => {
    expect(resolveContextMenuScope(stubEl(CONTEXT_MENU_EDITABLE_SELECTOR, false))).toBe('editable')
  })
})
