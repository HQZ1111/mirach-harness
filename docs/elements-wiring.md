# elements 组件接线清单（2026-10-17 审计）

> 对象：`src/components/assistant-ui/elements/` 下全部 110 个组件。
> 判据：**有真数据 + 不与现有渲染重复**才接；缺数据或重复的登记原因，
> 不为了"接满"而编造（见 AGENTS「禁止兜底」）。
>
> 统计：**已接 30**（+ 面板内直接消费 3：todo-list / task-card / logos；
> 合计 33 个在渲染）/ **孤儿 80**。

## 一、本轮新接（7 个）

| 组件 | 挂点 | 数据源 | 适配 |
|---|---|---|---|
| `todo-list` | 活动面板「待办」分区 | `todo-store`（`todo_list.v1`） | `panel-adapters.toAuiTodoItems`（open→pending / in_progress→active / dropped→done+「已删除」/ blocked→failed+reason） |
| `task-card` | 活动面板「子代理」「终端」分区 | `agent-hub-store` / `jobs-store` | `panel-adapters.childToTaskCardState`；终端用 exitCode 判 done/failed |
| `logos` | 模型选择器图标 | `model-catalog-store.toModelOptions` | provider 关键字 → Claude/OpenAI/Gemini；**未匹配不塞图标** |
| `quote.aui` | 用户消息 `MessagePrimitive.Parts` 的 `Quote` 槽 | assistant-ui quote part | 无 |
| `typing-indicator` | 助手消息 indicator 部件 | `status.type === 'running'` | 替换此前手写的 `"●"` 脉冲 |
| `tool-timeline` | 助手消息底部（run 级） | 消息的 tool-call 部件聚合 | verb=工具名、chip=参数摘要 |
| `day-separator`（行提取） | 消息间隙 | `createdAt` | 已有（组件本体是整块演示，只提取日期行） |

## 二、明确不接的原因（按类别）

### A. pi 无数据（引擎侧缺口，见 `engine-gaps.md`）
`context-breakdown`（无分段 token）· `quota-banner`（无配额）·
`activity-graph` / `trace-waterfall` / `timeline` / `heat-graph`
（swarm_* 是**离线分析器**，不产生事件）· `agent-handoff`（无 handoff 事件）·
`agent-status`（无状态机事件）· `artifact-card`（无 artifact 概念）·
`memory-chips`（无 memory API）· `schedule-card`（无定时任务 API）·
`job-progress`（bash job 是单阶段，无 stages/weight——硬塞即编造）·
`sources` / `inline-citation`（pi 无 citations，见 FR-1）·
`approval-card` / `elicitation-form` / `permission-grant`
（`ExtensionUiRequest` 只有 confirm/custom 有约定，见 FR-2；现有
`approval-cards.tsx` 已覆盖通用面）

### B. 生成式 UI 展示壳（要模型产结构化 payload，未建 A2UI）
`chart` · `flow-graph` · `diagram` · `canvas-split` · `data-table` ·
`comparison-card` · `recommendation-card` · `research-report` ·
`retrieval-chunks` · `score-breakdown` · `spec-sheet` · `map-answer` ·
`generative-ui` · `confidence-marker` · `computer-use` · `image-generation` ·
`web-preview` · `document-reference` · `code-runner` · `code-diff` ·
`reviewable-diff` · `file-tree`（已有真实文件树 pane）

### C. 与现有渲染重复（接了就会双份）
| 组件 | 重复对象 |
|---|---|
| `checkpoint-history` | `CheckpointBar` 面板（**且官方第三行硬编码 `{files} files`，pi 只有 messageCount——单位不匹配会撒谎**） |
| `edit-message` | `EditComposer`（`ComposerPrimitive` 全链已接） |
| `message-pair` / `streaming-text` | assistant-ui 消息渲染（自带流式） |
| `scroll-anchor` | `thread-scroll-store` + `ThreadPrimitive.Viewport`（官方是带假打字机的演示件） |
| `loading-state` | `ThreadThinkingIndicator`（同为「正文未到」态） |
| `agent-plan` | 待办分区已表达计划（`submit_plan` 的 details 无结构化 steps） |
| `task-card`（独立任务卡语义） | 面板已用（见上） |
| `voice` / `voice-conversation` / `voice.aui` | 已接 `voice.aui`（朗读链） |
| `mobile-composer` / `launcher-bubble` / `onboarding` / `draft-restore` / `feedback-dialog` / `shared-conversation` / `conversation-search` / `thread-search` / `prompt-library` / `mcp-server-panel` / `mcp-config.aui` / `file` / `image` / `mermaid-diagram` / `markdown-text` / `directive-text` / `math-block` | 各自有等价现役实现，或需新的交互面（下一轮） |

> `directive-text`：需要 `DirectiveTextFormatter`（指令语法），pi 侧无此语法。
> `math-block`：需要结构化 `steps`（表达式 + 注记），消息里只有 LaTeX 文本；
> 接它要加 `remark-math` + katex 依赖（未做）。
> `markdown-text`：现役 `src/components/markdown-text.tsx`（shiki 高亮）已是
> 更完整版本。

## 三、验证

- 实跑（CEF + CDP）：面板注入真形状数据后渲染 —
  `todo-list` / `task-card`(×2, 含 actions/result) 均出现在 DOM
  （`data-slot` 实测），console 错误 0。
- 回归：tsc 0 / vitest 全绿（面板 31 用例，含 7 个 adapter 用例）/
  cargo test 53 / vite build OK。
