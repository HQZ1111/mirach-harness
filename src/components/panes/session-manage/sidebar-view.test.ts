/**
 * 侧栏选项（sidebar-view）单测：严格解析（非法形状 console.error 可见并回
 * 默认）、手动序迁移推导、排序排名纯函数（updated→不排名 / title→标题字母
 * 序）、buildSessionDisplay 的视图模式投影（分组 date/none、排序
 * updated/title/manual 与置顶共存、排序键忽略非手动序——hermes 语义）、
 * store 旋钮写通（setOrdering 弃手动序与保存序、claimManual、resetView）。
 * IPC/渲染不在测试面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSessionDisplay,
  type SessionViewMode,
} from './session-display'
import {
  SIDEBAR_DEFAULT_DENSITY,
  SIDEBAR_DEFAULT_GROUPING,
  SIDEBAR_DEFAULT_ORDERING,
  effectiveOrdering,
  isSidebarViewCustomized,
  loadInitialManual,
  parseDensity,
  parseGrouping,
  parseManual,
  parseOrdering,
  rankIdsByOrdering,
  sessionSortTitle,
  sidebarViewStore,
  titleCompare,
} from './sidebar-view'
import { ORDER_KEY, sessionManageStore } from './session-manage-store'

/** 静音解析失败的 console.error（被测行为就是报错——断言调用而非听噪声） */
const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const resetStores = () => {
  localStorage.clear()
  sidebarViewStore.setState({
    grouping: SIDEBAR_DEFAULT_GROUPING,
    ordering: SIDEBAR_DEFAULT_ORDERING,
    manual: false,
    density: SIDEBAR_DEFAULT_DENSITY,
  })
  sessionManageStore.setState({ pinned: [], order: {}, groupsCollapsed: {}, drag: null })
}

// ── 严格解析 ─────────────────────────────────────────────────────────────

describe('sidebar-view 严格解析', () => {
  it('null → 默认值（无持久化数据是常态非错误）', () => {
    expect(parseGrouping(null)).toBe('date')
    expect(parseOrdering(null)).toBe('updated')
    expect(parseDensity(null)).toBe('comfortable')
    expect(parseManual(null)).toBe(false)
  })

  it('合法形状原样解析', () => {
    expect(parseGrouping('none')).toBe('none')
    expect(parseOrdering('title')).toBe('title')
    expect(parseDensity('compact')).toBe('compact')
    expect(parseManual('true')).toBe(true)
  })

  it('非法形状 → console.error + 默认（不冒充旧数据）', () => {
    const spy = silenceErrors()
    expect(parseGrouping('project')).toBe('date')
    expect(parseOrdering('cost')).toBe('updated')
    expect(parseDensity('cozy')).toBe('comfortable')
    expect(parseManual('yes')).toBe(false)
    expect(spy).toHaveBeenCalledTimes(4)
    spy.mockRestore()
  })
})

describe('loadInitialManual（手动序迁移推导）', () => {
  it('旗标存在以旗标为准（order 表内容无关）', () => {
    expect(loadInitialManual('false', JSON.stringify({ a: 0 }))).toBe(false)
    expect(loadInitialManual('true', null)).toBe(true)
  })

  it('旗标缺失：order 表非空 = 手动序曾在生效（旧语义拖拽序无条件生效）', () => {
    expect(loadInitialManual(null, JSON.stringify({ a: 0 }))).toBe(true)
    expect(loadInitialManual(null, '{}')).toBe(false)
    expect(loadInitialManual(null, null)).toBe(false)
  })
})

// ── 排序排名纯函数 ───────────────────────────────────────────────────────

describe('rankIdsByOrdering / titleCompare', () => {
  it('updated → 空排名（recency 即到达序，hermes sidebar-sort 同款）', () => {
    expect(rankIdsByOrdering([{ id: 'b', title: 'B' }, { id: 'a', title: 'A' }], 'updated')).toEqual([])
  })

  it('title → 标题字母序；空标题按 New Chat 兜底；同标题按 id 定序', () => {
    expect(sessionSortTitle(undefined)).toBe('New Chat')
    expect(sessionSortTitle('')).toBe('New Chat')
    const metas = [
      { id: '1', title: 'banana' },
      { id: '2', title: 'apple' },
      { id: '3' },
      { id: '4', title: 'Apple' },
    ]
    expect(rankIdsByOrdering(metas, 'title')).toEqual(['2', '4', '1', '3'])
  })

  it('titleCompare 同标题按 id 稳定', () => {
    expect(titleCompare({ id: 'a', title: 'X' }, { id: 'b', title: 'X' })).toBeLessThan(0)
  })
})

// ── buildSessionDisplay 视图模式投影 ─────────────────────────────────────

// 固定钟：2026-01-10 12:00（正午，避开 4 点滚动边界）。
const BASE = new Date(2026, 0, 10, 12, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 3_600_000
// a = 今天（未标名头部）；b = 8h59m 前（>8h 断口 → 昨天桶，单行）；
// c/d = 3 天前同桶两行（桶内排序的试验床）。
const METAS = [
  { id: 'a', lastActiveMs: BASE - 1 * MINUTE, title: 'zeta' },
  { id: 'b', lastActiveMs: BASE - 9 * HOUR, title: 'alpha' },
  { id: 'c', lastActiveMs: BASE - 3 * 24 * HOUR, title: 'banana' },
  { id: 'd', lastActiveMs: BASE - 3 * 24 * HOUR - 1 * MINUTE, title: 'apple' },
]
const OPTS = { nowMs: BASE, weekStartsOn: 1 }

const sessionIds = (rows: ReturnType<typeof buildSessionDisplay>['rows']): string[] =>
  rows.filter((r) => r.kind === 'session').map((r) => (r.kind === 'session' ? r.id : ''))

const dividerCount = (rows: ReturnType<typeof buildSessionDisplay>['rows']): number =>
  rows.filter((r) => r.kind === 'divider').length

describe('buildSessionDisplay 分组模式', () => {
  it('date（默认）→ 日历桶分隔线，桶成员由 recency 钉死', () => {
    const out = buildSessionDisplay(METAS, [], {}, {}, { ...OPTS, view: { grouping: 'date' } })
    expect(dividerCount(out.rows)).toBeGreaterThanOrEqual(2)
    expect(sessionIds(out.rows)[0]).toBe('a')
  })

  it('none（平铺）→ 无分隔线，整表单列', () => {
    const out = buildSessionDisplay(METAS, [], {}, {}, { ...OPTS, view: { grouping: 'none' } })
    expect(dividerCount(out.rows)).toBe(0)
    expect(out.rows.every((r) => r.kind === 'session')).toBe(true)
  })
})

describe('buildSessionDisplay 排序模式（与置顶共存）', () => {
  it('updated 忽略保存的手动序（hermes：非 manual 旗标的保存序不生效）', () => {
    const out = buildSessionDisplay(
      METAS,
      [],
      { d: 0, c: 1 },
      {},
      { ...OPTS, view: { ordering: 'updated' } },
    )
    expect(sessionIds(out.rows)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('title 组内字母序：桶成员不变（recency 钉死），桶内 apple < banana', () => {
    const out = buildSessionDisplay(METAS, [], {}, {}, { ...OPTS, view: { ordering: 'title' } })
    expect(dividerCount(out.rows)).toBeGreaterThanOrEqual(2)
    expect(sessionIds(out.rows)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('none + title → 平铺整表按标题字母序', () => {
    const out = buildSessionDisplay(METAS, [], {}, {}, {
      ...OPTS,
      view: { grouping: 'none', ordering: 'title' },
    })
    expect(sessionIds(out.rows)).toEqual(['b', 'd', 'c', 'a'])
  })

  it('manual → 持久化手动序在桶内应用（reconcileOrder 折回）', () => {
    const out = buildSessionDisplay(
      METAS,
      [],
      { d: 0, c: 1 },
      {},
      { ...OPTS, view: { ordering: 'manual' } },
    )
    expect(sessionIds(out.rows)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('置顶恒最上：置顶行退出会话区进 pinnedIds，pinned 数组序即展示序', () => {
    const out = buildSessionDisplay(
      METAS,
      ['c', 'a'],
      {},
      {},
      { ...OPTS, view: { ordering: 'title' } },
    )
    expect(out.pinnedIds).toEqual(['c', 'a'])
    expect(sessionIds(out.rows)).toEqual(['b', 'd'])
  })

  it('折叠：分隔线保留、其下行隐藏（视图模式不影响折叠语义）', () => {
    const collapsed: Record<string, boolean> = {}
    const withDividers = buildSessionDisplay(METAS, [], {}, {}, { ...OPTS, view: { grouping: 'date' } })
    for (const row of withDividers.rows) {
      if (row.kind === 'divider') collapsed[row.key] = true
    }
    const out = buildSessionDisplay(
      METAS,
      [],
      {},
      collapsed,
      { ...OPTS, view: { grouping: 'date' } },
    )
    expect(dividerCount(out.rows)).toBe(dividerCount(withDividers.rows))
    // 头部行（a）永不折叠，其余全被收起。
    expect(sessionIds(out.rows)).toEqual(['a'])
  })
})

// ── store 旋钮写通 ───────────────────────────────────────────────────────

describe('sidebarViewStore 旋钮', () => {
  beforeEach(resetStores)

  it('setGrouping / setDensity 写通 localStorage', () => {
    sidebarViewStore.getState().setGrouping('none')
    sidebarViewStore.getState().setDensity('compact')
    expect(localStorage.getItem('mirach.harness.sidebar.grouping.v1')).toBe('none')
    expect(localStorage.getItem('mirach.harness.sidebar.density.v1')).toBe('compact')
  })

  it('setOrdering 弃手动序 + 清保存的序号表（hermes setSidebarOrdering 逐语义）', () => {
    sessionManageStore.getState().setOrder({ a: 0, b: 1 })
    sidebarViewStore.getState().claimManual()
    sidebarViewStore.getState().setOrdering('title')
    expect(sidebarViewStore.getState().manual).toBe(false)
    expect(localStorage.getItem('mirach.harness.sidebar.manual.v1')).toBe('false')
    expect(sessionManageStore.getState().order).toEqual({})
    expect(localStorage.getItem(ORDER_KEY)).toBe('{}')
    expect(localStorage.getItem('mirach.harness.sidebar.ordering.v1')).toBe('title')
  })

  it('claimManual 声明手动序（幂等）并写通', () => {
    sidebarViewStore.getState().claimManual()
    sidebarViewStore.getState().claimManual()
    expect(sidebarViewStore.getState().manual).toBe(true)
    expect(localStorage.getItem('mirach.harness.sidebar.manual.v1')).toBe('true')
  })

  it('resetView 回出厂 + 清手动序（不动折叠态——hermes resetSidebarView 面）', () => {
    sidebarViewStore.getState().setGrouping('none')
    sidebarViewStore.getState().setDensity('compact')
    sidebarViewStore.getState().claimManual()
    sessionManageStore.getState().setOrder({ a: 0 })
    sessionManageStore.getState().setGroupCollapsed('today', true)
    sidebarViewStore.getState().resetView()
    expect(sidebarViewStore.getState().grouping).toBe('date')
    expect(sidebarViewStore.getState().ordering).toBe('updated')
    expect(sidebarViewStore.getState().manual).toBe(false)
    expect(sidebarViewStore.getState().density).toBe('comfortable')
    expect(sessionManageStore.getState().order).toEqual({})
    expect(sessionManageStore.getState().groupsCollapsed).toEqual({ today: true })
  })

  it('effectiveOrdering：manual 压过排序键（hermes $sidebarOrdering 同构）', () => {
    expect(effectiveOrdering({ ordering: 'title', manual: false })).toBe('title')
    expect(effectiveOrdering({ ordering: 'title', manual: true })).toBe('manual')
  })

  it('isSidebarViewCustomized：出厂 false，任一旋钮离开默认即 true', () => {
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(false)
    sidebarViewStore.getState().setGrouping('none')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().claimManual()
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().setDensity('compact')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().setOrdering('title')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
  })
})

// SessionViewMode 类型仅作编译面消费（缺省 = date + updated 的出厂形态）。
const _viewTypeGuard: SessionViewMode = { grouping: 'date', ordering: 'updated' }
void _viewTypeGuard
