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

- **MCP 目录已补（2026-11-17 续，同日再扩）**：`mcp.catalog` =
  `src-tauri/src/pi_mcp_catalog.rs` + `assets/mcp-catalog.json`（hermes
  `optional-mcps/` 的宿主可执行子集：**64 条 = 10 条 no-auth HTTP + 54 条
  OAuth HTTP**，如 deepwiki/context7/wolfram/notion/linear/sentry）。
  `mcp.servers.add {preset}` 一键装（写 `~/.rpi/agent/mcp.json` 的 `{url}`）；
  `mcp.servers.test` 对 HTTP 条目做**真实探测**（initialize → initialized →
  tools/list，实机 deepwiki 返回 3 个工具 + serverInfo）；
  `mcp.servers.set_api_key` 写 `mcpServers.<name>.env`；`mcp.servers.remove` 真删。
- **MCP OAuth（宿主标准 DCR 流程）**：`pi_mcp_oauth.rs` 实现 RFC 9728/8414
  discovery → Dynamic Client Registration → PKCE S256 → 本机回调 → token
  交换 → 把 `Authorization: Bearer …` 写回 mcp.json headers；启动时批量刷新
  10 分钟内到期的 token。实机（notion dry-run）：discovery + DCR 成功
  （client_id 已注册）。**不支持 DCR 的厂商**（需预注册 client）如实报错，
  不进目录（asana / n8n 两条）。
- `mcp.catalog` 的 `installed` 标记从 pi_mcp 真快照回读；`profiles.describe`
  的 `mcp_servers` 同源。
- **技能市场 = 本地技能目录**（2026-11-17 续）：宿主没有 hermes Hub，但把
  上游 `optional-skills/`（**22 分类 / 139 技能 / 819 文件**）复制进
  `src-tauri/skills-catalog` 并随包（bundle.resources）。`skills.manage`
  search 真检索（名称/描述/分类），install = 整目录复制到
  `~/.rpi/agent/skills/<name>`（rpi 技能发现目录），remove 真删。
  实机：搜索 "git" 4 条；安装 `watchers` 后 `~/.rpi/agent/skills/watchers/`
  出现 SKILL.md + scripts/。
- `bot_relay.*` = 单身份：roster.sync 0 / drain 空 / reply·deliver 明确报错。
  **agent 互发（message_agent 工具）**需要 rpi 扩展提供工具注入口，见
  `docs/pi-host-gaps.md` §6。

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

## 3. canonical（网关驱动）群聊：已落地最小驱动（2026-11-17 续）

**状态**：新群聊可创建、可驱动。实机（CDP）：新建群聊 → 两名成员依次跑轮次
（真实 403 配额错误）→ turn.failed 如实回写 → room.activity settled，界面
显示「回合失败」卡与 Round 状态。

实现三层：

- `src/components/panes/hub/canonical-group-driver.ts`：前端驱动循环
  （groups_plan → 成员会话 `Group: <room_id>` → prompt.submit → 轮询
  session.resume → 写回 message.member / turn.settled / turn.failed /
  turn.cancelled / room.activity）；driver_status 供 workspace 的 typing 行 /
  Round N / Stop 按钮。
- `groups_plan` 暴露 task 的完整 prompt 与坐标；新增 `groups.driver_append`
  （Rust 侧 actor-kinds + 事件形状校验后落 hosted_room_events）；
  `groups.list` 补 `next_offset`、`room_json` 补 `members/latest_seq`、
  `groups.send` 返回 `accepted/client_event_id` 受理回执。
- `groups.capabilities` = driver:true + 16 个方法；`host-rpc` 的
  groups.state 注入 driver_status，send/continue/stop 接驱动生命周期。

**与 hermes 的差距（如实标注）**：无 driver 租约/fencing/indeterminate 恢复
（应用重启 = 在途轮次丢失，启动扫描会重驱动仍有待办的讨论）。
**同日续**：approvals 已桥接（lane pending_approval → driver_status.
pending_actions → `groups.approve` 回灌 once/deny；触发前提是引擎侧权限闸
扩展生效，见 pi-host-gaps §6）；retry/discard 已实现（retry 重跑本次应用内
失败任务、discard 写 turn.cancelled；重启后仅剩日志会明确报错）；
**router(auto) 已实现**（route 计划 → 一次模型调用选应答者 → `room.routed`，
实机：输出 everyone → 成员真回复）。legacy 房间不受影响。

**宿主扩展（非上游协议）**：`groups.driver_append`；成员身份字段改用
Unicode 标识符（宿主机器人名是中文，上游 profile 是 ASCII slug）。

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
- **canonical 群聊最小驱动落地**（同日）：见 §3——新建群聊可创建、驱动
  跑轮次、失败如实回写、settled 收尾，实机全通。

## 7. 2026-11-17 收尾：真模型成功链验证（用户提供测试 key）

用户提供 `https://bbtoken.boywe.cn/v1` 测试 key（models.json 加 `BBT`
provider，defaultProvider=BBT/deepseek-v4.1-flash）。**「真模型端到端」硬阻塞
解除**，逐链验证（全部实机）：

| 链 | 结果 |
|---|---|
| 主对话 | 「1+1 等于几」→「1+1 等于 2。」（usage 21338/10，stopReason stop） |
| canonical 群聊 | 两成员各回真实自我介绍；handoff 行「风格和 请 二万人 接手」；`已结束 — 没有人还有话要说`（message.member ×2 + turn.settled ×2 + room.activity settled） |
| legacy 群聊 | 两成员真回复（「大家好，我是微软…」「大家好，我是风格和…」） |
| router(auto) | `room.routed {everyone:true}` → 成员真回复 |
| MCP（模型内调用）| `mcp_list` 发现 deepwiki（serverInfo/tools）→ `mcp_call ask_wiki_question(facebook/react)` 返回真实答案并中文总结；远端错误（仓库未索引）也如实回显 |
| 技能目录 | search "git" → 4 条；install `watchers` → 落盘 SKILL.md + scripts/ |
| MCP OAuth | notion dry-run：discovery + DCR 成功（client_id 注册） |

同日新增宿主面：MCP OAuth（标准 DCR+PKCE+刷新）、本地技能目录（139 技能）、
canonical approvals/retry/discard/router。**仍未做**：lead 路由、权限闸运行时
切换（引擎侧，见 pi-host-gaps §6）、message_agent/relay（引擎扩展）、display。

## 8. 2026-11-18 夜：引擎侧四件套落地后，§7 清单里的"仍缺"全部闭环

（用户："全部做，做完检查，没问题了 pr 给 pi rust"。引擎/宿主改动与实机
证据的完整清单见 `docs/HANDOFF.md` 同轮条目 + `AGENTS.md`「引擎侧四件套」
+ `docs/pi-host-gaps.md`。）

| 此前的"仍缺" | 现状（2026-11-18） |
|---|---|
| 权限闸运行时切换 | ✅ 引擎 `approval_gate.rs` 三态 + 宿主弹卡；always-ask 下 bash 真弹卡、允许真执行、拒绝真回灌 |
| message_agent | ✅ 引擎内置工具 + 宿主投递/回信；微软→remote-bot 真链通过（含回信落回发送者） |
| display（屏幕面板） | ✅ 宿主 `pi_display.rs`（GDI+RFB）→ screen-pane noVNC 1280×720 真帧；接管/交还 lease 闭环 |
| 任务身份/终局回执/租约 | ✅ 引擎 `task_lease.rs` + canonical driver 接线；fencing 拒陈旧 token、cancelled/settled receipt、recovered→indeterminate 全部实测 |
| relay（跨网关） | ❌ 有意不做（单身份宿主无 relay 概念，显式报错） |
| lead 路由 | ❌ 仍未做（与租约无关；可后续补一次廉价模型调用） |

**engine E2E 残留**：canonical 群聊**含租约**的整房间 UI 流程未再跑一遍
（建房→多成员→settled）；各原语（快照/fencing/恢复/meta 落盘）已单独实测，
driver 消费面单测在 vitest 门禁内。

## 9. 2026-11-18 第二波：跨网关全链打通（上表 relay 一行已过时）

（用户："垮网关是bots的核心，看bots的代码有没有漏项"。审计 =
镜像 121 文件 vs 上游 283，缺的全是测试；真漏项在数据面，逐项修复见
`docs/HANDOFF.md` 同轮条目。）

| 面 | 现状 |
|---|---|
| `host.connections()` | ✅ 裸数组真注册表（此前被当对象读 → 恒空表） |
| `host.profileRoutes()` | ✅ local 每 bot 一条 + 远端连接每 profile 一条（30s 缓存） |
| `host.agents()` | ✅ 本地 ∪ 远端并集（sources 带 remote 行） |
| **relay（跨网关）** | ✅ **四门+B2 仓+transport 全接**：`pi_relay.rs` 持久仓（outbox/claimed/replies/receipts）+ `pi_gateway.rs` JSON-RPC over WS；双向实机 E2E（远端→本机真模型轮次+回信回远端；本机→远端 queued→DELIVER→回执→waiter 唤醒发送者） |
| `bot_relay.*` 门 | ✅ roster.sync / outbox.drain / deliver（本机目标真跑轮次+回执）/ reply（先写者胜+事件）；drain 未回执重投 + TTL queued_expired |
| peer 房间（groups.peer.*） | ❌ 仍未实现（transport 已铺好；RoomLink HTTP + 对端网关配合是下一层） |
| 远端连接 token | ❌ 管理 UI 未接（keyring 录入；当前只能无 token 连回环/--insecure） |
| `tool.start` / `groups.changed` / `gateway.ready` | ✅ 生产者已接（screen auto-raise / 房间推送 / 深链） |
| 插件侧删除/编辑 | ✅ `host.deleteProfile` 真删；`cli.exec profile describe --text`、`config unset model` 已接 |
| display 契约 | ✅ observe/start 展平、thumbnail `{data_url,suppressed}`、switchSandboxImage 有 case |

## 10. 2026-11-18 第三波：token 管理 / image.generate / pet 画廊（§9 两行 ❌ 的部分收口）

| 面 | 现状 |
|---|---|
| **远端连接 token 管理** | ✅ **已接**：token 进 OS 凭据管理器（service `mirach.connections`，entry=连接 id；注册表 JSON 只存派生 `tokenSet/tokenPreview`，每次读取从 keyring 重算）；`pi_connections_save` 的 `token` 字段只写不读（空串=清除，删除连接同步删 entry）；连接页编辑表单有 token 密码输入 + 清除钮 + `token ...abcd` 徽章（preview = hermes `tokenPreview` 同款：≤8 → "set"，否则 `...`+末 6 位）；`pi_gateway_connect` 的 token=null 时**由 Rust 取 keyring**（token 永不过前端）。**`pi_connections_test` 对 remote/cloud 变真**：用注册表 URL + keyring token 开一次性 WS 等 `gateway.ready`（8s），失败红显真错误；ssh 无隧道实现，仍 stub 红显 |
| **`image.generate`** | ✅ **真后端**（`src-tauri/src/pi_image.rs`）：OpenAI 兼容 `{base}/images/generations`；provider = `settings.image.provider` > `default_provider` > models.json 首个有凭据者；key 走 models.json apiKey（字面量 / `env:VAR` / 裸环境变量）→ auth.json → provider env；probe = GET `{base}/models` 挑图像型模型（image/dall-e/imagen/flux/…，**真网络检查**），无图像模型 → `available:false`（插件隐藏生成入口）；`settings.image.model` 可覆盖；生成 b64 → `image_data` data URL，失败走契约 `error` |
| **`pet.gallery` / `pet.thumb`** | ✅ **已接**（`src-tauri/src/pi_pet.rs`，hermes `agent/pet/*` 对偶）：gallery = petdex 公共 manifest（UA `hermes-agent-petdex`，300s 进程内缓存；`installed` 读 `~/.rpi/agent/pets/<slug>/pet.json`）；thumb = 已装 spritesheet 优先、否则**仅 petdex.dev 主机** URL（上游 `_is_petdex_host` 同款反 SSRF），裁首帧 192×208 → 96×104 NEAREST → PNG data URI + `pets/.thumbs/<slug>.png` 磁盘缓存。镜像 pet.tsx 的 Pet tab 从此有真数据 |
| peer 房间（groups.peer.*） | 🟡 **Desktop 驱动全通 + mirach peer 借出面已接（第四/五波）**：authority 侧（邀请对端 bot 进本机房间）`groups.peer.register/revoke` + canonical driver 对 peer 成员按 profile 解析 remote 路由；实机（hermes 插件流程）：1 本机 + 2 远端成员建房 → 全员 seat → 全员回复 → settled。**lending 侧（本机被借出）**：`pi_peer.rs` 原生 HTTP 服务（127.0.0.1:9731，Bearer 配对令牌走 OS 凭据管理器）——对端 mirach 用 URL + 令牌接入后，canonical driver 的 remote 路由经 `pi_peer_call` 走对端 `session.create/resume/prompt.submit/interrupt/compact`；实机（mock peer + 真 canonical driver）：1 本机 + 1 远端 mirach 成员建房 → 本机真模型回复 + 远端 peer bot 经 peer HTTP 回复 → 双 turn.settled → settled。**仍未做**：hermes 网关 wire 兼容（`groups.peer.invite` WS 方法 + `/v1/room-members/*` HTTP 路由——那是整个 hermes 网关 HTTP 服务端，宿主没有）|
| per-bot MCP 勾选 | 🟡 **per-bot 配置文件已接（2026-11-18 第四波）**：bots 对话框 MCP 页 = 全局 `mcp.json` 服务器多选（`pi_mcp_servers` 真清单）；启动时 `pi_bot_mcp_config` 只过滤所选服务器生成 `~/.rpi/agent/bot-mcp/<bot>.json`，`configPath` 注入 system prompt（rpi-mcp-adapter 的 `mcp_list/mcp_call/mcp_resource` 本就按 `configPath` 读配置——per-bot 真生效）。**限制（如实）**：不选 = 不注入该配置；adapter 的四个 MCP 工具是**进程级注册**，宿主没有 per-session 工具遮蔽面，所以"不选"不能从工具层阻断模型自行使用全局配置 |
| SSH 隧道 | ✅ **已接（2026-11-19）**：`pi_ssh.rs` —— 注册表 ssh 条目加 `gatewayPort`（缺省 = hermes api_server 默认 8642）；`pi_ssh_tunnel_start` 起 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<gateway_port>` 子进程（`BatchMode=yes` + `ExitOnForwardFailure=yes` + `StrictHostKeyChecking=accept-new`），等本地端口就绪返回隧道 URL；`pi_gateway_connect` 对 url 为空的 SSH 连接自动起隧道 + WS 走本地端口；`pi_connections_test` 对 ssh 变真（隧道 + gateway.ready 探测）；连接页 ssh 编辑器加网关端口字段；`RunEvent::Exit` 时 `stop_all()` kill 全部子进程。**限制（如实）**：密钥需在 agent（`BatchMode=yes` 不弹交互）；hermes SSH 模式是 1197 行完整远端 backend 管理，宿主只做了端口转发这一层 |
| `groups.replica_state` | ✅ **已接（2026-11-19）**：`hosted_rooms/replicas.rs` 补 SQL 写入层（ingest_page / replica_state_query / promote_replica / demote_room 逐行翻译 hermes `hosted_room_replicas.py`）；`pi_groups.rs` 分派 + peer HTTP 接收路由 `POST /v1/mirach/rooms/{id}/replicate`（bearer 鉴权 → ingest_page 写本地 replica 表）。`groups.replicate` 读房间事件构建 ReplicaPage 给调用方发到 peer |
| `groups.demote` | ✅ **已接（2026-11-19）**：`pi_groups.rs` 分派 → `replicas::demote_room`（上游 `demote_room()` 逐行移植——当本机权威 epoch 过期时追加 `authority.lost` 并采纳对端新谱系；幂等） |
| `groups.promote` | ✅ **已接（2026-11-19）**：`pi_groups.rs` 分派 → `replicas::promote_replica`（上游 `promote_replica()` 逐行移植——replica 接管为 authority（epoch+1），复制日志 + `authority.claimed`；防止重复接管与 room_id 冲突） |
| `groups.replicate` | ✅ **已接（2026-11-19）**：读房间事件构建 ReplicaPage（events + authority + latest_seq），调用方经 peer HTTP `POST /v1/mirach/rooms/{id}/replicate` 发到 peer → peer ingest 进本地 replica 表 |
| `groups.peer.invite` | 🟡 mirach 原生 peer 面已替代（对端 mirach 走 `pi_peer_call`）；hermes Desktop wire 兼容（WS invite + `/v1/room-members/*`）需要 hermes 网关 HTTP 服务端——**宿主架构不同**，如实报错 |
| `display.install` | ✅ **已接（2026-11-19）**：`pi_ssh.rs` SSH exec 检查/安装远端 RFB 服务；`display.observe` 对 SSH 连接经隧道连远端 RFB |

