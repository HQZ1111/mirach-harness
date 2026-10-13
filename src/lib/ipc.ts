/**
 * invoke 通道前端封装（L2 桥接层第一通道，架构 §10.1 / §10.2）。
 *
 * 铁律（与 Rust 侧 middleware.rs 同构，改一侧必须同步另一侧）：
 * - 全部 invoke 走本文件，无黑名单、无例外（§10.1"统一走 InFlightMap"）。
 * - key = `method + ':' + hash(payload)`（FNV-1a，纯函数、非加密；§10.2）。
 *   approve_action 这类 payload 携带幂等语义的命令靠 payload hash 区分，
 *   否则两次不同应答会撞成一条。
 * - **仅 in-flight 去重，没有 response cache**：promise 一落定就不再复用。
 *   把结果留成缓存会把 send / acknowledge 这类一次性动作变出"幂等"假象——
 *   §10.4 明确终态幂等是 Rust ApprovalRegistry 的职责，不在前端缓存里伪造。
 * - 失败必须传播（工程规矩 12）：不 catch 后返回默认值，调用方自己决定。
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'

/** 并发上限（§10.2 容量 1000）——打满即拒，绝不排队降级成串行 */
export const DEFAULT_INFLIGHT_CAPACITY = 1000

/**
 * 完成记录保留时长。§10.2 只钉了"TTL 用完成时间 + 每 30s 清理"，
 * 60s 是本侧的取值理由：至少跨一个清理周期，保证完成记录一定被
 * 后台扫描看到一次（<30s 会被误判成"仍在飞行"而不清）。
 */
export const DEFAULT_INFLIGHT_TTL_MS = 60_000

/** 后台清理间隔（§10.2 每 30s） */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000

/** 容量打满的错误码（§10.2 ERR_INFLIGHT_FULL） */
export const ERR_INFLIGHT_FULL = 'ERR_INFLIGHT_FULL'

/** 带机器可读 code 的错误（Rust 侧返回的错误码同理，不靠 message 匹配） */
export class IpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'IpcError'
    this.code = code
  }
}

function bytesToString(bytes: Uint8Array): string {
  return `b:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 稳定序列化：对象键排序后再 JSON.stringify。
 * 为什么不能直接 JSON.stringify——同一 payload 的字面量键序不同就得到不同
 * 字符串，两次等价请求会被当成两条 in-flight 各自发出去（去重失效）。
 * 为什么先试 toJSON——JSON.stringify 本身就调 toJSON；不调的话 Channel
 * （私有字段 + `toJSON() → __CHANNEL__:<id>`）遍历 Object.keys 只得到 {},
 * 于是两次 attach 撞同一条记录、第二条 Channel 永远注册不上。
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  const ancestors = new Set<object>()
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    const obj = v as object
    if (ancestors.has(obj)) {
      throw new TypeError('stableStringify: payload 存在环引用，无法生成稳定 key')
    }
    ancestors.add(obj)
    try {
      const toJSON = (obj as { toJSON?: unknown }).toJSON
      if (typeof toJSON === 'function') return (toJSON as () => unknown).call(obj)
      if (obj instanceof ArrayBuffer) return bytesToString(new Uint8Array(obj))
      if (ArrayBuffer.isView(obj)) {
        return bytesToString(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength))
      }
      if (Array.isArray(v)) return v.map(normalize)
      const record = obj as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        out[key] = normalize(record[key])
      }
      return out
    } finally {
      ancestors.delete(obj)
    }
  }

  return JSON.stringify(normalize(value)) ?? 'undefined'
}

/**
 * FNV-1a 32bit（纯 hash，非加密；选它只为前后端 key 可复算、无依赖）。
 *
 * 注：本实现**不做超长输入截断**。调用方若真的发出 MB 级 args，每次调用为
 * 去重多付一次 O(n) 遍历，在 invoke 的 IPC 序列化开销面前不成比例；把 hash
 * 降级成碰撞安全的问题留给"别那样用"，不在这里做看不见的降级。
 */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** InFlightMap 的 key（§10.2）。args 缺省视作空对象——Rust 侧无参命令也是一条命令。 */
export function inflightKey(method: string, args?: InvokeArgs): string {
  return `${method}:${fnv1a32(stableStringify(args ?? {}))}`
}

export interface InFlightOptions {
  /** 并发上限；默认 DEFAULT_INFLIGHT_CAPACITY */
  capacity?: number
  /** 完成记录保留时长；默认 DEFAULT_INFLIGHT_TTL_MS */
  ttlMs?: number
  /** 后台清理间隔；传 0 关闭（本模块单测与临时实例用，避免挂住进程） */
  sweepIntervalMs?: number
  /** 时钟注入：TTL 单测要确定性，不能真等 */
  now?: () => number
}

interface Entry {
  promise: Promise<unknown>
  settled: boolean
  /** 完成时刻（ms）。TTL 基准——不是开始时刻（§10.2 ⭐）：
   * 长命令跑了 40s 才开始 TTL 计时的话，会被后台扫描当成陈旧飞行记录清掉。 */
  completedAt: number | null
}

export class InFlightMap {
  private readonly entries = new Map<string, Entry>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: InFlightOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_INFLIGHT_CAPACITY
    this.ttlMs = options.ttlMs ?? DEFAULT_INFLIGHT_TTL_MS
    this.now = options.now ?? (() => Date.now())
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    if (sweepIntervalMs > 0) {
      this.timer = setInterval(() => {
        this.sweep()
      }, sweepIntervalMs)
      // Node（vitest/SSR）下定时器默认吊住进程；调用方显式 dispose 之前
      // 它都不该影响退出。
      ;(this.timer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /** 未过期记录总数（含已完成的），用于自检/调试 */
  get size(): number {
    return this.entries.size
  }

  /** 真正在飞行的条数——容量只看它（§10.2 容量=并发上限） */
  get liveCount(): number {
    let n = 0
    for (const entry of this.entries.values()) {
      if (!entry.settled) n += 1
    }
    return n
  }

  /** 同一 key 的调用方共享同一个 promise 对象（不是等值副本） */
  peek(key: string): Promise<unknown> | undefined {
    const entry = this.entries.get(key)
    return entry && !entry.settled ? entry.promise : undefined
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /**
   * 同 key 并发共享一条；无记录则新建（容量打满抛 ERR_INFLIGHT_FULL）。
   * 完成即允许下一轮同名请求重新发起（无 cache），完成记录只留到 TTL 到期。
   */
  acquire<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key)
    if (existing && !existing.settled) return existing.promise as Promise<T>

    if (this.liveCount >= this.capacity) {
      throw new IpcError(ERR_INFLIGHT_FULL, `in-flight 已达上限 ${this.capacity}（key=${key}）`)
    }

    // 记一条在飞行的占位再调用 factory：factory 同步抛错时不会留下一条
    // 永远 settled=false 的记录卡住容量。
    const entry: Entry = { promise: undefined as unknown as Promise<unknown>, settled: false, completedAt: null }
    this.entries.set(key, entry)
    try {
      entry.promise = factory().then(
        (value) => {
          entry.settled = true
          entry.completedAt = this.now()
          return value
        },
        (err: unknown) => {
          entry.settled = true
          entry.completedAt = this.now()
          // 失败原样传播：这里只负责记账，不替换错误内容（规矩 12）
          throw err
        },
      )
    } catch (err) {
      entry.settled = true
      entry.completedAt = this.now()
      throw err
    }
    return entry.promise as Promise<T>
  }

  /**
   * 给在飞行的记录补注（§10.3 start_agent_event_stream 的 lastSequence
   * 校验所需）：补注后 key 变了，因此**不是**对原 key 的更新——已登记的那条
   * in-flight 仍然共享，新的调用按新 key 另发一条，Rust 侧 AttachState 负责
   * 拒同 runId 重复 attach。
   */
  annotate(baseKey: string, payload: unknown, separator = '#'): string {
    const key = `${baseKey}${separator}${fnv1a32(stableStringify(payload))}`
    const entry = this.entries.get(baseKey)
    if (entry) this.entries.set(key, entry)
    return key
  }

  /** 清掉超过 TTL 的完成记录，返回清除条数（公开是为了让单测确定性驱动） */
  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      // 在飞行的记录永不清理：它们就是正在用的
      if (!entry.settled) continue
      if (entry.completedAt !== null && now - entry.completedAt >= this.ttlMs) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** 整体丢弃（模块卸载/测试隔离用） */
  clear(): void {
    this.entries.clear()
  }

  /** 停掉后台定时器并清空记录（模块卸载 / 测试隔离用） */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.entries.clear()
  }
}

/** 全应用共享的实例（invokeOnce 的默认通道） */
export const defaultInflightMap = new InFlightMap()

/**
 * 唯一的 invoke 出口：同 method+payload 的并发调用共用一条 IPC。
 * 失败（Rust Err / IPC 断连 / 容量打满）一律 reject——调用方自己决定
 * 是重试、提示还是崩，绝不在这里兜一个默认值（规矩 12）。
 */
export async function invokeOnce<T>(method: string, args?: InvokeArgs): Promise<T> {
  return defaultInflightMap.acquire(inflightKey(method, args), () => invoke<T>(method, args))
}
