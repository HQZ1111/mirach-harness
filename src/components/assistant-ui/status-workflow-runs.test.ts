import { describe, expect, it, vi } from 'vitest'
import { deriveWorkflowRuns, workflowRunWords } from './status-workflow-runs'

type Call = {
  toolName: 'plan' | 'dispatch'
  toolCallId: string
  args?: Record<string, unknown>
  result?: unknown
  startedAt?: number
  completedAt?: number
}

function message(calls: Call[]): unknown {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'tool-call',
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      args: call.args ?? {},
      result: call.result,
      timing: {
        ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
        ...(call.completedAt !== undefined ? { completedAt: call.completedAt } : {}),
      },
    })),
  }
}

function graph(...nodes: Array<{ id: string; task: string; status: string }>): unknown {
  return {
    content: [{ type: 'text', text: 'dispatched 2 node(s)' }],
    details: { nodes: nodes.map((node) => ({ ...node, deps: [] })) },
  }
}

describe('deriveWorkflowRuns', () => {
  it('a successful plan set opens a pending run with the input graph', () => {
    const { running, ended } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: {
            action: 'set',
            nodes: [
              { id: 'a', task: '读取仓库', deps: [] },
              { id: 'b', task: '改代码', deps: ['a'] },
            ],
          },
          startedAt: 100,
          completedAt: 200,
        },
      ]),
    ])
    expect(ended).toHaveLength(0)
    expect(running).toHaveLength(1)
    expect(running[0]!.status).toBe('pending')
    expect(running[0]!.title).toBe('读取仓库')
    expect(running[0]!.nodesTotal).toBe(2)
    expect(running[0]!.nodesSettled).toBe(0)
    expect(workflowRunWords(running[0]!)).toEqual({ kind: 'status', status: 'pending' })
  })

  it('a dispatch wave keeps the run running and counts settled nodes', () => {
    const { running } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: { action: 'set', nodes: [{ id: 'a', task: 't1' }, { id: 'b', task: 't2' }] },
          startedAt: 100,
          completedAt: 200,
        },
        {
          toolName: 'dispatch',
          toolCallId: 'c2',
          args: { maxParallel: 4 },
          result: graph(
            { id: 'a', task: 't1', status: 'done' },
            { id: 'b', task: 't2', status: 'running' },
          ),
          startedAt: 300,
          completedAt: 400,
        },
      ]),
    ])
    expect(running).toHaveLength(1)
    expect(running[0]!.status).toBe('running')
    expect(running[0]!.nodesSettled).toBe(1)
    expect(running[0]!.nodesTotal).toBe(2)
    expect(workflowRunWords(running[0]!)).toEqual({ kind: 'steps', done: 1, total: 2 })
  })

  it('an all-settled graph moves the run into the ended list', () => {
    const { running, ended } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: { action: 'set', nodes: [{ id: 'a', task: 't1' }, { id: 'b', task: 't2' }] },
          startedAt: 100,
          completedAt: 200,
        },
        {
          toolName: 'dispatch',
          toolCallId: 'c2',
          args: {},
          result: graph(
            { id: 'a', task: 't1', status: 'done' },
            { id: 'b', task: 't2', status: 'skipped' },
          ),
          startedAt: 300,
          completedAt: 400,
        },
      ]),
    ])
    expect(running).toHaveLength(0)
    expect(ended).toHaveLength(1)
    expect(ended[0]!.status).toBe('completed')
    expect(ended[0]!.nodesSettled).toBe(2)
    expect(workflowRunWords(ended[0]!)).toBeNull()
  })

  it('a failed node ends the run as errored', () => {
    const { ended } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: { action: 'set', nodes: [{ id: 'a', task: 't1' }] },
          startedAt: 100,
          completedAt: 200,
        },
        {
          toolName: 'dispatch',
          toolCallId: 'c2',
          args: {},
          result: graph({ id: 'a', task: 't1', status: 'failed' }),
          startedAt: 300,
          completedAt: 400,
        },
      ]),
    ])
    expect(ended).toHaveLength(1)
    expect(ended[0]!.status).toBe('errored')
  })

  it('an in-flight dispatch keeps the run running even before any result lands', () => {
    const { running } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: { action: 'set', nodes: [{ id: 'a', task: 't1' }] },
          startedAt: 100,
          completedAt: 200,
        },
        { toolName: 'dispatch', toolCallId: 'c2', args: {}, startedAt: 300 },
      ]),
    ])
    expect(running).toHaveLength(1)
    expect(running[0]!.status).toBe('running')
    expect(running[0]!.nodesSettled).toBe(0)
  })

  it('a superseding plan set drops the unconverged previous run with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { running, ended } = deriveWorkflowRuns([
        message([
          {
            toolName: 'plan',
            toolCallId: 'c1',
            args: { action: 'set', nodes: [{ id: 'a', task: 'old' }] },
            startedAt: 100,
            completedAt: 200,
          },
          {
            toolName: 'plan',
            toolCallId: 'c2',
            args: { action: 'set', nodes: [{ id: 'z', task: 'new' }] },
            startedAt: 300,
            completedAt: 400,
          },
        ]),
      ])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(ended).toHaveLength(0)
      expect(running).toHaveLength(1)
      expect(running[0]!.runId).toBe('c2')
    } finally {
      warn.mockRestore()
    }
  })

  it('plan updates and non-orchestrator calls never open runs', () => {
    const { running, ended } = deriveWorkflowRuns([
      // plan-mode / 别的插件的 plan 工具：没有 action 字段 → 不认
      message([{ toolName: 'plan', toolCallId: 'x', args: { note: 'hello' }, completedAt: 1 }]),
      // 没有 set 的 dispatch（转录截断）→ 无归属
      message([{ toolName: 'dispatch', toolCallId: 'y', args: {}, completedAt: 2 }]),
      { role: 'user', content: [{ type: 'tool-call', toolName: 'plan', toolCallId: 'z' }] },
    ])
    expect(running).toHaveLength(0)
    expect(ended).toHaveLength(0)
  })

  it('an errored dispatch result leaves the previous graph snapshot intact', () => {
    const { running } = deriveWorkflowRuns([
      message([
        {
          toolName: 'plan',
          toolCallId: 'c1',
          args: { action: 'set', nodes: [{ id: 'a', task: 't1' }, { id: 'b', task: 't2' }] },
          startedAt: 100,
          completedAt: 200,
        },
        {
          toolName: 'dispatch',
          toolCallId: 'c2',
          args: {},
          result: {
            content: [{ type: 'text', text: 'no progress: no pending node is ready' }],
            isError: true,
          },
          startedAt: 300,
          completedAt: 400,
        },
      ]),
    ])
    expect(running).toHaveLength(1)
    expect(running[0]!.nodesTotal).toBe(2)
    expect(running[0]!.nodesSettled).toBe(0)
    expect(running[0]!.status).toBe('running')
  })

  it('malformed node rows are dropped with a visible error, not fabricated', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { ended } = deriveWorkflowRuns([
        message([
          {
            toolName: 'plan',
            toolCallId: 'c1',
            args: { action: 'set', nodes: [{ id: 'a', task: 't1' }] },
            startedAt: 100,
            completedAt: 200,
          },
          {
            toolName: 'dispatch',
            toolCallId: 'c2',
            args: {},
            result: {
              details: { nodes: [{ id: 'a', task: 't1', status: 'done' }, { id: 'b', status: 'wat' }] },
            },
            startedAt: 300,
            completedAt: 400,
          },
        ]),
      ])
      expect(error).toHaveBeenCalled()
      expect(ended).toHaveLength(1)
      expect(ended[0]!.nodesTotal).toBe(1)
      expect(ended[0]!.status).toBe('completed')
    } finally {
      error.mockRestore()
    }
  })
})
