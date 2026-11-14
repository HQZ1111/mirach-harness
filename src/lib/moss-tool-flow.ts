/**
 * MOSS Live 工具调用的协议态机（纯模块，无 DOM/IPC——传输与执行都注入，
 * 2026-11-13；单测覆盖去重/取消/限流/确认续跑/超时全路径）。
 *
 * 协议职责（platform.moss.cn moss-live reference）：
 * - 声明：`session.update`（session.tools 整表替换）——attach 后调用一次。
 * - 调用到达：`response.function_call_arguments.done`（call_id + arguments
 *   JSON 串；async 工具多带 task_id/revision）。**每 call_id 只执行一次**
 *   （response.done 可能重播同一调用）。
 * - 回报：`conversation.item.create`（item.type=function_call_output）→
 *   vendor 确认 `conversation.item.created` → `response.create`
 *   `{response:{call_ids:[…]}}` 续跑回复。sync/async 同一条回报路径。
 * - async 生命周期：≤128 任务/会话（含已结束）、≤4 并发、≤120s/次执行；
 *   超限 → 失败输出（协议要求失败也返回可用描述）。
 *   `response.function_call.cancel_requested` 到达 → 停止跟踪该调用，
 *   **迟到的结果直接丢弃**（事件不保证宿主执行器真停了——宿主侧不强杀，
 *   只丢弃回报，cron 作业本身照常跑完，如实口径）。
 * - 客户端发起的 `session.tool_task.revise` / `.cancel` 需要触发 UI（改参
 *   重跑/撤销），本轮无该 UI → **不实现这两个客户端命令**（不做死代码）；
 *   服务端确认 `session.tool_task.updated` 无需动作，session 层自行忽略。
 *
 * 失败可见（规矩 12）：执行器 throw / 超时 / 限流都转成 `{"ok":false,…}`
 * 工具输出交回（模型如实转述），同时 console.warn + onNotice——不静默。
 */

import { validateToolDecls, type MossToolDecl } from './moss-tools'

/** 单次执行上限（协议 ≤120s/次）。超时 = 交付失败输出并停止跟踪；迟到的
 *  真结果丢弃（vendor 侧也会 cancel_requested(reason=timeout)，两边一致）。 */
export const TOOL_TIMEOUT_MS = 120_000
/** 协议并发上限：≤4 个进行中的异步任务。 */
export const MAX_CONCURRENT_ASYNC = 4
/** 协议会话上限：≤128 个异步任务（含已结束）。 */
export const MAX_ASYNC_TASKS_PER_SESSION = 128

/** 宿主执行器：工具名 + 已解析参数 → 整形后的输出文本。throw = 失败输出。 */
export type MossToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>

/** 外发事件（经 MossLiveSession.sendRawEvent → pi_voice_moss_send_text）。 */
export interface MossOutboundEvent {
  action: string
  [key: string]: unknown
}

interface AsyncInfo {
  taskId: string
  revision: number
  executionMode: string
}

/**
 * executing = 执行器在跑；awaiting-confirm = 输出已交付等确认；
 * continued = 已续跑（终态）；discarded = 取消（终态，迟到结果丢弃）。
 */
type CallState = 'executing' | 'awaiting-confirm' | 'continued' | 'discarded'

interface CallRecord {
  callId: string
  name: string
  asyncInfo: AsyncInfo | null
  state: CallState
  /** finishedAsync 只计一次（128 上限含已结束；去重靠这面旗）。 */
  settled: boolean
}

export class MossToolFlow {
  private records = new Map<string, CallRecord>()
  /** 已结束的异步任务数（协议上限含已结束；镜像 vendor 的会计口径）。 */
  private finishedAsync = 0
  /** 收到 cancel_requested 的调用（done 后到的调用也丢弃）。 */
  private cancelledCallIds = new Set<string>()

  constructor(
    private opts: {
      tools: MossToolDecl[]
      executor: MossToolExecutor
      send: (event: MossOutboundEvent) => void
      /** 非致命告警面板（panel onError(message,false) 同路）——失败可见。 */
      onNotice?: (message: string) => void
      /** 测试注入（缺省全局 setTimeout/clearTimeout）。 */
      setTimeoutFn?: (fn: () => void, ms: number) => unknown
      clearTimeoutFn?: (t: unknown) => void
      timeoutMs?: number
    },
  ) {
    const errors = validateToolDecls(opts.tools)
    if (errors.length > 0) {
      throw new Error(`工具声明不合法（vendor 会整表拒绝）：${errors.join('; ')}`)
    }
  }

  /** attach 后声明工具表（协议：session.update 整表替换）。 */
  announce(): void {
    this.opts.send({ action: 'session.update', session: { tools: this.opts.tools } })
  }

  /** 本态机消费的事件名（session 层先问再委托）。 */
  owns(action: string): boolean {
    return (
      action === 'response.function_call_arguments.done' ||
      action === 'conversation.item.created' ||
      action === 'response.function_call.cancel_requested'
    )
  }

  handleEvent(action: string, data: Record<string, unknown>): void {
    switch (action) {
      case 'response.function_call_arguments.done':
        this.onCallArgumentsDone(data)
        return
      case 'conversation.item.created':
        this.onItemCreated(data)
        return
      case 'response.function_call.cancel_requested':
        this.onCancelRequested(data)
        return
      default:
        return
    }
  }

  // ── 调用到达 ─────────────────────────────────────────────────────────────

  private onCallArgumentsDone(data: Record<string, unknown>): void {
    const callId = typeof data.call_id === 'string' ? data.call_id : ''
    if (!callId) {
      this.notice('function_call 缺 call_id，丢弃')
      return
    }
    if (this.cancelledCallIds.has(callId)) {
      this.notice(`调用 ${callId} 已被取消（cancel_requested 先到），丢弃`)
      return
    }
    // 去重：每 call_id 只执行一次（response.done 会重播同一调用）
    if (this.records.has(callId)) return

    const name = typeof data.name === 'string' ? data.name : ''
    if (!name) {
      this.deliverFailure(callId, 'function_call 缺 name')
      return
    }

    const asyncInfo: AsyncInfo | null =
      typeof data.task_id === 'string' && data.task_id
        ? {
            taskId: data.task_id,
            revision: typeof data.revision === 'number' ? data.revision : 1,
            executionMode: typeof data.execution_mode === 'string' ? data.execution_mode : '',
          }
        : null

    if (asyncInfo) {
      const inFlight = this.countInFlightAsync()
      if (this.finishedAsync + inFlight >= MAX_ASYNC_TASKS_PER_SESSION) {
        this.deliverFailure(callId, `异步任务已达会话上限（${MAX_ASYNC_TASKS_PER_SESSION}，含已结束）`, asyncInfo)
        return
      }
      if (inFlight >= MAX_CONCURRENT_ASYNC) {
        this.deliverFailure(callId, `异步任务并发已达上限（${MAX_CONCURRENT_ASYNC}），稍后再试`, asyncInfo)
        return
      }
    }

    let args: Record<string, unknown> = {}
    if (typeof data.arguments === 'string' && data.arguments.trim()) {
      try {
        const parsed: unknown = JSON.parse(data.arguments)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          this.deliverFailure(callId, 'arguments 必须是 JSON 对象', asyncInfo)
          return
        }
        args = parsed as Record<string, unknown>
      } catch {
        this.deliverFailure(callId, 'arguments 不是合法 JSON', asyncInfo)
        return
      }
    }

    const record: CallRecord = { callId, name, asyncInfo, state: 'executing', settled: false }
    this.records.set(callId, record)

    const setTimeoutFn = this.opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimeoutFn = this.opts.clearTimeoutFn ?? ((t) => clearTimeout(t as number))
    const timer = setTimeoutFn(() => {
      // 超时 = 交付失败输出并停止跟踪（state → awaiting-confirm，迟到的真
      // 结果经 onExecuted 的 state 守卫丢弃）
      this.onExecuted(record, `工具 ${name} 执行超时（${(this.opts.timeoutMs ?? TOOL_TIMEOUT_MS) / 1000}s）`)
    }, this.opts.timeoutMs ?? TOOL_TIMEOUT_MS)

    void Promise.resolve()
      .then(() => this.opts.executor(name, args))
      .then(
        (output) => {
          clearTimeoutFn(timer)
          this.onExecuted(record, null, output)
        },
        (e: unknown) => {
          clearTimeoutFn(timer)
          this.onExecuted(record, e instanceof Error ? e.message : String(e))
        },
      )
  }

  /** 执行落地（成功/失败/超时）。state 已非 executing（取消/已交付）= 迟到
   *  结果，直接丢弃——不重复交付（timeout 先交付过失败输出）。 */
  private onExecuted(record: CallRecord, error: string | null, output?: string): void {
    if (record.state !== 'executing') {
      this.notice(`调用 ${record.callId}（${record.name}）的迟到结果已丢弃`)
      return
    }
    const text =
      error !== null
        ? JSON.stringify({ ok: false, error })
        : (output ?? JSON.stringify({ ok: false, error: '执行器返回空输出' }))
    if (error !== null) {
      console.warn(`[moss-tools] ${record.name} 失败: ${error}`)
    }
    record.state = 'awaiting-confirm'
    this.settleAsync(record)
    this.opts.send({
      action: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: record.callId, output: text },
    })
  }

  /** 执行落地（完成/失败/取消）都算一次已结束的异步任务（协议上限含已结束）。 */
  private settleAsync(record: CallRecord): void {
    if (record.asyncInfo && !record.settled) {
      record.settled = true
      this.finishedAsync += 1
    }
  }

  // ── vendor 确认 / 取消 ───────────────────────────────────────────────────

  private onItemCreated(data: Record<string, unknown>): void {
    const item = data.item
    if (typeof item !== 'object' || item === null) return
    const callId = (item as Record<string, unknown>).call_id
    if (typeof callId !== 'string' || !callId) return
    const record = this.records.get(callId)
    if (!record || record.state !== 'awaiting-confirm') return
    if (this.cancelledCallIds.has(callId)) {
      // 输出已交付但取消先判——不再续跑
      record.state = 'discarded'
      return
    }
    this.opts.send({ action: 'response.create', response: { call_ids: [callId] } })
    record.state = 'continued'
  }

  private onCancelRequested(data: Record<string, unknown>): void {
    const callId = typeof data.call_id === 'string' ? data.call_id : ''
    if (!callId) return
    this.cancelledCallIds.add(callId)
    const record = this.records.get(callId)
    if (record && record.state === 'executing') {
      // 停止跟踪并丢弃迟到结果（事件不保证执行器真停——宿主侧不强杀）
      record.state = 'discarded'
      this.settleAsync(record)
    }
    // 已交付（awaiting-confirm）的取消：记录旗标，确认到达时不再续跑
  }

  // ── 杂项 ─────────────────────────────────────────────────────────────────

  private countInFlightAsync(): number {
    let n = 0
    for (const r of this.records.values()) {
      if (r.asyncInfo && r.state === 'executing') n += 1
    }
    return n
  }

  /** 限流/形状失败的快速回报（不执行器，同一条回报路径）。async 占位同样
   *  计入 finished（任务在 vendor 侧已存在，上限含已结束）。 */
  private deliverFailure(callId: string, error: string, asyncInfo: AsyncInfo | null = null): void {
    console.warn(`[moss-tools] 调用 ${callId} 失败: ${error}`)
    this.notice(error)
    // 占位记录（防同 call_id 重播再走一次）；awaiting-confirm 态使 vendor
    // 确认到达时正常续跑（模型能把失败说出来）
    const record: CallRecord = { callId, name: '', asyncInfo, state: 'awaiting-confirm', settled: false }
    this.settleAsync(record)
    this.records.set(callId, record)
    this.opts.send({
      action: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: false, error }),
      },
    })
  }

  private notice(message: string): void {
    console.warn(`[moss-tools] ${message}`)
    this.opts.onNotice?.(message)
  }
}
