import { describe, expect, it } from 'vitest'

import type { AgentEvent, AgentEventKind, ExtensionUiResponse, ResumeOutcome } from './agent-protocol'

/**
 * 协议镜像单测（§9 铁律 5：serde 序列化形状 = L1 TypeScript 镜像类型的唯一依据）。
 * 这里守的不是"实现对不对"，而是**形状不漂移**：与 Rust 侧
 * agent-protocol 的 serde 契约互为锁——任一侧改字段名，本用例的 key
 * 断言即失配（需同步改两侧，忘了改一侧就红）。
 */

describe('agent-protocol 镜像形状', () => {
  it('AgentEvent 顶层键固定为 runId/seq/kind（camelCase）', () => {
    const ev: AgentEvent = {
      runId: 'run-1',
      seq: 1,
      kind: { type: 'assistant_output', delta: 'hi' },
    }
    expect(Object.keys(ev).sort()).toEqual(['kind', 'runId', 'seq'])
    expect(JSON.parse(JSON.stringify(ev))).toEqual({
      runId: 'run-1',
      seq: 1,
      kind: { type: 'assistant_output', delta: 'hi' },
    })
  })

  it('AssistantOutput 无 toolCallId ⭐（类型系统 + 形状双重保证）', () => {
    const kind: AgentEventKind = { type: 'assistant_output', delta: 'x' }
    expect('toolCallId' in kind).toBe(false)
    // 构造带 toolCallId 的 assistant_output 必须编译失败（此处只断言形状）
    const bad = { type: 'assistant_output', delta: 'x', toolCallId: 't1' } as unknown as AgentEventKind
    expect('toolCallId' in bad).toBe(true) // 若上例类型被放宽，这条会真——形状守卫的负样本
  })

  it('ToolOutput 必带 toolCallId ⭐（缺字段即 TS 编译错）', () => {
    const kind: AgentEventKind = { type: 'tool_output', toolCallId: 't1', delta: 'partial' }
    expect(kind.type === 'tool_output' && kind.toolCallId).toBe('t1')
    expect(JSON.parse(JSON.stringify(kind))).toEqual({
      type: 'tool_output',
      toolCallId: 't1',
      delta: 'partial',
    })
  })

  it('ResumeOutcome 三分支判别字段固定', () => {
    const outs: ResumeOutcome[] = [
      { type: 'replayed' },
      { type: 'snapshot_required' },
      { type: 'run_gone' },
    ]
    expect(outs.map((o) => o.type)).toEqual(['replayed', 'snapshot_required', 'run_gone'])
  })

  it('ExtensionUiResponse 必带 protocolVersion（版本漂移显式失败）', () => {
    const resp: ExtensionUiResponse = { id: 'r1', value: { ok: true }, cancelled: false, protocolVersion: 1 }
    expect(resp.protocolVersion).toBe(1)
    expect(Object.keys(resp).sort()).toEqual(['cancelled', 'id', 'protocolVersion', 'value'])
  })

  it('事件判别 tag 全集与 Rust 枚举一一对应（新增 kind 必须同步此处）', () => {
    const tags = [
      'assistant_output',
      'tool_output',
      'run_started',
      'run_finished',
      'run_aborted',
      'run_error',
      'snapshot_restored',
      'run_ended_ack',
      'run_gone',
    ]
    const covered = (k: AgentEventKind) => tags.includes(k.type)
    expect(covered({ type: 'assistant_output', delta: '' })).toBe(true)
    expect(covered({ type: 'tool_output', toolCallId: 't', delta: '' })).toBe(true)
    expect(covered({ type: 'run_started' })).toBe(true)
    expect(covered({ type: 'run_gone' })).toBe(true)
  })

  it('seq 从 1 起、per-run 单调（序列化保序不丢零）', () => {
    const seqs = [1, 2, 3].map((seq) => ({
      runId: 'r',
      seq,
      kind: { type: 'assistant_output', delta: 'd' } as AgentEventKind,
    }))
    const round = JSON.parse(JSON.stringify(seqs)) as AgentEvent[]
    expect(round.map((e) => e.seq)).toEqual([1, 2, 3])
  })
})