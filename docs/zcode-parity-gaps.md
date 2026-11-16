# 对话对齐 ZCode：宿主侧缺口清单（统一改造前盘点）

> 2026-11-16 · 状态：**只盘点，不动实现**。用户口径：先把宿主侧缺的东西成文；
> 最后统一改宿主侧，然后提 PR。
>
> 触发问题：*「之前对话一直无法复刻 ZCode 的，是因为宿主侧每个思考后出正文？」*

## 0. 结论

**一半对。**「每个思考后出正文」是 **pi 的数据形状**，不是渲染 bug：

- pi 每次工具循环落**一条 assistant 消息**，形状几乎恒为
  `thinking + text + toolCall…`（实测
  `C:\Users\Administrator\.rpi\sessions\--C--Users-Administrator--\2026-11-15T12-13-00-771Z_01a1df20-…jsonl`：
  68+ 段 assistant 消息全为此形，见 §5）。
- 宿主把它并成一条 TurnMessage（`pi-hydrate.ts:5-25`），于是 parts 序列天然是
  「思考→正文→工具→思考→正文…」——**每个思考后面确实跟着一段正文**。

宿主真正的缺口不是样式，而是 **行身份**：ZCode 的 UI 协议里每条 assistant 文本是
**行**（`AssistantTextRow`，带 `entityId/state/actions`），"哪条是正文"由**行级判据**
决定（`conversationTurnRenderUnits.ts:262-270`），其余全部折进工作段
（`conversationTurnWorkSegments.ts:179-200`）。宿主没有行身份，只能启发式取
**最后一条非空 text**（`work-segment.ts:157-176`）。由此产生三个可复现的偏差：

1. **轮次以工具收尾时，中途 commentary 被当正文显示**（实测：末轮结尾是 `write`
   工具，界面把上一条短文本「heredoc 把反斜杠转义掉了。改用 write 工具写脚本。」
   拉到折叠区外当答案；ZCode 判据下"最后一行不是文本"→ 无正文、折叠默认展开）。
2. **运行中无法实时切正文**，只能把全部部件压进 history（`work-parts.aui.tsx:491-506`）
   ——ZCode 用行判据实时切（CLI 标记行运行中即可离开折叠区）。
3. **运行期 provider 错误完全不可见**（本次实测 DS key 403 配额用尽：用户气泡下
   空白，无红条/无错误文本/无重试）。

---

## 1. ZCode 的判据（对齐目标，源码位置）

| 概念 | ZCode 依据 |
|---|---|
| 最终正文 `latestAssistantTextRow` | `packages/ui/src/v4/conversationTurnRenderUnits.ts:262-270`：`actionAssistantTextRow（CLI 标记 canFork/canRetry）?? (!isRunning && 最后一行是文本 ? 最后一行 : undefined)` |
| 折叠/正文切分 | `conversationTurnWorkSegments.ts:179-200`（`segmentHistoryRows = slice(0, visibleIndex)`，`following = slice(visibleIndex+1)`） |
| 无正文时默认开合 | 同文件 `:240-246`（`visibleAssistantTextRow === undefined && flowRows.length > 0` → 默认**展开**） |
| 一个 turn 多段（guide/插话） | 同文件 `:89-116`（按 CLI `workSegments.triggerEntityId` 切段，各段独立 status/时长） |
| flow 组装 | `conversationTurnFlowItems.ts:57-89`（`assistantText` 之外的行落 `assistantHistory/assistantWork`） |
| 行渲染 | `ConversationTurnGroup.tsx:304-315` → `ConversationTurnRow` → `ConversationRowView` |

宿主已复刻的部分（**不用再动**）：工作段外壳/两层头（`work-segment.aui.tsx`）、
连续摘要组（`summary-group.aui.tsx`）、思考行「思考 持续了 N 秒」形态
（`work-parts.aui.tsx:178-200`）、轮尾操作条/文件摘要、运行中单加载位。

---

## 2. 宿主侧缺口

### A. 协议层（Rust AG-UI 映射，`src-tauri/src/agui.rs`）

**A1 块生命周期事件未映射（`G1`）。**
pi 源事件齐全：`Start / TextStart / TextDelta / TextEnd / ThinkingStart / ThinkingDelta /
ThinkingEnd / ToolCallStart / ToolCallDelta / ToolCallEnd / Done / Error`，每块是
`{Start,Delta*,End}` 三元组且带 `content_index`（`G:\pi-rust-main\crates\rpi-ai\src\types.rs:924-978`）。
宿主只映射三个 delta（`agui.rs:400-414`，其余 `_ => vec![]`；`MessageStart` 也丢弃 `:396`）。
协议表本来就要求补（`docs/pi-integration.md:187-195`：Start→`*_MESSAGE_START`、
End→`*_MESSAGE_END`，按 `contentIndex` 独立配对），当前由测试钉住现状
（`agui.rs:963-989` `message_update_block_starts_and_ends_currently_unmapped`，注释明说"将来补齐时的翻转点"）。
现状后果：前端收不到 `THINKING_TEXT_MESSAGE_START/END`、`TEXT_MESSAGE_START/END`、
`TOOL_CALL_END`；`turn-actor.ts:278-310` 只能启发式插块（注释自认 "START 缺失时 CONTENT 自立"）。
**修法**：四个块 Start/End + `ToolCallEnd` 映射进协议，`content_index` 作为**行的稳定 id**。

**A2 运行期错误事件未映射（`G2`）。** 高优先、独立可先修。
pi 以 `AssistantMessageEvent::Error{reason, error}` / `Done{reason, message}` 收尾
（`types.rs:970-977`），且 `MessageEnd{message}` 可携带 `stopReason:"error"` +
`errorMessage` 的 assistant 消息。宿主两者都没接（`agui.rs:400-415` 全丢；
`AgentEnd` 注释明说 "rpi AgentEnd 无 error 字段——provider 失败经 prompt Err 走
进程级 RUN_ERROR" → 只覆盖**进程级**失败，**运行内**失败漏网）。
实测：DS key 配额用尽 → 会话条目
`{"content":[], "stopReason":"error", "errorMessage":"http error 403: … insufficient_quota"}`
（`…01a1e333…jsonl` 第 4/6 条），UI 什么都不显示。
**修法**：`MessageEnd`/`MessageUpdate(Error|Done)` 检 `stopReason=error` → `RUN_ERROR`（带 errorMessage）。

**A3 消息边界/身份未映射（`G3`）。**
`AgentEvent::{MessageStart,MessageEnd}` 都带 `message_id`（`rpi-agent/src/events.rs:63-86`），
宿主只发一个 `TEXT_MESSAGE_END`（`agui.rs:415`），message_id 不用。一个 run 里
pi 会落**多条** assistant 消息（每轮工具一条），协议上无分界 → 前端只能并成一条。
**修法**：映射 start/end（含 message_id），前端按消息边界建"行组"（ZCode 多 assistantText 行的对偶）。

**A4 TurnEnd / pending / Retry 未接（`G4`）。**
`AgentEvent::TurnEnd{message, tool_results, pending_messages}`（`events.rs:45-60`）未映射；
`pending_messages` 正是 ZCode「排队 N 条」指示的数据面。`RetryScheduled` 已映射成
CUSTOM `provider_retry`（`agui.rs:391-394`）但前端未注册（静默忽略）——ZCode 有重试提示。

### B. 投影层（前端）

**B1 「最终正文」判据不对（`G5`）。**
宿主 `splitWorkParts` = 最后一条非空 text（`work-segment.ts:157-176`），无论后面是否还有工具、
轮是否结束。ZCode = 「轮完成 && 最后一行是文本」或 CLI 标记行（§1 表）。
分歧实例见 §0-1。**依赖 A1/A3**（行身份）才能按 ZCode 判据改。

**B2 错误 assistant 消息被 hydrate 吞掉（`G7`）。**
`pi-hydrate.ts:103-154` 只认 text/image/toolCall/thinking 块，`stopReason/errorMessage`
完全忽略；空 content → 空消息（UI 什么都不渲染，实测见 A2）。
**修法**：hydrate 识别 errorMessage → 错误部件/轮级错误；与 A2 的 live 面统一。

**B3 行级状态与计时缺失（`G8`）。**
ZCode 行带 `state`（streaming/complete/interrupted/inputStreaming/running/pendingApproval）
与 `createdAt`；「思考 N 秒」按行计。宿主 live 侧只有 tool-call 有 timing；reasoning/text
的 per-block 完成时刻拿不到（hydrate 有 timestamp，`pi-hydrate.ts:100-164`）。
**修法**：A1 的 End 事件给完成时刻，部件补 `startedAt/completedAt`（结构已有）。

**B4 多工作段（guide/插话）模型缺失（`G9`）。**
ZCode 一个 product turn 可含多段（每次 guide 取出开一段）。宿主把运行中插话的 user
消息当普通消息落盘 → hydrate 在每条 user 处断 turn（`pi-hydrate.ts:235-251`）→
一个用户轮被拆成多段，折叠/工时各算各的。**修法**：把"运行中插入"标成 turn 内段边界
（或显式接受拆段的现状并写注释）。

**B5 运行中不切正文（备注，不一定是缺口）。**
`work-parts.aui.tsx:491-506` 运行中全部部件留 history（2026-11-15 用户口径，治"散件出现
又并回"）。ZCode 在**没有** CLI 标记行时的行为相同（running 时 `latestAssistantTextRow`
为 undefined → 全部 history + 默认展开）；差异只在 CLI 标记行（运行中即可出正文）。
**修法**：A1/A3 到位后复核，有标记行时放开。

---

## 3. 统一改造顺序（建议一批做完，一次 PR）

1. **协议层（Rust + 测试翻转点）**：A1 A2 A3 A4 —— 把 `agui.rs:963` 的 `currently_unmapped`
   测试翻成真断言；`MessageEnd`/`Error` 的错误分支加用例。
2. **前端行身份**：`TurnPart` 增 `id/state`（content_index 或 message_id 派生），
   `turn-actor.ts` 按块 START/END 建行、按行维护 text/thinking（替换启发式插入）。
3. **判据切换（B1）**：`splitWorkParts` 改「轮完成 && 最后一行是文本」+（可选）CLI 标记位；
   无正文默认展开（**:240-246** 对照）。
4. **错误面（B2/A2）**：live `RUN_ERROR` + hydrate 错误部件 + 轮尾重试入口。
5. **段模型（B4）**：最后做；运行中插入消息标记段边界。

## 4. 非目标（本轮不碰）

- ZCode 工具行细节（审批/ExitPlanMode/文件摘要/子代理配对）——已对齐。
- 样式/间距/字级（另有 tokens 轮）。
- hermes-bots 插件侧（`src/hermes-mirror/**`）——那是插件自己的渲染，不进本清单。

## 5. 证据与复现

- **形状样本**：`C:\Users\Administrator\.rpi\sessions\--C--Users-Administrator--\2026-11-15T12-13-00-771Z_01a1df20-07dd-743f-925e-1c6a98ea0c49.jsonl`
  （用 `E:\Temp\inspect-session2.mjs` 打印每条 assistant 的块序列）。
- **错误样本**：同目录 `2026-11-16T07-12-45-668Z_01a1e333-8060-703f-90d8-ee3f631a09f1.jsonl`
  （第 4/6 条：`stopReason:"error"` + 403 `insufficient_quota`，UI 无显示）。
- **CDP 探针**：`E:\Temp\cdp-turn-structure*.mjs`、`cdp-live-run*.mjs`（临时脚本，未入库）。
- **截图**（临时）：`E:\Temp\zcode-parity.png`（长会话轮次结构）、`run-done.png`（错误轮空白）。
- **pi 事件源**：`G:\pi-rust-main\crates\rpi-ai\src\types.rs:915-978`、
  `G:\pi-rust-main\crates\rpi-agent\src\events.rs:23-100`。
