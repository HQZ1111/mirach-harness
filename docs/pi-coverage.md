# pi 能力覆盖清单（2026-10-17）

> 回答三个问题：①pi 功能接完了吗？②哪些能力该接但没前端 UI？③哪些能力
> 完全没用上？
>
> 口径：**"接"= 有 IPC/数据通路 + 有可见 UI 或渲染分支**。只有 IPC 没有 UI
> 不算接完；只有工具渲染没有专用卡不算"没 UI"（走通用卡也是 UI）。

## 0. 总账

| 面 | 数量 | 状态 |
|---|---|---|
| 我们的 IPC 命令 | 52 | 全部有前端调用（`pi_get_messages`/`pi_sessions_usage`/`session_meta_get` 等经别名模块调用） |
| pi 内置工具 | 46（含子动作） | **2 个有专用渲染**（bash / web_search），其余走通用卡 |
| pi 非工具能力 | 见 §3 | 大部分已接，少数无 UI |

---

## 1. 工具 → UI 覆盖

### A. 有专用渲染（2）
| 工具 | UI | 数据 |
|---|---|---|
| `bash` | `terminal-block`（命令 + 行输出） | args.command + result |
| `web_search` | `web-search`（查询 + 结果条） | args.query + 解析结果 |

### B. 有 IPC 拉取面 + 面板分区（3，间接 UI）
| 工具 | UI | 说明 |
|---|---|---|
| `todo` | 活动面板「待办」分区（官方 `TodoList`）+ `pi_todo_state` | 完整 |
| `hub` | 活动面板「子代理」分区（`TaskCard` + Stop）+ `pi_hub_roster`/`pi_hub_kill` | roster/kill 接了；**transcript/steer/inbox/revive 无 UI** |
| `jobs` | 活动面板「终端」分区（`TaskCard` + Stop）+ `pi_job_list`/`pi_job_cancel` | list/cancel 接了；**wait 无 UI** |

### C. 只走通用卡（无专用渲染）—— **应该补 UI 的**
| 工具 | 现状 | 建议 UI |
|---|---|---|
| `read` `edit` `write` `ls` `find` `grep` `hashline_edit` | 通用卡（args + 文本结果） | **`code-diff` / `file-tree` / `document-reference`** —— 编辑类应有 diff 视图，这是最大缺口 |
| `submit_plan` | 通用卡 | `agent-plan`（解析 plan 文本成 steps） |
| `ask` | 通用卡 | `elicitation-form` / 审批卡（pi 有 ask 策略但宿主未装 picker UI） |
| `lsp` `debug` | 通用卡 | 无现成组件，可做专用卡 |
| `ast_grep` `ast_edit` | 通用卡 | 可复用 diff/结果卡 |
| `github` | 通用卡 | 无组件 |
| `security_scan` | 通用卡 | `score-breakdown` 可用 |
| `eval` | 通用卡 | `code-runner` 可用 |
| `current_time` | 通用卡 | 无需专用（一行文本） |
| `inspect_image` `read_media` | 通用卡 | `image` 元素可用 |
| `generate_image` | 通用卡 | `image-generation` 元素可用 |
| `tts` | 通用卡 | 可接 `voice` |
| `computer` `browser` | 通用卡 | `computer-use` / `web-preview` 可用 |
| `subagent`（opt-in） | 未启用（`enabled_tools` 不含） | 走 `hub` 名册即可 |

---

## 2. 「有能力、没有前端 UI」——优先补

按价值排序：

1. **编辑类工具的 diff 视图**（`edit`/`write`/`hashline_edit`）——`code-diff` /
   `reviewable-diff` 组件已在树里，pi 的 ToolOutput 有 content，但**没有逐行
   diff 结构**（只有文本）。要精确 diff 需要宿主解析或上游加字段
   （见 engine-gaps 类似项）。
2. **`submit_plan` 的计划视图**——`agent-plan` 可用，但 pi 的 details 只有
   `{planReview}`，正文在文本里 → 需解析 markdown 成 steps（可做）。
3. **`ask` 工具的问题卡**——`elicitation-form` 可用。pi 的 `ask` 已启用，
   但**宿主没装 channel UI**（`AskTool` 走 `ask_policy` 自动回答）。接
   `hub`/`ask` 的 UI 需要宿主装 picker —— **这是真缺口**。
4. **`hub` 的 transcript / steer / inbox**——`TaskCard` 的 children 槽可展开
   transcript（pi 有 `transcript_page`）。steer/inbox 需要输入面。
5. **`jobs` 的 wait/输出全量**——`TaskCard` result 已显示 `outputTail`，
   全量要走 `artifactPath` 读文件。
6. **`github` / `lsp` / `debug`**——无现成组件，价值中等。
7. **`inspect_image` / `read_media` / `generate_image` / `tts`**——组件在树里
   （`image`/`image-generation`/`voice`），增量小。

---

## 3. 非工具能力 —— 接线情况

| pi 能力 | IPC | UI | 状态 |
|---|---|---|---|
| 发消息 / 流式 | `POST /ag-ui` + SSE | 对话区 | ✅ |
| 中断 | `pi_interrupt` | composer 停止钮 | ✅ |
| 会话列表/新建/打开/删除/重命名 | 5 条 IPC | 左栏 | ✅ |
| 会话分叉 / 分支切换 | fork/points/siblings/switch | 消息分支条 | ✅ |
| 检查点 mark/list/rewind | 3 条 IPC | CheckpointBar | ✅ |
| 重试编辑 | `pi_retry_edit` | 消息编辑 | ✅ |
| 压缩（自动） | CUSTOM compaction | guardrail-notice 横幅 | ✅ |
| 手动压缩 `compact` | `pi_compact` | **会话维护条**「压缩上下文」 | ✅ 已接（2026-10-17） |
| fork 出子会话后打开 | `pi_open_session` | 会话分栏 | ✅ |
| 模型列表/切换 | `pi_list_models` / `pi_set_model` | composer 选择器 | ✅ |
| thinking level | `pi_set_thinking_level` | composer | ✅ |
| 设置读写 | `pi_get_settings` / `pi_set_settings` | 设置浮层 | ✅ |
| 模型配置读写 | `pi_get_models_config` / `pi_set_models_config` | 设置浮层 | ✅ |
| 认证状态 | `pi_auth_status` | 设置浮层 | ✅ |
| 资源清单（skills/prompts/agents） | `pi_list_resources` | hub 入口栏 + 对话框 | ✅ |
| 会话导出 HTML | `pi_export_session_html` | 会话菜单 | ✅ |
| 会话用量（批量） | `pi_sessions_usage` | 侧栏用量 | ✅ |
| 扩展 UI 请求（审批） | `pi_pending_approvals` / `pi_extension_ui_response` | approval-cards | ✅（仅 confirm/custom 有约定） |
| 扩展（extensions）加载 | `SessionOptions.extension_paths` | **无 UI** | ❌ **缺口**（只能配置文件） |
| MCP 服务器 | `SessionOptions.mcp`（未设） | **无 UI** | ❌ **未启用** |
| 工作区多根（`/add-dir`） | `SessionOptions.workspace`（未设） | **无 UI** | ❌ **未启用** |
| 撤销 / 重做（undo） | `pi_undo_redo` / `pi_undo_history` | **会话维护条**「撤销 (N) / 重做」 | ✅ 已接（2026-10-17；pi 的 `create_agent_session` 默认路径已挂 `FileMutationRecorder`） |
| steer / follow-up（排队） | **无 IPC** | 入队靠 `sessionQueue`（宿主自建） | ⚠️ 部分 |
| `ask` 工具 picker | 无 | approval-cards 兜底 | ⚠️ 部分 |
| advisor / semantic context | 未设 | 无 | ❌ 未用 |
| 自动重试（failover） | `SessionOptions.retry = None`（默认不重试） | 无 | ⚠️ 有意关闭 |
| 会话导入 | 无 | 无 | ❌ 未用 |
| agent_hub revive / bus | 无 IPC | 无 | ❌ 未用 |
| swarm 分析器（ledger/flight/replay/SLO） | 无 | 无 | ❌ 未用（离线工具，非实时面） |
| worktree 隔离（`worktree_iso`） | 无 | 无 | ❌ 未用（subagent isolation 参数未用） |
| 统计（session stats / token） | 部分（usage） | 部分 | ⚠️ |
| RPC 子进程传输 | 未用（in-process SDK） | — | 有意 |

---

## 4. 结论

**接完了吗？** 核心链路（对话/会话/工具/检查点/分支/审批/设置/模型）**完整**。
但有三类没接完：

**A. 有 pi 能力、缺前端 UI（应补）**
1. `edit`/`write` 的 diff 视图（组件在，缺结构化 diff 数据）
2. `submit_plan` 的计划卡
3. `ask` 工具的交互卡（需宿主装 picker）
4. `hub` transcript/steer/inbox

**已补（2026-10-17）**：手动 `compact`（`pi_compact` + 会话维护条）、
撤销/重做（`pi_undo_redo` / `pi_undo_history` + 会话维护条）。

**B. 有 IPC 但 UI 弱**
- `hub`/`jobs` 只有 list/kill/cancel 面，深层操作（transcript/steer/wait）无入口

**C. 完全没用上的 pi 能力**
- MCP（`SessionOptions.mcp` 未设）
- 多根工作区（`SessionOptions.workspace` 未设）
- 扩展加载（无 UI，只能改文件）
- advisor / semantic context
- 会话导入、agent_hub revive/bus、swarm 分析器、worktree 隔离
- 自动重试（有意关）
- RPC 子进程传输（有意不用）

**D. 有意不接**
- `subagent` 工具（opt-in；用 `hub` 名册代替）
- swarm_*（离线分析器，非实时面板数据面）
- RPC 传输（in-process 更简单）

---

## 5. 核实依据（2026-10-17 逐项查证）

`SessionOptions` 的实际赋值（`pi_session.rs` `create_session_opts`）只设：
`provider` / `model` / `system_prompt` / `no_session:false` / `session_path` /
`workspace_trusted` / `working_directory` / `extension_ui_handler` /
`persist_extension_permissions:false`，其余走 `..Default::default()`。

逐项 grep 证实**未出现**：`mcp:`、`workspace:`、`extension_paths:`、
`compact`（无 IPC）、`undo` / `mutation_recorder`。

工具侧：`thread.aui.tsx` 的 `PiToolUI` 只有两个专用分支——
`toolName === "bash"` 与 `toolName === "web_search"`；其余全走
`GenericToolCall`（通用折叠卡，args + 文本结果）。

IPC 侧：52 条命令全部有前端调用（`pi_get_messages` / `pi_sessions_usage` /
`session_meta_get` 经别名模块调用）；`approve_action` / `delegate_to_agent` /
`sync_app_context` 只存在于 `lib/ipc.ts` + 测试，**后端无对应命令**
（legacy 草案残留）。

