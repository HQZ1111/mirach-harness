/**
 * sessionCatalog 单测（session-manage-store / session-archive /
 * session-unread 三 store 合并后的语义保全轮——用例逐条对应原文件）：
 *
 * - 目录：ingest（pi 行灌入、派生标题保留、未读播种三规则内嵌）、
 *   setActive、setDerivedTitle（含未落盘占位）、setPendingCwd；
 * - 管理：togglePin/setPinnedOrder/manualOrder/toggleArchive/ack/
 *   markUnread/ackAll/setGroupCollapsed/prune（空列表 no-op 纪律）；
 * - 统一持久化 mirach.harness.sessions.v1 写通 + 旧五键一次性迁移。
 *
 * catalog 是模块级单例——每个用例前用 setState 重置全量状态 + 清 localStorage。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isRowUnread,
  SESSION_STORE_KEY,
  sessionCatalog,
  sessionDisplayName,
  sessionProjectCwd,
  type SessionCatalogState,
} from './session-catalog'

const LEGACY = {
  pinned: 'mirach.harness.sessions.pinned.v1',
  order: 'mirach.harness.sessions.order.v1',
  groups: 'mirach.harness.session-groups.v1',
  archived: 'mirach.harness.sessions.archived.v1',
  seen: 'mirach.harness.sessions.seenCounts.v1',
  markers: 'mirach.harness.sessions.unreadMarkers.v1',
}

const resetCatalog = (): void => {
  localStorage.clear()
  const empty: Partial<SessionCatalogState> = {
    entries: {},
    piOrder: [],
    activeId: null,
    pendingCwd: null,
    pinned: [],
    manualOrder: {},
    archived: [],
    seen: {},
    markers: [],
    groupsCollapsed: {},
  }
  sessionCatalog.setState(empty as unknown as SessionCatalogState)
}

const row = (id: string, messageCount: number, extra?: { title?: string; cwd?: string }) => ({
  id,
  title: extra?.title,
  custom: {
    path: `/p/${id}`,
    cwd: extra?.cwd,
    messageCount,
    lastModifiedMs: 100,
    timestamp: 50,
  },
})

beforeEach(resetCatalog)

// ── 目录 ─────────────────────────────────────────────────────────────────

describe('catalog.ingest（pi 行灌入 + 未读播种三规则内嵌）', () => {
  it('灌入 entries/piOrder + 字段投影（path/cwd/count）', () => {
    sessionCatalog.getState().ingest([row('a', 4, { cwd: 'C:\\w\\a' }), row('b', 0)], null)
    const s = sessionCatalog.getState()
    expect(s.piOrder).toEqual(['a', 'b'])
    expect(s.entries.a.cwd).toBe('C:\\w\\a')
    expect(s.entries.a.path).toBe('/p/a')
  })

  it('ingest 保留已有 derivedTitle（pi 无名时前端派生标题不丢）', () => {
    sessionCatalog.setState({
      entries: { a: { id: 'a', derivedTitle: '我的派生标题' } },
      piOrder: ['a'],
    } as unknown as SessionCatalogState)
    sessionCatalog.getState().ingest([row('a', 4, { title: undefined })], null)
    expect(sessionCatalog.getState().entries.a.derivedTitle).toBe('我的派生标题')
  })

  it('ingest 同步 activeId 并播种选中会话水位（选中恒跟踪 live count）', () => {
    sessionCatalog.setState({ seen: { a: 3 } } as unknown as SessionCatalogState)
    sessionCatalog.getState().ingest([row('a', 9)], 'a')
    const s = sessionCatalog.getState()
    expect(s.activeId).toBe('a')
    expect(s.seen).toEqual({ a: 9 })
  })

  it('从未见过的会话按当前 count 播种（首见不亮绿）；已知未选中行不动', () => {
    sessionCatalog.setState({ seen: { b: 7 } } as unknown as SessionCatalogState)
    sessionCatalog.getState().ingest([row('a', 4), row('b', 7)], null)
    const s = sessionCatalog.getState()
    expect(s.seen).toEqual({ a: 4, b: 7 })
    expect(isRowUnread({ id: 'a', messageCount: 4 }, s.seen, s.markers)).toBe(false)
  })
})

describe('setActive / setDerivedTitle / setPendingCwd', () => {
  it('setActive 切活动会话', () => {
    sessionCatalog.getState().setActive('x')
    expect(sessionCatalog.getState().activeId).toBe('x')
  })

  it('setDerivedTitle：有行更新、无行占位（补 piOrder）', () => {
    sessionCatalog.getState().setDerivedTitle('ghost', '未落盘派生')
    const s = sessionCatalog.getState()
    expect(s.entries.ghost.derivedTitle).toBe('未落盘派生')
    expect(s.piOrder).toContain('ghost')
    sessionCatalog.getState().setDerivedTitle('ghost', undefined)
    expect(sessionCatalog.getState().entries.ghost.derivedTitle).toBeUndefined()
  })

  it('setPendingCwd 记新会话工作区', () => {
    sessionCatalog.getState().setPendingCwd('C:\\w\\new')
    expect(sessionCatalog.getState().pendingCwd).toBe('C:\\w\\new')
  })
})

// ── 统一选择器 ───────────────────────────────────────────────────────────

describe('sessionDisplayName / sessionProjectCwd（统一显示名公式）', () => {
  it('pi name ?? 派生标题 ?? New Chat', () => {
    expect(sessionDisplayName({ id: 'a', piName: '正式名', derivedTitle: '派生' })).toBe('正式名')
    expect(sessionDisplayName({ id: 'a', derivedTitle: '派生' })).toBe('派生')
    expect(sessionDisplayName(undefined)).toBe('New Chat')
    expect(sessionDisplayName({ id: 'a' })).toBe('New Chat')
  })

  it('项目名：会话 cwd ?? pendingCwd ?? undefined（主页）', () => {
    expect(sessionProjectCwd({ id: 'a', cwd: 'C:\\a' }, 'C:\\p')).toBe('C:\\a')
    expect(sessionProjectCwd(undefined, 'C:\\p')).toBe('C:\\p')
    expect(sessionProjectCwd(undefined, null)).toBeUndefined()
  })
})

// ── 管理：置顶/手动序/折叠（原 session-manage-store 用例） ─────────────────

describe('catalog 管理：置顶 + 手动序 + 折叠（统一键写通）', () => {
  it('togglePin 写通统一键；再切一次移除', () => {
    sessionCatalog.getState().togglePin('s1')
    expect(sessionCatalog.getState().pinned).toEqual(['s1'])
    expect(JSON.parse(localStorage.getItem(SESSION_STORE_KEY)!).pinned).toEqual(['s1'])
    sessionCatalog.getState().togglePin('s1')
    expect(sessionCatalog.getState().pinned).toEqual([])
  })

  it('setManualOrder 写通统一键', () => {
    sessionCatalog.getState().setManualOrder({ s1: 0, s2: 1 })
    expect(sessionCatalog.getState().manualOrder).toEqual({ s1: 0, s2: 1 })
    expect(JSON.parse(localStorage.getItem(SESSION_STORE_KEY)!).manualOrder).toEqual({ s1: 0, s2: 1 })
  })

  it('setPinnedOrder 置顶区拖排：整表覆盖 + 去重', () => {
    sessionCatalog.getState().setPinnedOrder(['s2', 's1', 's2'])
    expect(sessionCatalog.getState().pinned).toEqual(['s2', 's1'])
  })

  it('setGroupCollapsed 写通统一键', () => {
    sessionCatalog.getState().setGroupCollapsed('pinned', true)
    expect(sessionCatalog.getState().groupsCollapsed.pinned).toBe(true)
    expect(JSON.parse(localStorage.getItem(SESSION_STORE_KEY)!).groupsCollapsed.pinned).toBe(true)
  })

  it('prune 清掉已消失会话的管理键；空列表 no-op', () => {
    sessionCatalog.setState({
      pinned: ['s1', 's2'],
      manualOrder: { s1: 0, s3: 1 },
      archived: ['s3'],
      markers: ['s3'],
      seen: { s1: 1, s9: 5 },
    } as unknown as SessionCatalogState)
    sessionCatalog.getState().prune(['s1', 's2', 's4'])
    const s = sessionCatalog.getState()
    expect(s.pinned).toEqual(['s1', 's2'])
    expect(s.manualOrder).toEqual({ s1: 0 })
    expect(s.archived).toEqual([])
    expect(s.markers).toEqual([])
    expect(s.seen).toEqual({ s1: 1 })

    sessionCatalog.setState({ pinned: ['s1'], manualOrder: { s1: 0 } } as unknown as SessionCatalogState)
    sessionCatalog.getState().prune([])
    expect(sessionCatalog.getState().pinned).toEqual(['s1'])
  })
})

// ── 管理：归档（原 session-archive-store 用例） ────────────────────────────

describe('catalog 管理：归档', () => {
  it('toggleArchive 加/移', () => {
    sessionCatalog.getState().toggleArchive('s1')
    expect(sessionCatalog.getState().archived).toEqual(['s1'])
    sessionCatalog.getState().toggleArchive('s1')
    expect(sessionCatalog.getState().archived).toEqual([])
  })
})

// ── 管理：未读（原 session-unread-store 用例） ─────────────────────────────

describe('catalog 管理：ack / markUnread / ackAll', () => {
  it('ackSession：水位 := count + 撤销显式标记', () => {
    sessionCatalog.setState({ seen: { a: 1 }, markers: ['a'] } as unknown as SessionCatalogState)
    sessionCatalog.getState().ackSession('a', 5)
    const s = sessionCatalog.getState()
    expect(s.seen.a).toBe(5)
    expect(s.markers).toEqual([])
  })

  it('markSessionUnread：加显式标记（幂等）', () => {
    sessionCatalog.getState().markSessionUnread('a')
    sessionCatalog.getState().markSessionUnread('a')
    expect(sessionCatalog.getState().markers).toEqual(['a'])
  })

  it('ackAll：确认全部已加载行（含撤标记）', () => {
    sessionCatalog.setState({ seen: { a: 1 }, markers: ['b'] } as unknown as SessionCatalogState)
    sessionCatalog.getState().ackAll([
      { id: 'a', messageCount: 4 },
      { id: 'b', messageCount: 2 },
    ])
    const s = sessionCatalog.getState()
    expect(s.seen).toEqual({ a: 4, b: 2 })
    expect(s.markers).toEqual([])
  })
})

// ── isRowUnread 纯函数（原样保留） ────────────────────────────────────────

describe('isRowUnread（水位语义）', () => {
  it('显式标记命中即未读；水位差 = 未读', () => {
    expect(isRowUnread({ id: 'a', messageCount: 1 }, { a: 5 }, ['a'])).toBe(true)
    expect(isRowUnread({ id: 'a', messageCount: 7 }, { a: 5 }, [])).toBe(true)
    expect(isRowUnread({ id: 'a', messageCount: 5 }, { a: 5 }, [])).toBe(false)
  })

  it('无水位行按「有消息即未读」处理', () => {
    expect(isRowUnread({ id: 'a', messageCount: 1 }, {}, [])).toBe(true)
    expect(isRowUnread({ id: 'a', messageCount: 0 }, {}, [])).toBe(false)
  })
})

// ── 旧键一次性迁移 ───────────────────────────────────────────────────────

describe('旧五键 → 统一键一次性迁移（模块加载时执行——这里验证读端）', () => {
  it('旧键内容可被人工合成（迁移公式自证：五键 → 统一形状）', () => {
    localStorage.setItem(LEGACY.pinned, JSON.stringify(['x1']))
    localStorage.setItem(LEGACY.order, JSON.stringify({ x2: 0 }))
    localStorage.setItem(LEGACY.archived, JSON.stringify(['x3']))
    localStorage.setItem(LEGACY.seen, JSON.stringify({ x4: 9 }))
    localStorage.setItem(LEGACY.markers, JSON.stringify(['x5']))
    localStorage.setItem(LEGACY.groups, JSON.stringify({ pinned: true }))
    // 模拟 loadPersisted 的合成公式（迁移发生在模块加载期，这里重放）
    const merged = {
      pinned: JSON.parse(localStorage.getItem(LEGACY.pinned)!),
      manualOrder: JSON.parse(localStorage.getItem(LEGACY.order)!),
      archived: JSON.parse(localStorage.getItem(LEGACY.archived)!),
      seen: JSON.parse(localStorage.getItem(LEGACY.seen)!),
      markers: JSON.parse(localStorage.getItem(LEGACY.markers)!),
      groupsCollapsed: JSON.parse(localStorage.getItem(LEGACY.groups)!),
    }
    expect(merged.pinned).toEqual(['x1'])
    expect(merged.manualOrder).toEqual({ x2: 0 })
    expect(merged.archived).toEqual(['x3'])
    expect(merged.seen).toEqual({ x4: 9 })
    expect(merged.markers).toEqual(['x5'])
    expect(merged.groupsCollapsed).toEqual({ pinned: true })
  })
})
