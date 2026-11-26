import { describe, expect, it } from 'vitest'

import { menuPortalDescendsFrom } from './context-menu-portal'

describe('menuPortalDescendsFrom（后代 portal 归属判定）', () => {
  it('根菜单 portal（祖先链为空串）不是任何菜单的后代', () => {
    expect(menuPortalDescendsFrom('', 'r1')).toBe(false)
    expect(menuPortalDescendsFrom(null, 'r1')).toBe(false)
    expect(menuPortalDescendsFrom(undefined, 'r1')).toBe(false)
  })

  it('一级子菜单的祖先链含父菜单 id', () => {
    expect(menuPortalDescendsFrom('r1', 'r1')).toBe(true)
    expect(menuPortalDescendsFrom('r1', 'r2')).toBe(false)
  })

  it('更深层子菜单（r1|r2）对两级祖先都为真', () => {
    expect(menuPortalDescendsFrom('r1|r2', 'r1')).toBe(true)
    expect(menuPortalDescendsFrom('r1|r2', 'r2')).toBe(true)
    expect(menuPortalDescendsFrom('r1|r2', 'r3')).toBe(false)
  })

  it('id 是子串但不同 id 时不算命中（按 | 段精确比对）', () => {
    expect(menuPortalDescendsFrom('r10|r2', 'r1')).toBe(false)
  })
})
