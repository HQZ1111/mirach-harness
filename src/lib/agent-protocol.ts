/**
 * agent-protocol 前端镜像类型（L1）——与 crates/agent-protocol 的 Rust
 * 类型一一对应，是协议序列化形状的唯一前端消费依据（§9）。
 *
 * 类型纪律（铁律）：
 * - `AssistantOutput` 无 `tool_call_id`；`ToolOutput` 必带 `tool_callId`
 *   ——联合类型判别字段强制，编译期约束（Rust 侧同样编译期强制）。
 * - `seq` per-run 单调递增（从 1 起）；`RunId` 是本次轮次的唯一标识。
 * - `protocolVersion` 随 ExtensionUi 往返校验。
 * - Rust serde 序列化使用 `#[serde(rename_all = "camelCase")]` —— 本文件
 *   全部 camelCase，与 Rust 侧字段名对齐（注意 Rust `run_id` ↔ TS `runId`）。
 */

// ── 基础标量 newtype（Rust 侧为透明包装，serde 序列化为裸字符串/数字） ─────

/** 运行（轮次）唯一标识 */
export type RunId = string

/** 工具调用唯一标识（pi 的 tool_call_id） */
export type ToolCallId = string

/** 事件序号（per-run 单调递增，从 1 起） */
export type Seq = number

// ── Agent 事件（数据面） ─────────────────────────────────────────────────────

/**
 * Agent 事件——pi 引擎逐事件推给前端的唯一数据面形状。
 * 每条事件带 runId + seq（per-run 单调），供 TokenStream 按序 append。
 */
export interface AgentEvent {
  runId: RunId
  seq: Seq
  kind: AgentEventKind
}

/**
 * 事件种类判别联合。
 * - AssistantOutput 无 tool_call_id（类型系统强制，张冠李戴编译不过）
 * - ToolOutput 必带 toolCallId ⭐
 */
export type AgentEventKind =
  | { type: 'assistant_output'; delta: string }
  | { type: 'tool_output'; toolCallId: ToolCallId; delta: string }
  // ── run 生命周期控制帧 ──
  | { type: 'run_started'; source?: 'user' | 'delegate' }
  | { type: 'run_finished'; usage?: TurnUsage | null }
  | { type: 'run_aborted' }
  | { type: 'run_error'; message: string }
  // ── 恢复/结束控制帧 ──
  | { type: 'snapshot_restored' }
  | { type: 'run_ended_ack' }
  | { type: 'run_gone' }

/** 会话用量快照（RUN_FINISHED 附带；与现有 TurnUsage 形状一致） */
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  costUsd?: number
}

// ── 恢复语义（attach 时 Rust 返回的三分支） ───────────────────────────────

/** attachStream(runId, lastSequence) 的返回：三分支（§11.3 第 3 步） */
export type ResumeOutcome =
  | { type: 'replayed' } // 等 Channel 推重放事件
  | { type: 'snapshot_required' } // 起 5s 提示超时，等 SNAPSHOT_RESTORED 或 RUN_GONE
  | { type: 'run_gone' } // 清 Store

// ── 审批/问题卡（ExtensionUi） ─────────────────────────────────────────────

/** 审批/问题卡请求——pi ExtensionUiHandler 经 event-bridge 推前端 */
export interface ExtensionUiRequest {
  id: string
  /** 固定枚举：confirm/select/input/editor/notify（pi 上游语义） */
  method: string
  payload: unknown
  protocolVersion: number
}

/** 前端应答——经 invoke approve_action 回灌 */
export interface ExtensionUiResponse {
  id: string
  /** pi ExtensionUiResponse::Confirmed|Value|Cancelled 的投影 */
  value?: unknown
  cancelled: boolean
  protocolVersion: number
}

// ── 能力差异（移动端 vs 桌面，协议层表达） ─────────────────────────────────

/** 平台能力标志——移动端差异在协议层表达（§9 铁律 4） */
export interface CapabilityFlags {
  /** 桌面 ChannelSink：EventSink+SnapshotSource+Replayable 全 impl */
  replayable: boolean
  /** 快照缓存上限（桌面无上限/移动端每会话 ≤3） */
  maxSnapshotsPerSession: number | null
}
