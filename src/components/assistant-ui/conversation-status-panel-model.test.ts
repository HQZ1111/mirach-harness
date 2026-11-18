/**
 * 活动状态面板模型单测（ZCode conversationStatusPanelModel 的宿主适配）。
 *
 * 锁住 2026-11-17「完整移植」轮的推导规则：
 * - goal-state 严格解析（未知 status 丢弃，不猜 active）；
 * - 用时口径（active 走 now / paused+complete 停 updatedAt）；
 * - 会话计划标题（首 H1 → 首个非空行）与 seq 降序；
 * - git 干净仓库不挂卡；hasContent 只认活内容（已结束目录不单独开门）；
 * - Todo 紧凑窗口（>6 条回补成三条）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildConversationGoalIterationSummaries,
  buildStatusPanelModel,
  getPlanDirectoryTitle,
  getStatusPanelTodoFocusWindow,
  goalElapsedSeconds,
  parseGoalState,
  type StatusPanelInput,
} from './conversation-status-panel-model'

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

function baseInput(overrides: Partial<StatusPanelInput> = {}): StatusPanelInput {
  return {
    todoTasks: [],
    git: null,
    goalRaw: null,
    planEntries: [],
    jobs: [],
    runningAgents: [],
    endedAgentCount: 0,
    runningWorkflows: [],
    endedWorkflowCount: 0,
    ...overrides,
  }
}

describe('parseGoalState（rpi-goal goal-state 条目）', () => {
  const good = {
    active: {
      title: '  发布 v1  ',
      status: 'active',
      notes: '主线',
      startedAt: 1000,
      updatedAt: 2000,
      turnsUsed: 3,
      maxTurns: 10,
      deadlineMs: 60000,
    },
    archived: [],
  }

  it('正常目标逐字段解析（标题去首尾空白）', () => {
    expect(parseGoalState(good)).toEqual({
      title: '发布 v1',
      status: 'active',
      notes: '主线',
      startedAt: 1000,
      updatedAt: 2000,
      turnsUsed: 3,
      maxTurns: 10,
      deadlineMs: 60000,
      iterations: [],
      verifications: [],
      verifying: null,
    })
  })

  it('无 active / null / undefined → null（无目标不是错误）', () => {
    const spy = silenceErrors()
    expect(parseGoalState(null)).toBeNull()
    expect(parseGoalState(undefined)).toBeNull()
    expect(parseGoalState({ active: null })).toBeNull()
    expect(parseGoalState({ archived: [] })).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('标题缺失/空 → null + 错误可见', () => {
    const spy = silenceErrors()
    expect(parseGoalState({ active: { status: 'active' } })).toBeNull()
    expect(parseGoalState({ active: { title: '   ', status: 'active' } })).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('未知 status → null + 错误可见（不猜成 active）', () => {
    const spy = silenceErrors()
    expect(parseGoalState({ active: { title: 'x', status: 'exploded' } })).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('complete → verified；ZCode 校验器态原样接受（真到场就真渲染）', () => {
    expect(
      parseGoalState({ active: { title: 'x', status: 'complete' } })?.status,
    ).toBe('verified')
    expect(
      parseGoalState({ active: { title: 'x', status: 'verifying' } })?.status,
    ).toBe('verifying')
    expect(
      parseGoalState({ active: { title: 'x', status: 'notSatisfied' } })?.status,
    ).toBe('notSatisfied')
  })

  it('可选字段缺席 → 零值/null（不造假 0 秒起算）', () => {
    const goal = parseGoalState({ active: { title: 'x', status: 'paused' } })
    expect(goal).toEqual({
      title: 'x',
      status: 'paused',
      notes: '',
      startedAt: null,
      updatedAt: null,
      turnsUsed: 0,
      maxTurns: null,
      deadlineMs: null,
      iterations: [],
      verifications: [],
      verifying: null,
    })
  })

  it('verifying：在途校验解析（坏形状 → null + 错误可见）', () => {
    const spy = silenceErrors()
    const goal = parseGoalState({
      active: { title: 'x', status: 'active', verifying: { iteration: 4, startedAt: 99 } },
    })
    expect(goal?.verifying).toEqual({ iteration: 4, startedAt: 99 })

    expect(
      parseGoalState({ active: { title: 'x', status: 'active', verifying: { iteration: 0 } } })
        ?.verifying,
    ).toBeNull()
    expect(
      parseGoalState({ active: { title: 'x', status: 'active', verifying: 'yes' } })?.verifying,
    ).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('iterations：逐行解析 + 单行损坏只丢该行（错误可见）', () => {
    const spy = silenceErrors()
    const goal = parseGoalState({
      active: {
        title: 'x',
        status: 'active',
        iterations: [
          {
            iteration: 1,
            updatedAt: 10,
            items: [
              { id: 't1', content: '读仓库', status: 'completed' },
              { id: 't2', content: '改代码', status: 'inProgress' },
            ],
          },
          { iteration: 'nope', items: [] },
          { iteration: 3, items: [{ content: '', status: 'pending' }] },
        ],
      },
    })
    expect(goal?.iterations).toHaveLength(2)
    expect(goal?.iterations[0]).toMatchObject({
      iteration: 1,
      updatedAt: 10,
      items: [
        { id: 't1', content: '读仓库', status: 'completed' },
        { id: 't2', content: '改代码', status: 'inProgress' },
      ],
    })
    expect(goal?.iterations[1]).toMatchObject({ iteration: 3, items: [] })
    expect(spy).toHaveBeenCalled()
  })
})

describe('buildConversationGoalIterationSummaries（上游逐条照抄）', () => {
  const goal = (over: Partial<Parameters<typeof buildConversationGoalIterationSummaries>[0]> = {}) => ({
    title: '发布 v1',
    status: 'active' as const,
    notes: '',
    startedAt: null,
    updatedAt: null,
    turnsUsed: 2,
    maxTurns: null,
    deadlineMs: null,
    iterations: [],
    verifications: [],
    verifying: null,
    ...over,
  })

  it('无迭代快照 → 一行（首轮标题 = 目标标题，items 空）', () => {
    const rows = buildConversationGoalIterationSummaries(goal())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      iteration: 1,
      title: '发布 v1',
      totalCount: 0,
      completedCount: 0,
      completed: false,
      verificationOutcome: null,
    })
  })

  it('三轮快照 → 三行；完成轮回标题 = 上轮 nextAction；计数如实', () => {
    const rows = buildConversationGoalIterationSummaries(
      goal({
        iterations: [
          { iteration: 1, updatedAt: 1, items: [
            { id: 't1', content: 'a', status: 'completed' },
            { id: 't2', content: 'b', status: 'completed' },
          ] },
          { iteration: 2, updatedAt: 2, items: [
            { id: 't3', content: 'c', status: 'pending' },
          ] },
        ],
        verifications: [
          { iteration: 1, outcome: 'pass', at: 1, reason: '全部完成', nextAction: '继续发布 v2' },
        ],
      }),
    )
    expect(rows).toHaveLength(2)
    const first = rows.find((row) => row.iteration === 1)!
    expect(first.completed).toBe(true)
    expect(first.completedCount).toBe(2)
    expect(first.verificationOutcome).toBe('pass')
    expect(first.verificationReason).toBe('全部完成')
    const second = rows.find((row) => row.iteration === 2)!
    expect(second.title).toBe('继续发布 v2')
    expect(second.completed).toBe(false)
  })

  it('内部兜底 nextAction 不显示（上游 visibleNextAction 同判）', () => {
    const rows = buildConversationGoalIterationSummaries(
      goal({
        iterations: [{ iteration: 2, updatedAt: 2, items: [] }],
        verifications: [
          {
            iteration: 1,
            outcome: 'notSatisfied',
            at: 1,
            nextAction: 'Continue verifying and completing the goal.',
          },
        ],
      }),
    )
    expect(rows.find((row) => row.iteration === 2)!.title).toBeNull()
  })

  it('完成的行排在前面（上游 sort 同判）', () => {
    const rows = buildConversationGoalIterationSummaries(
      goal({
        iterations: [
          { iteration: 1, updatedAt: 1, items: [{ id: 'a', content: 'a', status: 'pending' }] },
          { iteration: 2, updatedAt: 2, items: [{ id: 'b', content: 'b', status: 'completed' }] },
        ],
      }),
    )
    expect(rows.map((row) => row.iteration)).toEqual([2, 1])
  })
})

describe('goalElapsedSeconds（目标用时）', () => {
  const goal = (over: Partial<Parameters<typeof goalElapsedSeconds>[0]> = {}) => ({
    title: 'x',
    status: 'active' as const,
    notes: '',
    startedAt: 1000,
    updatedAt: 5000,
    turnsUsed: 0,
    maxTurns: null,
    deadlineMs: null,
    iterations: [],
    verifications: [],
    verifying: null,
    ...over,
  })

  it('active → now - startedAt', () => {
    expect(goalElapsedSeconds(goal(), 10_000)).toBe(9)
  })

  it('paused → 停在 updatedAt（now 不参与）', () => {
    expect(goalElapsedSeconds(goal({ status: 'paused' }), 999_000)).toBe(4)
  })

  it('verified（插件 complete）→ 停在 updatedAt', () => {
    expect(goalElapsedSeconds(goal({ status: 'verified' }), 999_000)).toBe(4)
  })

  it('verifying / notSatisfied 与 active 同走 now（校验器面也计入在跑）', () => {
    expect(goalElapsedSeconds(goal({ status: 'verifying' }), 10_000)).toBe(9)
    expect(goalElapsedSeconds(goal({ status: 'notSatisfied' }), 10_000)).toBe(9)
  })

  it('paused 无 updatedAt → 落在 startedAt（0 秒，不拿 now 假装在跑）', () => {
    expect(goalElapsedSeconds(goal({ status: 'paused', updatedAt: null }), 999_000)).toBe(0)
  })

  it('startedAt 缺席 → null；负值钳到 0', () => {
    expect(goalElapsedSeconds(goal({ startedAt: null }), 10_000)).toBeNull()
    expect(goalElapsedSeconds(goal({ startedAt: 9000 }), 1000)).toBe(0)
  })
})

describe('getPlanDirectoryTitle（上游逐字照抄）', () => {
  it('首个 H1 优先', () => {
    expect(getPlanDirectoryTitle('前言\n# 迁移计划\n正文')).toBe('迁移计划')
  })

  it('无 H1 → 首个非空行（剥列表/引用/标题装饰）', () => {
    expect(getPlanDirectoryTitle('## 二级标题\n正文')).toBe('二级标题')
    expect(getPlanDirectoryTitle('\n\n> 引用标题\n正文')).toBe('引用标题')
    expect(getPlanDirectoryTitle('- 列表项\n正文')).toBe('列表项')
  })

  it('空文本 → undefined（不造空标题）', () => {
    expect(getPlanDirectoryTitle('')).toBeUndefined()
    expect(getPlanDirectoryTitle('   \n\n\t')).toBeUndefined()
  })
})

describe('buildStatusPanelModel', () => {
  it('全空输入 → 无内容（面板不渲染）', () => {
    const model = buildStatusPanelModel(baseInput())
    expect(model).toMatchObject({
      git: null,
      goal: null,
      sessionPlans: null,
      plan: null,
      runningJobs: [],
      runningAgents: [],
      endedAgentCount: 0,
      runningWorkflows: [],
      endedWorkflowCount: 0,
      hasContent: false,
    })
  })

  it('git：非仓库 / 干净仓库不挂卡；有变更才进模型', () => {
    const repo = { isRepository: true, branch: 'main', added: 0, removed: 0, changedFiles: 0 }
    expect(buildStatusPanelModel(baseInput({ git: repo })).git).toBeNull()
    expect(
      buildStatusPanelModel(baseInput({ git: { ...repo, isRepository: false } })).git,
    ).toBeNull()
    expect(
      buildStatusPanelModel(baseInput({ git: { ...repo, added: 3, removed: 1, changedFiles: 2 } })),
    ).toMatchObject({ git: { branchName: 'main', dirtyFileCount: 2, added: 3, removed: 1 }, hasContent: true })
  })

  it('plan：任务状态映射 + 计数，displayItems 与 items 同引用', () => {
    const model = buildStatusPanelModel(
      baseInput({
        todoTasks: [
          { content: 'a', status: 'done' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'open' },
          { content: 'd', status: 'blocked' },
        ],
      }),
    )
    expect(model.plan!.items.map((i) => i.status)).toEqual([
      'completed',
      'inProgress',
      'pending',
      'pending',
    ])
    expect(model.plan!.completedCount).toBe(1)
    expect(model.plan!.waitingCount).toBe(3)
    expect(model.plan!.totalCount).toBe(4)
    expect(model.plan!.displayItems).toBe(model.plan!.items)
  })

  it('sessionPlans：seq 降序 + 标题从 markdown 提取', () => {
    const model = buildStatusPanelModel(
      baseInput({
        planEntries: [
          { entryId: 'e1', seq: 1, timestamp: 100, plan: '# 旧计划\n内容' },
          { entryId: 'e2', seq: 2, timestamp: 200, plan: '新计划正文' },
        ],
      }),
    )
    expect(model.sessionPlans!.items.map((i) => i.entryId)).toEqual(['e2', 'e1'])
    expect(model.sessionPlans!.items[0]).toMatchObject({ title: '新计划正文', markdown: '新计划正文' })
    expect(model.sessionPlans!.items[1]).toMatchObject({ title: '旧计划' })
  })

  it('jobs：命令行 → 标题；cancellable 缺省 true、显式 false 保留', () => {
    const model = buildStatusPanelModel(
      baseInput({
        jobs: [
          { id: 'j1', command: 'npm test', startedAtMs: 1000 },
          { id: 'j2', command: 'npm run build', startedAtMs: 2000, cancellable: false },
        ],
      }),
    )
    expect(model.runningJobs).toEqual([
      { workId: 'j1', title: 'npm test', startedAt: 1000, cancellable: true },
      { workId: 'j2', title: 'npm run build', startedAt: 2000, cancellable: false },
    ])
    expect(model.hasContent).toBe(true)
  })

  it('已结束智能体计数不单独开门（hasContent 仍 false，上游同判）', () => {
    const model = buildStatusPanelModel(baseInput({ endedAgentCount: 5 }))
    expect(model.endedAgentCount).toBe(5)
    expect(model.hasContent).toBe(false)
  })

  it('运行中智能体 → hasContent true', () => {
    const model = buildStatusPanelModel(
      baseInput({ runningAgents: [{ id: 'a1', title: '扫描仓库', startedAt: 1000 }] }),
    )
    expect(model.runningAgents).toHaveLength(1)
    expect(model.hasContent).toBe(true)
  })

  it('工作流：运行中才开门；已结束计数不单独开门（上游同判）', () => {
    const run = {
      runId: 'r1',
      toolCallId: 'c1',
      title: '读取仓库',
      status: 'running' as const,
      nodesSettled: 1,
      nodesTotal: 2,
      startedAt: 1000,
      completedAt: null,
      nodes: [],
    }
    const active = buildStatusPanelModel(baseInput({ runningWorkflows: [run] }))
    expect(active.runningWorkflows).toHaveLength(1)
    expect(active.hasContent).toBe(true)

    const endedOnly = buildStatusPanelModel(baseInput({ endedWorkflowCount: 3 }))
    expect(endedOnly.endedWorkflowCount).toBe(3)
    expect(endedOnly.hasContent).toBe(false)
  })
})

describe('getStatusPanelTodoFocusWindow（上游逐条照抄）', () => {
  const item = (content: string, status: 'pending' | 'inProgress' | 'completed') => ({
    id: content,
    content,
    status,
  })

  it('≤6 条 → 不压缩，focus = 全量', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`t${i}`, 'pending'))
    const w = getStatusPanelTodoFocusWindow(items)
    expect(w.compact).toBe(false)
    expect(w.focusItems).toBe(items)
  })

  it('>6 条：inProgress 居中成三条窗口', () => {
    const items = [
      item('a', 'completed'),
      item('b', 'completed'),
      item('c', 'pending'),
      item('d', 'pending'),
      item('e', 'pending'),
      item('f', 'inProgress'),
      item('g', 'pending'),
      item('h', 'pending'),
    ]
    const w = getStatusPanelTodoFocusWindow(items)
    expect(w.compact).toBe(true)
    expect(w.focusItems.map((i) => i.content)).toEqual(['f', 'g', 'h'])
    expect(w.precedingItems.map((i) => i.content)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(w.followingItems).toEqual([])
  })

  it('>6 条：无 inProgress → 首个未完成项起窗', () => {
    const items = [
      item('a', 'completed'),
      item('b', 'completed'),
      item('c', 'pending'),
      item('d', 'pending'),
      item('e', 'pending'),
      item('f', 'pending'),
      item('g', 'pending'),
    ]
    const w = getStatusPanelTodoFocusWindow(items)
    expect(w.focusItems.map((i) => i.content)).toEqual(['c', 'd', 'e'])
    expect(w.followingItems.map((i) => i.content)).toEqual(['f', 'g'])
  })

  it('>6 条且全完成 → 收尾三条', () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`t${i}`, 'completed'))
    const w = getStatusPanelTodoFocusWindow(items)
    expect(w.focusItems.map((i) => i.content)).toEqual(['t5', 't6', 't7'])
  })

  it('窗口贴近尾部时向前回补（始终三条）', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item(`t${i}`, i === 6 ? 'inProgress' : 'pending'),
    )
    const w = getStatusPanelTodoFocusWindow(items)
    expect(w.focusItems.map((i) => i.content)).toEqual(['t4', 't5', 't6'])
  })
})
