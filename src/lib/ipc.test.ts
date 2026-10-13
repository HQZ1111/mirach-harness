/**
 * InFlightMap / invokeOnce 单测（§10.2）。
 *
 * 这里守的是**去重语义**而不是"能不能调通 IPC"：key 稳定性、并发上限、
 * TTL 基准时刻（完成时间而非开始时间）、失败是否原样传播——四条都是与
 * Rust middleware.rs 对齐的契约，漂了就会出现"前端以为去重了、Rust 其实
 * 执行两次"这类只在真机上偶发的重复副作用。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_INFLIGHT_CAPACITY,
  ERR_INFLIGHT_FULL,
  InFlightMap,
  fnv1a32,
  inflightKey,
  invokeOnce,
  stableStringify,
} from './ipc'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

/** 可推进的假时钟：TTL 用真实等待会拖慢且不确定 */
function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

/** 测试实例：关掉后台定时器（sweep 由单测显式驱动，确定性优先） */
function makeMap(options: { capacity?: number; ttlMs?: number; now?: () => number } = {}) {
  return new InFlightMap({ ...options, sweepIntervalMs: 0 })
}

/** 挂在 resolve 上但不立即兑现的 promise，用来制造"在飞行"窗口 */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  invokeMock.mockReset()
  vi.restoreAllMocks()
})

describe('inflightKey：key = method + ":" + hash(payload)', () => {
  it('同 method + 同 payload → 同 key（键序不同也算同 payload）', () => {
    expect(inflightKey('sync_app_context', { a: 1, b: 2 })).toBe(inflightKey('sync_app_context', { b: 2, a: 1 }))
  })

  it('payload 不同 → key 不同；method 不同 → key 不同', () => {
    expect(inflightKey('approve_action', { id: 'r1' })).not.toBe(inflightKey('approve_action', { id: 'r2' }))
    expect(inflightKey('call_action', { id: 'r1' })).not.toBe(inflightKey('sync_app_context', { id: 'r1' }))
  })

  it('嵌套对象的键序不影响 key（稳定序列化是去重的前提）', () => {
    expect(stableStringify({ outer: { b: 1, a: 2 } })).toBe(stableStringify({ outer: { a: 2, b: 1 } }))
  })

  it('走 toJSON 的对象按其序列化结果参与 hash（Channel 两次 attach 不撞 key）', () => {
    const channelLike = (id: number) => ({
      id,
      toJSON: () => `__CHANNEL__:${id}`,
      // 私有字段：直接遍历 Object.keys 只会得到 {}
    })
    expect(stableStringify({ onEvent: channelLike(1) })).not.toBe(stableStringify({ onEvent: channelLike(2) }))
  })

  it('环引用显式抛错（key 静默退化成 null 会让两个不同请求共用一条记录）', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => stableStringify(cyclic)).toThrow(TypeError)
  })

  it('fnv1a32 是纯函数：同输入同输出，异输入不同输出', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'))
    expect(fnv1a32('abc')).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'))
  })
})

describe('InFlightMap：并发去重 + 容量上限', () => {
  it('同 key 并发共享同一个 Promise 对象（不是等值副本）', async () => {
    const map = makeMap()
    const gate = pending<string>()
    const factory = vi.fn(() => gate.promise)

    const a = map.acquire('m:1', factory)
    const b = map.acquire('m:1', factory)
    const c = map.acquire('m:1', factory)

    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(map.liveCount).toBe(1)

    gate.resolve('done')
    await expect(a).resolves.toBe('done')
    // 落定后 Promise 身份仍然共享：等待者拿到的是同一个对象
    expect(c).toBe(a)
  })

  it('不同 key 各自独立发起', () => {
    const map = makeMap()
    const factory = vi.fn(() => pending<void>().promise)
    map.acquire('m:1', factory)
    map.acquire('m:2', factory)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(map.liveCount).toBe(2)
  })

  it('容量打满抛 ERR_INFLIGHT_FULL（同步抛；invokeOnce 是 async 故表现为 reject）', () => {
    const map = makeMap({ capacity: 2 })
    const factory = () => pending<void>().promise
    map.acquire('m:1', factory)
    map.acquire('m:2', factory)

    expect(() => map.acquire('m:3', factory)).toThrow(ERR_INFLIGHT_FULL)
    try {
      map.acquire('m:3', factory)
      expect.unreachable('容量打满必须抛')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain(ERR_INFLIGHT_FULL)
      expect((err as { code?: string }).code).toBe(ERR_INFLIGHT_FULL)
    }
  })

  it('默认容量是 1000（§10.2）', () => {
    expect(DEFAULT_INFLIGHT_CAPACITY).toBe(1000)
    const map = makeMap({ capacity: DEFAULT_INFLIGHT_CAPACITY })
    const factory = () => pending<void>().promise
    for (let i = 0; i < DEFAULT_INFLIGHT_CAPACITY; i++) map.acquire(`m:${i}`, factory)
    expect(map.liveCount).toBe(DEFAULT_INFLIGHT_CAPACITY)
    expect(() => map.acquire('m:overflow', factory)).toThrow(ERR_INFLIGHT_FULL)
  })

  it('落定后容量立刻释放（完成记录不占并发额度）', async () => {
    const map = makeMap({ capacity: 1 })
    await expect(map.acquire('m:1', async () => 'a')).resolves.toBe('a')
    expect(map.liveCount).toBe(0)
    await expect(map.acquire('m:2', async () => 'b')).resolves.toBe('b')
  })

  it('无 response cache：同名请求完成后再次调用会真的重发', async () => {
    const map = makeMap()
    const factory = vi.fn(async () => 'value')

    await expect(map.acquire('m:1', factory)).resolves.toBe('value')
    await expect(map.acquire('m:1', factory)).resolves.toBe('value')

    expect(factory).toHaveBeenCalledTimes(2)
    expect(map.peek('m:1')).toBeUndefined()
  })

  it('失败原样传播，且失败后同 key 可重发（错误不被吞成默认值）', async () => {
    const map = makeMap()
    const boom = new Error('Rust: ERR_QUEUE_FULL')
    await expect(
      map.acquire('m:1', async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(map.liveCount).toBe(0)

    await expect(map.acquire('m:1', async () => 'recovered')).resolves.toBe('recovered')
  })

  it('factory 同步抛错不留脏记录（不会卡住容量）', () => {
    const map = makeMap({ capacity: 1 })
    expect(() =>
      map.acquire('m:1', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(map.liveCount).toBe(0)
    expect(() => map.acquire('m:2', () => pending<void>().promise)).not.toThrow()
  })
})

describe('InFlightMap：TTL 按完成时间清理（§10.2 ⭐）', () => {
  it('TTL 从完成时刻起算：飞行时长不计入保留期', async () => {
    const clock = makeClock()
    const map = makeMap({ ttlMs: 1000, now: clock.now })
    const gate = pending<string>()

    const p = map.acquire('m:1', () => gate.promise)
    clock.advance(5000) // 飞行了 5s（远超 TTL）
    gate.resolve('done')
    await p
    expect(clock.now()).toBe(6000)

    // 完成才 0ms：不该被清
    expect(map.sweep()).toBe(0)
    expect(map.has('m:1')).toBe(true)

    clock.advance(999)
    expect(map.sweep()).toBe(0)
    clock.advance(1)
    expect(map.sweep()).toBe(1)
    expect(map.has('m:1')).toBe(false)
  })

  it('若按开始时间计时，这条飞行 5s 的记录会在完成瞬间就被扫掉（反例断言）', async () => {
    const clock = makeClock()
    const map = makeMap({ ttlMs: 1000, now: clock.now })
    const gate = pending<string>()
    const p = map.acquire('m:1', () => gate.promise)
    clock.advance(5000)
    gate.resolve('done')
    await p
    // 起点计时的话 now - startedAt = 5000 ≥ 1000，记录已被回收；我们按完成
    // 时间计时，因此它还在——这就是"用完成时间"的可观测差别。
    expect(map.size).toBe(1)
  })

  it('后台清理定时器默认 30s 一次，且 dispose 后停', async () => {
    vi.useFakeTimers()
    try {
      const clock = makeClock()
      const map = new InFlightMap({ ttlMs: 100, now: clock.now })
      await map.acquire('m:1', async () => 'done')
      expect(map.size).toBe(1)

      vi.advanceTimersByTime(30_000) // 一个清理周期到
      clock.advance(100)
      vi.advanceTimersByTime(30_000)
      expect(map.size).toBe(0)

      await map.acquire('m:2', async () => 'done')
      map.dispose()
      clock.advance(10_000)
      vi.advanceTimersByTime(120_000)
      // dispose 同时清空记录并停掉定时器：之后既不再自动清理，也没有残留
      expect(map.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('annotate 补注产生新 key，原 in-flight 记录仍共享（§10.3 lastSequence）', async () => {
    const map = makeMap()
    const gate = pending<string>()
    const base = inflightKey('start_agent_event_stream', { runId: 'run-1', lastSequence: null })
    const p = map.acquire(base, () => gate.promise)

    const keyed = map.annotate(base, { lastSequence: 7 })
    expect(keyed).not.toBe(base)
    expect(map.peek(base)).toBe(p)

    gate.resolve('ok')
    await p
  })
})

describe('invokeOnce：唯一的 invoke 出口', () => {
  it('并发同 method+payload 只发一次 IPC（走 @tauri-apps/api 的 invoke）', async () => {
    invokeMock.mockReturnValue(Promise.resolve('once'))
    const [a, b] = await Promise.all([
      invokeOnce<string>('sync_app_context', { a: 1 }),
      invokeOnce<string>('sync_app_context', { a: 1 }),
    ])
    expect(a).toBe('once')
    expect(b).toBe('once')
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('sync_app_context', { a: 1 })
  })

  it('payload 不同 → 各发各的', async () => {
    invokeMock.mockResolvedValue('ok')
    await invokeOnce('approve_action', { id: 'r1' })
    await invokeOnce('approve_action', { id: 'r2' })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('Rust 侧 Err 原样 reject，不返回默认值', async () => {
    invokeMock.mockRejectedValue('ERR_QUEUE_FULL')
    await expect(invokeOnce('delegate_to_agent', { runId: 'r' })).rejects.toBe('ERR_QUEUE_FULL')
    // 失败后不留 in-flight：下一次同名调用要真的重发（不吞错误，也不缓存失败）
    invokeMock.mockResolvedValue('second')
    await expect(invokeOnce('delegate_to_agent', { runId: 'r' })).resolves.toBe('second')
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})
