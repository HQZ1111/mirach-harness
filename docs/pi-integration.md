# pi_agent_rust SDK 集成方案（2026-09-29 · 落位定稿）

> 本文档是 pi 引擎接入 mirach-harness 的**落位规范**：每个能力住在哪一层、
> 哪个文件、UI 哪个区域。实现与文档冲突时，以文档为准改代码。
> 上游源码：`G:\pi_agent_rust-main`（版本 0.5.1，lib 名 `pi`，crate
> `pi_agent_rust`）。上游文档基准：`docs/sdk.md`（SDK Cook）、
> `docs/rpc.md`（RPC 面）、`docs/session.md`（会话存储）、
> `docs/settings.md`、`docs/models.md`、`docs/skills.md`、
> `docs/packages.md`、`docs/capability-prompts.md`。
>
> 对应总架构：AGENTS.md「待办 3」L1–L5 分层。本文只管「哪里放什么」；
> L4 适配器的实现细节在代码里长出来后再回填本文 §9。

---

## 0. 一句话总图

```
┌─ L1 前端（mirach-harness src/，纯投影）──────────────────────────┐
│  对话区(主栏)      侧栏(左/右栏)        设置页(未来)               │
│  AssistantThread   sessions 列表        provider/model/tools      │
│  ← AG-UI SSE       thread 列表          thinking/compaction       │
├─ L2 桥接层 ─────────────────────────────────────────────────────┤
│  AG-UI HTTP+SSE (axum, 127.0.0.1:0)  │  Tauri IPC（会话 CRUD 等） │
├─ L3 Rust 应用层（mirach-harness/src-tauri）──────────────────────┤
│  axum 挂 tauri::async_runtime · AppState · SQLx 快照 · Auth       │
│  ★ pi = { package = "pi_agent_rust" } 直接进 Cargo.toml          │
│  ★ create_agent_session 在这里调，AgentEvent 在这里归约成 AG-UI   │
├─ L4 pi 本体（G:\pi_agent_rust-main，上游库，不改）────────────────┤
│  pi::sdk 稳定面：AgentSession / AgentEvent / ToolRegistry /       │
│  SessionOptions / RpcTransportClient / ExtensionManager           │
└─────────────────────────────────────────────────────────────────┘
```

**集成形态选型（已定）**：**库依赖（in-process SDK）**，不是子进程 RPC。
理由：
1. AGENTS「待办 3」原文即 "L4 pi-adapter（create_agent_session ·
   AgentEvent · ToolRegistry · 生命周期）"——SDK 面就是为嵌入者准备的；
2. 事件零序列化损耗，`AgentEvent::MessageUpdate` 直接翻 AG-UI SSE；
3. `SessionTransport` 统一适配器（`SessionTransport::in_process`）留了
   后路：未来移动端（L5）或沙箱隔离需要时，一行换
   `SessionTransport::rpc_subprocess(...)` 走 `pi --mode rpc`，AG-UI 层
   不用动（RPC 面 prompt/abort/steer/follow_up/set_model/
   set_thinking_level/compact/get_state/get_messages 全覆盖，见
   `docs/rpc.md`）。

**上游注意（来自 `docs/sdk.md` + `examples/basic_sdk.rs`）**：
- pi 不用 tokio，用 **asupersync** 运行时。L3 侧在 tauri::async_runtime
  之外为 pi 会话单独起 asupersync runtime（current_thread + reactor），
  或者经 `SessionOptions` 的 runtime 注入（`pub runtime` 字段，"Runtime
  this session dispatches background work on"）——落地时以 sdk.rs 实测
  为准，**禁止**把 pi 的 future 塞进 tokio。
- 消费方 crate 必须自带 `#![recursion_limit = "256"]`（pi 内部提了不
  继承；没有它 `Send` 证明会溢出，报错还不指真因）。
- `--no-default-features` 编译可去掉 TUI 全栈（crossterm/bubbletea…），
  库消费方应加 features 集控制体积；`sqlite-sessions` 等按需保留。

---

## 1. L3 src-tauri：pi 进什么、怎么进

### 1.1 依赖

`src-tauri/Cargo.toml`：

```toml
[dependencies]
pi = { package = "pi_agent_rust", path = "G:/pi_agent_rust-main",
       default-features = false, features = ["sqlite-sessions"] }
# 走 git 时：
# pi = { package = "pi_agent_rust", git = "https://github.com/Dicklesworthstone/pi_agent_rust", ... }
```

编译约束：消费 crate（src-tauri 的 lib）加
`#![recursion_limit = "256"]`；Windows 上确认 rust-toolchain ≥ 1.95
（上游 rust-version 2024 edition）。

### 1.2 新模块 `src-tauri/src/pi_session.rs`

pi SDK 只在 Rust 侧出现，前端永不 import pi。模块职责：

```
pi_session.rs
├─ PiEngine（AppState 成员，Mutex<HashMap<sessionId, PiSessionRuntime>>）
│   ├─ create(provider?, model?) -> SessionId      # 包 create_agent_session
│   ├─ prompt(sessionId, text, images?)            # 包 prompt_with_abort
│   ├─ abort(sessionId)                            # 包 new_abort_handle
│   ├─ steer / follow_up(sessionId, text)          # 传输层行为（见 §3.4）
│   ├─ set_model / set_thinking(sessionId, ...)    # 包 set_model / set_thinking_level
│   ├─ state(sessionId) -> AgentSessionState       # provider/model/usage/message_count
│   └─ shutdown(sessionId)                         # 包 transport.shutdown
├─ AgentEvent → AG-UI 事件翻译器（§2.2 映射表）
└─ 会话快照桥（SQLx，run 边界 + AgentEnd/TurnEnd 落库）
```

`SessionOptions` 填法（对应 UI 语义）：

| SessionOptions 字段 | 来源 | 备注 |
|---|---|---|
| `provider` / `model` / `thinking` | 设置页 + 对话区触发器 | 默认值读 `~/.pi/agent/settings.json`（pi 自读）|
| `system_prompt` / `append_system_prompt` | 机器人配置（未来 bots） | per-session |
| `enabled_tools` | 设置页「工具与密钥」 | `None`=全部内建（read/bash/edit/write/grep/find/ls/hashline_edit，见 `BUILTIN_TOOL_NAMES`）|
| `working_directory` | 当前项目 cwd | 文件树/终端同源 |
| `workspace_trusted` | 打开项目时用户确认 | **默认 false**（程序化调用 fail-closed，上游注释明说）|
| `no_session: false` + `session_dir` | mirach 会话目录 | pi 的 JSONL/V2 会话存储与 mirach SQLx 快照**双写不互替**：pi 管对话真相（§4.1）|
| `extension_paths` / `extension_policy` | 设置页「技能与扩展」 | `safe` 起步 |
| `extension_ui_handler` | **L3 必须实现** | 能力审批弹窗走这里（§3.5）；不实现 = 全部 deny（fail closed）|
| `persist_extension_permissions: false` | mirach 桌面场景 | 审批决定存 mirach 自己的库，不写 `~/.pi/extension-permissions.json` |
| `mcp: Some(McpSessionOptions)` | 设置页「MCP」 | `config_paths` 指向 mirach 管理的 mcp.json |
| `compaction_settings` | 设置页「记忆与上下文」 | `Some(ResolvedCompactionSettings)` 直传；`None` 用 pi 默认 |
| `on_tool_start/end/on_stream_event` | 日志窗格埋点 | logs pane 的数据源之一 |

### 1.3 运行时纪律

- 每个 `create_agent_session` 在 **tauri::async_runtime::spawn_blocking
  外**的专用 asupersync runtime 上驱动；mirach 不 merge 两套 runtime。
- `AgentSessionHandle` 是 `&mut self` 语义——PiSessionRuntime 内用
  `Mutex<AgentSessionHandle>` 串行化 prompt/控制调用。
- 取消：`AgentSessionHandle::new_abort_handle()` 对一次 prompt 一个，
  abort 后 handle 丢弃重建。

---

## 2. L2 桥接：AgentEvent → AG-UI SSE

### 2.1 端点（AGENTS「待办 3」不变）

`POST /ag-ui`（发消息+收流）、`/ag-ui/interrupt`、`/ag-ui/resume`
（断线带 lastEventId 续流）、`/ag-ui/tool-result`（前端工具回调/审批）。
axum 绑 `127.0.0.1:0`，Origin/Host 校验 + Bearer（token 经 IPC 下发）。

### 2.2 事件映射表（pi::AgentEvent → AG-UI）

| pi 侧（src/agent.rs / model.rs） | AG-UI 侧 | 前端消费者 |
|---|---|---|
| `AgentStart` | `RUN_STARTED` | XState 轮次机 streaming |
| `TurnStart` | （内部计数，不外发）| — |
| `MessageStart` | `RUN_STARTED`（首 turn）/ `TEXT_MESSAGE_STARTED` | 轮次机 |
| `MessageUpdate { TextDelta }` | `TEXT_MESSAGE_CONTENT { delta }` | MarkdownText 流式 |
| `MessageUpdate { ThinkingDelta }` | `THINKING_STARTED/…`（思考流） | Reasoning 元素 streaming 态 |
| `MessageUpdate { ToolCallStart/Delta/End }` | `TOOL_CALL_STARTED/…` | ToolGroup / tool-call 元素 |
| `ToolExecutionStart` | `TOOL_CALL_STARTED`（执行段） | thinking-indicator「正在使用 X」 |
| `ToolExecutionUpdate { partial_result }` | `TOOL_CALL_ARGS/RESULT` 流式 | 终端块/网页预览等工具 UI |
| `ToolExecutionEnd { is_error }` | `TOOL_CALL_END`（error 标记） | tool-error 元素 |
| `TurnEnd` | `TEXT_MESSAGE_END` + `STEP_FINISHED`（带 usage） | ContextDisplay.Bar（token 用量的唯一来源）|
| `AgentEnd { messages, error }` | `RUN_FINISHED` / `RUN_ERROR` | 轮次机 done/error；**usage 快照在此落 SQLx** |
| `AutoCompactionStart/End` | 自定义 `COMPACTION` 提示事件 | 会话头横幅 |
| `extension_ui_request`（能力审批） | 不进 AG-UI → 走 Tauri IPC 事件 | 审批弹窗（§3.5）|
| `ask_request`（ask 工具问题卡） | 不进 AG-UI → 走 Tauri IPC 事件 | 问题卡 UI（§3.5）|

**A2UI $action 分流**照旧：`target:agent` 走 AG-UI，`target:client`
本地消化或 IPC。

### 2.3 resume/interrupt 的真相

- `interrupt` → `abort`（`new_abort_handle` + abort）。
- 断线续流：L3 在 `AgentEnd`/`TurnEnd` 落 SQLx 快照（按 run 边界）；
  `/ag-ui/resume` 从快照重放，**不用** pi 的 RPC lastEventId（那是
  RPC 传输层的机制，in-process 下由我们自己保证）。
- `steer` / `follow_up`：in-process `AgentSessionHandle` 暂未暴露
  （上游 Compatibility Notes 明说 steer/follow_up 在 RpcTransportClient
  上）。两个选择：先映射为「abort + prompt」（降级），或直接用
  `SessionTransport::rpc_subprocess` 拿全量队列控制。**定稿：MVP 用
  降级映射，设置页注明**；等上游 in-process 面补齐再切。

---

## 3. UI 落位（前端哪里放什么）

### 3.1 对话区（主栏，AssistantThreadPane）

| UI 件 | 数据源 | 说明 |
|---|---|---|
| 消息流（MarkdownText / Reasoning / ToolGroup） | AG-UI SSE | 不变，mock 三阶段已验证全状态 |
| thinking-indicator | AG-UI | 不变 |
| **停止按钮**（Send↔Cancel 已有） | `/ag-ui/interrupt` | XState streaming 态发 |
| **ModelSelector**（composer 右组） | `/api/models` → `RpcModelInfo` 列表 | 选择经 `set_model` IPC 下发（§3.4）；MODELS 常量废弃 |
| **ContextDisplay.Bar** | TurnEnd 的 usage → token 用量 | mock 里永远空的面板从此点亮 |
| **thinking 等级**（ModelOption efforts 行） | `set_thinking_level` IPC | ThinkingLevel: off/minimal/low/medium/high/xhigh/max |
| 附件 | AG-UI 消息体 images 字段 | pi `UserContent` 原生支持 ImageContent |
| 会话重命名/分支 | Tauri IPC → pi session | `set_session_name` / fork（§3.4）|

### 3.2 侧栏（左栏 sessions / 右栏 files）

| UI 件 | 数据源 | 说明 |
|---|---|---|
| **sessions 列表** | Tauri IPC `session_list` | L3 读 pi 会话目录（`~/.pi/agent/sessions/--encoded--/`，JSONL header）做列表；**列表元数据走 IPC 不走 pi 库**（轻、稳定）；改名/删除经 IPC 调 pi 的会话管理 |
| 新建会话 | IPC `session_create` | L3 → `create_agent_session`（复用引擎） |
| **thread 标签 ↔ 会话绑定** | layout store + IPC | 拖动对话标签 = 拖动那个会话（tab 与 sessionId 绑定，落 `session_pane` 映射） |
| 右栏 files | 已有 fs.rs | 不动（pi 的 read 工具与文件树同 cwd，天然一致） |
| logs 窗格 | `on_tool_start/end` 钩子 + ToolExecutionUpdate | pi 工具执行的流水，落到窗格 |
| 机器人（bots） | 机器人 = system_prompt+tools+model 的预设 | 点开机器人会话 = 带 `SessionOptions.system_prompt/enabled_tools` 建会话 |

### 3.3 设置页（自己做的壳，接线清单）

| 设置 section | 数据源 | 落点 |
|---|---|---|
| **提供方** | `pi --list-providers` 语义 → L3 缓存 | API key 管理：写 `~/.pi/agent/settings.json` 兼容键或 env；上游支持 env vars + `!command` shell lookup（models.md）|
| **模型** | `get_available_models` / models.json | 自定义 provider 走 `~/.pi/agent/models.json`（baseUrl/apiKey/models，ollama 等本地 provider 内建）|
| **对话** | settings.json | `steering_mode`/`follow_up_mode`（one-at-a-time/all）、compaction 三参数 |
| **记忆与上下文** | settings.json | `compaction.enabled/reserve_tokens/keep_recent_tokens`；SessionOptions 覆盖优先 |
| **工具与密钥** | `BUILTIN_TOOL_NAMES` + ToolRegistry | per-机器人 `enabled_tools` 勾选 |
| **技能与扩展** | docs/skills.md + packages.md | 技能目录 `~/.pi/agent/skills/`、`.pi/skills/`；包管理 `pi install/remove/list`（npm/git/local 三源）；`extension_policy: safe|balanced|permissive` |
| **MCP** | McpSessionOptions | config_paths 管理 + 服务器开关 |
| **审批**（能力提示） | extension_ui_handler 决策 | `~/.pi/extension-permissions.json` 的镜像视图（mirach 场景存自己库里）|

### 3.4 控制面走 Tauri IPC（不走 AG-UI）

「不属于 Agent 循环」的判据（AGENTS L2 正交原则）：

```
IPC：session_list / session_create / session_open / session_delete /
     session_rename / set_model / set_thinking_level / get_state /
     get_messages / compact / fork / export_html / get_agui_endpoint /
     extension_ui_response / ask_response / approval (capability)
AG-UI：prompt(发消息+收流) / interrupt / resume / tool-result
```

注意 `set_model`/`get_state` 两处都有人想往 AG-UI 塞——**不**。它们是
会话管理面，设置页与侧栏在无轮次运行时也要用。

### 3.5 审批与问题卡（pi 的两个 UI 回调）

pi 有两类「引擎伸手要 UI」的请求，都必须由 L3 的 handler 承接：

1. **ExtensionUiRequest**（能力审批 confirm/select/input/editor/notify）：
   `SessionOptions.extension_ui_handler`（in-process，async_trait）。
   mirach 实现 → Tauri 事件发前端弹窗 → 决定回传 handler。
   **fail closed**：handler 缺位 = deny。`persist: false`（会话内记忆）
   由弹窗第三态「仅本次」提供。
2. **ask 工具**（`ask_request` 事件：questions[{question, options,
   multi}] + timeoutMs）：RPC 模式下是事件；in-process 下经
   ToolExecutionUpdate/ask_tool 面暴露（落地时以 sdk.rs 实测为准）。
   UI = 问题卡组件（elements/option-list 将来可套用），答案走
   `ask_response` 语义回灌。
   **超时语义照抄上游**：timeout 后模型收到「用户未回答」错误，不挂死。

---

## 4. 数据真相边界（谁持什么）

### 4.1 对话真相 = pi（L4）

pi 的会话存储（V1 JSONL → V2 segmented store，含分支树/compaction/
checkpoint/迁移账本）是**对话真相的唯一持有者**。mirach 不解析、不改写
pi 会话文件——侧栏列表读 header 是「只读镜像」。fork/branch/tree 全部
下沉给 pi 的能力面。

### 4.2 UI 快照 = mirach SQLx（L3）

run 边界快照（AgentEnd/TurnEnd）落 mirach 自己的 SQLx，**只服务**
resume/审计/崩溃恢复，不是第二真相。删会话 = 调 pi 删 + 删 mirach 快照，
顺序：先 pi 后快照（真相在后删的一方）。

### 4.3 配置真相 = pi settings.json（兼容镜像进设置页）

设置页读写 `~/.pi/agent/settings.json` 的兼容键（camelCase alias 上游
自认），`PI_CONFIG_PATH` 不设（pi 双文件合并语义：全局+项目）。mirach
自有的 UI 偏好（主题/语言/布局）继续走 mirach 的存储，**不混进** pi
settings。

---

## 5. mock → 真引擎的切换面

`src/components/assistant-ui/runtime.tsx` 的 `mockModelAdapter` 退役
路径：AssistantRuntime 的 ChatModelAdapter 改为「把 composer 提交发到
L2 AG-UI、把 SSE 事件喂回 assistant-ui store」的适配器。**UI 层一行不
改**——这是当初选 assistant-ui + AG-UI 的全部理由。切换后必须回归
mock 时代验证过的全部状态：思考流式/完成折叠/工具运行/1 tool call/
thinking-indicator 三态/composer 全控件。

---

## 6. 落地顺序（照 AGENTS「待办 3」，细化到文件）

1. **L3 骨架**：`src-tauri/Cargo.toml` 加 pi 依赖（path 引用 G 盘）→
   `pi_session.rs`（create/prompt/abort/state 五个函数打通，asupersync
   runtime 起来）→ `cargo check` 过（recursion_limit 生效验证）。
2. **L2 打通**：axum `/ag-ui` 一条竖链，AgentEvent→AG-UI 翻译器
   （§2.2 表逐行写单测，用 pi 的 AgentEvent 构造样本）。
3. **L1 切换**：runtime.tsx 适配器换成真 SSE；发消息→流式回复→渲染。
4. **控制面**：IPC 十二命令（§3.4）+ 侧栏 sessions 列表 + composer
   ModelSelector/ContextDisplay 点亮。
5. **审批/问题卡**：extension_ui_handler + ask 卡片。
6. **设置页接线**（§3.3 表）与技能/包管理。

每步的验收 = AGENTS 两门禁（tsc + vitest）+ `cargo check`，外加
「§5 状态回归清单」逐项过。

---

## 7. 风险与未决（记录在案）

- **asupersync ≠ tokio**：pi 的 future 不能进 tauri::async_runtime。
  L3 需要一个 per-app 的 asupersync runtime 单例（或 SessionOptions
  runtime 注入），shutdown 顺序在 app 退出钩子里处理。
- **steer/follow_up 在 in-process 缺位**（上游 Compatibility Notes）：
  MVP 降级为 abort+prompt，设置页注明；或换 rpc_subprocess 传输。
- **workspace_trusted 默认 false**：打开项目的「信任此目录」确认框是
  必需 UI，不是装饰。
- **G 盘 path 依赖**：`G:/pi_agent_rust-main` 是开发期 path 引用；
  出包前换成 git rev-pin 或 vendored 拷贝（上游发 crates.io 后用版本）。
- **pi 版本漂移**：上游 0.5.1，`pi::sdk` 之外全是 #[doc(hidden)] 不
  稳定面——集成只准 import `pi::sdk::*`（+ `pi::model::` 的事件类型），
  碰别的模块即违反 SemVer 纪律。
- **Windows**：上游 windows.md 有专门文档，编译/路径坑开工前先读；
  rust-toolchain 1.95 与本机工具链对齐。
