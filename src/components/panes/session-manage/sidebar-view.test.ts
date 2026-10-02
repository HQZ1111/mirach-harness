/**
 * 侧栏选项（sidebar-view）单测：严格解析（非法形状 console.error 可见并回
 * 默认）、手动序迁移推导、排序排名纯函数（updated→不排名 / created→创建
 * 时间降序 / status→状态 rank 升序（缺辅助面 throw）/ tokens→词元数降序
 * （缺辅助面 throw，未拉到按 0 沉底））、buildSessionDisplay 的视图模式
 * 投影（分组 date/status/project、排序 updated/created/status/tokens/manual
 * 与置顶共存、排序键忽略非手动序——hermes 语义）、状态筛选（五桶多选，
 * 空 = 不过滤）、store 旋钮写通（setOrdering 弃手动序与保存序、
 * claimManual、toggleStatusBucket、resetView）。IPC/渲染不在测试面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSessionDisplay,
  type SessionViewMode,
} from './session-display'
import { sessionStatusBucket } from './session-status'
import {
  SIDEBAR_DEFAULT_DENSITY,
  SIDEBAR_DEFAULT_GROUPING,
  SIDEBAR_DEFAULT_ORDERING,
  createdCompare,
  effectiveOrdering,
  filterByStatus,
  isSidebarViewCustomized,
  loadInitialManual,
  parseDensity,
  parseGrouping,
  parseManual,
  parseOrdering,
  parseRowMeta,
  parseStatusFilter,
  rankIdsByOrdering,
  sidebarViewStore,
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
  sessionManageStore.setState({ pinned: [], order: {}, groupsCollapsed: {} })
}

// ── 严格解析 ─────────────────────────────────────────────────────────────

describe('sidebar-view 严格解析', () => {
  it('null → 默认值（无持久化数据是常态非错误）', () => {
    expect(parseGrouping(null)).toBe('date')
    expect(parseOrdering(null)).toBe('updated')
    expect(parseDensity(null)).toBe('comfortable')
    expect(parseManual(null)).toBe(false)
    expect(parseStatusFilter(null)).toEqual([])
    expect(parseRowMeta(null)).toEqual(['updated'])
  })

  it('合法形状原样解析', () => {
    expect(parseGrouping('status')).toBe('status')
    expect(parseGrouping('project')).toBe('project')
    expect(parseOrdering('tokens')).toBe('tokens')
    expect(parseOrdering('status')).toBe('status')
    expect(parseOrdering('created')).toBe('created')
    expect(parseDensity('compact')).toBe('compact')
    expect(parseManual('true')).toBe(true)
    expect(parseStatusFilter('["working","unread"]')).toEqual(['working', 'unread'])
  })

  it('非法形状 → console.error + 默认（不冒充旧数据）', () => {
    const spy = silenceErrors()
    // gateway = 网关与配置：pi 单配置档案无语义（菜单 disabled）→ 持久化
    // 中出现按非法回默认。
    expect(parseGrouping('gateway')).toBe('date')
    // 'none'（平铺）自任务定稿起删除（用户截图无此项）。
    expect(parseGrouping('none')).toBe('date')
    // 'title'（标题字母序）/'manual'（手动）自任务定稿起从菜单删除。
    expect(parseOrdering('title')).toBe('updated')
    // 'cost'（成本）自任务定稿起删除（用户截图 Show 子菜单无成本）。
    expect(parseOrdering('cost')).toBe('updated')
    expect(parseDensity('cozy')).toBe('comfortable')
    expect(parseManual('yes')).toBe(false)
    spy.mockRestore()
  })

  it('rowMeta：cost/pr 条目剔除（部分合法保留合法部分），整串非法回默认', () => {
    const spy = silenceErrors()
    expect(parseRowMeta('["tokens","cost"]')).toEqual(['tokens'])
    expect(parseRowMeta('["tokens","updated"]')).toEqual(['tokens', 'updated'])
    expect(parseRowMeta('not-json')).toEqual(['updated'])
    spy.mockRestore()
  })

  it('statusFilter：桶白名单过滤 + 去重保序；整串非法回空（不过滤）', () => {
    const spy = silenceErrors()
    expect(parseStatusFilter('["draft","working","draft"]')).toEqual(['draft', 'working'])
    expect(parseStatusFilter('["all"]')).toEqual([])
    expect(parseStatusFilter('not-json')).toEqual([])
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

describe('rankIdsByOrdering', () => {
  it('updated → 空排名（recency 即到达序，hermes sidebar-sort 同款）', () => {
    expect(rankIdsByOrdering([{ id: 'b' }, { id: 'a' }], 'updated')).toEqual([])
  })

  it('created → 创建时间降序（hermes rankBy created = -started_at）；同毫秒按 id', () => {
    const metas = [
      { id: 'old', createdMs: 100 },
      { id: 'new', createdMs: 300 },
      { id: 'mid', createdMs: 200 },
    ]
    expect(rankIdsByOrdering(metas, 'created')).toEqual(['new', 'mid', 'old'])
    expect(rankIdsByOrdering(metas, 'created')).toEqual(
      [...metas].sort(createdCompare).map((m) => m.id),
    )
  })

  it('status → 状态 rank 升序（needs-input > working > unread > draft > idle，'
    + 'hermes STATUS_RANK 原样）；tie 按新近降序', () => {
    const buckets = new Map([
      ['i1', 'idle' as const],
      ['w1', 'working' as const],
      ['n1', 'needs-input' as const],
      ['u1', 'unread' as const],
      ['d1', 'draft' as const],
    ])
    const metas = [
      { id: 'i1', lastActiveMs: 500 },
      { id: 'w1', lastActiveMs: 400 },
      { id: 'n1', lastActiveMs: 300 },
      { id: 'u1', lastActiveMs: 200 },
      { id: 'd1', lastActiveMs: 100 },
    ]
    expect(rankIdsByOrdering(metas, 'status', { statusBuckets: buckets })).toEqual([
      'n1', 'w1', 'u1', 'd1', 'i1',
    ])
  })

  it('status 同 rank 的两行 tie 按新近降序（hermes 稳定 sort 的新近基准序）', () => {
    const buckets = new Map([
      ['a', 'idle' as const],
      ['b', 'idle' as const],
    ])
    const metas = [
      { id: 'a', lastActiveMs: 100 },
      { id: 'b', lastActiveMs: 900 },
    ]
    expect(rankIdsByOrdering(metas, 'status', { statusBuckets: buckets })).toEqual(['b', 'a'])
  })

  it('status 排序缺 aux.statusBuckets → throw（接线 bug 可见，禁止兜底）', () => {
    expect(() => rankIdsByOrdering([{ id: 'a' }], 'status')).toThrow(/statusBuckets/)
  })

  it('tokens → 词元数降序（hermes rankBy tokens = -(input+output)）；'
    + '未拉到用量的行按 0 沉底；tie 按新近降序', () => {
    const totals = new Map([
      ['big', 9000],
      ['small', 12],
    ])
    const metas = [
      { id: 'big', lastActiveMs: 100 },
      { id: 'none', lastActiveMs: 200 },
      { id: 'small', lastActiveMs: 300 },
    ]
    expect(rankIdsByOrdering(metas, 'tokens', { tokenTotals: totals })).toEqual([
      'big', 'small', 'none',
    ])
  })

  it('tokens 排序缺 aux.tokenTotals → throw（接线 bug 可见，禁止兜底）', () => {
    expect(() => rankIdsByOrdering([{ id: 'a' }], 'tokens')).toThrow(/tokenTotals/)
  })
})

// ── 状态桶判定（session-status.ts）───────────────────────────────────────

describe('sessionStatusBucket（五桶判定）', () => {
  const SIGNALS = {
    needsInput: false,
    running: false,
    unread: false,
    draft: false,
  }

  it('优先级链 = hermes claim 链：needs-input > working > unread > draft > idle', () => {
    expect(sessionStatusBucket({ ...SIGNALS, needsInput: true, running: true, unread: true, draft: true })).toBe('needs-input')
    expect(sessionStatusBucket({ ...SIGNALS, running: true, unread: true, draft: true })).toBe('working')
    expect(sessionStatusBucket({ ...SIGNALS, unread: true, draft: true })).toBe('unread')
    expect(sessionStatusBucket({ ...SIGNALS, draft: true })).toBe('draft')
    expect(sessionStatusBucket(SIGNALS)).toBe('idle')
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

  it('status → 按状态桶分组：五桶 rank 定组序，非空桶才出组头', () => {
    const aux = {
      statusBuckets: new Map([
        ['a', 'working' as const],
        ['b', 'draft' as const],
        ['c', 'idle' as const],
        ['d', 'idle' as const],
      ]),
    }
    const out = buildSessionDisplay(METAS, [], {}, {}, {
      ...OPTS,
      view: { grouping: 'status', aux },
    })
    // 组序 = needs-input(无) → working(a) → unread(无) → draft(b) → idle(c,d)。
    expect(out.rows).toEqual([
      { key: 's:working', kind: 'divider', label: '运行中', variant: 'status' },
      { id: 'a', kind: 'session' },
      { key: 's:draft', kind: 'divider', label: '草稿', variant: 'status' },
      { id: 'b', kind: 'session' },
      { key: 's:idle', kind: 'divider', label: '空闲', variant: 'status' },
      { id: 'c', kind: 'session' },
      { id: 'd', kind: 'session' },
    ])
    expect(dividerCount(out.rows)).toBe(3)
  })

  it('status 分组的行缺状态桶 → throw（禁止兜底）', () => {
    expect(() =>
      buildSessionDisplay(METAS, [], {}, {}, {
        ...OPTS,
        view: { grouping: 'status', aux: { statusBuckets: new Map() } },
      }),
    ).toThrow(/statusBuckets/)
  })

  it('status 分组 × tokens 排序：组内保持词元数降序', () => {
    const aux = {
      statusBuckets: new Map([
        ['a', 'idle' as const],
        ['b', 'idle' as const],
        ['c', 'idle' as const],
        ['d', 'idle' as const],
      ]),
      tokenTotals: new Map([
        ['a', 10],
        ['b', 900],
        ['c', 100],
        ['d', 200],
      ]),
    }
    const out = buildSessionDisplay(METAS, [], {}, {}, {
      ...OPTS,
      view: { grouping: 'status', ordering: 'tokens', aux },
    })
    expect(sessionIds(out.rows)).toEqual(['b', 'd', 'c', 'a'])
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

  it('manual 组内手挑序：桶成员不变（recency 钉死），桶内按持久序', () => {
    const out = buildSessionDisplay(
      METAS,
      [],
      { d: 0, c: 1 },
      {},
      { ...OPTS, view: { ordering: 'manual' } },
    )
    expect(sessionIds(out.rows)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('date + created：桶成员不变，桶内创建时间降序', () => {
    // createdMs 与 recency 反序的行对（c/d 同桶）：created 键把 d 提到 c 前
    // （hermes rankBy created = -started_at），桶成员仍由 recency 钉死。
    const metas = [
      { ...METAS[0]!, createdMs: 100 },
      { ...METAS[1]!, createdMs: 400 },
      { ...METAS[2]!, createdMs: 300 },
      { ...METAS[3]!, createdMs: 500 },
    ]
    const out = buildSessionDisplay(
      metas,
      [],
      {},
      {},
      { ...OPTS, view: { ordering: 'created' } },
    )
    expect(dividerCount(out.rows)).toBeGreaterThanOrEqual(2)
    expect(sessionIds(out.rows)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('project 分组吃 status 排序序：组序由首行的状态 rank 决定', () => {
    const aux = {
      statusBuckets: new Map([
        ['c', 'working' as const],
        ['a', 'idle' as const],
        ['b', 'idle' as const],
        ['d', 'idle' as const],
      ]),
    }
    const metas: Parameters<typeof buildSessionDisplay>[0] = [
      { id: 'a', lastActiveMs: BASE, cwd: 'C:\\w\\alpha' },
      { id: 'b', lastActiveMs: BASE - HOUR, cwd: 'C:\\w\\beta' },
      { id: 'c', lastActiveMs: BASE - 2 * HOUR, cwd: 'C:\\w\\alpha' },
      { id: 'd', lastActiveMs: BASE - 3 * HOUR, cwd: 'C:\\w\\beta' },
    ]
    const out = buildSessionDisplay(metas, [], {}, {}, {
      view: { grouping: 'project', ordering: 'status', aux },
    })
    // status 全局序：c(working) → a,b,d(idle，tie 新近 a>b>d)；分组
    // partition 保序：a,c → alpha；b,d → beta。
    expect(out.allUnpinnedIds).toEqual(['c', 'a', 'b', 'd'])
    const ids = out.rows.map((r) => (r.kind === 'session' ? r.id : `|${r.key}`))
    expect(ids).toEqual([
      '|w:C:\\w\\alpha', 'c', 'a',
      '|w:C:\\w\\beta', 'b', 'd',
    ])
  })

  it('置顶恒最上：置顶行退出会话区进 pinnedIds，pinned 数组序即展示序', () => {
    const out = buildSessionDisplay(
      METAS,
      ['c', 'a'],
      {},
      {},
      { ...OPTS, view: { ordering: 'created' } },
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

  it('status 分组折叠：键 = s:<bucket>（组头保留、行隐藏）', () => {
    const aux = {
      statusBuckets: new Map([
        ['a', 'working' as const],
        ['b', 'draft' as const],
        ['c', 'idle' as const],
        ['d', 'idle' as const],
      ]),
    }
    const out = buildSessionDisplay(METAS, [], {}, {}, {
      ...OPTS,
      view: { grouping: 'status', aux },
    })
    const collapsedOut = buildSessionDisplay(METAS, [], {}, { 's:working': true, 's:draft': true }, {
      ...OPTS,
      view: { grouping: 'status', aux },
    })
    const ids = collapsedOut.rows.map((r) => (r.kind === 'session' ? r.id : `|${r.key}`))
    expect(ids).toEqual(['|s:working', '|s:draft', '|s:idle', 'c', 'd'])
    void out
  })
})

// ── 状态筛选纯函数（hermes Filters>Status：五桶多选，空 = 不过滤）────────

describe('filterByStatus（状态筛选）', () => {
  const ROWS = [
    { id: 'a', bucket: 'working' as const },
    { id: 'b', bucket: 'draft' as const },
    { id: 'c', bucket: 'idle' as const },
  ]

  it('空筛选原样放行（不过滤——hermes persistentAtom 初值 []）', () => {
    expect(filterByStatus(ROWS, [], (m) => m.bucket)).toEqual(ROWS)
  })

  it('单桶只留命中行', () => {
    expect(filterByStatus(ROWS, ['working'], (m) => m.bucket)).toEqual([{ id: 'a', bucket: 'working' }])
  })

  it('多桶并集（checkbox 多选）', () => {
    expect(filterByStatus(ROWS, ['draft', 'idle'], (m) => m.bucket)).toEqual([
      { id: 'b', bucket: 'draft' },
      { id: 'c', bucket: 'idle' },
    ])
  })

  it('无命中的桶 → 空面（UI 层 noFilterMatches 文案）', () => {
    expect(filterByStatus(ROWS, ['needs-input'], (m) => m.bucket)).toEqual([])
  })
})

// ── store 旋钮写通 ───────────────────────────────────────────────────────

describe('sidebarViewStore 旋钮', () => {
  beforeEach(resetStores)

  it('setGrouping / setDensity / setInboxStyle 写通 localStorage', () => {
    sidebarViewStore.getState().setGrouping('status')
    sidebarViewStore.getState().setDensity('compact')
    sidebarViewStore.getState().setInboxStyle(true)
    expect(localStorage.getItem('mirach.harness.sidebar.grouping.v1')).toBe('status')
    expect(localStorage.getItem('mirach.harness.sidebar.density.v1')).toBe('compact')
    expect(localStorage.getItem('mirach.harness.sidebar.inbox.v1')).toBe('true')
  })

  it('setOrdering 弃手动序 + 清保存的序号表（hermes setSidebarOrdering 逐语义）', () => {
    sessionManageStore.getState().setOrder({ a: 0, b: 1 })
    sidebarViewStore.getState().claimManual()
    sidebarViewStore.getState().setOrdering('status')
    expect(sidebarViewStore.getState().manual).toBe(false)
    expect(localStorage.getItem('mirach.harness.sidebar.manual.v1')).toBe('false')
    expect(sessionManageStore.getState().order).toEqual({})
    expect(localStorage.getItem(ORDER_KEY)).toBe('{}')
    expect(localStorage.getItem('mirach.harness.sidebar.ordering.v1')).toBe('status')
  })

  it('claimManual 声明手动序（幂等）并写通——菜单不再展示手动项但拖拽序生效', () => {
    sidebarViewStore.getState().claimManual()
    sidebarViewStore.getState().claimManual()
    expect(sidebarViewStore.getState().manual).toBe(true)
    expect(localStorage.getItem('mirach.harness.sidebar.manual.v1')).toBe('true')
    expect(effectiveOrdering(sidebarViewStore.getState())).toBe('manual')
  })

  it('resetView 回出厂 + 清手动序（不动折叠态——hermes resetSidebarView 面）', () => {
    sidebarViewStore.getState().setGrouping('status')
    sidebarViewStore.getState().setDensity('compact')
    sidebarViewStore.getState().claimManual()
    sidebarViewStore.getState().toggleStatusBucket('working')
    sessionManageStore.getState().setOrder({ a: 0 })
    sessionManageStore.getState().setGroupCollapsed('today', true)
    sidebarViewStore.getState().resetView()
    expect(sidebarViewStore.getState().grouping).toBe('date')
    expect(sidebarViewStore.getState().ordering).toBe('updated')
    expect(sidebarViewStore.getState().manual).toBe(false)
    expect(sidebarViewStore.getState().density).toBe('comfortable')
    expect(sidebarViewStore.getState().statusFilter).toEqual([])
    expect(localStorage.getItem('mirach.harness.sidebar.statusFilter.v1')).toBe('[]')
    expect(sessionManageStore.getState().order).toEqual({})
    expect(sessionManageStore.getState().groupsCollapsed).toEqual({ today: true })
  })

  it('effectiveOrdering：manual 压过排序键（hermes $sidebarOrdering 同构）', () => {
    expect(effectiveOrdering({ ordering: 'status', manual: false })).toBe('status')
    expect(effectiveOrdering({ ordering: 'status', manual: true })).toBe('manual')
  })

  it('toggleStatusBucket 五桶多选写通 + 持久化（hermes $sidebarStatusFilter 同款）', () => {
    sidebarViewStore.getState().toggleStatusBucket('working')
    sidebarViewStore.getState().toggleStatusBucket('unread')
    expect(sidebarViewStore.getState().statusFilter).toEqual(['working', 'unread'])
    expect(JSON.parse(localStorage.getItem('mirach.harness.sidebar.statusFilter.v1')!)).toEqual([
      'working', 'unread',
    ])
    // 再切 = 移出（checkbox 语义）。
    sidebarViewStore.getState().toggleStatusBucket('working')
    expect(sidebarViewStore.getState().statusFilter).toEqual(['unread'])
  })

  it('isSidebarViewCustomized：出厂 false，任一旋钮离开默认即 true', () => {
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(false)
    sidebarViewStore.getState().setGrouping('status')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().claimManual()
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().setDensity('compact')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
    resetStores()
    sidebarViewStore.getState().setOrdering('tokens')
    expect(isSidebarViewCustomized(sidebarViewStore.getState())).toBe(true)
  })
})

// SessionViewMode 类型仅作编译面消费（缺省 = date + updated 的出厂形态）。
const _viewTypeGuard: SessionViewMode = { grouping: 'date', ordering: 'updated' }
void _viewTypeGuard
