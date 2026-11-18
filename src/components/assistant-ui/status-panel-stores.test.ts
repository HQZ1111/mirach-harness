/**
 * 活动面板数据面单测：三个 store 的严格解析（parseChildEntries /
 * parseJobs / parseTodoList）+ sidecar 分派 + 终态判定。纯逻辑，无 IPC。
 *
 * 纪律：坏行 console.error 可见 + 跳过（不静默吞、不造缺省值）；
 * 整体非数组 → 空投影 + 错误可见。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentHubBridge, isSettled, parseChildEntries } from './agent-hub-store'
import { jobsBridge, parseJobs } from './jobs-store'
import { planEntriesBridge, parsePlanEntries } from './plan-entries-store'
import { gitBridge, parseGitDiffStat } from './git-store'
import { flatTasks, parseTodoList, todoBridge } from './todo-store'
import { dispatchToolDetails } from './tool-sidecar'
import {
  childToSubagentItem,
  childToTaskCardState,
  jobStages,
  toAuiTodoItems,
  toAuiTodoStatus,
} from './panel-adapters'
import { diffFilename, extractDiffText, parsePiDiff } from './diff-parse'
import { parsePlanSteps, planReviewState } from './plan-parse'
import { parsePendingAsks } from './ask-bridge'

const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

beforeEach(() => {
  vi.restoreAllMocks()
  agentHubBridge.setState({ children: [] })
  jobsBridge.setState({ jobs: [] })
  todoBridge.setState({ todo: null })
  gitBridge.setState({ stat: null })
  planEntriesBridge.setState({ entries: [] })
})

describe('isSettled（ChildStatus 终态，与 pi ChildStatus::settled 同语义）', () => {
  it('终态四值', () => {
    for (const s of ['done', 'failed', 'cancelled', 'killed'] as const) {
      expect(isSettled(s)).toBe(true)
    }
  })
  it('非终态（starting/running）', () => {
    expect(isSettled('starting')).toBe(false)
    expect(isSettled('running')).toBe(false)
  })
})

describe('parseChildEntries', () => {
  const good = {
    id: 'scout-1',
    name: 'scout',
    kind: 'subagent',
    task: '扫描仓库',
    pid: 123,
    status: 'running',
    startedMs: 1000,
    finishedMs: null,
    outputBytes: 42,
    transcriptPath: 'G:/t.jsonl',
    steerPath: 'G:/s',
    revivedFrom: null,
  }

  it('正常行逐字段解析', () => {
    const out = parseChildEntries([good])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'scout-1', kind: 'subagent', status: 'running' })
  })

  it('非数组 → [] + 错误可见', () => {
    const spy = silenceErrors()
    expect(parseChildEntries({ nope: true })).toEqual([])
    expect(spy).toHaveBeenCalled()
  })

  it('字段缺失行 → 跳过，好行保留', () => {
    const spy = silenceErrors()
    const out = parseChildEntries([good, { id: 'x' }])
    expect(out).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
  })

  it('未知 kind/status → 跳过', () => {
    silenceErrors()
    expect(parseChildEntries([{ ...good, kind: 'bogus' }])).toEqual([])
    expect(parseChildEntries([{ ...good, status: 'weird' }])).toEqual([])
  })
})

describe('parseJobs（rpi-background-tasks 快照行）', () => {
  const good = {
    schema: 'rpi.background-tasks.v1',
    id: 'job-1',
    kind: 'bash',
    label: 'dev server',
    command: 'npm test',
    status: 'running',
    startedAtMs: 1000,
    finishedAtMs: null,
    exitCode: null,
    pid: 99,
  }

  it('正常行解析（含 label/kind）', () => {
    const out = parseJobs([good])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'job-1',
      status: 'running',
      label: 'dev server',
      kind: 'bash',
      startedAtMs: 1000,
    })
  })

  it('插件词表五态直映，未知 status 跳过', () => {
    for (const status of ['running', 'completed', 'failed', 'interrupted', 'cancelled']) {
      expect(parseJobs([{ ...good, status }])[0]!.status).toBe(status)
    }
    silenceErrors()
    expect(parseJobs([{ ...good, status: 'zombie' }])).toEqual([])
  })

  it('可选项缺席留 null（不补 0）', () => {
    const out = parseJobs([
      {
        schema: 'rpi.background-tasks.v1',
        id: 'j2',
        command: 'sleep 60',
        status: 'running',
        startedAtMs: 5,
      },
    ])
    expect(out[0]).toMatchObject({
      kind: null,
      label: null,
      finishedAtMs: null,
      exitCode: null,
      pid: null,
    })
  })

  it('非数组 → [] + 错误可见', () => {
    const spy = silenceErrors()
    expect(parseJobs('nope')).toEqual([])
    expect(spy).toHaveBeenCalled()
  })

  it('缺 startedAtMs 行 → 跳过，好行保留', () => {
    silenceErrors()
    expect(parseJobs([good, { schema: 'rpi.background-tasks.v1', id: 'x', status: 'running' }])).toHaveLength(1)
  })
})

describe('parseTodoList（pi todo_list.v1 details.list）', () => {
  it('扁平任务（开放中）', () => {
    const proj = parseTodoList({
      phases: [{ tasks: [{ content: '写文档', state: 'in_progress' }] }],
    })
    expect(proj).not.toBeNull()
    expect(flatTasks(proj!)).toEqual([
      { content: '写文档', status: 'in_progress' },
    ])
  })

  it('blocked 带 reason', () => {
    const proj = parseTodoList({
      phases: [{ tasks: [{ content: '跑测试', state: 'blocked', reason: '缺凭据' }] }],
    })
    const [t] = flatTasks(proj!)
    expect(t).toEqual({ content: '跑测试', status: 'blocked', reason: '缺凭据' })
  })

  it('blocked 缺 reason → 跳过该任务（上游形状要求）', () => {
    silenceErrors()
    const proj = parseTodoList({
      phases: [{ tasks: [{ content: 'x', state: 'blocked' }] }],
    })
    expect(flatTasks(proj!)).toEqual([])
  })

  it('未知 state → 跳过', () => {
    silenceErrors()
    const proj = parseTodoList({
      phases: [{ tasks: [{ content: 'x', state: 'bogus' }] }],
    })
    expect(flatTasks(proj!)).toEqual([])
  })

  it('phases 非数组 → null + 错误可见', () => {
    const spy = silenceErrors()
    expect(parseTodoList({ phases: 5 })).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('命名 phase 保留 name', () => {
    const proj = parseTodoList({
      phases: [{ name: '阶段一', tasks: [{ content: 'a', state: 'open' }] }],
    })
    expect(proj!.phases[0]!.name).toBe('阶段一')
  })
})

describe('parsePlanEntries（pi_plan_entries 裸数组）', () => {
  const good = { entryId: 'e-1', seq: 3, timestamp: 1000, plan: '# 计划\n内容' }

  it('正常行逐字段解析', () => {
    const out = parsePlanEntries([good])
    expect(out).toEqual([good])
  })

  it('非数组 → [] + 错误可见', () => {
    const spy = silenceErrors()
    expect(parsePlanEntries({ nope: true })).toEqual([])
    expect(spy).toHaveBeenCalled()
  })

  it('字段缺失 / 空文本行 → 跳过，好行保留', () => {
    const spy = silenceErrors()
    expect(parsePlanEntries([good, { entryId: 'x' }])).toHaveLength(1)
    expect(parsePlanEntries([good, { ...good, entryId: 'e-2', plan: '   ' }])).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
  })
})

describe('dispatchToolDetails（CUSTOM tool_execution → store 分派）', () => {
  it('todo_list.v1 → todoBridge', () => {
    const consumed = dispatchToolDetails('tool_execution', {
      phase: 'end',
      result: {
        details: {
          schema: 'todo_list.v1',
          list: { phases: [{ tasks: [{ content: 'a', state: 'open' }] }] },
          summary: '0/1',
        },
      },
    })
    expect(consumed).toBe(true)
    expect(flatTasks(todoBridge.getState().todo!)).toHaveLength(1)
    expect(todoBridge.getState().todo!.summary).toBe('0/1')
  })

  it('roster schema → agentHubBridge', () => {
    const consumed = dispatchToolDetails('tool_execution', {
      phase: 'end',
      result: {
        details: {
          schema: 'pi.agent-hub.roster/v1',
          children: [
            {
              id: 'a-1', name: 'a', kind: 'subagent', task: 't', pid: null,
              status: 'running', startedMs: 1, finishedMs: null, outputBytes: 0,
              transcriptPath: 'p', steerPath: 's', revivedFrom: null,
            },
          ],
        },
      },
    })
    expect(consumed).toBe(true)
    expect(agentHubBridge.getState().children).toHaveLength(1)
  })

  it('pi.bash_job.v1 → jobsBridge（update 相位取 partial）', () => {
    const consumed = dispatchToolDetails('tool_execution', {
      phase: 'update',
      partial: {
        details: {
          schema: 'pi.bash_job.v1', id: 'j-1', command: 'ls', startedAtMs: 1,
          status: 'running', exitCode: null, pid: 2, artifactPath: 'p',
          artifactTruncated: false, artifactError: null, outputTail: '', outputComplete: false,
        },
      },
    })
    expect(consumed).toBe(true)
    expect(jobsBridge.getState().jobs).toHaveLength(1)
  })

  it('未知 schema / 无 details / 非 tool_execution → 不消费（非错误）', () => {
    const spy = silenceErrors()
    expect(dispatchToolDetails('tool_execution', { phase: 'end', result: { details: { schema: 'planReview' } } })).toBe(false)
    expect(dispatchToolDetails('tool_execution', { phase: 'start' })).toBe(false)
    expect(dispatchToolDetails('compaction', {})).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('parseGitDiffStat（fs_git_diff_stat）', () => {
  it('正常行解析（含 branch）', () => {
    const out = parseGitDiffStat({
      isRepository: true,
      root: 'G:/x',
      branch: 'main',
      added: 13,
      removed: 2,
      changedFiles: 2,
    })
    expect(out).toEqual({
      isRepository: true,
      root: 'G:/x',
      branch: 'main',
      added: 13,
      removed: 2,
      changedFiles: 2,
    })
  })

  it('非仓库（branch null）解析', () => {
    const out = parseGitDiffStat({
      isRepository: false,
      root: '',
      branch: null,
      added: 0,
      removed: 0,
      changedFiles: 0,
    })
    expect(out?.isRepository).toBe(false)
    expect(out?.branch).toBeNull()
  })

  it('字段缺失/非法 → null + 错误可见', () => {
    const spy = silenceErrors()
    expect(parseGitDiffStat({ isRepository: true })).toBeNull()
    expect(parseGitDiffStat('nope')).toBeNull()
    expect(spy).toHaveBeenCalled()
  })

  it('refresh(null/空) → 清投影不报错', async () => {
    gitBridge.setState({
      stat: { isRepository: true, root: 'r', branch: null, added: 1, removed: 0, changedFiles: 1 },
    })
    await gitBridge.getState().refresh(null)
    expect(gitBridge.getState().stat).toBeNull()
    await gitBridge.getState().refresh('   ')
    expect(gitBridge.getState().stat).toBeNull()
  })
})

describe('panel-adapters（pi 形状 → 官方 elements 形状）', () => {
  it('toAuiTodoStatus：open/in_progress/done 直映', () => {
    expect(toAuiTodoStatus({ content: 'a', status: 'open' }).status).toBe('pending')
    expect(toAuiTodoStatus({ content: 'a', status: 'in_progress' }).status).toBe('active')
    expect(toAuiTodoStatus({ content: 'a', status: 'done' }).status).toBe('done')
  })

  it('toAuiTodoStatus：dropped → done + 「已删除」（不静默当完成）', () => {
    expect(toAuiTodoStatus({ content: 'a', status: 'dropped' })).toEqual({
      status: 'done',
      reason: '已删除',
    })
  })

  it('toAuiTodoStatus：blocked → failed + reason', () => {
    expect(toAuiTodoStatus({ content: 'a', status: 'blocked', reason: '缺凭据' })).toEqual({
      status: 'failed',
      reason: '缺凭据',
    })
  })

  it('toAuiTodoItems：id 用序号、reason 只在有值时出现', () => {
    const out = toAuiTodoItems([
      { content: '甲', status: 'open' },
      { content: '乙', status: 'blocked', reason: 'x' },
    ])
    expect(out).toEqual([
      { id: '0', text: '甲', status: 'pending' },
      { id: '1', text: '乙', status: 'failed', reason: 'x' },
    ])
  })

  it('childToTaskCardState：六态全覆盖', () => {
    expect(childToTaskCardState('starting')).toBe('working')
    expect(childToTaskCardState('running')).toBe('working')
    expect(childToTaskCardState('done')).toBe('done')
    expect(childToTaskCardState('failed')).toBe('failed')
    expect(childToTaskCardState('cancelled')).toBe('cancelled')
    expect(childToTaskCardState('killed')).toBe('cancelled')
  })

  it('childToSubagentItem：model 位用真实 kind（不编造模型名）', () => {
    const c = {
      id: 's-1', name: 'scout', kind: 'subagent' as const, task: 't', pid: null,
      status: 'running' as const, startedMs: 1, finishedMs: null, outputBytes: 0,
      transcriptPath: 'p', steerPath: 's', revivedFrom: null,
    }
    expect(childToSubagentItem(c)).toEqual({ name: 'scout', model: 'subagent' })
  })

  it('jobStages：bash job 无阶段 → null（不硬塞阶段进度条）', () => {
    const j = {
      schema: 'rpi.background-tasks.v1', id: 'j', kind: 'bash', label: null,
      command: 'ls', startedAtMs: 1, finishedAtMs: null,
      status: 'running' as const, exitCode: null, pid: 1,
    }
    expect(jobStages(j)).toBeNull()
  })
})

describe('parsePiDiff（edit/hashline_edit 的 details.diff）', () => {
  // pi generate_diff_string 的真实形状：'+{新行号} 文本' / '-{旧行号} 文本'
  // / ' {行号} 文本' / '   ...'
  const SAMPLE = [
    '  1 const a = 1',
    '+2 const b = 2',
    '-2 const c = 3',
    '  3 return a',
    '   ...',
  ].join('\n')

  it('分类：context / added / removed，计数正确', () => {
    const d = parsePiDiff(SAMPLE)!
    expect(d.additions).toBe(1)
    expect(d.deletions).toBe(1)
    expect(d.lines.map((l) => l.kind)).toEqual(['context', 'added', 'removed', 'context'])
    expect(d.lines[1]!.text).toBe('const b = 2')
  })

  it('skip marker（...）不入 lines', () => {
    const d = parsePiDiff(SAMPLE)!
    expect(d.lines.some((l) => l.text.includes('...'))).toBe(false)
  })

  it('保留行内前导空格（只剥行号）', () => {
    const d = parsePiDiff('+10     indented')!
    expect(d.lines[0]!.text).toBe('    indented')
  })

  it('空输入 / 无有效行 → null', () => {
    expect(parsePiDiff('')).toBeNull()
    expect(parsePiDiff('garbage')).toBeNull()
  })
})

describe('extractDiffText / diffFilename', () => {
  it('从 result.details.diff 取字符串', () => {
    expect(extractDiffText({ details: { diff: '+1 x' } })).toBe('+1 x')
  })
  it('无 details / 非字符串 → null', () => {
    expect(extractDiffText({})).toBeNull()
    expect(extractDiffText(null)).toBeNull()
    expect(extractDiffText({ details: { diff: 42 } })).toBeNull()
  })
  it('文件名取 args.path，缺省 "?"', () => {
    expect(diffFilename({ path: 'a.ts' })).toBe('a.ts')
    expect(diffFilename({})).toBe('?')
    expect(diffFilename(null)).toBe('?')
  })
})

describe('parsePlanSteps（submit_plan 自由文本 → 步骤）', () => {
  it('数字编号列表', () => {
    const p = parsePlanSteps('目标：修 bug\n1. 读代码\n2. 改代码\n3. 跑测试')!
    expect(p.steps).toEqual(['读代码', '改代码', '跑测试'])
  })

  it('符号列表（- / * / •）', () => {
    const p = parsePlanSteps('- 甲\n* 乙\n• 丙')!
    expect(p.steps).toEqual(['甲', '乙', '丙'])
  })

  it('"Steps:" 段落内的缩进行', () => {
    const p = parsePlanSteps('Goal: x\nSteps:\n    第一步\n    第二步')!
    expect(p.steps).toEqual(['第一步', '第二步'])
  })

  it('去重保序', () => {
    const p = parsePlanSteps('1. a\n2. b\n3. a')!
    expect(p.steps).toEqual(['a', 'b'])
  })

  it('无可提取步骤 → null（不假装有计划）', () => {
    expect(parsePlanSteps('一段没有列表的散文。')).toBeNull()
    expect(parsePlanSteps('')).toBeNull()
    expect(parsePlanSteps(undefined)).toBeNull()
  })
})

describe('planReviewState', () => {
  it('pending / auto_approved', () => {
    expect(planReviewState({ details: { planReview: 'pending' } })).toBe('pending')
    expect(planReviewState({ details: { planReview: 'auto_approved' } })).toBe('auto_approved')
  })
  it('缺失/未知 → null', () => {
    expect(planReviewState({})).toBeNull()
    expect(planReviewState({ details: { planReview: 'weird' } })).toBeNull()
  })
})

describe('parsePendingAsks（pi_ask_pending）', () => {
  const good = {
    id: 'ask-1',
    request: {
      questions: [
        { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }], multi: false },
      ],
    },
  }

  it('正常行解析', () => {
    const out = parsePendingAsks([good])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('ask-1')
    expect(out[0]!.request.questions[0]!.options).toHaveLength(2)
  })

  it('非数组 / 缺字段 → 丢弃 + 错误可见', () => {
    const spy = silenceErrors()
    expect(parsePendingAsks('x')).toEqual([])
    expect(parsePendingAsks([{ id: 'x' }])).toEqual([])
    expect(spy).toHaveBeenCalled()
  })
})
