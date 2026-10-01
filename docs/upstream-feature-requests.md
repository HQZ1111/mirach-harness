# pi_agent_rust 上游 Feature Request 清单（2026-10-02）

> 收件仓库：https://github.com/Dicklesworthstone/pi_agent_rust（当前最新
> v0.6.1，2026-09-24；mirach-harness vendored 0.5.1）。本文整理 mirach
> 桌面壳在集成中发现的数据模型缺口，按价值排序。每条含：现状、提议、
> 为什么该在上游做（而非宿主补丁）。

## FR-1：citations / sources 数据模型

**现状**：`ContentBlock` 六变体（Text/Thinking/RedactedThinking/Image/Media/
ToolCall）与 `AgentEvent` 全部变体均无引用/来源字段；provider 原始响应里的
citations（Anthropic citations API、Gemini grounding、OpenAI web_search
annotations、Perplexity citations）在 pi 的 provider 流解析层被丢弃。
全 src 搜 citation 零命中（0.5.1 与 0.6.1 changelog 均无）。

**提议**：二选一——
1. `ContentBlock::Citation(CitationContent { url, title, source_type, ... })`
   作为一等块；或
2. 消息级 `AssistantMessage.citations: Option<Vec<SourceRef>>` +
   provider 解析层把各家 citation 格式归一化写入。

**为什么在上游做**：citations 格式各家 provider 不同，映射必须住在
provider 适配层（pi 的核心职责区）；宿主侧只能拿到已被丢弃后的流。
**宿主过渡方案（已可自行实施）**：provider 原始 citations 透传进
`ToolOutput.details`（自由 JSON 位）——不改 serde 模型的窄版补丁。

## FR-2：UI hostcall select / input / editor 的 payload schema

**现状**：`ExtensionUiRequest` 支持多 method，但 select/input/editor 的
payload 形状在源码与文档中均未定义（0.5.x 至 0.6.1 changelog 皆无；最近
相关只有 0.5.0 的 `capability_prompt`→`capabilityPrompt` 改名）。宿主实现
`ExtensionUiHandler` 时无法渲染结构化选择/输入卡——mirach 审批卡目前
只完整支持 confirm，其余 method 只能显示原始 payload + 取消。

**提议**：为每个 method 定义 envelope schema 并写进 docs/sdk.md，例如
select: `{ question, options: [{label, value}], multi?: bool }`、
input: `{ prompt, placeholder?, multiline? }`；校验失败 fail-closed。

**为什么在上游做**：schema 是扩展生态契约——宿主各定各的，扩展作者的
同一份 hostcall 在不同壳里行为不同；上游定一次全生态受益。
（changelog 显示 0.99.x 的 TS 版 pi 已有 elicitation 相关演进，Rust 版
可对齐其语义。）

## FR-3：自动命名下沉到 SDK 层（可选）

**现状**：auto-titling 已存在于 TUI 编排层（`interactive/agent.rs`，
首轮完成后向小模型要名字、fire-and-forget、手动命名优先），配置键
`titling.auto_title` 也在 Config；但 in-process SDK 宿主拿不到这套编排
（`complete_ai` 宿主桥默认返回 "not configured"）。

**提议**：SDK 提供 opt-in 的 title 回调或事件（如 `SessionTitleSuggestion`
事件透出给宿主），复用 TUI 的防呆（回答式输出拒绝、示例回声检测、
"friendly greeting" 占位不覆盖）。宿主 mirach 已在客户端实现规则段
（首条消息截断命名 + 撞名 `#N` 谱系编号），LLM 段等此 FR 或走
`complete_ai` 桥。

## FR-4（小）：`AgentSessionHandle` 稳定面透出分支读取

**现状**：`Session.sibling_branches()` / `navigate_to()` /
`to_messages_for_current_path()` 均 pub，但只能在
`session_mut()`→`Arc<Mutex<Session>>` 的深层拿（宿主可行，已实现）；若
未来上游收紧内部字段（leaf_id 已是 pub(crate)），宿主路径会断。

**提议**：把"列出兄弟分支 / 切叶 / 读当前路径消息"提升为
`AgentSessionHandle` 的稳定方法（fork 已有 RPC 形态，补进程内对称面）。
优先级低——宿主当前路径可用，仅作 API 稳定性建议。

---

## 已确认无需 FR 的项（防重复劳动）

- **steer/follow_up**：v0.6.0 已加（"live steering, follow-up and abort
  within a turn; turn-wide deadlines"）——升级即得。
- **Windows 保存 Access denied**：v0.6.0 已修（gh #239）——宿主本地补丁
  可退休。
- **结构化工具输出**：TS 版 0.99.0 已有 `outputSchema + structuredContent`，
  Rust 版 ToolOutput.details 自由 JSON 位够用——宿主约定即可。
- **消息时间戳**：已有（UserMessage/AssistantMessage.timestamp）。
