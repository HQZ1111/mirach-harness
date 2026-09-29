# pi_agent_rust SDK 集成方案（2026-09-29 · v2 落位定稿）

> 本文档是 pi 引擎接入 mirach-harness 的**落位规范**：每个能力住在哪一层、
> 哪个文件、UI 哪个区域。实现与文档冲突时，以文档为准改代码。
> 上游源码：`G:\pi_agent_rust-main`（版本 0.5.1，lib 名 `pi`，crate
> `pi_agent_rust`，**工具链钉 nightly-2026-08-31**）。
> v2 吸收了 agent-native 架构文档（Cargo Workspace 拆分 / 三通道 /
> ActionRegistry / A2UI / delegate 队列）并逐点对照上游源码核实，
> 修正了双方文档的失实处（§1.1 差异对照）。

---

## 0. 一句话总图

```
┌─ L1 前端（mirach-harness src/，纯投影）──────────────────────────┐
│  FlexLayout · assistant-ui（聊天 Store + A2UI 渲染）· shadcn/ui  │
│  对话区(主栏)      侧栏(左/右栏)        设置页(未来)               │
├─ L2 桥接层（三通道）─────────────────────────────────────────────┤
│  AG-UI SSE（Agent→前端）· Tauri IPC（前端→Rust）                  │
│  · Tauri Event（Rust→前端，内部任务事件：delegate 队列进度等）     │
├─ L3 Rust 应用层（src-tauri + workspace crates，stable）──────────┤
│  ActionRegistry · AppState · SQLx · axum · agui-bridge · Auth    │
│  AgentDelegate 实现 · SnapshotProvider 实现                       │
├─ L4 pi-adapter（nightly，唯一碰 pi 的地方）───────────────────────┤
│  create_agent_session · AgentEvent 归约 · ToolRegistry 注入       │
│  render_a2ui 拦截 · A2UI 验证                                     │
├─ L5 Tauri v2 Mobile ────────────────────────────────────────────┤
└─────────────────────────────────────────────────────────────────┘
```

**集成形态（已定）**：**库依赖（in-process SDK）**，不用 RPC 子进程、
不用 DSH。pi 拥有 Agent 循环，Rust 是应用层，前端是渲染层——三层谁也
不越界。`SessionTransport` 统一适配器留后路：L5 移动端若需沙箱隔离，
一行换 `SessionTransport::rpc_subprocess`（`pi --mode rpc`），映射层不动。

### 0.1 前置事实（读源码实锤，非转述）

| 事实 | 出处 | 对集成的约束 |
|---|---|---|
| pi 钉 `nightly-2026-08-31`（rustfmt+clippy） | 上游 rust-toolchain.toml | **A19 清账：确实要 nightly**。pi-adapter 子 crate 放独立 rust-toolchain.toml 钉同版本；locked 依赖图要 Rust ≥1.95 |
| pi 用 **asupersync** 运行时，不是 tokio | examples/basic_sdk.rs | pi 的 future 禁止进 tauri::async_runtime/tokio；pi-adapter 内自管 asupersync runtime |
| 消费 crate 必须 `#![recursion_limit="256"]` | docs/sdk.md | src-tauri / pi-adapter crate 顶部加上，否则 Send 证明溢出且报错不指真因 |
| 稳定面 = `pi::Error`/`pi::PiResult`/`pi::sdk::*` | src/lib.rs | 其余模块 `#[doc(hidden)]` 无 SemVer 保证；**只准 import `pi::sdk` 与 `pi::model` 的事件类型** |
| `AgentSessionHandle::prompt` 是 `async`、`&mut self`、回调 `Fn`（Arc 包装） | docs/sdk.md Recipe 1/2、basic_sdk.rs | A3/A4/A7 清账；Mutex 串行化 + 回调不得捕获可变状态 |
| `AgentEnd` 之后还有事件（AutoCompaction*、extension_error） | src/agent.rs 枚举 | **A10 清账**：以 channel 关闭为退出条件（写法 A），AgentEnd 只做 UI 收尾，不做流退出 |
| **SDK 没有 `session.approve()/deny()`** | src/sdk.rs 全文无此符号 | **A16 清账**：审批回灌必须走 `ExtensionUiHandler`（§4.4） |
| `ExtensionUiRequest` 自带 `id` | docs/sdk.md Recipe 5b（`id: request.id`） | A15 清账：不需我方生成 UUID（除非上游某变体缺） |
| `SessionOptions` 有 `Default`、无 builder | Recipe 全部 `..SessionOptions::default()` | A1/A2 清账 |
| `steer/follow_up` 仅在 `RpcTransportClient`，in-process 无 | docs/sdk.md Compatibility Notes | MVP 降级（§4.6） |

### 0.2 三通道瘦身定稿（v2.1，回答"三通道是否过多"）

通道数量不是问题，**语义污染**才是。原设计里 Tauri Event 携带了领域
数据（delegate 的文本流/工具调用）——那才是多余的。定稿：通道各管一摊，
数据不过界：

```
┌ AG-UI HTTP（唯一数据面，2 个端点）
│   POST /ag-ui                        # 起 run，返回 {runId}（不携流）
│   GET  /ag-ui/stream?thread&lastEventId  # 常驻事件流（唯一消费口）
├ Tauri IPC（唯一控制面，全部 invoke）
│   会话 CRUD、set_model/thinking、interrupt、approve、ask 应答、
│   tool_result、sync_app_context、delegate_to_agent、get_agui_endpoint
└ Tauri Event：（v2.2 归零——门铃删除）
```

关键裁定：
1. **常驻流消费（v2.2）**：前端对打开的 thread 常驻一条 GET 流，所有
   run（前端发起 + delegate）的事件都在这条流上按 thread 全序到达；
   POST 只触发 run 并返回 {runId}，不再携带事件流。**门铃删除**——
   Tauri Event 通道归零，两通道收口。标准 AG-UI 的 POST 流式形状若
   未来要兼容（L5/第三方客户端），从同一缓冲做扇出即可，缓冲不动。
2. **interrupt、tool_result 从 HTTP 挪进 IPC**——abort 是控制操作不是
   数据流；HTTP 端点从 4 个收到 2 个，鉴权面同步收窄。
3. **JWT → 不透明随机 token**——127.0.0.1:0 + token 经 IPC 下发的威胁
   模型下，签名/过期/刷新全无必要；砍掉 jsonwebtoken 依赖，uuid 即可。
4. **MVP 裁剪（出关键路径，非删除）**：A2UI 整个子系统（render_a2ui
   工具、a2ui-types crate、ts-rs 代码生成、前端 generative-ui 接线、
   A22/A24/A25/A26/A28 五个待确认项）；MESSAGES_SNAPSHOT 溢出回退
   （序号+环形缓冲保留——很小，且"可恢复优先"）。
5. **XState 定稿为唯一轮次真相**（用户 2026-09-29 拍板，撤回 v2.1 的
   "延后 XState"提议）：AG-UI SSE → **XState actor（唯一 SSE 消费者）**
   → 归约出 phase/messages/runId/lastEventId → **ExternalStoreRuntime**
   适配器注入 assistant-ui（纯渲染；isRunning 由机器态供给，assistant-ui
   不再自推）。ExternalStore 是**快照式**——每次转换喂整组 messages
   数组 + onNew/onCancel/onEdit 回调，**无需自实现增量协议**；真正的
   成本是 AG-UI 事件→消息 part 的归约器（LocalRuntime 方案同样要写，
   且 mock 三阶段已验证过累积 content 的构造）。收益：铁律②"SSE 只喂
   机器"成立、XState Inspector 一条调试主线、resume/interrupt 是一等
   转换、delegate 门铃→attach 走同一条归约路径、前端刷新由 run 边界
   快照水合后 assistant-ui 照常渲染。API 面以已装
   @assistant-ui/react 0.15.22 的 useExternalStoreRuntime 导出实测为准。
6. **不建议砍**：ApprovalRegistry（审批态必须驻 Rust，跨前端刷新）；
   sync_app_context（get_app_context 的推送面，字段已最小化）；
   workspace 分阶段拆分（§3 已是保守版）。

### 0.3 同 thread 多 run 共存（v2.2，回答"delegate run 与当前 run 怎么共存"）

**它们不交错——互斥已把共存变成了排队。** 一个 thread = 一个 pi
session，AgentSessionHandle 被 Mutex 保护（同一时刻只有一个 prompt）；
delegate 队列"忙则入队"检查的就是这把锁。因此：

1. **缓冲分段连续**：run A 的 RUN_FINISHED 必然先于 run B 的
   RUN_STARTED 落缓冲，per-thread 缓冲里 runs 是首尾相接的连续段，
   每条事件带 run_id。事件级交错在物理上不可能——机器若收到交错序列
   （streaming 中收到另一 runId 的 RUN_STARTED）= 协议违例，**fail
   loud**（dev 断言 + error 上报），不静默吞。
2. **机器语义**：RUN_STARTED(runId, source) → 追加**新消息段**（append
   不 replace，一段对话本来就是多个 run 首尾相接），context.currentRunId
   换轨、phase→streaming；RUN_FINISHED → currentRunId=null、phase→idle。
   `source`（user/delegate）由 run 创建时的元数据标记，UI 可据此画
   "机器人主动执行"徽标/分组。
3. **消费口唯一**：不区分"当前 run 的流"和"delegate 的流"——常驻
   GET 流是唯一消费口（§0.2-1），run 归属只看事件里的 run_id/source。
   断线重连 Last-Event-ID 天然跨 run 段连续续放。
4. **队列纪律**：composer 在 phase≠idle 时禁用发送（或显式转
   follow_up）；用户触发与 delegate 任务走**同一把 Mutex、同一个队**
   （AgentDelegate 是唯一排序权威），不允许两条排队通道。

---

## 1. 与 agent-native 架构文档的差异对照（逐点核实后的裁定）

> 架构文档 = 用户提供的 pi 集成架构（workspace 拆分/三通道/A2UI/
> delegate/附录 A）。下表按「架构文档原文 → 上游源码事实 → 裁定」给出，
> 是两份文档的合并基准。

| # | 架构文档说法 | 源码事实 | 裁定 |
|---|---|---|---|
| 1 | §6.1 审批：Rust 调 `session.approve()` / `session.deny()` | sdk.rs 无此 API；唯一回灌面是 `SessionOptions.extension_ui_handler`（async_trait `request_ui -> ExtensionUiResponse`） | **修正**：pi-adapter 实现 handler 时挂 oneshot——请求到达→转 Tauri Event 发前端→前端 IPC `approve_action` 回来→resolve oneshot→handler 返回 `ExtensionUiResponse`。**fail closed**：handler 缺位=deny（上游明说） |
| 2 | §4.3 "pi-adapter 不依赖 agent-core" vs §三/§4.4 "pi-adapter → agent-core（ActionRegistry→ToolRegistry）" | 依赖图两边自相矛盾 | **以依赖图为准**：pi-adapter 依赖 agent-core。不碰 ActionRegistry 就没法定义 Pi 工具 |
| 3 | §二 "nightly 隔离在 pi-adapter"（A19 待确认） | 上游钉 nightly-2026-08-31 | **成立**（见 §0.1）；pi-adapter 独立 rust-toolchain.toml |
| 4 | §4.4 事件映射表缺 TurnStart/MessageStart/MessageEnd/AutoCompaction；usage/token 无落点 | agent.rs 枚举有这些变体；Usage 在 AssistantMessage 上 | **合并**：以本文 §2.2 表为准（含 STEP_FINISHED 带 usage——ContextDisplay 的唯一数据源） |
| 5 | A2UI ACTIVITY_SNAPSHOT 是否 AG-UI 标准事件（A24） | 未核实（ag-ui crate 待查） | **待确认保留**；若非标准则走 AG-UI `CUSTOM` 事件包 A2UI payload，映射函数不动 |
| 6 | "delegate_to_agent 队列" | **pi 无此概念**——这是应用层自建设计，非 pi 能力 | 保留为 mirach 设计（§4.7），标注来源；互斥语义成立：AgentSessionHandle 被 Mutex 保护，同一时刻只有一个 prompt |
| 7 | A2UI 渲染 "@assistant-ui/react-generative-ui 原生接管" | npm 包真实存在（elements 轮已装进工程依赖）；`useAgUiRuntime`/`useAgUiSendA2uiAction` API 未核实（A25/A26） | **待确认保留**；落地时先查包导出面 |
| 8 | §二 "审批响应走 Tauri IPC，不走 AG-UI" | 与 AGENTS「待办 3」的 `/ag-ui/tool-result` 端点有口径差 | **分工定稿（v2.1 收紧）**：审批（ExtensionUiRequest）与前端工具回调（tool_result）**都走 IPC**——HTTP 只剩 POST 起 run + GET 重放流（§0.2） |
| 9 | §九 "UI 输入的 key 不落盘；配置文件 key 用 OS keyring" | pi 自身读 env vars / models.json（支持 `!command` shell lookup） | keyring 是 mirach 增强项（非 pi 能力）；MVP 先 env + pi 原生配置文件，keyring 后置 |
| 10 | workspace 五 crate 拆分 | 拆分动机：nightly 隔离（成立）+ semver 卫生 + 编译隔离 | **分阶段**：见 §3（先单 crate 模块划分，接通后拆 pi-adapter） |

**Agent-Native 理念对齐**（架构文档 §十一对照表，逐条核过）：
Shared Actions（ActionDef+Registry+useAction 同 handler）✓；Shared Data
（SQLite+TanStack invalidateQueries，data_changed 走 AG-UI CUSTOM 不走
STATE_DELTA）✓；Shared Application State（get_app_context 按需拉取 +
sync_app_context 100ms debounce 推送，**不含 draft_content**——草稿是
纯 UI 态，Pi 不该知道）✓；UI 即 Agent 操作面板（delegate+agent_tool
标注+Tauri Event 回传）✓；动态 UI（A2UI render_a2ui）✓。
**核心原则**：Pi 拥有 Agent 循环、Rust 不碰；前端只管"怎么显示"；
Action 是唯一业务入口；不在 Tokio 里 block_on；AI 非确定性工作走对话流。

---

## 2. L2 桥接：AgentEvent → AG-UI（合并后的事件映射表）

### 2.1 端点

`POST /ag-ui`（起 run，**返回 {runId}，不携事件流**）+ 
`GET /ag-ui/stream?thread&lastEventId`（**常驻事件流，唯一消费口**；
重放自实现，Last-Event-ID 跨 run 段连续续放，§0.3）。axum 绑
`127.0.0.1:0`，**不透明随机 token**（uuid，经 IPC 下发）+ Origin/Host
校验；(port, token) 存 AppState，前端 `invoke("get_agui_endpoint")`
主动拉取（避免启动竞态）。interrupt/tool-result 不设 HTTP 端点（§0.2）。

### 2.2 事件映射（pi::AgentEvent → AG-UI EventType）

| pi 侧（src/agent.rs、model.rs） | AG-UI 事件 | 消费者 |
|---|---|---|
| `AgentStart` | `RUN_STARTED` | XState 轮次机 |
| `TurnStart` | （内部计数，不外发） | — |
| `MessageStart` | `TEXT_MESSAGE_START` / `THINKING_TEXT_MESSAGE_START`（按首个块类型） | — |
| `MessageUpdate { TextDelta }` | `TEXT_MESSAGE_CONTENT` | MarkdownText 流式 |
| `MessageUpdate { ThinkingDelta }` | `THINKING_TEXT_MESSAGE_CONTENT`（AG-UI thinking 事件名以 ag-ui crate 版本为准） | Reasoning streaming |
| `MessageUpdate { ToolCallStart/Delta/End }` | `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` | ToolGroup / tool-call |
| `ToolExecutionStart` | `TOOL_CALL_START`（执行段，配 CUSTOM 进度） | thinking-indicator「正在使用 X」 |
| `ToolExecutionUpdate { partial_result }` | `TOOL_CALL_ARGS` 流式 / `CUSTOM` | 终端块、web-preview 等工具 UI |
| `ToolExecutionEnd { result, is_error }` | `TOOL_CALL_END`（error 标记） | tool-error 元素 |
| `TurnEnd` | `STEP_FINISHED`（**带 usage**——ContextDisplay/token 计量的唯一来源） | ContextDisplay.Bar |
| `MessageEnd` | `TEXT_MESSAGE_END` | 轮次机 |
| `AgentEnd { messages, error }` | `RUN_FINISHED` / `RUN_ERROR`；usage 快照落 SQLx | 轮次机 done/error |
| `AutoCompactionStart/End` | `CUSTOM`（compaction 提示） | 会话横幅 |
| `ExtensionUiRequest` | `CUSTOM`（审批载荷带 requestId）→ 前端弹卡 → **IPC 回灌** | 审批卡（§4.4） |
| ask 工具问题卡 | `CUSTOM`（questions+timeoutMs） | 问题卡 UI（option-list 元素可套用） |
| A2UI（render_a2ui 拦截产物） | `CUSTOM` 或 ACTIVITY_SNAPSHOT（#5 待确认） | assistant-ui generative-ui 渲染 |
| 业务数据变更 | `CUSTOM`（data_changed → invalidateQueries） | TanStack Query |

镜像类型纪律（架构文档 §5.1 采纳）：agent-protocol **不引用**
`pi_agent_rust::AgentEvent`，自建镜像类型，pi-adapter 做转换——nightly
污染不泄漏。SSE 序号：per-thread 单调递增，镜像到 SSE `id:` 行；环形
缓冲（先单锁，热了再 DashMap）；**先写缓冲再写 SSE**；淘汰后回退
`MESSAGES_SNAPSHOT` 强制重建；重放只重发已产生事件，绝不重跑 Agent 循环。

---

## 3. Cargo 布局：先模块后拆分（分阶段定稿）

架构文档的五 crate 拆分（agent-core / agent-protocol / a2ui-types /
pi-adapter / agui-bridge）是**终态**。对 mirach 现状（src-tauri 薄壳、
pi 未接），**先单 crate 模块划分、第一条竖链跑通后拆出 pi-adapter**：

```
阶段 1（竖链）                阶段 2（拆分，动机出现时）
src-tauri/src/                my-agent workspace（架构文档 §十四 结构照抄）
  pi_session.rs  ←──────→     crates/pi-adapter/   # nightly，唯一碰 pi
  agui.rs        ←──────→     crates/agui-bridge/  # SSE+重放缓冲
  actions.rs     ←──────→     crates/agent-core/   # ActionRegistry/AppState/DB
  （镜像类型内联）              crates/agent-protocol/# 镜像类型+映射（无 IO）
                              crates/a2ui-types/   # catalog 单一事实源
```

拆分触发条件（满足其一）：① pi 的 nightly 依赖把 src-tauri 整体拖进
nightly；② pi 编译时间拖累增量开发；③ A2UI catalog 需要独立 semver。
模块内文件划分照架构文档 §十四（pi-adapter 的 session/events/tools/
a2ui_bridge/lifecycle 五文件职责原样保留）。

---

## 4. 落位清单（哪里放什么）

### 4.1 L3/L4 Rust 侧

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `pi-adapter::session` | 包 `create_agent_session(SessionOptions)` | runtime=asupersync；`no_session:false`+`session_dir` 指向 mirach 会话目录 |
| `pi-adapter::events` | pi::AgentEvent → agent_protocol 镜像 → AG-UI | 纯转换，无 IO（可单测） |
| `pi-adapter::tools` | `Vec<ActionDef>` 过滤 `agent_tool:true` → Pi `ToolRegistry` | **agent-visible 超 15-20 个后工具选择质量下降**——分组/渐进暴露预案 |
| `pi-adapter::a2ui_bridge` | 注册 `render_a2ui` 自定义工具；拦截→`validate_a2ui`→映射 ACTIVITY_SNAPSHOT | **验证失败降级为文本展示**（原文附上+"UI 生成失败"），不静默丢弃 |
| `pi-adapter::lifecycle` | `Mutex<AgentSessionHandle>` 串行；**abort handle 在锁外获取**；channel 关闭退出 | prompt 持锁跨整个执行期（同一时刻只有一个 prompt） |
| `src-tauri::approval` | ApprovalRegistry（HashMap<session_id, Vec<PendingApproval>>） | 超时默认**自动拒绝**；会话关闭时遍历 pending 按策略处理；崩溃恢复 `list_pending_approvals` 带 remaining_seconds |
| `src-tauri::delegate` | AgentDelegate 队列（上限 10，满返 QueueFull） | 执行事件走 **Tauri Event**（Rust 侧不能凭空起 AG-UI run）；prompt 完成回调触发下一项 |
| `src-tauri::snapshot` | 实现 agui-bridge 的 SnapshotProvider trait | messages_snapshot 经 pi-adapter 从 Pi 会话态取；state_snapshot 从 AppState 读 |

### 4.2 对话区（主栏，AssistantThreadPane）

| UI 件 | 数据源 | 说明 |
|---|---|---|
| 消息流（Markdown/Reasoning/ToolGroup/thinking-indicator） | AG-UI SSE | mock 三阶段已验证全状态，切换后逐项回归 |
| 停止按钮（Send↔Cancel 已有） | `/ag-ui/interrupt` | — |
| ModelSelector | `/api/models`（RpcModelInfo） | MODELS 常量退役；efforts 行 → set_thinking_level |
| ContextDisplay.Bar | TurnEnd usage | mock 里永远空的面板从此点亮 |
| 审批卡 | CUSTOM + IPC 回灌 | 审批流 §4.4 |
| 问题卡 | CUSTOM（ask） | 超时后模型收"用户未回答"错误，不挂死 |
| A2UI surface | CUSTOM/ACTIVITY_SNAPSHOT | generative-ui 渲染；$action 走 IPC |
| 附件 | AG-UI 消息体 images | pi UserContent 原生支持 ImageContent |

### 4.3 侧栏

| UI 件 | 数据源 | 说明 |
|---|---|---|
| sessions 列表 | IPC 读 pi 会话目录 header（**只读镜像**） | 改名/删除经 IPC 下沉 pi；fork/branch/tree 全下沉 pi |
| 新建会话 | IPC session_create | 复用引擎 |
| thread 标签↔会话绑定 | layout store + IPC | 拖对话标签=拖那个会话 |
| 右栏 files | 已有 fs.rs | 不动；与 pi read 工具同 cwd 天然一致 |
| logs 窗格 | on_tool_start/end 钩子 + ToolExecutionUpdate | — |
| bots | 机器人=system_prompt+tools+model 预设 | 点开=带 SessionOptions 建会话 |

### 4.4 审批与问题卡（pi 的两个 UI 回调，全部 fail closed）

1. **ExtensionUiRequest**（confirm/select/input/editor/notify）：
   pi-adapter 实现 `extension_ui_handler`（async_trait）→ Tauri Event
   发前端弹卡 → 前端 IPC `approve_action(sessionId, requestId,
   approved)` → resolve oneshot → handler 返回 ExtensionUiResponse。
   `persist_extension_permissions:false`（决定存 mirach 库，不写
   `~/.pi/extension-permissions.json`）；弹窗第三态"仅本次"=响应里
   `"persist": false`。
2. **ask 工具**：questions[{question, options, multi}] + timeoutMs，
   答案按 ask_response 语义回灌；超时=模型收到未回答错误（上游语义，
   不挂死）。

### 4.5 控制面走 Tauri IPC（不走 AG-UI）

```
IPC：session_list/create/open/delete/rename、set_model、
     set_thinking_level、interrupt、get_state、get_messages、compact、
     fork、export_html、get_agui_endpoint、approve_action、
     ask_response、tool_result、sync_app_context（100ms debounce）、
     delegate_to_agent
AG-UI HTTP：POST /ag-ui（起 run，返回 runId） / GET /ag-ui/stream
            （常驻事件流，唯一消费口）
```

判据：**HTTP 只管事件流，其余一切控制都走 IPC**——设置页与侧栏在无
轮次运行时也要用，且少一个鉴权端点就少一分攻击面。

### 4.6 steer/follow_up（已定降级）

in-process 面缺位（上游明说）。MVP：`steer` = abort+prompt（丢失排队
语义，设置页注明）；`follow_up` = L3 自己排队（delegate 队列即复用）。
上游补齐后一行切 `SessionTransport::rpc_subprocess`。

### 4.7 delegate 队列（mirach 自建设计，非 pi 能力）

前端 IPC `delegate_to_agent` → AgentDelegate 检查 session 空闲：
空闲立即 prompt；忙则入队（上限 10，超出 QueueFull）。执行者=src-tauri。
**执行事件（文本流/工具调用）进 AG-UI 环形缓冲照发 sequence**——前端
常驻 GET 流上按 thread 全序自然到达，无门铃、无专用通道（§0.2-1、
§0.3）；前端刷新/断线 Last-Event-ID 续放。run 创建时标 `source:
delegate` 供 UI 归属。用户触发与 delegate 走同一把 Mutex、同一个队。

---

## 5. 数据真相边界（谁持什么）

- **对话真相 = pi**：V1 JSONL→V2 segmented store（分支树/compaction/
  checkpoint/迁移账本）是唯一持有者。mirach 只读 header 做列表镜像，
  不解析不改写。
- **UI 快照 = mirach SQLx**（app_data_dir/agent.db，sqlx::migrate! 编译
  期内嵌）：run 边界快照只服务 resume/审计/崩溃恢复。删会话=先 pi 后
  快照（真相在后删的一方）。
- **配置真相 = pi settings.json**（`~/.pi/agent/settings.json` 全局 +
  `.pi/settings.json` 项目，camelCase alias 兼容）；nested 对象整体
  替换不合并（上游语义，设置页 UI 要照此呈现）。mirach 的 UI 偏好
  （主题/语言/布局）不混进 pi settings。
- **状态归属表**（架构文档 §4.1 采纳）：纯 UI 态=Zustand；聊天线程/
  composer/A2UI surface 内部态=assistant-ui Store（surface 是消息的
  一部分，重渲不丢）；Action 返回值=TanStack Query；业务数据=Rust SQL；
  Agent 会话态=Pi 进程内；UI 上下文=AppState（字段权威：route/
  selected_record_id/active_view/selected_text 前端推送，
  active_session_id Rust 管）。

---

## 6. mock → 真引擎切换

runtime.tsx 从 LocalRuntime+mockModelAdapter 换成
**useExternalStoreRuntime 适配器**：XState actor 唯一消费 AG-UI SSE，
归约出的 messages/isRunning 喂 assistant-ui 纯渲染（§0.2-5 定稿）。
切换后回归清单：思考流式/完成折叠/工具运行/1 tool call/thinking-
indicator 三态/composer 全控件/审批卡/问题卡/A2UI surface/断线 resume。

## 7. 落地顺序

1. **L3 骨架**：Cargo.toml 加 pi（path 引 G 盘，default-features=false
   去 TUI 栈）→ pi_session.rs 打通 create/prompt/abort/state →
   cargo check 过（recursion_limit/nightly 生效验证）。
2. **L2 竖链**：/ag-ui 一条链 + 事件映射器（§2.2 表逐行单测，用 pi
   AgentEvent 构造样本）。
3. **L1 切换**：XState actor + ExternalStore 适配器（§0.2-5）；发消息→
   流式回复→渲染。
4. **控制面**：IPC 命令 + 侧栏 sessions + ModelSelector/ContextDisplay
   点亮。
5. **审批/问题卡**：handler + oneshot + 前端卡。
6. **A2UI**（MVP 后）：render_a2ui 工具 + catalog + 前端 generative-ui
   接线（先清 A22/A24/A25/A26/A28）。
7. **设置页接线**（提供方/模型/compaction/工具/技能包管理/审批镜像）。

每步验收 = tsc + vitest + cargo check + §6 回归清单。

## 8. 风险与未决（含架构文档附录 A 清账结果）

**已清（源码实锤）**：A1✓ A2✓ A3✓ A4✓ A7✓ A8✓ A9✓ A10✓（AgentEnd 后
还有 AutoCompaction*/extension_error）A15✓（自带 id）A16✓（无
approve/deny）A17✓（{tool_call_id, tool_name, args, result, is_error}）
A19✓（nightly-2026-08-31 实锤）A21✓（get_app_context 注册为
agent_tool:true 的 Action 即动态读 AppState）A27✓（稳定面有
Tool/ToolDefinition/ToolRegistry/ToolFactory/default_tool_registry，
自定义工具经 ToolRegistry 注入）。

**待源码确认**：A5/A6（RunContext 相关——若走 Agent::run() 路径才需要；
MVP 只用 session.prompt() 可绕开）A11/A12/A20（ag-ui crate 的
Agent trait/mount_agent 签名——装依赖后查）A13（逐步落地时对签名）
A14（环形缓冲容量/sequence 起点——实现时定，建议 sequence 从 1 起）
A22（a2ui-rs 来源——crates.io 查证）A23（catalog 注入与
append_system_prompt 兼容性）A24（ACTIVITY_SNAPSHOT payload）A25/A26
（assistant-ui present 注册/useAgUiSendA2uiAction——查已装的
@assistant-ui/react-generative-ui 导出面）A28（ts-rs/specta 类型生成）
A29（delegate 队列触发回调——实现时定）A30（handler async_trait——
ActionDef::handler 已是 boxed async Fn，无需）。

**风险**：asupersync≠tokio（§0.1）；G 盘 path 引用出包前换 git
rev-pin/vendored；nightly 工具链与本机 rustup 对齐（上游 pin
nightly-2026-08-31，rust-toolchain.toml 自动拉取）；A2UI catalog 前后
端同步成本（ts-rs 生成，变更频率低可控）；agent-visible Action 数量
红线 15-20。
