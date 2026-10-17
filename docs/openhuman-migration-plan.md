# openhuman 全量移植可行性（方案 B）

> 2026-10-17。目标：全量照抄 openhuman settings（132 文件 / 27,914 行），
> 引擎侧没有的数据**标注出来由你决定（删 or 加引擎能力）**；能用 pi 接口
> 代替的 OpenHuman API 一并替换。

## 0. 关键发现：openhuman 的数据面是 **RPC**，不是 Tauri IPC

openhuman 前端调 `callCoreRpc('openhuman.xxx', …)` → Rust `relay_http_rpc`
→ 自己的 core 进程。**86 个 RPC 方法**。我们的 pi 是 in-process SDK +
Tauri IPC（52 条命令）。

所以「复制面板」= 复制 UI + 把 `callCoreRpc(...)` 换成我们的 `invoke(...)`。

## 1. 面板 ↔ pi 能力映射（能接的）

| openhuman 面板 | 行 | openhuman RPC | pi 对应 | 可否代替 |
|---|---|---|---|---|
| `AIPanel`（模型/供应商） | 466 | `inference_list_models` / `config_update_model_settings` / `inference_test_connection` | `pi_list_models` / `pi_set_model` / `pi_get_models_config` | ✅ **能**（模型目录 + 默认模型 + provider 凭据） |
| `ai/ProviderAuthSection` | 508 | `auth_get_state` / `auth_set_credential` | `pi_auth_status` | ✅ 能（存在性/来源/环境变量，pi 不返回 key 内容——比 openhuman 更严） |
| `ai/ProviderModelPickerDialog` | 445 | `inference_list_models` | `pi_list_models` | ✅ 能 |
| `ToolsPanel`（工具开关） | 214 | `config_get`/`config_update`（tools 段） | `pi_get_settings` / `pi_set_settings`（`tools.loadMode`） | ⚠️ **需改造**：pi 的工具开关是 `enabled_tools`（SDK 参数），不是 settings.json 字段 |
| `AutonomyPanel`（限流） | 190 | `config_get/update_autonomy_settings` | **无** | ❌ 引擎缺：pi 无 `max_actions_per_hour` |
| `PermissionsPanel`（三级权限/路径） | 339 | `config_get/update_agent_paths` + autonomy | **部分**：pi 有 `workspace_trust`、`enabled_tools`、tool_approval | ⚠️ 需映射，无三级预设 |
| `SearchPanel`（搜索供应商/路由/白名单） | 242+ | `config_get/update_search_settings` | **部分**：pi 有 `web_search` 工具 + `browser` 域名白名单 | ⚠️ 需改造 |
| `SandboxSettingsPanel` | 364 | `config_get/update_sandbox_settings` | **无** | ❌ 引擎缺 |
| `ComputerPanel` | 256 | `config_update_computer_settings` | **部分**：pi 有 `computer` 工具 | ⚠️ |
| `EmbeddingsPanel` | 573 | `embeddings_*`（9 个 RPC） | **无** | ❌ 引擎缺（pi 无 embeddings） |
| `MemorySettingsTab` / memory RPC | 8 | `memory_*`（29 个 RPC） | **无** | ❌ 引擎缺（pi 有 `memory` 模块但无这些 RPC） |
| `McpServerPanel` | 278 | `mcp_*` + `mcp_open_client_config` | **无 IPC**（pi 有 `SessionOptions.mcp` 未启用） | ❌ 引擎缺 + 未启用 |
| `VoicePanel` / `LiveVoicePanel` / `VoicePanel*` | 554+415+ | `inference_tts` / `voiceSettingsApi` | **部分**：pi 有 `tts` 工具 | ⚠️ |
| `CronJobsPanel` / `cron/*` | 284+924 | `config_get/update` + core cron | **无**（pi 有 `jobs` 但不定时） | ❌ 引擎缺 |
| `WalletPanel` / `WalletBalancesPanel` / `wallet/*` | 53+567+ | `walletApi` | **无** | ❌ 引擎缺（crypto） |
| `RecoveryPhrasePanel` | 439 | `walletApi` | **无** | ❌ 引擎缺（crypto） |
| `ComposioPanel` / `ComposioTriagePanel` | 457+162 | `composioApi` | **无** | ❌ 引擎缺（SaaS 集成） |
| `ApprovalHistoryPanel` | 258 | `approvalApi` | **部分**：pi 的 `ApprovalRegistry` 只有 pending，无历史 | ⚠️ 需加历史存储 |
| `EventLogPanel` | 466 | `coreRpcClient` 事件流 | **部分**：pi 有 AG-UI 事件（可桥接） | ⚠️ |
| `SystemDiagnostics` / `DeveloperOptionsPanel` | 168+461 | `logs_folder_path` / `health_snapshot` | **部分**：pi 有 stats/doctor 模块 | ⚠️ |
| `ThemeStudioPanel` / `AppearancePanel` / `theme/*` | 550+191+ | 本地 store | ✅ **能**（纯前端，接我们的 tokens.css） |
| `AboutPanel` | 221 | `check_app_update` | **部分**（我们无自更新） | ⚠️ |
| `AccountPanel` / `FeedbackPanel` / `MigrationPanel` | 122+336+400 | 云账号 | **无** | ❌ 引擎缺（无云账号体系） |
| `PrivacyPanel` / `PrivacyModeSection` | 74+172 | `config_get/set_privacy_mode` | **无** | ❌ 引擎缺 |
| `PersonaPanel` / `persona/*` | 344+ | `personaFilesApi` | **部分**：pi 有 `system_prompt` | ⚠️ |
| `AgentAccessPanel` | 573 | 组合多个 | 组合 | ⚠️ |
| `MascotPanel` | 906 | 本地 store | **无** | ❌ 不支持（吉祥物） |
| `BrowserConnectionsPanel` / `LlmConnectionsPanel` / `VoiceConnectionsPanel` / `ComputerStatusCard` | 296+56+15 | core rpc | **部分** | ⚠️ |
| `TokenUsagePanel` / `UsagePanel` | 342+78 | usage | ✅ **能**：`pi_sessions_usage` + `usage-bridge` |
| `FilesFolderSection` | 154 | 本地 | ✅ 能 |

### 小结

- ✅ **能接（真数据）**：AIPanel 系（4 个）、Theme/Appearance、TokenUsage/Usage、FilesFolder —— 约 **2,900 行**
- ⚠️ **需改造**：Tools / Permissions / Search / Computer / Voice / ApprovalHistory / EventLog / Diagnostics / Persona / AgentAccess —— 约 **4,000 行**
- ❌ **引擎缺**：Autonomy / Sandbox / Embeddings / Memory / MCP / Cron / Wallet / RecoveryPhrase / Composio / Account / Feedback / Migration / Privacy / Mascot —— 约 **7,000 行**
- 基础设施（layout/sidebar/subnav/registry/hooks/controls/ui）—— 约 **14,000 行**，无数据依赖，**可全抄**

## 2. 移植基础设施清单（无数据依赖，可直拷）

| 目录 | 行 | 处理 |
|---|---|---|
| `components/ui/*`（48） | ~5.6k | 直接拷（部分与我们 shadcn 重名，放 `settings/ui/`） |
| `components/settings/layout/*` | ~800 | 拷，去掉 router（用 state 切面板） |
| `components/settings/controls/*` | 13 shim | 拷（指向 ui） |
| `components/settings/hooks/*` | 165 | 拷，`useLocation/useNavigate` → 本地 state |
| `components/settings/settingsRouteRegistry.ts` | 651 | 拷，删掉引擎缺的面板条目（或标注后隐藏） |
| `lib/i18n/I18nContext.tsx` | 106 | **替换**：用我们既有 i18n（en+zh） |
| `components/layout/TwoPaneNav.tsx` | 137 | 拷（依赖 Button） |
| `components/layout/PanelPage.tsx` / `ChipTabs` | ? | 拷 |

## 3. 需要你决策的三类

**A. 引擎缺（14 个面板）** —— 删掉 UI，还是加引擎能力？
Autonomy（每小时动作上限）、Sandbox、Embeddings、Memory（29 RPC）、
MCP、Cron、Wallet、RecoveryPhrase、Composio、Account、Feedback、
Migration、Privacy、Mascot。

**B. 需改造（10 个面板）** —— 我先按"最接近"映射做出来，标注差距？
Tools（pi 的 `enabled_tools` 是 SDK 参数，改完要重建会话）、
Permissions（pi 无三级预设）、Search（pi 的 `web_search` 无 provider 概念）、
Computer / Voice / ApprovalHistory / EventLog / Diagnostics / Persona / AgentAccess。

**C. 基础设施（14k 行）** —— 直接抄，不涉及决策。

## 4. 我的建议

**分三步**：
1. **先抄基础设施 + 能接的 4 个面板**（AIPanel 系 / Theme / Usage / Files）——
   跑起来给你看外观，占位面板统一显示"引擎侧缺数据"。
2. **再改造 10 个**，逐个标注差距。
3. **14 个引擎缺的**，UI 保留 + 醒目标注，你逐个决定删/加。

这样你能先看到"openhuman 长什么样"，再决定哪些值得补引擎。
