# 引擎侧缺失数据清单（engine-gaps）

> 2026-10-16 建立。**用途**：对话栏右上角活动面板（`ConversationStatusPanel`，
> 移植自 ZCode `packages/ui/src/v4/ConversationStatusPanel.tsx`）需要的数据，
> pi（`pi_agent_rust` v0.5.1，vendored `src-tauri/vendor/pi_agent_rust/`，
> 上游真源 `G:\pi_agent_rust-main`，两处字节一致）**没有**的部分在此登记。
>
> **决策位**：每一节末尾的「裁决」留空 = 待定。选项：`自建`（宿主在
> src-tauri 侧实现）/ `等上游`（提 FR）/ `不做`。用户口径（2026-10-16）：
> 先把能做的做了，缺数据的做 UI 并标注，将来再定自建还是等上游。

## 结论速览

| 分区 | ZCode 数据源 | pi 侧实况 | 状态 |
|---|---|---|---|
| 待办 plan | `PlanState.items` | `todo` 工具 → `todo_list.v1`（已启用） | ✅ 已接（G1 部分） |
| 子代理 agent | `RunningSubagentSummary` | `agent_hub::registry().roster()`（pub 全局单例） | ✅ 已接 |
| 终端 terminal | `BackgroundWorkSummary[]` | `jobs::list(sessionId)`（pub） | ✅ 已接 |
| 会话计划 sessionPlans | `ToolCallRow` ExitPlanMode | `submit_plan` 工具（details 无结构化步骤） | ⚠️ 见 G1 |
| ~~工作流 workflow~~ | `WorkflowRunState[]` | **无** | ❌ 见 G3（UI 占位） |
| ~~目标 goal~~ | `GoalState` | **无**（仅 handoff 文本） | ❌ 见 G4（UI 占位） |
| ~~环境 git 变更~~ | `gitWorktreeChangeSummary` | 宿主自建（`git diff --numstat`） | ✅ 已接（G6） |

**已解：** G2（待办拉取面）/ G5（Stop 接线）/ G6（git 变更统计）——
2026-10-16 自建完成。**待定：** G1 / G3 / G4。

---

## G1：会话计划（sessionPlans）无结构化步骤输出

**现状**：ZCode 的 sessionPlans 分区枚举会话内 `ExitPlanMode` 工具调用，
从 tool output 提取 markdown 计划 + 标题 + 计划文件路径。

pi 的 `submit_plan` 工具（`plan.rs:64-134`）**details 只有**：
```json
{ "planReview": "pending" }   // 或 "auto_approved"
```
计划**正文在 tool-result 的 content 文本里**（`"Plan submitted for review..."` /
`"...Execute it now:\n\n{plan}"`），没有结构化字段（无 markdown 字段、
无标题、无文件路径）。`Agent::plan_state()`（`agent.rs:1884`）返回的
`PlanState` 是**模式机**（Off/Planning/Reviewing + 当前 plan 文本），不是
步骤列表。

**影响**：无法像 ZCode 那样渲染"计划目录"（多条 ExitPlanMode 行 + 标题）。
MVP 处理：**不渲染 sessionPlans 分区**（计划的正文仍随对话流显示在消息里）。

**裁决**：待定。

---

## G2：todo 状态无 IPC 拉取面（只能靠事件）

**现状**：`todo` 工具每次调用把 `todo_list.v1` 塞进 `ToolOutput.details`
（`todo.rs:556`），且**持久化为会话树 Custom 条目**（`todo.rs:547`，
重放由 `latest_from_entries` 复原）——**真相是持久的**。

但 **`AgentSessionHandle` 未暴露 `plan_state()` / todo 状态**：
- `Agent::plan_state()` 是 pub（`agent.rs:1884`），但 handle 只有
  `with_session(&Session)`（`sdk.rs:2183`），拿不到 `Agent`
  （`AgentSession.agent` 虽 pub，但 handle 不暴露 `AgentSession`；
  `into_inner` 消费 handle，不能用于读）。
- `AgentSessionState` / `RpcSessionState`（`sdk.rs`）都**无 todo 字段**。

**影响**：mirach 现在只能靠"模型调 todo 工具 → details 事件"拿到待办投影。
**重启后、模型再次调用 todo 工具前，待办分区为空**（虽然 pi 磁盘上有持久
条目）。这是诚实空态（不编造），但体验上不如 ZCode（它从投影快照拉）。

**过渡方案（宿主可自行实施，不必等上游）**：宿主读会话 JSONL 的 Custom
`todo_list.v1` 条目重放——与 pi `latest_from_entries` 同逻辑（枚举活动路径
Custom 条目、取最新）。已在 checkpoint 的 `list_checkpoints` 里做过同款
（`pi_session.rs:936` 枚举 `custom_type == "checkpoint"`）。加一个
`pi_todo_state()` 即可，**不需要上游改**。

**裁决**：✅ **已自建（2026-10-16）**——`pi_todo_state` IPC
（`pi_session.rs::todo_state()` 调 `pi::todo::latest_from_entries`）+ 前端
`todoBridge.refresh()` 挂载时拉。4 个 Rust 单测（重放取最新 / 空 / 坏条目
跳过 / summary 形状）。

---

## G3：工作流运行（workflow run）—— pi 无此概念

**现状**：ZCode 的 workflow 分区渲染 `WorkflowRunState`：阶段（phase）/
车道（lane）/ 参与者（participant）/ 因果图（`WorkflowCausalityGraphData`，
含 `phaseEdges`/`alongside`/`step.kind`）/步数（settled/total）/产物。

pi **没有**：
- 无 `WorkflowRunState` / `WorkflowCausalityGraphData` 类型。
- 无 `phase()` / `alongside()` / lane / participant 概念。
- 无 workflow run 生命周期事件。
- （`github.rs` 里的 "workflow run" 是**查 GitHub Actions CI**，不同东西。）

pi 最接近的是 **subagent 编排**（`subagents.rs`，进程级子 Pi；`agent_hub.rs`
名册）——但那是"扁平的子进程列表"，没有"阶段/车道/因果图"的二维结构。

**影响**：workflow 分区**无法用 pi 数据渲染**。面板保留该分区但显示"引擎侧
缺数据"占位行。

**自建成本评估**：ZCode 那边是 46 个文件（`workflow-timeline/`）
+ 自研 DSL + 因果图分析器。自建等于在 mirach 造一个编排引擎——**大工程，
与"抄 ZCode UI"不是一个量级**。

**裁决**：待定（倾向"等上游"或"永久不做，用 subagent 分区替代"）。

---

## G4：目标（goal）—— pi 无 GoalState

**现状**：ZCode 的 goal 分区渲染 `GoalState`：目标文本 / 状态机
（active/verifying/notSatisfied/paused/verified）/迭代列表 / 每轮验证结果 /
暂停恢复。

pi **没有** `GoalState`。唯一相关：
- `handoff.rs`：会话交接文档里把"目标"当**文本**提取
  （`handoff.goal: String`，`handoff.rs:108-159`），是"生成交接摘要"功能，
  不是"目标迭代/验证状态机"。
- `plan.rs`：`SubmitPlanTool` 的 goal 是计划文本的一部分（无状态）。

**影响**：goal 分区无法用 pi 数据渲染。面板保留分区 + 占位行。

**裁决**：待定（倾向"等上游"——goal 状态机是内核级新概念）。

---

## G5：宿主取消面未接线（hub agent kill / jobs cancel）

**现状**：ZCode 的 agent/terminal/workflow 行都有 Stop 按钮，调
`onCancelBackgroundWork(workId)`。

pi **有**能力但宿主未接：
- `hub` 工具 `agent kill` / `agent revive`（`tools.rs:8693` dispatch_agent，
  `agent_hub.rs:352 mark_killed` / `:359 revive`）
- `jobs` 工具 `cancel`（`jobs.rs:2484 pub async fn cancel_async`，
  `jobs.rs` `request_cancel`）

这些是**模型调用的工具**，不是宿主 IPC。宿主可以直接调
`agent_hub::registry().mark_killed(id)` 和 `jobs::cancel_async(owner, id)`
（都 pub）——**不需要上游改**。

**影响**：面板的 Stop 按钮当前是**禁用占位**（`StopAffordance`，tooltip
说明）。要接线就加 `pi_hub_kill(agentId)` / `pi_job_cancel(jobId)` IPC。

**裁决**：✅ **已自建（2026-10-16）**——`pi_hub_kill`（`hub_kill()` 调
`agent_hub::registry().mark_killed`，id 不存在 Err）+ `pi_job_cancel`
（`job_cancel()` 调 `jobs::cancel_async`，等结算）+ 前端 `StopButton`
（IPC + 成功后 refresh；失败 console.error 可见）。

---

## G6：git 变更统计（+N/-M）

**现状**：ZCode 的 environment 分区显示"本会话改动 +N/-M"、分支、脏文件数。

pi **没有**"本会话改动统计"。相关但不同：`worktree_iso.rs`（agent 隔离
工作树）、`commit_split.rs`（提交拆分规划）。pi 不跟踪"本会话编辑了哪些文件
的多少行"。

**自建方案（宿主）**：跑 `git diff --numstat` / `git status --short` 解析。
宿主已有 `fs_git_root`（`fs.rs:148`）。加一个 `fs_git_diff_stat` IPC 即可。
注意：这是**工作区当前状态**，不是"本会话改动"（若用户手动改了文件也算进
去）——语义要对齐 ZCode 的话，需要 ZCode 那种 taskChangeSummary 概念。

**裁决**：✅ **已自建（2026-10-16）**——`fs_git_diff_stat` IPC（`fs.rs`：
`git diff --numstat HEAD` + `git status --porcelain` + `rev-parse
--abbrev-ref`）+ 前端 `gitBridge` + 面板 Environment 分区（有变更才显示；
底部注明"工作区当前状态，非本会话改动"）。6 个 Rust 单测（numstat 普通/
二进制/空/畸形 + porcelain 计数/排除忽略项）+ 4 个前端用例。

---

## 附：已确认**无需**缺口登记的项

- **子代理名册**：`agent_hub::registry()` is `pub`（`agent_hub.rs:165`），
  进程级全局单例 → 宿主直接拉，已接（`pi_hub_roster`）。
- **后台任务列表**：`jobs::list(sessionId)` is `pub`（`jobs.rs:2205`）→
  宿主直接拉，已接（`pi_job_list`）。
- **tool details 端到端**：`ToolOutput.details` 在 `AgentEvent` 序列化存活，
  `agui.rs` mapper 整包透传（`value.partial` / `value.result`）——
  已加 3 个回归测试（`agui.rs` `tool_execution_*_passes_details_through`）。
- **swarm_* 模块**（activity_ledger / flight_recorder / replay / progress_slo）：
  **只读离线分析器**（消费外部 JSONL，不产生事件）——**不是**活动面板数据面。
  对应 ZCode 的 trace-waterfall/activity-graph（事后分析视图），非实时面板。
