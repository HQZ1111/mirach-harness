/**
 * 子代理委托卡解析（rpi-delegation 形状）单测。
 *
 * 只测纯函数 `parseDelegationResult`：真实形状 = ToolOutput.content[0].text
 * 里的 JSON 字符串（二次 parse）；形状不符必须返回 null（调用方回退通用
 * 工具卡，不编造字段）。
 */
import { describe, expect, it } from 'vitest'

import { parseDelegationResult } from './delegation-card'

const PAYLOAD = {
  kind: 'rpi-delegation',
  task: '把 report 算出来',
  role: 'worker',
  maxTurns: 2,
  timeoutSeconds: 300,
  childId: 'child-1',
  sessionId: 'sess-1',
  status: 'completed',
  turns: 1,
  turnLimited: false,
  report: '2',
}

const toolOutput = (text: string) => ({
  content: [{ type: 'text', text }],
  details: undefined,
  isError: false,
})

describe('parseDelegationResult', () => {
  it('ToolOutput.content[0].text 二次 parse → 全字段', () => {
    const r = parseDelegationResult(toolOutput(JSON.stringify(PAYLOAD)))
    expect(r).not.toBeNull()
    expect(r?.kind).toBe('rpi-delegation')
    expect(r?.role).toBe('worker')
    expect(r?.status).toBe('completed')
    expect(r?.turns).toBe(1)
    expect(r?.maxTurns).toBe(2)
    expect(r?.turnLimited).toBe(false)
    expect(r?.report).toBe('2')
    expect(r?.sessionId).toBe('sess-1')
    expect(r?.childId).toBe('child-1')
  })

  it('turnLimited / running 原样透出（不改成 completed）', () => {
    const r = parseDelegationResult(
      toolOutput(JSON.stringify({ ...PAYLOAD, status: 'running', turnLimited: true })),
    )
    expect(r?.status).toBe('running')
    expect(r?.turnLimited).toBe(true)
  })

  it('缺少 kind 但有 childId+status+task（orchestrator 近似形状）→ 也认', () => {
    const r = parseDelegationResult(
      toolOutput(JSON.stringify({ childId: 'c', status: 'done', task: 't', report: 'ok' })),
    )
    expect(r).not.toBeNull()
    expect(r?.kind).toBe('rpi-delegation')
    expect(r?.report).toBe('ok')
  })

  it('直接对象（已解析）+ kind 后缀 -delegation → 认', () => {
    const r = parseDelegationResult({ ...PAYLOAD, kind: 'other-delegation' })
    expect(r?.kind).toBe('other-delegation')
  })

  it('非 JSON / 非对象 / 缺身份字段 → null（不编造）', () => {
    expect(parseDelegationResult(toolOutput('not json'))).toBeNull()
    expect(parseDelegationResult(toolOutput('["array"]'))).toBeNull()
    expect(parseDelegationResult(toolOutput(JSON.stringify({ kind: 'other', status: 'done' })))).toBeNull()
    expect(parseDelegationResult(undefined)).toBeNull()
    expect(parseDelegationResult('plain text')).toBeNull()
  })

  it('缺可选字段 → null 而不是 0/空串（渲染层据此隐藏行）', () => {
    const r = parseDelegationResult(
      toolOutput(JSON.stringify({ kind: 'rpi-delegation', status: 'completed', report: 'r' })),
    )
    expect(r?.turns).toBeNull()
    expect(r?.maxTurns).toBeNull()
    expect(r?.timeoutSeconds).toBeNull()
    expect(r?.sessionId).toBeNull()
    expect(r?.task).toBeNull()
  })
})
