# bots 插件移植完成度审计（2026-11-17 复核轮）

> 口径说明：本文的「宿主」= **mirach 桌面应用（Tauri + 前端，即插件宿主）**，
> 不是 pi/rpi 引擎。引擎侧会话数据面缺口见 `docs/zcode-parity-gaps.md`。
>
> 问题：**移植完了吗？有漏项吗？百分百功能复刻吗？**
>
> 结论（2026-11-17）：**审计里点名的 P0/P2/P3 已全部接线并实机验证**。
> 剩一个结构性缺口：**canonical（网关驱动）群聊** —— 新群聊按上游语义被
> 网关能力声明挡住（宿主是 legacy 驱动模式），现有群聊成员轮次已全链跑通。

## 0. 一句话分层

| 层 | 状态 |
|---|---|
| 插件 UI / 业务代码（`src/hermes-mirror/plugins/hermes-bots/**`） | **100% 原样**（121 文件全量 vendored，未改写） |
| 宿主 SDK/适配层（`src/sdk/**`、`src/plugin**`、`panes/`） | **本轮补齐**（下表逐项） |
| 引擎/后端能力 | 群聊成员轮次=后台 bot 泳道真跑；canonical driver 未移植（见 §3） |

## 1. 本轮（2026-11-17）接线清单

### P0 群聊成员轮次（此前"不会说话"）

- **`src-tauri/src/pi_bot.rs`（新）**：后台 bot 会话泳道。每个成员会话一棵独立
  rpi harness（复刻 cron 的独立会话装配；`pi_session.rs` 抽出
  `build_harness_impl` 共用），互不抢前台活动会话。命令面：
  `pi_bot_create_session` / `pi_bot_open`（重启后懒重开）/ `pi_bot_prompt`
  （admission 语义：立即返回，完成经事件 + `pi_bot_state` 轮询）/
  `pi_bot_interrupt` / `pi_bot_compact` / `pi_bot_attach_image` /
  `pi_bot_attach_file` / `pi_bot_clarify_lock` / `pi_bot_approval_respond`。
- **`src/sdk/host-rpc.ts`**：`prompt.submit`（→ bot 泳道，人格/模型/工具集经
  botLaneConfig 透传）、`session.resume` 富投影（`running`/`inflight`/
  `turn_started_at`/`open_requests`/`pending_approval` + transcript 行
  `{role, text, content, display_kind}`，失败轮产出 `failed_turn` 边界行）、
  `approval.respond`、`clarify.lock`、`file.attach`、`image.attach_bytes`、
  `session.create({room_plumbing:true})`（成员会话建在泳道 + 路径登记隐藏集）、
  `session.interrupt`/`session.compress` 按 session_id 路由到泳道。
- **失败可见（规矩 12）**：成员轮次失败 → `mirach:plugin:error`（信封带
  session_id）→ 房间轮询读到 `failed_turn` 行 → 活动行显示真错误文案。

### P1 事件面

- `message.complete` / `error` 两个通道**有了真生产者**（bot 泳道；通道名
  映射 `mirach:plugin:message:complete` / `mirach:plugin:error`，与
  `host.onEvent` 的点号→冒号归一一致）——群聊轮询的加速信号。
- `session.reclaimed` / `groups.changed` / `gateway.ready` / `tool.start` /
  `display.*` / `bot_relay.outbox.pending` 仍无生产者：前两者是 canonical
  模式的面（见 §3），`display.*` 结构性不支持（`display.status` 已定型
  `supported:false`），`tool.start` 供屏幕自动升起（屏幕不支持）。

### P2 贡献面（宿主消费 2/7 → 6/7）

- `composer.atCompletions`：`composer-wired.tsx` 合并插件源（`provide(query)`）
  与宿主静态 PEOPLE（去重、插件行标 role agent）。实机：输入 `@` 出
  「风格和 / 微软（agent）+ mirach / reviewer（human）」。
- `composer.middleware`：`runtime.tsx` 的 `onNew` 在发送前跑管线（顺序执行、
  首个 null 取消、抛错透传且 console 可见）。
- `chat.empty`：`thread.aui.tsx` 空态挂贡献（ContribBoundary 隔离）。
- `command.palette`：命令面板合并 `PALETTE_AREA` 贡献。实机：面板出
  「New bot…」行。
- `sidebar.profile.group.header`（screen-portal）：屏幕不支持，无消费面
  （不放假入口）。
- **`host.openWorkspace` 真门（本轮补，此前是空开关）**：
  `src/components/layout/plugin-workspaces.ts` + `plugin-workspace-pane.tsx`
  ——插件工作区 = 主区 dockview 标签页（hermes-bots 群聊房间走这条；
  此前只 dispatch 无监听者的事件、还吞掉 close 返回值，点群聊行毫无反应）。
  含：重启后孤儿面板剪枝（boot 期 fromJSON 之后，避免在 layout 恢复中
  close 抛 dockview "invalid operation"）。

### P2 MCP / 技能市场 / relay（诚实接线，不造假）

- **MCP 目录已补（2026-11-17 续）**：`mcp.catalog` = `src-tauri/src/pi_mcp_catalog.rs`
  + `assets/mcp-catalog.json`（hermes `optional-mcps/` 的宿主可执行子集：
  **10 条 no-auth HTTP**，如 deepwiki/context7/wolfram/microsoft-learn）。
  `mcp.servers.add {preset}` 一键装（写 `~/.rpi/agent/mcp.json` 的
  `{url}`）；`mcp.servers.test` 对 HTTP 条目做**真实探测**（initialize →
  initialized → tools/list，实机 deepwiki 返回 3 个工具 + serverInfo）。
  `mcp.servers.set_api_key` 写 `mcpServers.<name>.env`；`mcp.servers.remove` 真删。
  **56 条 OAuth 条目不入目录**：rpi-mcp-adapter 没有 OAuth token 管理（见
  `docs/pi-host-gaps.md` §1），列出来就是假入口。显式 config 的任意
  HTTP/stdio 服务器仍可加。
- `mcp.catalog` 的 `installed` 标记从 pi_mcp 真快照回读；`profiles.describe`
  的 `mcp_servers` 同源。
- `skills.manage` 搜索 = 空表 + console.warn（宿主没有技能市场），install
  明确报错（本地技能清单见 pi_capabilities → 设置页能力）。
- `bot_relay.*` = 单身份：roster.sync 0 / drain 空 / reply·deliver 明确报错。

### P3 细节

- `setPersistedSessionHidden` 真面（`hidden-sessions.ts` + 侧栏过滤，
  群成员会话不再进会话列表）。
- `model.options` = pi_list_models 按 provider 分组（编辑机器人的模型下拉）。
- `profiles.describe` 的 `mcp_servers` 读 pi_mcp（含 enabled 名单回读）。
- `host.agents()` 返回真机器人花名册 + **sources 用 `connectionId` 键**
  （此前写成 `id` → 插件源索引恒空 → 所有行"网关已移除"、群成员 0 可用）。

### 本轮揪出的 5 个真 bug（都会造成用户可见故障）

| # | 文件 | 症状 → 修法 |
|---|---|---|
| 1 | `runtime-loader.ts`（ctx.storage） | 值级 KV 被当字符串存：对象写成 `"[object Object]"`、`get` 回裸字符串、`remove` 方法名不存在 → 插件自有持久化（bot-meta v2 / 分区 / 群聊记录）全坏。修 = JSON 序列化 + `remove` + 兼容读旧裸字符串 |
| 2 | `sdk/index.ts`（gatewayActivationEpoch） | 上游是**函数**，宿主写成 `const = 0` → 群聊创建对话框 settle 抛 "not a function" → 永远停在"检查中"。修 = 函数形态（镜像 `store/gateway.ts` 同修） |
| 3 | `sdk/host.ts`（agents sources） | 见上（connectionId 键）→ 实测"2 个中 0 个可用"+ 行尾红字 |
| 4 | `main.rs`（pi_get_session_messages） | 叶子取"文件最后一行"——rpi 在消息后追加 record 条目（无 parentId 链）→ 投影恒空数组 → 群聊读不到成员回复（实测读成"超时静默"）。修 = 叶子取最后一条 **message** 条目 |
| 5 | `sdk/message-text.tsx` | 借用 assistant-ui 的 `MarkdownText`（读 message-part 上下文）→ 群聊房间（无 part scope）渲染抛 `The current scope does not have a "part" property` → 发第一条消息后房间被 ContribBoundary 整块隐藏。修 = 独立 react-markdown 管线（GFM + 数学 + decorateText 钩子） |

## 2. 实机验证记录（2026-11-17，CDP 真鼠标）

夹具 = 插件 storage 里一条 legacy 房间（engine:'desktop'，成员 微软/风格和）。

1. 花名册行「测试群, 2 个机器人, 2 个中 2 个可用」；机器人行「本机 · 就绪」。
2. 点击群聊行 → 主区开出标签「测试群」（openWorkspace 门）。
3. 输入消息回车 → 成员会话创建（`Group: fixture-room-1 · <thread>`，落在
   隐藏路径集）+ `prompt.submit` → pi_bot 泳道 → **真模型调用**（deepseek
   403 配额用尽）→ `session.resume` 投影 failed_turn → 活动行显示
   「风格和 遇到错误 — http error 403 …insufficient_quota」（真错误文案）。
4. 房间状态行「二万人 正在工作… · 停止」= 轮询实时态；一轮失败后自动
   轮到下一成员（round-robin 真驱动）。
5. `@` 补全出插件行；命令面板出「New bot…」。
6. 成员会话文件可读（含 room prompt 全文 + assistant failed 记录）。

**唯一未闭环的验证点 = 成功回复**：本机 deepseek key 配额耗尽（403），
回复正文链路要真 key 才能看到；协议/泳道/投影全链已由失败轮证明。

## 3. 剩余结构性缺口：canonical（网关驱动）群聊

**hermes 语义**：新群聊必须由网关驱动（`groupCreationEngine`：legacy 网关
→ `unavailable/owner_update_required`；这也是实机里"本设备版本太旧"提示的
来源）。宿主选择 legacy 能力声明的原因与现状：

- 已移植：`src-tauri/src/hosted_rooms/`（26 模块：事件日志 9 表 / discussion
  计划 / driver 租约状态机 / controls 30 方法，464 tests 绿）+
  `pi_groups.rs` 的 `groups_dispatch` 25 方法（capabilities/list/state/log/
  create/rename/disband/send/context/stop/continue/retry/discard/附件）、
  `groups_plan`（"谁下一个说话"）。
- 未移植：**driver runner** —— 把 plan 产出的任务变成成员会话的一次真 run、
  把结果写回房间事件日志（turn.started / message.member / turn.settled）。
  上游实现 = `D:\hermes-agent-main\tui_gateway\hosted_room_driver.py`
  （1320 行）+ `hosted_room_service.py`（1306 行）。它依赖会话层的
  **任务身份/终局回执**（`submit(task=…, on_terminal=…)`、history 里的
  terminal receipt、`expected_task_id` 中断）——rpi 会话层目前没有这组
  语义；接线前要先定这层协议（可复用 pi_bot 泳道的执行面，但它现在只有
  "一轮 run"粒度，没有 task_id/generation）。
- `groups.approve` / `groups.peer.*` / `promote/demote/replica`：明确报错
  （跨网关 peer 通道未接通，不伪造成功）。

## 4. 统计口径（2026-11-17）

- 插件业务 RPC：审计点名的未接 11+ 个（`prompt.submit`、`approval.respond`、
  `clarify.lock`、`file.attach`、`image.attach_bytes`、`mcp.catalog`、
  `mcp.servers.*`、`model.options`、`skills.manage`、`bot_relay.*`）
  **全部有实现**（其中 MCP/技能/relay 按宿主事实返回空或明确报错）。
- `host.*` 成员 34 个全存在；`openWorkspace` 从空开关变为真门（返回 close）。
- 贡献面 7 个：宿主消费 6（panes×2 / atCompletions / middleware / chat.empty
  / command.palette），1 个无消费面（profile group header——屏幕不支持）。
- 门禁：tsc 0（非镜像树）/ vitest 1003（82 文件）/ cargo test 660 /
  cargo check 0 错误。

## 5. 验证素材

- 门禁与实机命令见本节会话记录；CDP 脚本 = `scripts/cdp.mjs` +
  `%TEMP%\mirach-click-xy.mjs` / `mirach-type-enter.mjs`（临时，不入库）。
- 夹具房间与成员会话文件（`~/.rpi/sessions/…01a1e5d6…` / `…01a1e5f7…`）
  为验证产物，可随时删除。

## 6. 2026-11-17 续：能力面板与 MCP 目录

- **能力面板导出补全**：`src/sdk/capabilities-views.tsx` 导出
  `CapabilitiesView` / `ConnectorsTab` / `ToolsetConfigPanel`（hermes-mirror
  原件 + 宿主桥/Provider 包装，`supportsFixedConnection=true`）。实机：
  机器人编辑对话框「高级」出现 技能 / 插件 / 连接器 / 工具集 四页签
  （此前只有技能/工具集两块列表）。连接器页的"托管应用"区块在宿主如实
  报错（没有 hermes 云后端），本机 MCP 管理走设置页「连接器」。
- **MCP 目录/测试/密钥**：见 §1 的 P2 MCP 段（10 条 no-auth HTTP 可一键
  安装；deepwiki 真实探测返回 3 工具 + serverInfo；56 条 OAuth 条目不
  入目录——引擎扩展没有 OAuth，见 `docs/pi-host-gaps.md`）。
- **image.generate**：probe 返回 `available:false`（隐藏生成入口），真生成
  明确报错；`display.*` 方法明确报"无 display 子系统"。
- 引擎侧缺口统一收在 **`docs/pi-host-gaps.md`**（OAuth MCP、display、
  canonical driver 的会话任务身份、session.reclaimed、多连接 peer）。
