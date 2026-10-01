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

  it('lets Radix-owned surfaces keep the whole gesture (session rows)', () => {
    expect(resolveContextMenuScope(stubEl(CONTEXT_MENU_OWNER_SELECTOR))).toBe('owned')
  })

  it('editable wins over owned (a field inside an owned surface stays native)', () => {
    expect(resolveContextMenuScope(stubEl(CONTEXT_MENU_EDITABLE_SELECTOR, false))).toBe('editable')
  })
})
