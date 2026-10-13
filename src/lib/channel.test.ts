/**
 * SeqTracker / openRunChannel 单测（§11.2）。
 *
 * 跑的是**真** `@tauri-apps/api` 的 Channel（配 `@tauri-apps/api/mocks`
 * 的 mockIPC 驱动 window.__TAURI_INTERNALS__），不是替身：这样"Channel 自带
 * 按序投递"这条前提是被真实现验证的，而不是我们自说自话——职责收窄（SeqTracker
 * 只管跨 attach 续接）建立在它之上。
 *
 * Node 环境下 @tauri-apps/api/mocks 依赖 window，这里补一个 `window = globalThis`
 * 的替身（vitest.setup.ts 的 localStorage 同思路）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentEventKind, Seq } from './agent-protocol'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { SeqTracker, isAgentEvent, openRunChannel, type DispatchEvent, type RunChannel, type RunChannelHandlers } from './channel'

type TokenEvent = Extract<DispatchEvent, { kind: 'token' }>
type ControlEvent = Extract<DispatchEvent, { kind: 'control' }>

/** @tauri-apps/api v3 alpha 不再全局声明 __TAURI_INTERNALS__，这里本地声明一次 */
interface TauriInternals {
  transformCallback(callback: (data: unknown) => void, once?: boolean): number
  unregisterCallback(id: number): void
  runCallback(id: number, data: unknown): void
  invoke(cmd: string, args?: unknown): Promise<unknown>
  callbacks?: Map<number, (data: unknown) => void>
}

function internals(): TauriInternals {
  const scope = globalThis as unknown as { window?: { __TAURI_INTERNALS__?: TauriInternals } }
  const found = scope.window?.__TAURI_INTERNALS__
  if (!found) throw new Error('Tauri internals 未安装：先 mockIPC')
  return found
}

let lastArgs: Record<string, unknown> = {}

beforeEach(() => {
  const scope = globalThis as unknown as { window?: unknown }
  if (scope.window === undefined) {
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true })
  }
  lastArgs = {}
  mockIPC((_cmd, payload) => {
    lastArgs = (payload ?? {}) as Record<string, unknown>
    // §11.3 第 3 步：attach 返回 ResumeOutcome
    return { type: 'replayed' }
  })
})

afterEach(() => {
  clearMocks()
  vi.restoreAllMocks()
})

// ── 事件构造 ─────────────────────────────────────────────────────────────────

function ev(runId: string, seq: Seq, kind: AgentEventKind): AgentEvent {
  return { runId, seq, kind }
}

const assistantDelta = (delta: string): AgentEventKind => ({ type: 'assistant_output', delta })
const toolDelta = (toolCallId: string, delta: string): AgentEventKind => ({ type: 'tool_output', toolCallId, delta })

/** 真 Channel 的驱动台：Rust 侧 send() 走 index，end 帧走 drop */
function createStream(runId: string, handlers: RunChannelHandlers) {
  const handle: RunChannel = openRunChannel(runId, handlers)
  let index = 0
  return {
    handle,
    /** send(event)：index 单调递增，与协议 seq 相互独立 */
    send(event: AgentEvent): void {
      internals().runCallback(handle.channel.id, { index: index++, message: event })
    },
    /** out-of-order(index, event)：刻意打乱投递顺序，验证 Channel 自带缓冲 */
    sendAt(at: number, event: AgentEvent): void {
      internals().runCallback(handle.channel.id, { index: at, message: event })
      index = Math.max(index, at + 1)
    },
    /** end 帧：Rust 侧 Channel drop 的物理形态（JS 端只看到回调被注销） */
    end(): void {
      internals().runCallback(handle.channel.id, { index: index++, end: true })
    },
  }
}

function makeHandlers() {
  return {
    onToken: vi.fn<(chunk: TokenEvent) => void>(),
    onControl: vi.fn<(event: ControlEvent) => void>(),
    onReseat: vi.fn<(from: Seq) => void>(),
    onClose: vi.fn<(reason: string) => void>(),
    onProtocolError: vi.fn<(frame: unknown) => void>(),
  }
}

// ── SeqTracker ───────────────────────────────────────────────────────────────

describe('SeqTracker：连续窗口推进', () => {
  it('从 maxSeq=0 起，seq 从 1 连投逐帧推进', () => {
    const t = new SeqTracker()
    expect(t.maxSeq).toBe(0)
    for (const seq of [1, 2, 3]) {
      const r = t.ingest(seq, ev('r', seq, assistantDelta('x')))
      expect(r.accepted).toBe(true)
      expect(r.maxSeq).toBe(seq)
    }
    expect(t.maxSeq).toBe(3)
    expect(t.needsReseat()).toBe(false)
  })

  it('seq <= maxSeq 一律丢弃（重放/旧帧幂等）', () => {
    const t = new SeqTracker()
    t.ingest(1, ev('r', 1, assistantDelta('a')))
    t.ingest(2, ev('r', 2, assistantDelta('b')))

    const dup = t.ingest(2, ev('r', 2, assistantDelta('b')))
    expect(dup.accepted).toBe(false)
    if (!dup.accepted) expect(dup.reason).toBe('duplicate')

    const old = t.ingest(1, ev('r', 1, assistantDelta('a')))
    expect(old.accepted).toBe(false)
    if (!old.accepted) expect(old.reason).toBe('duplicate')

    expect(t.maxSeq).toBe(2)
    expect(t.needsReseat()).toBe(false)
  })

  it('续接起点可从已有 maxSeq 起（重挂后接着往后收）', () => {
    const t = new SeqTracker(7)
    expect(t.maxSeq).toBe(7)
    expect(t.ingest(8, ev('r', 8, assistantDelta('x'))).accepted).toBe(true)
    expect(t.maxSeq).toBe(8)
    // 续接点之前的帧属于上一段生命周期，仍按 duplicate 处理
    expect(t.ingest(7, ev('r', 7, assistantDelta('x'))).accepted).toBe(false)
  })
})

describe('SeqTracker：空洞 → needsReseat', () => {
  it('seq > maxSeq+1 判空洞：不推进、不接受、needsReseat=true', () => {
    const t = new SeqTracker()
    t.ingest(1, ev('r', 1, assistantDelta('a')))
    t.ingest(2, ev('r', 2, assistantDelta('b')))

    const gap = t.ingest(5, ev('r', 5, assistantDelta('e')))
    expect(gap.accepted).toBe(false)
    if (!gap.accepted) {
      expect(gap.reason).toBe('gap')
      // 续接点必须落在空洞之前：抬到 5 就永久丢掉 3/4
      expect(gap.maxSeq).toBe(2)
    }
    expect(gap.needsReseat).toBe(true)
    expect(t.maxSeq).toBe(2)
    expect(t.holeSeq).toBe(5)
  })

  it('补齐空洞后连续性恢复，needsReseat 自动解除', () => {
    const t = new SeqTracker()
    t.ingest(1, ev('r', 1, assistantDelta('a')))
    t.ingest(2, ev('r', 2, assistantDelta('b')))
    expect(t.ingest(4, ev('r', 4, assistantDelta('d'))).accepted).toBe(false)
    expect(t.needsReseat()).toBe(true)

    // replay 从续接点（maxSeq=2）开始补：3 补上但空洞仍在（4 还没到）
    expect(t.ingest(3, ev('r', 3, assistantDelta('c'))).accepted).toBe(true)
    expect(t.needsReseat()).toBe(true)
    expect(t.maxSeq).toBe(3)

    expect(t.ingest(4, ev('r', 4, assistantDelta('d'))).accepted).toBe(true)
    expect(t.maxSeq).toBe(4)
    expect(t.needsReseat()).toBe(false)
    expect(t.holeSeq).toBeNull()
  })

  it('markReseated 清标记（上层已改走 SnapshotRequired 分支）', () => {
    const t = new SeqTracker()
    t.ingest(3, ev('r', 3, assistantDelta('c')))
    expect(t.needsReseat()).toBe(true)
    t.markReseated()
    expect(t.needsReseat()).toBe(false)
  })
})

describe('isAgentEvent：坏帧必须被挡住（§9 铁律 1）', () => {
  it('tool_output 缺 toolCallId → 不是合法帧', () => {
    expect(isAgentEvent({ runId: 'r', seq: 1, kind: { type: 'tool_output', delta: 'x' } })).toBe(false)
  })
  it('未知 kind / 非整数 seq / 缺 runId → 不是合法帧', () => {
    expect(isAgentEvent({ runId: 'r', seq: 1, kind: { type: 'thinking' } })).toBe(false)
    expect(isAgentEvent({ runId: 'r', seq: 1.5, kind: { type: 'run_finished' } })).toBe(false)
    expect(isAgentEvent({ seq: 1, kind: { type: 'run_finished' } })).toBe(false)
    expect(isAgentEvent(null)).toBe(false)
  })
  it('合法帧放行', () => {
    expect(isAgentEvent({ runId: 'r', seq: 1, kind: { type: 'assistant_output', delta: 'x' } })).toBe(true)
    expect(isAgentEvent({ runId: 'r', seq: 2, kind: { type: 'run_gone' } })).toBe(true)
  })
})

// ── Channel 分流 ─────────────────────────────────────────────────────────────

describe('openRunChannel：token / control 分流', () => {
  it('assistant_output → onToken（主文本流 toolCallId=null）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, assistantDelta('he')))
    s.send(ev('run-1', 2, assistantDelta('llo')))

    expect(h.onControl).not.toHaveBeenCalled()
    expect(h.onToken).toHaveBeenCalledTimes(2)
    expect(h.onToken.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'token', runId: 'run-1', seq: 1, toolCallId: null, delta: 'he' },
      { kind: 'token', runId: 'run-1', seq: 2, toolCallId: null, delta: 'llo' },
    ])
    expect(s.handle.maxSeq).toBe(2)
  })

  it('tool_output → onToken 且按 toolCallId 分组（同一工具的 delta 归同一部件）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)

    const byTool = new Map<string, string>()
    h.onToken.mockImplementation((chunk) => {
      const key = chunk.toolCallId ?? '__main__'
      byTool.set(key, (byTool.get(key) ?? '') + chunk.delta)
    })

    s.send(ev('run-1', 1, assistantDelta('先说一句')))
    s.send(ev('run-1', 2, toolDelta('call-a', 'partial')))
    s.send(ev('run-1', 3, toolDelta('call-b', 'other')))
    s.send(ev('run-1', 4, toolDelta('call-a', '-done')))

    expect(Object.fromEntries(byTool)).toEqual({
      __main__: '先说一句',
      'call-a': 'partial-done',
      'call-b': 'other',
    })
    expect(h.onControl).not.toHaveBeenCalled()
  })

  it('控制帧 → onControl（XState 消费面），token 面不沾', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)

    s.send(ev('run-1', 1, { type: 'run_started', source: 'user' }))
    s.send(ev('run-1', 2, { type: 'run_finished', usage: { inputTokens: 3 } }))
    s.send(ev('run-1', 3, { type: 'snapshot_restored' }))

    expect(h.onToken).not.toHaveBeenCalled()
    expect(h.onControl.mock.calls.map((c) => c[0].control.type)).toEqual(['run_started', 'run_finished', 'snapshot_restored'])
    expect(h.onClose).not.toHaveBeenCalled()
  })

  it('两种面都带 runId + seq（TokenStream 按 seq 追加、state 侧拒绝重复）', () => {
    const h = makeHandlers()
    const s = createStream('run-7', h)
    s.send(ev('run-7', 1, assistantDelta('x')))
    s.send(ev('run-7', 2, { type: 'run_started', source: 'user' }))
    expect(h.onToken.mock.calls[0]?.[0]).toMatchObject({ runId: 'run-7', seq: 1 })
    expect(h.onControl.mock.calls[0]?.[0]).toMatchObject({ runId: 'run-7', seq: 2 })
  })
})

describe('openRunChannel：seq 门禁', () => {
  it('重放/旧帧不再派发（幂等）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, assistantDelta('a')))
    s.send(ev('run-1', 2, assistantDelta('b')))
    s.send(ev('run-1', 2, assistantDelta('b'))) // 重放
    s.send(ev('run-1', 1, assistantDelta('a'))) // 旧帧

    expect(h.onToken).toHaveBeenCalledTimes(2)
    expect(s.handle.maxSeq).toBe(2)
    expect(h.onReseat).not.toHaveBeenCalled()
  })

  it('空洞帧不派发，且上报续接点 maxSeq（补帧交给 replay）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, assistantDelta('a')))
    s.send(ev('run-1', 2, assistantDelta('b')))
    s.send(ev('run-1', 5, assistantDelta('e'))) // 跳过 3/4

    expect(h.onToken).toHaveBeenCalledTimes(2) // 空洞帧没进 TokenStream
    expect(h.onReseat).toHaveBeenCalledTimes(1)
    expect(h.onReseat).toHaveBeenCalledWith(2)
    expect(s.handle.needsReseat()).toBe(true)

    // 上层 attachStream(runId, 2) → Rust 重投 3/4/5
    s.send(ev('run-1', 3, assistantDelta('c')))
    s.send(ev('run-1', 4, assistantDelta('d')))
    s.send(ev('run-1', 5, assistantDelta('e')))

    expect(s.handle.maxSeq).toBe(5)
    expect(s.handle.needsReseat()).toBe(false)
    expect(h.onToken).toHaveBeenCalledTimes(5)
    expect(h.onReseat).toHaveBeenCalledTimes(1) // 补帧期间不重复催 attach
  })

  it('乱序投递由 Tauri Channel 内部缓冲：本层收到时已按序（职责收窄的前提）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)

    s.sendAt(0, ev('run-1', 1, assistantDelta('a')))
    s.sendAt(2, ev('run-1', 3, assistantDelta('c'))) // index 1 未到
    expect(h.onToken).toHaveBeenCalledTimes(1) // 缺 index 1 时 onmessage 不触发

    s.sendAt(1, ev('run-1', 2, assistantDelta('b')))
    expect(h.onToken.mock.calls.map((c) => c[0].delta)).toEqual(['a', 'b', 'c'])
    expect(s.handle.maxSeq).toBe(3)
    expect(h.onReseat).not.toHaveBeenCalled() // 通道层保序 ≠ 协议层空洞，两码事
  })
})

describe('openRunChannel：drop / 关闭时的订阅清理', () => {
  it('终止控制帧先派发再清理订阅（Rust Channel 已 drop 的可观测代理）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, { type: 'run_finished' }))
    s.send(ev('run-1', 2, { type: 'run_ended_ack' }))

    expect(h.onControl.mock.calls.map((c) => c[0].control.type)).toEqual(['run_finished', 'run_ended_ack'])
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.onClose).toHaveBeenCalledWith('run_ended_ack')
    expect(s.handle.closed).toBe(true)
  })

  it('run_gone 同样收摊（§11.3 RunGone → 清 Store）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, { type: 'run_gone' }))
    expect(h.onClose).toHaveBeenCalledWith('run_gone')
    expect(s.handle.closed).toBe(true)
  })

  it('close() 幂等；关闭后到达的消息一律忽略', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, assistantDelta('a')))

    s.handle.close()
    s.handle.close()
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.onClose).toHaveBeenCalledWith('closed')

    s.send(ev('run-1', 2, assistantDelta('b')))
    s.send(ev('run-1', 3, { type: 'run_finished' }))
    expect(h.onToken).toHaveBeenCalledTimes(1)
    expect(h.onControl).not.toHaveBeenCalled()
  })

  it('Rust 侧 end 帧（物理 drop）之后本层已无回调可收：清场不抛不漏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-1', 1, assistantDelta('a')))
    s.end()

    // end 帧把回调注销掉了，之后 Rust 再 send 什么都不会进 onmessage
    s.send(ev('run-1', 2, assistantDelta('b')))
    expect(h.onToken).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled() // 提示来自 @tauri-apps/api 的回调缺失告警
  })

  it('坏帧可见：没给 onProtocolError 时走 console.error，不静默吞（规矩 12）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = makeHandlers()
    // 故意不提供 onProtocolError：验证默认出口是"看得见"而不是"悄悄丢"
    const s = createStream('run-1', { onToken: h.onToken, onControl: h.onControl })
    s.send({ runId: 'run-1', seq: 1, kind: { type: 'tool_output', delta: '缺 toolCallId' } } as unknown as AgentEvent)

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('不合约')
  })

  it('runId 串台按协议错误处理（Channel 按 run 分实例，串台必是 bug）', () => {
    const h = makeHandlers()
    const s = createStream('run-1', h)
    s.send(ev('run-2', 1, assistantDelta('别人的 run')))

    expect(h.onToken).not.toHaveBeenCalled()
    expect(h.onProtocolError).toHaveBeenCalledTimes(1)
    expect(s.handle.maxSeq).toBe(0)
  })
})
