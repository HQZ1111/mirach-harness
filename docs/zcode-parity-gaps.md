# 对话对齐 ZCode：宿主（pi rust 引擎）侧缺口清单

> 2026-11-16 · **范围修正**：本文的「宿主侧」= **pi rust 引擎**
> （`G:\pi-rust-main`：`rpi-ai` / `rpi-agent` / `rpi-harness` / `rpi-cli`），
> **不是** Tauri 壳（mirach-harness）。
>
> 第一版误按 tauri 侧（`src-tauri/src/agui.rs` + 前端投影）写，已按本口径重写；
> tauri/前端遗留项收进 §5 附录（下游，不是本清单的「宿主」）。

## 0. 结论

- **「每个思考后出正文」是 pi 的落盘形状**：每次工具循环落一条 assistant 消息，
  内容几乎恒为 `thinking + text + toolCall…`（实测
  `C:\Users\Administrator\.rpi\sessions\--C--Users-Administrator--\2026-11-15T12-13-00-771Z_01a1df20-…jsonl`：
  68+ 段 assistant 消息全为此形）。**这是模型输出，不是引擎 bug。**
- ZCode 的差别不在「有没有这段正文」，而在它的 **CLI 把会话投影成「行」**：
  `RowBase{rowId, turnId, productTurnId, entityId, createdAt, actions}` +
  `turnHeader / assistantText / reasoning / toolCall / subagent / hookInvocation /
  timelineMarker / artifact`（`G:\ZCode-main\packages\shared\src\zcode-protocol-v4\rows.ts:16-37, 57-116, 174-242`）。
  行是自包含的、`rowId` 是事件日志的确定性纯函数、**turn 只是行上的标签不是容器**；
  「过程正文」与「最终正文」靠行身份/actions 判定，不靠猜。
- **pi 缺的正是这层数据面与标记**：没有 row / productTurn / workSegments / 行级
  state·时间 / 最终正文标记。下游（mirach）只能启发式「最后一条非空 text = 正文」
  ——于是出现「每个思考后的过程正文被当正文」、工作段边界不准、运行中无法实时
  切正文等观感问题。
- **好消息**：原始事件是齐的——`AssistantMessageEvent` 已有
  `Start / TextStart / TextDelta / TextEnd / ThinkingStart / ThinkingDelta /
  ThinkingEnd / ToolCallStart / ToolCallDelta / ToolCallEnd / Done / Error`
  且带 `content_index`（`rpi-ai/src/types.rs:915-978`）。缺的是**投影层、持久化、
  对外协议**，不是模型事件。

## 1. ZCode 的目标数据面（UI 依赖）

| 行类型 | 关键字段（rows.ts） |
|---|---|
| RowBase | `rowId`（session 内单调、永不复用、事件日志的确定性纯函数）、`turnId`、`productTurnId`、`entityId`、`createdAt/createdAtSeq`、`actions{canFork,canEdit,canRetry,canRewindFiles}`（`:16-37`） |
| turnHeader | `origin`、`executionKind`、`state`（running / completedSuccess / completedInterrupted / failed）、`startedAt/endedAt/activeMs`、`outputTokens`、`modelDurationMs/toolDurationMs/otherDurationMs`、`workSegments[{segmentId,triggerEntityId,startedAt,endedAt,activeMs}]`、`fileChanges`（`:57-116`） |
| assistantText | `text`、`state`（streaming / complete / interrupted / failed）、`assistantResponseId`、`model`、`feedback`（`:174-188`） |
| reasoning | `text`、`state`（streaming / complete / interrupted）、`durationMs`、`assistantResponseId`（`:190-199`） |
| toolCall | `toolCallId/toolName`、`status`（inputStreaming / pendingApproval / running / success / error / cancelled）、`startedAt/endedAt`、`input/output/display/progress/error`（`:213-242`） |
| 其余 | artifact / subagent / hookInvocation / timelineMarker（`:246-466`） |

结构规则（`rows.ts:3-5`）：**行自包含**（渲染任一行不需看别的行）；结构变化换整行
（`row.upserted`），文本增长用 append（`row.delta`）；**turn 是行上的标签不是容器**。
guide 语义（`:101-103`）：**guide 不切 product turn**；一个 drain 边界 FIFO 取出的
全部 guide 共用首条开启的视觉工作段，段边界由 CLI 给 `triggerEntityId`，客户端零归属逻辑。

## 2. pi 现状（事件 / 消息 / 会话）

- **事件**：`AgentEvent` = AgentStart / AgentEnd / RetryScheduled / TurnStart /
  TurnEnd{message, tool_results, pending_messages} / MessageStart{message, message_id} /
  MessageUpdate{message, message_id, assistant_message_event} / MessageEnd{message, message_id} /
  ToolExecutionStart/Update/End（`rpi-agent/src/events.rs:23-108`）。**没有 error 变体。**
- **消息**：`AssistantMessage` = `content: Vec<Content>`（TextContent / ThinkingContent /
  ToolCall）+ usage + `stopReason` + `errorMessage` + `timestamp`
  （`rpi-ai/src/types.rs:57-229, 688+`）。**内容块没有 id / 时间戳 / 状态。**
- **会话**：`LaneRecord` = `assistant_frame` / `message` / `operation_started` /
  `operation_finished` / …（`rpi-harness/src/session/types.rs:1102-1165`）；
  `OperationIntent` = Run / Compaction / Navigation（`:737-774`）；
  `AssistantFrame` 是**进度帧不是历史**（`:915-960`），不含块级起止时间。
  **没有 turn / productTurn / workSegment / row 实体。**
- **注入**：steering / follow-up 以普通 user message 注入，`message_id: None`
  （`rpi-agent/src/agent_loop.rs:244-285`）→ **持久化后没有 guided 标记**。
- **错误**：`StopReason::Error | Aborted` 时发
  `TurnEnd{message: 错误 assistant 消息, tool_results: [], pending_messages}`
  （`agent_loop.rs:305-314`），错误正文/原因只在 message 里。

## 3. 缺口清单（pi 侧）

### P1 没有「会话行」投影（row model）
- 任何 UI 必须自己从 message blocks 推「行」（mirach 的 `pi-hydrate.ts` /
  `turn-actor.ts` 就在做这件事），过程正文/最终正文/工具/思考的边界靠猜。
- 证据：pi 无 `ConversationRow` 等价物（全仓 grep 0 命中）；session 侧只有 LaneRecord。
- **建议**：在 `rpi-harness` 增 `session::projection`（纯函数：branch entries → `Vec<Row>`）：
  `Row{row_id: entryId+contentIndex, turn_id, product_turn_id, kind, state, created_at,
  completed_at, text/payload}`。`row_id` 由 `seq + content_index` 确定性生成（对应
  ZCode「事件日志的确定性纯函数」）。
- 验收：给定真实会话 jsonl，投影行序列与 ZCode row 序列一一对应（文本/思考/工具/轮尾）。

### P2 没有 product turn / workSegments
- ZCode：`turnHeader`（productTurnId、activeMs、state、executionKind）+ `workSegments`
  （guide 分组、各段 activeMs）。
- pi：只有 run（OperationStarted/Finished, runId）与 agent turn（TurnStart/End）；
  没有「用户轮」实体；steering/follow-up 注入后无 guided 标记（§2）。
- **建议**：turn 聚合（一条 user 输入开启 → 轮结束关闭；注入消息按 drain 边界开子段并带
  `segment_id/trigger_entity_id`），落盘为 turn 级 record（或投影缓存）。
- 验收：运行中插话的会话重放后仍能切出两段，各段有独立 activeMs。

### P3 没有块级状态 / 计时（重开即丢）
- ZCode：行级 `state` + `createdAt`；`reasoning.durationMs`；toolCall `startedAt/endedAt`。
- pi：块事件有 Start/End（流内），但落盘只有 `entry.timestamp`；AssistantFrame 只是进度帧。
- **建议**：`AgentEvent::MessageUpdate` 的块 Start/End 带上（或由 harness 记录）
  `started_at/completed_at`；session 侧把块级时间写进条目元数据，供冷启动投影用。
- 验收：重启后「思考 N 秒 / 已工作 N 秒」与实时一致。

### P4 没有「最终正文」/ actions 标记
- ZCode：`latestAssistantTextRow = actionAssistantTextRow（canFork/canRetry）??
  (!isRunning && 最后一行是文本 ? 最后一行 : undefined)`
  （`packages/ui/src/v4/conversationTurnRenderUnits.ts:262-270`）；行自带 actions。
- pi：`AssistantMessage` 只有 stopReason/usage；哪条 text 是本轮答案没有标记。
- **建议**：轮结束（StopReason::Stop/Length）时在投影里标记 final text row；
  actions 由 CLI/引擎给（canRetry 至少可由 stopReason 推出）。
- 验收：轮次以工具收尾时，投影能明确「无最终正文」（而不是让消费端猜）。

### P5 运行期错误没有一等事件
- pi：错误只在 `AssistantMessageEvent::Error`（MessageUpdate 内）或
  `TurnEnd.message(stopReason=Error/Aborted)` / `AgentEnd.messages` 里。
- ZCode：行/UI 有 failed 态 + 重试动作。
- **建议**：`AgentEvent::TurnError{reason, error_message, turn_id}`（或在 `TurnEnd`
  加 `stop_reason/error` 字段）。
- 验收：provider 403 配额错误在事件流里显式可辨（不是只藏在 message 里）。

### P6 没有 subagent / hook / timeline marker 行
- ZCode 行集合含 `SubagentRow` / `HookInvocationRow` / `TimelineMarkerRow`
  （modelChange / compaction 等）。
- pi：subagent 生命周期在 hub/jobs（会话流之外）；hook 调用无会话行；compaction 只有
  OperationIntent/事件，没有行。
- **建议**：把三者纳入投影（subagent spawn/finish 事件、hook 调用记录、marker）。
- 优先级：P3（显示层已部分自建，非阻塞）。

### P7 持久化是操作日志，不是可渲染行序列
- `LaneRecord` 是 append-only 操作日志（用于崩溃恢复/分支），UI 首屏必须重放推导；
  ZCode CLI 直接落 row 快照 / row 事件（`row.upserted` + `row.delta`）。
- **建议**：对外 API 返回投影行（`session.conversation_rows()`，投影可重建、不新增真源）；
  事件面可继续用现有 AgentEvent，但行 id 必须稳定。
- 验收：冷启动首屏不需要客户端再实现一套 `splitWorkParts`。

## 4. 统一改造顺序（pi 侧，一次 PR）

1. **P1**：`session::projection` 纯函数 + 真会话 fixture 单测（先只覆盖 message → row）。
2. **P2/P3**：事件补 `message_id`（已有，用起来）、块级 `startedAt/completedAt`、注入
   消息 `injected/segment_id`；session 落盘补块级时间。
3. **P4/P5**：turn 结束时标 final text row + `TurnError`/`TurnEnd.stop_reason`。
4. **P7**：对外 `conversation_rows()` + 行事件（或 AG-UI 映射的稳定 row id）。
5. **P6**：subagent/hook/marker 行（可后补）。

## 5. 附录：下游 tauri/前端遗留（不是本次「宿主」）

这些是**消费端**问题；pi 投影行落地后大多可删/变薄，但短期仍可单独修：

- `src-tauri/src/agui.rs`：`MessageUpdate` 的 `TextStart/TextEnd/ThinkingStart/
  ThinkingEnd/ToolCallEnd/Done/Error` 未映射（`:400-414`；测试 `:963-989` 钉住）；
  `MessageStart/End` 的 `message_id` 丢弃（`:396, :415`）；`TurnEnd` 只发 STEP_FINISHED（`:441`）。
- 前端：`splitWorkParts` 的「最后一条非空 text = 正文」启发式（`work-segment.ts:157-176`）；
  运行中全部压 history（`work-parts.aui.tsx:491-506`）；错误 assistant 消息被
  `pi-hydrate.ts:103-154` 吞掉（空消息）。

## 6. 非目标

- provider/model 层（块事件已齐，不用改）。
- ZCode UI 样式/间距（另有 tokens 轮）。
- 多网关 / 远端 profile / Bot Desktop（宿主无对应概念）。

## 7. 证据与复现

- **形状样本**：`C:\Users\Administrator\.rpi\sessions\--C--Users-Administrator--\2026-11-15T12-13-00-771Z_01a1df20-07dd-743f-925e-1c6a98ea0c49.jsonl`
  （`E:\Temp\inspect-session2.mjs` 打印每条 assistant 的块序列）。
- **错误样本**：同目录 `2026-11-16T07-12-45-668Z_01a1e333-…jsonl`（第 4/6 条：
  `content:[], stopReason:"error", errorMessage:"http error 403 … insufficient_quota"`，
  UI 无显示）。
- **pi 源**：`rpi-ai/src/types.rs:915-978`、`rpi-agent/src/events.rs:23-108`、
  `rpi-agent/src/agent_loop.rs:244-314`、`rpi-harness/src/session/types.rs:737-1165`。
- **ZCode 源**：`packages/shared/src/zcode-protocol-v4/rows.ts:16-116,174-242`、
  `packages/ui/src/v4/conversationTurnRenderUnits.ts:262-270`、
  `conversationTurnWorkSegments.ts:89-116,179-246`。
