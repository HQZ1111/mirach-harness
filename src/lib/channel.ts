/**
 * Channel 通道前端封装（L2 桥接层第二通道，架构 §10.1 / §11.2）。
 *
 * 职责收窄的来由（§11.2 表格，源码实锤）：Tauri `Channel` 自带按序投递
 * ——每条消息带 index，JS 端内部缓冲乱序、missing 时不触发 onmessage
 * （见 node_modules/@tauri-apps/api/core.js 的 Channel 实现）。所以本文件
 * 的 SeqTracker **不**做"每条消息的乱序窗口"，只负责**跨 attach 边界的
 * 续接**：记住本 attach 生命周期内连续收到的最大 seq，空洞时把 maxSeq 报给
 * 上层，由上层发起一次 attachStream(runId, maxSeq)（Rust 按 RunBuffer
 * .latest_seq 裁 replay 起点）。
 *
 * 分流（§11.2 末条 + §11.1 纪律）：
 * - assistant_output / tool_output → onToken：TokenStream 纯 append，
 *   tool_output 按 toolCallId 索引（同一工具的多次 delta 归同一部件）。
 * - 其余控制帧 → onControl：XState actor 是 run 生命周期的唯一消费者，
 *   本文件只派发、不投影、不缓存（组件禁止直接订阅事件流）。
 */

import { Channel } from '@tauri-apps/api/core'

import type { AgentEvent, AgentEventKind, RunId, Seq, ToolCallId } from './agent-protocol'

export type { AgentEvent, AgentEventKind, RunId, Seq, ToolCallId } from './agent-protocol'

/** 非 token 的控制帧（XState 消费面）——联合类型穷举，漏一种编译即红 */
export type ControlEventKind = Exclude<AgentEventKind, { type: 'assistant_output' | 'tool_output' }>

/** 本文件派发的事件总形态：token 面已拍平成扁平 chunk */
export type DispatchEvent =
  | {
      readonly kind: 'token'
      readonly runId: RunId
      readonly seq: Seq
      /** 工具输出的索引键；主文本流为 null（assistant_output 恒为 null） */
      readonly toolCallId: ToolCallId | null
      readonly delta: string
    }
  | { readonly kind: 'control'; readonly runId: RunId; readonly seq: Seq; readonly control: ControlEventKind }

/** 通道关闭原因：终止控制帧（= Rust 侧 Channel 已 drop）或上层显式收摊 */
export type CloseReason = 'run_ended_ack' | 'run_gone' | 'closed'

export interface RunChannelHandlers {
  /** TokenStream 回调：纯 append，不解析内容 */
  onToken(chunk: DispatchEvent & { kind: 'token' }): void
  /** XState 回调：send 语义，state 侧拒绝重复 */
  onControl(event: DispatchEvent & { kind: 'control' }): void
  /**
   * 出现 seq 空洞（seq > maxSeq+1）：上层据此发起
   * attachStream(runId, from)。不传则无人续接——不会有人偷偷补帧。
   */
  onReseat?(from: Seq): void
  /** 订阅已清理（终止帧或 close()），此后本 run 的消息一律忽略 */
  onClose?(reason: CloseReason): void
  /** 收到不合约的帧（visible 失败，不是静默丢弃；规矩 12） */
  onProtocolError?(frame: unknown): void
}

// ── 运行时守卫 ───────────────────────────────────────────────────────────────

/** 结构检查（kind 的判别 tag 全集）：Rust 侧加了新 kind 而前端没跟上时立刻响 */
const CONTROL_TAGS = [
  'run_started',
  'run_finished',
  'run_aborted',
  'run_error',
  'snapshot_restored',
  'run_ended_ack',
  'run_gone',
] as const

function isAgentEventKind(value: unknown): value is AgentEventKind {
  if (typeof value !== 'object' || value === null) return false
  const kind = value as { type?: unknown }
  if (kind.type === 'assistant_output' || kind.type === 'tool_output') {
    const hasDelta = typeof (value as { delta?: unknown }).delta === 'string'
    // ToolOutput 必带 toolCallId ⭐（§9 铁律 1）——缺了就是坏帧，不能放行
    return kind.type === 'assistant_output' ? hasDelta : hasDelta && typeof (value as { toolCallId?: unknown }).toolCallId === 'string'
  }
  return (CONTROL_TAGS as readonly string[]).includes(kind.type as string)
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false
  const ev = value as { runId?: unknown; seq?: unknown; kind?: unknown }
  return typeof ev.runId === 'string' && typeof ev.seq === 'number' && Number.isInteger(ev.seq) && isAgentEventKind(ev.kind)
}

// ── SeqTracker（§11.2） ──────────────────────────────────────────────────────

/** 拒绝原因：duplicate = 重放/旧帧；gap = 窗口空洞（需要 reseat） */
export type IngestResult =
  | { readonly accepted: true; readonly event: AgentEvent; readonly maxSeq: Seq; readonly needsReseat: boolean }
  | {
      readonly accepted: false
      readonly reason: 'duplicate' | 'gap'
      readonly maxSeq: Seq
      readonly needsReseat: boolean
    }

/**
 * 单 attach 生命周期的 seq 游标。seq per-run 单调从 1 起（agent-protocol）。
 *
 * - maxSeq 只沿**连续**窗口推进：空洞帧不推进也不派发。
 *   越过空洞把 maxSeq 抬到空洞之后，续接点就落在空洞之后，中间那几帧永久
 *   丢失——续接必须从空洞之前报。
 * - 空洞帧本身**不派发**给 TokenStream：它跳过了中间帧，落进 append 缓冲
 * 就会与后续文本错位；交给 replay 重投才是保序的那条路。
 */
export class SeqTracker {
  private seq: Seq

  /** 重放/续接起点（§11.3 第 3 步：首次 attach 报 0，Rust 当 null 处理） */
  private holeAt: Seq | null = null

  /** 续接起点：本 attach 生命周期内已连续收到的最大 seq */
  constructor(startSeq: Seq = 0) {
    this.seq = startSeq
  }

  get maxSeq(): Seq {
    return this.seq
  }

  /** 出现窗口空洞且尚未补齐 → 上层该发一次 attachStream(maxSeq) */
  needsReseat(): boolean {
    return this.holeAt !== null
  }

  /** 空洞落在哪一帧（调试/日志用；补齐后清空） */
  get holeSeq(): Seq | null {
    return this.holeAt
  }

  ingest(seq: Seq, event: AgentEvent): IngestResult {
    if (seq <= this.seq) {
      // 重放/旧帧：Tauri Channel 内已保序，能到这里说明是 Rust 主动重放
      // （attach 续接）或上层重复投递——一律丢弃，幂等。
      return { accepted: false, reason: 'duplicate', maxSeq: this.seq, needsReseat: this.needsReseat() }
    }
    if (seq > this.seq + 1) {
      this.holeAt = seq
      return { accepted: false, reason: 'gap', maxSeq: this.seq, needsReseat: true }
    }
    this.seq = seq
    // 补齐到当初那个跳点：连续性恢复，标记自动解除（不解除会反复重挂）
    if (this.holeAt !== null && seq >= this.holeAt) this.holeAt = null
    return { accepted: true, event, maxSeq: this.seq, needsReseat: this.needsReseat() }
  }

  /** 上层已就该空洞发起过 attachStream：清标记，避免补帧迟迟不来时反复重挂 */
  markReseated(): void {
    this.holeAt = null
  }
}

// ── Channel 封装 ─────────────────────────────────────────────────────────────

/**
 * Tauri 3 alpha 的 JS `Channel` **没有** drop 回调：源码里只在收到
 * `{index, end}` 帧时内部 cleanupCallback（unregisterCallback），不通知 JS
 * （node_modules/@tauri-apps/api/core.js）。所以"Channel 被 drop"在前端
 * 唯一可观测的代理是终止控制帧（run_ended_ack / run_gone）+ 上层显式
 * close()；两者都走同一条幂等的清理路径。
 */
function isClosingKind(type: string): type is CloseReason {
  return type === 'run_ended_ack' || type === 'run_gone'
}

export interface RunChannel {
  readonly runId: RunId
  /** 传给 Rust `start_agent_event_stream(runId, lastSequence, onEvent)` 的句柄 */
  readonly channel: Channel<AgentEvent>
  readonly closed: boolean
  /** 续接起点（attach 上报用） */
  readonly maxSeq: Seq
  needsReseat(): boolean
  /** 上层已就该空洞发起过 attachStream（或已改走 SnapshotRequired 分支）：
   * 清标记，避免补帧迟迟不来时反复重挂 */
  markReseated(): void
  /** 幂等：解绑 onmessage 并清掉索引订阅，之后本 run 消息一律忽略 */
  close(reason?: CloseReason): void
}

export function openRunChannel(runId: RunId, handlers: RunChannelHandlers): RunChannel {
  const tracker = new SeqTracker(0)
  let closed = false

  const reportProtocolError = (frame: unknown): void => {
    if (handlers.onProtocolError) {
      handlers.onProtocolError(frame)
      return
    }
    // 不静默丢：坏帧要看得见（规矩 12 的"可见"一支）
    console.error('[channel] 不合约的 AgentEvent 帧，已忽略：', frame)
  }

  const close = (reason: CloseReason): void => {
    if (closed) return
    closed = true
    // 解绑而不是置空函数：onmessage 是 Channel 的公开写入口，留着就会在
    // run 结束后继续被 Rust 的尾部消息驱动。
    channel.onmessage = () => {
      // 已关闭：静默吞掉（关闭是有序协议的一部分，不是错误）
    }
    handlers.onClose?.(reason)
  }

  const channel = new Channel<AgentEvent>((frame) => {
    if (closed) return
    if (!isAgentEvent(frame)) {
      reportProtocolError(frame)
      return
    }
    if (frame.runId !== runId) {
      reportProtocolError(frame)
      return
    }
    const result = tracker.ingest(frame.seq, frame)
    if (!result.accepted) {
      // 只有"新空洞"这一瞬间催续接；补帧过程中 holeAt 仍挂着但缺口在收窄，
      // 再催一次 attachStream 会把 Rust 的 replay 打成重复投递。
      if (result.reason === 'gap') handlers.onReseat?.(result.maxSeq)
      return
    }
    const kind = result.event.kind
    if (kind.type === 'assistant_output') {
      handlers.onToken({ kind: 'token', runId: frame.runId, seq: frame.seq, toolCallId: null, delta: kind.delta })
    } else if (kind.type === 'tool_output') {
      handlers.onToken({
        kind: 'token',
        runId: frame.runId,
        seq: frame.seq,
        toolCallId: kind.toolCallId,
        delta: kind.delta,
      })
    } else {
      handlers.onControl({ kind: 'control', runId: frame.runId, seq: frame.seq, control: kind })
    }
    if (isClosingKind(kind.type)) {
      close(kind.type)
    }
  })

  return {
    runId,
    channel,
    get closed() {
      return closed
    },
    get maxSeq() {
      return tracker.maxSeq
    },
    needsReseat: () => tracker.needsReseat(),
    markReseated: () => tracker.markReseated(),
    close: (reason: CloseReason = 'closed') => close(reason),
  }
}
