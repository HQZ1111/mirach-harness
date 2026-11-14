# rpi-main 迁移映射表（2026-11-14 竖链移植 + 全量能力审计）

> 用户定稿："核心换成 G:\pi-rust-main（rpi），不用 pi agent rust 了，单引擎"。
> 本文档 = rpi 工作区（v0.24.0，11 crate / ~2700 pub 面）与旧 pi_agent_rust
> 0.8.0 SDK 的逐面映射审计 + mirach 12 个迁移模块的归宿表。
>
> 竖链（对话核心）**已完成**（b9df5b9）：pi_session.rs 对话面 + agui.rs 映射
> 走 rpi-harness AgentHarness，AG-UI 协议面 100% 不变。本文档记录剩余迁移。

## 一、rpi 工作区 crate 职责

| crate | pub 面 | 职责（旧 pi SDK 对应物） |
|---|---|---|
| rpi-ai | 210 | LLM 层：Content/Message/AssistantMessage/Usage/Tool + AssistantMessageEvent 流 + Provider trait + anthropic/openai 真实现（= 旧 pi::model + pi::provider） |
| rpi-agent | 97 | Agent 运行时：Agent/AgentBuilder/run_agent_loop/AgentEvent/hooks/queues/abort（= 旧 pi::sdk 内核 + pi::model::AssistantMessageEvent） |
| rpi-harness | 538 | **AgentHarness**（会话树/JSONL 持久化/compaction/运行环/steering/follow_up）+ skills + prompt_templates + system_prompt + messages + durable（= 旧 pi::sdk::SessionOptions/create_agent_session + pi::session_index + pi::checkpoint + pi::resources 部分对应） |
| rpi-runtime | 67 | 模型配置/凭据/Provider 解析（ModelsConfig/ProviderConfig/AuthStore/Credential/OAuthRefresher）（= 旧 pi::config 路径/鉴权 + pi::provider_metadata） |
| rpi-tools | 197 | 内置工具：read/bash/edit/write + ExecutionEnv + FileIORouter（= 旧 pi::tools::ToolRegistry） |
| rpi-extensions | 103 | cdylib 插件 ABI（**与旧 pi::extensions 的 JS/WASM/Native 三运行时完全不同的设计**） |
| rpi-durable | 99 | 持久化操作日志（lane 操作 recovery/checkpoint 历史） |
| rpi-cli | 384 | **SDK 门面**：session::build（= createAgentSession）+ provider::resolve + settings + auth + export + session_gc + trust + child_agents + model_registry + packages |
| rpi-tui | 420 | 终端 TUI（mirach 不用） |
| rpi-telemetry | 20 | 遥测（mirach 不用） |

## 二、mirach 模块 → rpi 映射表

### ✅ 已完成（b9df5b9 竖链）

| mirach 模块 | 旧面 | rpi 新面 | 状态 |
|---|---|---|---|
| pi_session.rs 对话面 | pi::sdk::create_agent_session + SessionOptions + AgentSessionHandle | rpi-cli session::build → AgentHarness + AgentLane::prompt_text | ✅ |
| agui.rs 事件映射 | pi::sdk::AgentEvent | rpi_agent::AgentEvent（变体几乎同名，AgentEnd 无 error 字段——RUN_ERROR 走 prompt Err） | ✅ |
| agui.rs 图片 | pi ContentBlock::Image | rpi_ai::types::ImageContent（prompt_text 直收） | ✅ |
| pi_session.rs 中断 | pi::sdk::AbortHandle + PromptGuard | AgentLane::abort(&self)（无 handle） | ✅ |
| pi_session.rs 会话存储 | pi session_index（全局 ~/.pi/agent/sessions） | rpi durable JSONL（per-cwd `<workspace>/.rpi/sessions/`） | ✅ |
| egui 试验田 | pi::sdk 直连 | rpi-cli session::build 直连（验证通过） | ✅ |

### 🔄 本轮迁移（竖链收尾）

| mirach 模块 | 旧面 | rpi 新面 | 迁移方式 |
|---|---|---|---|
| pi_settings.rs 路径 | pi::config::Config::global_dir/auth_path | `~/.rpi/agent/`（pi_paths.rs） | 路径切换 + models.json 校验用 rpi_runtime::config::ModelsConfig ✅ |
| pi_settings.rs 模型目录 | pi::models::default_models_path | pi_paths::models_path（~/.rpi/agent/models.json） | ✅ |
| pi_settings.rs settings 校验 | pi Config 结构校验 | rpi-cli SavedSettings（Deserialize——pub 面待确认，或降级为 object-only） | 本轮 |
| pi_keys.rs auth 路径 | pi::config::Config::auth_path | pi_paths::auth_path | ✅ |
| pi_persona.rs 路径 | pi::config::Config::global_dir | pi_paths::agent_dir | ✅ |
| pi_connections.rs 路径 | pi::config::Config::global_dir | pi_paths::agent_dir | ✅ |
| pi_voice_live.rs HTTP | pi::http::client::Client | reqwest（rpi-ai 依赖树已有） | 本轮 |
| pi_capabilities.rs skills | pi::resources::load_skills/LoadSkillsOptions/Skill/format_skills_for_prompt | rpi-harness skills::load_skills(&ExecutionEnv, dirs)/format_skills_for_system_prompt/SourcedSkill | 本轮（ExecutionEnv = rpi-tools OsExecutionEnv + FileIORouter，照 CLI build 做法） |
| pi_resources.rs skills | pi::resources::load_skills + load_prompt_templates | rpi-harness skills/prompt_templates 同名 | 本轮 |
| pi_cron.rs 执行 | pi::sdk::create_agent_session + prompt_with_abort | rpi-cli provider::resolve(job.provider/model) → session::build → prompt_text | 本轮 |
| pi_cron.rs 路径 | pi::config::Config::global_dir | pi_paths::agent_dir（cron sessions 子目录） | 本轮 |
| pi_list_models | pi_list_models（旧 SDK 内部） | rpi-cli model_registry/list_models 或 provider::resolve catalog | 本轮 |

### ⏳ rpi-main 缺对应 → 如实降级 Err（标红待补）

| mirach 模块 | 旧面 | 缺口 | 降级 |
|---|---|---|---|
| pi_mcp.rs 全部 4 命令 | pi::mcp::config::discover/read/write_project_config + McpManager::test | rpi-main 无 MCP 模块（仅 plugin-sdk 提及 ACP/MCP stdio 概念） | MCP 页面 Err："rpi 引擎待接 MCP" |
| pi_extensions.rs | pi::extensions（JS/WASM/Native 三运行时 + 清单 + ResourceLoader） | rpi-extensions = cdylib 插件 ABI，无 manifest 目录扫描面 | 扩展页 Err |
| pi_pkg.rs 全部 4 命令 | pi::package_manager::PackageManager（install/remove/update/list） | rpi-cli packages.rs = 项目包运行（非安装管理） | 包管理页 Err |
| pi_usage.rs | pi::stats::aggregate（跨会话文件聚合） | rpi-harness get_stats = 单会话；无跨文件聚合 | usage 页 Err |
| pi_login.rs OAuth | pi::auth::OAuthStartInfo + AuthStorage + 本机回调服务器 | rpi-runtime credentials = 凭据解析（无 OAuth 启动流）；rpi-cli auth.rs run = 交互式 TUI | 登录页 Err（可配 env key） |
| agui.rs + main.rs ask | pi::ask::AskTool/AskResponse/AskAnswer | rpi 无 ask 工具 | ask 卡 Err |
| pi_session.rs 审批 | pi extension_ui → UiBridge → ApprovalRegistry | rpi before_tool_call 钩子可接（下一轮——工具本轮直接执行） | 审批卡暂不出现 |

### ✅ rpi-main 有、旧 SDK 没有的（新增能力，后续可接）

rpi-cli: session_gc / export_to_html+jsonl+markdown / trust.rs / child_agents.rs（子代理）/ model_registry（catalog 刷新）/ steer+follow_up 消息排队 / packages.rs（项目包运行）

## 三、依赖仲裁记录

- vendored pi 0.8.0 需 ignore ≥0.4.34（WalkBuilder::current_dir）
- rpi-cli 钉 globset "=0.4.15" → 已放宽（G:\pi-rust-main Cargo.toml 一行改 "0.4"）
- ignore 统一 0.4.34 / globset 0.4.21 / rpi 全家 0.24.0 / vendored pi 编译 ✓

## 四、后续路线

1. 本轮：完成上表「本轮」项 → 删 pi 依赖 → 删 vendor/pi_agent_rust
2. 下一轮：审批桥（before_tool_call + ApprovalRegistry）
3. 下一轮：消息水合重放（rpi JSONL → AG-UI messages）
4. rpi-main 侧（用户自己的 fork）：MCP 管理 / stats 聚合 / ask 工具 / 分支线系——每个 = 一轮 mirach 接回
