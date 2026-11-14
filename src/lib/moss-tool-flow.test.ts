/**
 * MOSS 工具面协议态机单测（纯模块，执行器/传输注入）：
 * 回报路径（item.create → created → response.create）/ call_id 去重 /
 * cancel_requested 停跟与迟到丢弃 / async 限流（≤4 并发、≤128 会话）/
 * 执行失败与超时的失败输出。声明校验见 moss-tools.test.ts。
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_ASYNC_TASKS_PER_SESSION,
  MAX_CONCURRENT_ASYNC,
  MossToolFlow,
  type MossOutboundEvent,
} from './moss-tool-flow'
import type { MossToolDecl } from './moss-tools'

const SYNC_TOOL: MossToolDecl = {
  type: 'function',
  name: 'quick_lookup',
  description: '快查询',
  parameters: { type: 'object', properties: {} },
  execution_mode: 'sync',
  read_only: true,
}
const ASYNC_TOOL: MossToolDecl = {
  type: 'function',
  name: 'slow_effect',
  description: '慢作业',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  execution_mode: 'async_effect',
  read_only: false,
}

/** 手动结算的执行器（测试控时序）：每次调用排一个 deferred。 */
class Deferred<T> {
  promise: Promise<T>
  resolve!: (v: T) => void
  reject!: (e: unknown) => void
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res
      this.reject = rej
    })
  }
}

function harness(tools: MossToolDecl[] = [SYNC_TOOL, ASYNC_TOOL]) {
  const sent: MossOutboundEvent[] = []
  const execCalls: { name: string; args: Record<string, unknown> }[] = []
  const deferreds: Deferred<string>[] = []
  const notices: string[] = []
  const flow = new MossToolFlow({
    tools,
    executor: (name, args) => {
      execCalls.push({ name, args })
      const d = new Deferred<string>()
      deferreds.push(d)
      return d.promise
    },
    send: (e) => sent.push(e),
    onNotice: (m) => notices.push(m),
  })
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))
  /** 模拟 vendor 确认（conversation.item.created）。 */
  const confirm = (callId: string) =>
    flow.handleEvent('conversation.item.created', { item: { id: `item-${callId}`, call_id: callId } })
  const done = (callId: string, name: string, args: unknown, asyncTask?: { taskId: string }) =>
    flow.handleEvent('response.function_call_arguments.done', {
      call_id: callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      ...(asyncTask ? { task_id: asyncTask.taskId, revision: 1, execution_mode: 'async_effect' } : {}),
    })
  return { flow, sent, execCalls, deferreds, notices, flush, confirm, done }
}

const doneEvents = (sent: MossOutboundEvent[], action: string): MossOutboundEvent[] =>
  sent.filter((e) => e.action === action)

describe('announce（session.update 声明）', () => {
  it('整表下发 tools', () => {
    const { flow, sent } = harness()
    flow.announce()
    expect(sent).toHaveLength(1)
    expect(sent[0].action).toBe('session.update')
    expect((sent[0].session as { tools: MossToolDecl[] }).tools).toHaveLength(2)
  })

  it('声明不合法直接 throw（vendor 会整表拒绝，客户端先自查）', () => {
    expect(
      () =>
        new MossToolFlow({
          tools: [{ type: 'function', name: 'bad name', description: 'x' }],
          executor: async () => '',
          send: () => undefined,
        }),
    ).toThrow(/name/)
  })
})

describe('sync 回报路径（item.create → created → response.create）', () => {
  it('执行 → 交付 → 确认 → 续跑', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', { k: 'v' })
    await h.flush()
    expect(h.execCalls).toEqual([{ name: 'quick_lookup', args: { k: 'v' } }])
    h.deferreds[0].resolve('查询结果文本')
    await h.flush()

    const creates = doneEvents(h.sent, 'conversation.item.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].item).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: '查询结果文本',
    })
    expect(doneEvents(h.sent, 'response.create')).toHaveLength(0)

    h.confirm('c1')
    const continues = doneEvents(h.sent, 'response.create')
    expect(continues).toHaveLength(1)
    expect(continues[0].response).toEqual({ call_ids: ['c1'] })
  })

  it('同 call_id 重播只执行一次（response.done 重复的调用）', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', {})
    h.done('c1', 'quick_lookup', {})
    await h.flush()
    expect(h.execCalls).toHaveLength(1)
    h.deferreds[0].resolve('结果')
    await h.flush()
    expect(doneEvents(h.sent, 'conversation.item.create')).toHaveLength(1)
  })

  it('arguments 非法 JSON → 失败输出（不炸执行器）', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', 'not json{')
    await h.flush()
    expect(h.execCalls).toHaveLength(0)
    const creates = doneEvents(h.sent, 'conversation.item.create')
    expect(creates).toHaveLength(1)
    expect((creates[0].item as { output: string }).output).toContain('ok":false')
  })

  it('arguments 是数组（非对象）→ 失败输出', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', '[1,2]')
    await h.flush()
    expect(h.execCalls).toHaveLength(0)
    expect((doneEvents(h.sent, 'conversation.item.create')[0].item as { output: string }).output).toContain(
      'JSON 对象',
    )
  })

  it('执行器 throw → 失败输出照常交付 + 确认后续跑', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', {})
    await h.flush()
    h.deferreds[0].reject(new Error('还没有活动会话'))
    await h.flush()
    const creates = doneEvents(h.sent, 'conversation.item.create')
    expect(creates).toHaveLength(1)
    const output = JSON.parse((creates[0].item as { output: string }).output) as {
      ok: boolean
      error: string
    }
    expect(output.ok).toBe(false)
    expect(output.error).toBe('还没有活动会话')
    h.confirm('c1')
    expect(doneEvents(h.sent, 'response.create')).toHaveLength(1)
  })
})

describe('cancel_requested（停跟与迟到丢弃）', () => {
  it('执行中取消 → 迟到结果不交付', async () => {
    const h = harness()
    h.done('c1', 'slow_effect', { id: 'j1' }, { taskId: 't1' })
    await h.flush()
    h.flow.handleEvent('response.function_call.cancel_requested', {
      call_id: 'c1',
      task_id: 't1',
      revision: 1,
      reason: 'timeout',
    })
    h.deferreds[0].resolve('跑完了但晚了')
    await h.flush()
    expect(doneEvents(h.sent, 'conversation.item.create')).toHaveLength(0)
    expect(doneEvents(h.sent, 'response.create')).toHaveLength(0)
  })

  it('cancel 先于 done → done 到达直接丢弃（执行器不跑）', async () => {
    const h = harness()
    h.flow.handleEvent('response.function_call.cancel_requested', { call_id: 'c1', reason: 'replaced' })
    h.done('c1', 'slow_effect', { id: 'j1' }, { taskId: 't1' })
    await h.flush()
    expect(h.execCalls).toHaveLength(0)
    expect(doneEvents(h.sent, 'conversation.item.create')).toHaveLength(0)
  })

  it('已交付未确认时取消 → 确认到达不再续跑', async () => {
    const h = harness()
    h.done('c1', 'quick_lookup', {})
    await h.flush()
    h.deferreds[0].resolve('ok')
    await h.flush()
    h.flow.handleEvent('response.function_call.cancel_requested', { call_id: 'c1', reason: 'timeout' })
    h.confirm('c1')
    expect(doneEvents(h.sent, 'response.create')).toHaveLength(0)
  })
})

describe('async 限流（协议：≤4 并发 / ≤128 会话含已结束）', () => {
  it('并发第 5 个 → 立即失败输出（不执行器）；sync 不受影响', async () => {
    const h = harness()
    for (let i = 1; i <= MAX_CONCURRENT_ASYNC; i += 1) {
      h.done(`c${i}`, 'slow_effect', { id: 'j' }, { taskId: `t${i}` })
    }
    await h.flush()
    h.done('c5', 'slow_effect', { id: 'j' }, { taskId: 't5' })
    await h.flush()

    expect(h.execCalls).toHaveLength(MAX_CONCURRENT_ASYNC)
    // 在途的 4 个尚未交付输出；此刻的 create 只有 c5 的失败输出
    const creates = doneEvents(h.sent, 'conversation.item.create')
    expect(creates).toHaveLength(1)
    expect((creates[0].item as { call_id: string }).call_id).toBe('c5')
    expect((creates[0].item as { output: string }).output).toContain('并发已达上限')
    // sync 调用不受 async 并发限制
    h.done('c6', 'quick_lookup', {})
    await h.flush()
    expect(h.execCalls).toHaveLength(MAX_CONCURRENT_ASYNC + 1)
    // 在途 4 个 async 结算后照常交付（c6 的 deferred 留在队尾不动）
    for (let i = 0; i < MAX_CONCURRENT_ASYNC; i += 1) h.deferreds[i].resolve('done')
    await h.flush()
    expect(doneEvents(h.sent, 'conversation.item.create')).toHaveLength(MAX_CONCURRENT_ASYNC + 1)
  })

  it('结算后释放并发槽（完成 → 确认 → 新 async 可进）', async () => {
    const h = harness()
    h.done('c1', 'slow_effect', { id: 'j' }, { taskId: 't1' })
    await h.flush()
    h.deferreds[0].resolve('done')
    await h.flush()
    h.confirm('c1')
    h.done('c2', 'slow_effect', { id: 'j' }, { taskId: 't2' })
    await h.flush()
    expect(h.execCalls).toHaveLength(2)
  })

  it(`会话累计 ${MAX_ASYNC_TASKS_PER_SESSION} 个后 → 后续 async 全部失败输出`, async () => {
    const h = harness()
    // 128 个 async 按 ≤4 并发分 32 波执行+结算（finishedAsync 镜像到上限）
    let seq = 0
    for (let wave = 0; wave < MAX_ASYNC_TASKS_PER_SESSION / MAX_CONCURRENT_ASYNC; wave += 1) {
      for (let i = 0; i < MAX_CONCURRENT_ASYNC; i += 1) {
        seq += 1
        h.done(`c${seq}`, 'slow_effect', { id: 'j' }, { taskId: `t${seq}` })
      }
      await h.flush()
      const base = h.deferreds.length - MAX_CONCURRENT_ASYNC
      for (let i = 0; i < MAX_CONCURRENT_ASYNC; i += 1) h.deferreds[base + i].resolve('ok')
      await h.flush()
    }
    expect(h.execCalls).toHaveLength(MAX_ASYNC_TASKS_PER_SESSION)
    h.done('overflow', 'slow_effect', { id: 'j' }, { taskId: 't-over' })
    await h.flush()
    expect(h.execCalls).toHaveLength(MAX_ASYNC_TASKS_PER_SESSION)
    const creates = doneEvents(h.sent, 'conversation.item.create')
    expect(creates).toHaveLength(MAX_ASYNC_TASKS_PER_SESSION + 1)
    const last = creates[creates.length - 1].item as { call_id: string; output: string }
    expect(last.call_id).toBe('overflow')
    expect(last.output).toContain('会话上限')
  })
})

describe('超时（≤120s/次执行）', () => {
  it('超时 → 失败输出交付；迟到的真结果丢弃', async () => {
    const sent: MossOutboundEvent[] = []
    const notices: string[] = []
    const d = new Deferred<string>()
    const flow = new MossToolFlow({
      tools: [ASYNC_TOOL],
      executor: () => d.promise,
      send: (e) => sent.push(e),
      onNotice: (m) => notices.push(m),
      timeoutMs: 10,
    })
    flow.handleEvent('response.function_call_arguments.done', {
      call_id: 'c1',
      name: 'slow_effect',
      arguments: JSON.stringify({ id: 'j' }),
      task_id: 't1',
      revision: 1,
      execution_mode: 'async_effect',
    })
    await new Promise<void>((r) => setTimeout(r, 30))
    const creates = sent.filter((e) => e.action === 'conversation.item.create')
    expect(creates).toHaveLength(1)
    expect((creates[0].item as { output: string }).output).toContain('超时')

    // 迟到的真结果：不重复交付
    d.resolve('其实跑完了')
    await new Promise<void>((r) => setTimeout(r, 10))
    expect(sent.filter((e) => e.action === 'conversation.item.create')).toHaveLength(1)
  })
})

describe('owns（事件消费面）', () => {
  it('三个协议事件归态机，其余归 session', () => {
    const { flow } = harness()
    expect(flow.owns('response.function_call_arguments.done')).toBe(true)
    expect(flow.owns('conversation.item.created')).toBe(true)
    expect(flow.owns('response.function_call.cancel_requested')).toBe(true)
    expect(flow.owns('session_attached')).toBe(false)
    expect(flow.owns('session.updated')).toBe(false)
    expect(flow.owns('input.transcript.updated')).toBe(false)
  })
})
