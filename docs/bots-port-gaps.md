# bots 插件移植完成度审计（2026-11-16）

> 口径说明：本文的「宿主」= **mirach 桌面应用（Tauri + 前端，即插件宿主）**，
> 不是 pi rust 引擎。pi 引擎侧的会话数据面缺口见 `docs/zcode-parity-gaps.md`。
>
> 问题：**移植完了吗？有漏项吗？百分百功能复刻吗？**
>
> 结论：**没有 100%。** 插件源码是原样 vendored（121 文件，0 改写）；
> 宿主适配层是「主干全通、边缘缺一大片」——花名册/单聊/例程全链已实测，
> 但**群聊成员轮次、事件面、MCP、技能市场、屏幕、relay、composer 贡献面
> 没有接线**。

## 0. 一句话分层

| 层 | 状态 |
|---|---|
| 插件 UI / 业务代码（`src/hermes-mirror/plugins/hermes-bots/**`） | **100% 原样**（121 文件全量 vendored，未改写） |
| 宿主 SDK/适配层（`src/sdk/**`、`src/plugins/bundled.ts`、`plugin-pane.tsx`） | 主干通，边缘缺（见 §2） |
| 引擎/后端能力 | groups 后端 25 模块 + 464 tests；display/peer 等结构性缺失 |

## 1. 已通（实测过）

- **花名册**：`plugins.list` → RosterRow 渲染（sections/置顶/头像/隐藏）、轮询。
- **单聊**：点击 bot → canonical Bot Chat 建/复用（双锚 `chatSessionId`）、composer
  发送（人格/模型生效）、编辑机器人（`profiles.describe/configure`）。
- **例程**：列表/新建/暂停/恢复/删除（CDP 全链；`pi_cron_*`）。
- **群聊后端**：`groups_dispatch` 15 方法（capabilities/list/state/log/create/
  rename/disband/send/context/stop/continue/retry/discard/attachment.upload/
  download）；`groups_plan` 实测返回 `status=task`（464 tests 绿）。
- **宿主门面**：panes 贡献（bots/routines）、`host.state` 原子、`paneVisibility`、
  notify/notifyError。

## 2. 漏项（按影响排序）

### P0 群聊「不会说话」——`prompt.submit` 未接线
- 插件执行成员轮次走 `requestForBot(member, 'prompt.submit', {session_id, text})`
  （`group-turns.ts:581 submitGroupTurnPrompt`，`:1251` 调用）。
- host-rpc **没有 `prompt.submit` case** → 抛 `host.request: method 'prompt.submit'
  在宿主未接线`。现状：群聊能建房、能记录消息、能算下一个该谁说话（groups_plan），
  **但成员不会真的跑一轮**。
- 同组未接：`approval.respond`（群聊审批回灌）、`clarify.lock`（clarify 锁）、
  `file.attach` / `image.attach_bytes`（群聊附件）。

### P1 事件面全空（9 个通道无生产者）
- 插件订阅：`session.reclaimed`、`groups.changed`、`gateway.ready`、`tool.start`、
  `display.status`、`display.lease`、`display.install.done`、`display.install.log`、
  `bot_relay.outbox.pending`。
- 宿主侧（Rust/前端）**没有任何 `mirach:plugin:*` 的生产者**（grep 只命中
  `host.ts` 的订阅实现）→ 依赖事件的刷新/提示/自动开屏都不触发；轮询面
  （roster/cron/roster last_active）不受影响。

### P1 Bot Desktop / 屏幕不可用（结构性）
- `display.status` 已定型 `supported:false`（2026-11-16，避免假 spinner）；
  `display.install / observe / lease / thumbnail / start / switchSandboxImage`
  未接 → 屏幕门户/屏幕面板全关。pi 引擎无 display 概念，属宿主结构性缺口。

### P2 MCP
- `mcp.catalog`（create-dialog / profile-config 都 `catch → null` → 菜单为空）、
  `mcp.servers.add/list/set_api_key/test` 未接 → 只能显示 `profiles.describe`
  的 `mcp_servers`（宿主恒 `[]`）。MCP 添加/测试/OAuth 不可用。

### P2 技能市场
- `skills.manage` 未接 → HubSkillsSection（技能 Hub 搜索/安装）报错；
  本地 skills/toolsets 开关可用（`profiles.configure` → BotPreset.skills/toolsets）。

### P2 bot relay（机器人互发消息）
- `bot_relay.outbox.drain/reply/roster.sync` 未接，`bot_relay.outbox.pending`
  无生产者 → 中转箱不可用。

### P2 Composer 贡献面没挂
- `mention-completions`（@ 自动补全）与 `mention-middleware`（@ 身份注记、
  /new→/compact 保护）**注册了但宿主 composer 不消费 `COMPOSER_AREAS`**。
- `chat-empty`（bot 空态）、`new-agent`（命令面板入口）无宿主消费面。
- `screen-portal`（侧栏 profile 组头）无宿主消费面（屏幕本就不可用）。
- 宿主消费的贡献面：**2/7**（`panes` 里的 `pane` + `routines`）。

### P3 细节
- **侧栏隐藏范围**：只隐藏 canonical Bot Chat（双锚 path 集）；上游隐藏**所有**
  Bot Mode 会话（`setPersistedSessionHidden`，宿主 no-op）→ bot 会话里开的
  侧栏会话会出现在 Sessions 列表。
- **模型选择器**：`model.options` 未接 → `ModelPicker` 退化自由文本；宿主有
  自己的模型目录（models.dev）可以接。
- **intro 消息**：新建 bot 的 kickoff 走 `prompt.submit`（`canonical-chat.ts:636`，
  catch 静默）→ 无自我介绍首条消息。
- **能力面板**：`CapabilitiesView` / `ConnectorsTab` / `ToolsetConfigPanel` 未导出
  （`src/sdk/index.ts` 无）→ 编辑机器人少能力总览/连接器/工具集三块；
  skills/toolsets 清单仍由 `profiles.describe` 渲染。
- `deleteProfile` / `completeMcpOAuth` 显式 throw；`warmProfile/warmAgent/
  retainProfile/retainProfileSocket/setWorkspaceScope/setWorkspaceOwnerLabel/
  focusOpenWorkspaceSession` 为 no-op（单机语义，可接受）。
- `host.agents()` 空 agents、`host.profileRoutes()` 空表（多源 roster 不适用）。
- `groups.peer.*` / `groups.promote` / `groups.demote` / `groups.replica*`
  未实现（Rust 明确「跨网关 peer 通道未接通，不伪造成功」）；
  `groups.approve` 同样显式未接线。

## 3. 统计口径（可复核）

- 插件文件：121。
- 插件业务 RPC（`requestForBot` / `host.request` 字符串面）：
  **已接 15**（其中 3 个部分：`cli.exec` 仅 profile delete+rename；
  `profiles.describe` 无 mcp_servers；`session.resume` 只投影 role+text），
  **未接 11+**（`prompt.submit`、`approval.respond`、`clarify.lock`、`file.attach`、
  `image.attach_bytes`、`bot_relay.outbox.drain/reply/roster.sync`、`mcp.catalog`、
  `mcp.servers.add/list/set_api_key/test`、`model.options`、`skills.manage`）。
- 插件使用的 `host.*` 成员 34 个：全部存在（无 undefined 崩），其中 throw 2
  （`deleteProfile` / `completeMcpOAuth`）、no-op 10（warm/retain/workspace 等单机语义）。
- `host.onEvent` 通道 9 个：生产者 0。
- 贡献面 7 个：宿主消费 2 个。

## 4. 要「每个按钮都能用」还需要什么（并入宿主统一改造批）

1. **P0**：`prompt.submit`（走 pi 的 prompt + session 定位）、`approval.respond`、
   `clarify.lock`、`file.attach`、`image.attach_bytes`。
2. **P1**：事件生产者（`session.reclaimed` 由 Rust 的会话回收点发；`groups.changed`
   由 groups 写路径发；其余按需）；display 明确不支持（已有 UI 隐藏）。
3. **P2**：composer 贡献面（`atCompletions` + `middleware` 消费）；`model.options`
   接宿主模型目录；MCP/技能市场（要么接、要么在 UI 明确置灰）。
4. **P3**：`setPersistedSessionHidden` 真面（或接受只藏 canonical）；能力面板可选。

结构性无法 100%：多连接/多 profile、跨网关 peer、Bot Desktop（pi 无对应概念）。

## 5. 验证素材

- 例程全链实测（2026-11-16，create 0 9 * * * → pause → resume → delete）。
- 群聊 `groups_plan` 实测：`status=task, reason=member_turn, task.member_id=m-ada`。
- 审计脚本：`E:\Temp\audit-plugin-api.mjs` / `audit-register.mjs` / `audit-rpc2.mjs`
  （临时，不入库）。
