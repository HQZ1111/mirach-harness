/**
 * 活动面板「智能体」行派生面单测（status-agent-rows.ts）。
 *
 * 锁住 2026-11-17「完整移植」轮的语义：
 * - 三种子代理工具名（delegate_task / subagent / dispatch）才入行；
 * - running/ended 分割 = timing.completedAt 有无（rpi 子代理运行态无
 *   宿主读取面，工具调用是唯一真值）；
 * - 目录按完成时间倒序；标题优先级链与 payload 组装。
 */
import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_NAMES, deriveAgentRows, toolOutputText } from './status-agent-rows'

const delegationResult = (fields: Record<string, unknown>): unknown => ({
  content: [{ type: 'text', text: JSON.stringify({ kind: 'rpi-delegation', ...fields }) }],
})

const assistantMessage = (parts: unknown[]): unknown => ({ role: 'assistant', content: parts })

const toolCall = (over: Record<string, unknown> = {}): unknown => ({
  type: 'tool-call',
  toolName: 'delegate_task',
  toolCallId: 'tc-1',
  args: {},
  ...over,
})

describe('AGENT_TOOL_NAMES', () => {
  it('三套工具名（rpi-subagents / rpi-orchestrator）', () => {
    expect([...AGENT_TOOL_NAMES].sort()).toEqual(['delegate_task', 'dispatch', 'subagent'])
  })
})

describe('toolOutputText', () => {
  it('字符串原样', () => {
    expect(toolOutputText('报告正文')).toBe('报告正文')
  })

  it('content 块拼接（text 块 / 裸字符串块）', () => {
    expect(toolOutputText({ content: [{ type: 'text', text: 'a' }, 'b'] })).toBe('ab')
  })

  it('其余形状 → null（不猜）', () => {
    expect(toolOutputText(null)).toBeNull()
    expect(toolOutputText(42)).toBeNull()
    expect(toolOutputText({ content: 'x' })).toBeNull()
  })
})

describe('deriveAgentRows', () => {
  it('非 assistant / 非 tool-call / 非代理工具 → 不入行', () => {
    const rows = deriveAgentRows([
      { role: 'user', content: [toolCall()] },
      assistantMessage([{ type: 'text', text: 'hi' }]),
      assistantMessage([toolCall({ toolName: 'bash' })]),
      assistantMessage([toolCall({ toolName: 'read' })]),
    ])
    expect(rows).toEqual({ running: [], ended: [] })
  })

  it('无完成时间 → running；有完成时间 → ended（状态/payload 组装）', () => {
    const rows = deriveAgentRows([
      assistantMessage([
        toolCall({ toolCallId: 'r1', args: { agent: 'scout', task: '扫描仓库' } }),
        toolCall({
          toolCallId: 'e1',
          toolName: 'subagent',
          args: { task: '写文档' },
          result: delegationResult({
            task: '写文档',
            role: 'writer',
            status: 'completed',
            report: '完成',
            childId: 'c1',
            sessionId: 's1',
          }),
          timing: { startedAt: 1000, completedAt: 2000 },
        }),
      ]),
    ])
    expect(rows.running).toEqual([{ id: 'r1', title: '扫描仓库', startedAt: null }])
    expect(rows.ended).toHaveLength(1)
    const ended = rows.ended[0]!
    expect(ended).toMatchObject({ id: 'e1', title: '写文档', completedAt: 2000, status: 'completed' })
    expect(ended.payload).toMatchObject({
      name: '子代理',
      role: 'writer',
      task: '写文档',
      status: 'completed',
      running: false,
      report: '完成',
      childId: 'c1',
      sessionId: 's1',
    })
  })

  it('标题优先级链：结果 task → args.task → args.agent → 兜底「子代理」', () => {
    const rows = deriveAgentRows([
      assistantMessage([
        // 结果 task 优先（args 里的 task 是请求，不是结果）
        toolCall({
          toolCallId: 'a',
          args: { task: '旧任务' },
          result: delegationResult({ task: '新任务', status: 'completed', childId: 'c' }),
          timing: { completedAt: 1 },
        }),
        // args.task（无结果）
        toolCall({ toolCallId: 'b', args: { task: '参数任务' } }),
        // args.agent
        toolCall({ toolCallId: 'c', args: { agent: 'scout' } }),
        // 全缺 → 兜底
        toolCall({ toolCallId: 'd' }),
      ]),
    ])
    expect(rows.ended.map((r) => r.title)).toEqual(['新任务'])
    expect(rows.running.map((r) => r.title)).toEqual(['参数任务', 'scout', '子代理'])
  })

  it('目录按完成时间倒序（最新在前）', () => {
    const rows = deriveAgentRows([
      assistantMessage([
        toolCall({ toolCallId: 'old', args: { task: '先完成' }, timing: { completedAt: 100 } }),
        toolCall({ toolCallId: 'new', args: { task: '后完成' }, timing: { completedAt: 300 } }),
        toolCall({ toolCallId: 'mid', args: { task: '中间' }, timing: { completedAt: 200 } }),
      ]),
    ])
    expect(rows.ended.map((r) => r.title)).toEqual(['后完成', '中间', '先完成'])
  })

  it('toolCallId 缺失行跳过（无稳定行键）', () => {
    const rows = deriveAgentRows([
      assistantMessage([toolCall({ toolCallId: '', args: { task: 'x' } })]),
    ])
    expect(rows).toEqual({ running: [], ended: [] })
  })

  it('结果带 output 文本（目录/详情页复用）', () => {
    const rows = deriveAgentRows([
      assistantMessage([
        toolCall({
          toolCallId: 'o1',
          args: { task: 't' },
          result: { content: [{ type: 'text', text: '纯文本输出' }] },
          timing: { completedAt: 5 },
        }),
      ]),
    ])
    expect(rows.ended[0]!.payload.output).toBe('纯文本输出')
    // 无结构化 result → 状态取 completed（有完成时间），report 缺席
    expect(rows.ended[0]!.payload.status).toBe('completed')
    expect(rows.ended[0]!.payload.report).toBeUndefined()
  })
})
