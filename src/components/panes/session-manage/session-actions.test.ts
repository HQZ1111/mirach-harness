/**
 * 动作清单纯投影单测：⋯ 与右键上下文菜单共用一份 spec（hermes
 * session-actions-menu.tsx 的组序/文案/图标键）——清单顺序与文案漂移
 * 会直接在这里爆。重审计 #4/#5/#6 落地后：IDENTITY 组加 read-state 项、
 * WORK 组加导出、DANGER 组加归档。
 */
import { describe, expect, it } from 'vitest'

import { projectSessionActions } from './session-actions'

describe('projectSessionActions', () => {
  it('hermes 组序：IDENTITY（重命名…/置顶/read-state/复制 ID）― WORK（分支/导出）― DANGER（归档/删除）', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: false })
    expect(specs.map((s) => s.kind === 'separator' ? `|${s.id}` : s.id)).toEqual([
      'rename',
      'pin',
      'unread',
      'copy-id',
      '|work',
      'branch',
      'export',
      '|danger',
      'archive',
      'delete',
    ])
  })

  it('文案逐字取 hermes zh catalog', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: false })
    const labels = specs.filter((s) => s.kind === 'item').map((s) => (s as { label: string }).label)
    expect(labels).toEqual([
      '重命名…',
      '置顶',
      '标记为未读',
      '复制 ID',
      '分支',
      '导出',
      '归档',
      '删除',
    ])
  })

  it('已置顶行：pin 项文案翻「取消置顶」（图标键不变）', () => {
    const specs = projectSessionActions({ pinned: true, branchDisabled: false, unread: false, archived: false })
    const pin = specs.find((s) => s.kind === 'item' && s.id === 'pin')
    expect(pin?.kind === 'item' && pin.label).toBe('取消置顶')
    expect(pin?.kind === 'item' && pin.disabled).toBe(false)
  })

  it('read-state 项：未读行「标记为已读」、已读行「标记为未读」', () => {
    const unreadRow = projectSessionActions({ pinned: false, branchDisabled: false, unread: true, archived: false })
    const readRow = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: false })
    const markRead = unreadRow.find((s) => s.kind === 'item' && s.id === 'unread')
    const markUnread = readRow.find((s) => s.kind === 'item' && s.id === 'unread')
    expect(markRead?.kind === 'item' && markRead.label).toBe('标记为已读')
    expect(markUnread?.kind === 'item' && markUnread.label).toBe('标记为未读')
  })

  it('归档项：未归档行「归档」、已归档行「取消归档」', () => {
    const plain = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: false })
    const archivedRow = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: true })
    const archive = plain.find((s) => s.kind === 'item' && s.id === 'archive')
    const unarchive = archivedRow.find((s) => s.kind === 'item' && s.id === 'archive')
    expect(archive?.kind === 'item' && archive.label).toBe('归档')
    expect(unarchive?.kind === 'item' && unarchive.label).toBe('取消归档')
  })

  it('删除恒末位、destructive、可点（确认弹层由对话框收口）', () => {
    const specs = projectSessionActions({ pinned: false, branchDisabled: true, unread: false, archived: false })
    const last = specs[specs.length - 1]
    expect(last.kind === 'item' && last.id).toBe('delete')
    expect(last.kind === 'item' && last.destructive).toBe(true)
    expect(last.kind === 'item' && last.disabled).toBe(false)
  })

  it('分支禁用条件独立透传（非活动行/无 fork 点）', () => {
    const on = projectSessionActions({ pinned: false, branchDisabled: false, unread: false, archived: false })
    const off = projectSessionActions({ pinned: false, branchDisabled: true, unread: false, archived: false })
    const itemOn = on.find((s) => s.kind === 'item' && s.id === 'branch')
    const itemOff = off.find((s) => s.kind === 'item' && s.id === 'branch')
    expect(itemOn?.kind === 'item' && itemOn.disabled).toBe(false)
    expect(itemOff?.kind === 'item' && itemOff.disabled).toBe(true)
  })
})
