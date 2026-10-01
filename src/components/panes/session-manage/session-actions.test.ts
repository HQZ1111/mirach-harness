/**
 * 动作清单纯投影单测：⋯ 与右键上下文菜单共用一份 spec（hermes
 * session-actions-menu.tsx 的组序/文案/图标键）——清单顺序与文案漂移
 * 会直接在这里爆。
 */
import { describe, expect, it } from 'vitest'

import { projectSessionActions } from './session-actions'

describe('projectSessionActions', () => {
  it('hermes 组序：IDENTITY（重命名…/置顶/复制 ID）― WORK（分支）― DANGER（删除）', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: false })
    expect(specs.map((s) => s.kind === 'separator' ? `|${s.id}` : s.id)).toEqual([
      'rename',
      'pin',
      'copy-id',
      '|work',
      'branch',
      '|danger',
      'delete',
    ])
  })

  it('文案逐字取 hermes zh catalog', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: false })
    const labels = specs.filter((s) => s.kind === 'item').map((s) => (s as { label: string }).label)
    expect(labels).toEqual(['重命名…', '置顶', '复制 ID', '分支', '删除'])
  })

  it('已置顶行：pin 项文案翻「取消置顶」（图标键不变）', () => {
    const specs = projectSessionActions({ pinned: true, branchDisabled: false })
    const pin = specs.find((s) => s.kind === 'item' && s.id === 'pin')
    expect(pin?.kind === 'item' && pin.label).toBe('取消置顶')
    expect(pin?.kind === 'item' && pin.disabled).toBe(false)
  })

  it('删除恒末位、destructive、可点（确认弹层由对话框收口）', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: true })
    const last = specs[specs.length - 1]
    expect(last.kind === 'item' && last.id).toBe('delete')
    expect(last.kind === 'item' && last.destructive).toBe(true)
    expect(last.kind === 'item' && last.disabled).toBe(false)
  })

  it('分支禁用条件独立透传（非活动行/无 fork 点）', () => {
    const on = projectSessionActions({ pinned: false, branchDisabled: false })
    const off = projectSessionActions({ pinned: false, branchDisabled: true })
    const itemOn = on.find((s) => s.kind === 'item' && s.id === 'branch')
    const itemOff = off.find((s) => s.kind === 'item' && s.id === 'branch')
    expect(itemOn?.kind === 'item' && itemOn.disabled).toBe(false)
    expect(itemOff?.kind === 'item' && itemOff.disabled).toBe(true)
  })
})
