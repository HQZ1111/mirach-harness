# pi / rpi 引擎侧缺口清单（宿主无法补齐的部分）

> 2026-11-17 建；**2026-11-18 全线更新**：§2/§3/§6/§7 四项已在引擎
> `G:\pi-rust-main` 工作树落地并实机验证（用户裁定"全部做，做完检查，
> 没问题了 pr 给 pi rust"）。`G:\pi-rust-main` 是**无 .git 的源码镜像**——
> 移植清单（5 处改动）见文末「PR 待办」；宿主侧对偶全部接通，见各节
> 「已落地」段。

## 1. ~~rpi-mcp-adapter 的 OAuth 支持~~（宿主侧已补，2026-11-17 收尾）

**更新**：宿主自己实现了 OAuth 客户端（`src-tauri/src/pi_mcp_oauth.rs`）：
RFC 9728/8414 discovery → DCR → PKCE S256 → 本机回调 → token 交换 → 把
`Authorization: Bearer …` 写进 mcp.json 的 headers（适配器原样发送）；启动
批量刷新 + 测试时按需刷新。目录扩到 **64 条（10 no-auth + 54 OAuth）**。
实机 notion dry-run：discovery + DCR 成功。

**剩余引擎侧可选项**：把 OAuth 放进扩展内（`mcp_list` 首次连接自动授权、
token 存 OS keyring），可省掉宿主写 headers 这一层；非阻塞。

## 2. Display / Bot Desktop（屏幕门户、屏幕面板、display.lease/observe）

**✅ 已落地（2026-11-18，宿主侧全实现，引擎零改动）**：
`src-tauri/src/pi_display.rs` = 本机桌面镜像子系统：
- GDI 截屏（`CAPTUREBLT`，virtual screen，JPEG/PNG 缩略图）+ **RFB 3.8 服务**
  经 tokio-tungstenite WS（`/api/display/ws?display_ticket=…`，ticket 单次
  30s 有效；`serverinit` 1280×720，raw 帧，350ms 节流）。
- IPC：`pi_display_status / ws_port / thumbnail / observe / start /
  lease_acquire / lease_release`；lease 契约 = 上游 gateway-contract
  （`holder:'agent'|'human'`，**恒为对象非 null**，epoch 单调递增——释放后
  仍以 agent 占位对象返回；`running = supported`，本机镜像恒在跑）。
- 前端：screen-pane 经 `display.observe` 拿 viewer+ticket → `resolveSiblingWsUrl`
  返回 `ws://127.0.0.1:<port>/api/display/ws` → noVNC 1.7 直连。
- **实机**：右键 bot 行 →「打开屏幕」→ canvas 1280×720 真帧（像素非零）→
  「接管」→「你正在控制」→「交还」→「机器人正在控制」（lease epoch 2）。

**有意不做**：`display.stop` / `display.install`（宿主无"停掉本机屏幕"语义，
上游面板也不消费 stop）；非 Windows 平台 `supported:false` 如实报错。
远程 bot 的"独立虚拟屏"不做——本机镜像的 `detail` 字段已如实标注。

## 3. 会话层的「任务身份 / 终局回执」（canonical 群聊 driver 的地基）

**✅ 已落地（2026-11-18，引擎 `rpi-harness/src/task_lease.rs` + 宿主接线）**：
- 引擎：持久任务租约模块——`acquire_with_meta / renew / finish / status /
  list / recover / ensure_live`；fencing 语义（Conflict / Stale / LeaseLost /
  AlreadyFinished / Invalid / Io）；落盘 `<session>.tasks.json`（tmp+rename，
  崩溃安全）。`recover` 把过期 Running 折成 `Indeterminate`。
- 宿主：每次 `pi_bot_prompt` = 一个 task 身份（task_id + execution_generation
  + 租约 + meta 坐标）；结束按 `HarnessRunOutcome` finish（Completed→Settled
  / Aborted→Cancelled / Failed→Failed，receipt = `runId:finalEntryId`）；
  `session.resume` 快照出 `task` / `tasks` / `recovered_tasks`；
  `task.interrupt` 走 `ensure_live` fencing；canonical driver 的 Stop 用
  fenced 中断、重启后 recovered → `turn.failed`（reason_code
  `indeterminate`）回写房间。localStorage 版 ledger 已删除。
- **实机**：running 快照/持久（重启后 tasks 仍在）✓；stale generation 中断
  被拒（"stale task identity (generation moved)"）✓；正确 generation →
  `cancelled`+meta 落盘 ✓；fixture 过期 Running → `indeterminate`
  （"driver restarted while the task was running"）→ take-once 清空 ✓。

**~~仍缺（引擎后续可选项）~~ 已收口（2026-11-19/20）**：router(auto) 已接
（宿主前端 `routeCanonicalRoom` 一次廉价模型调用 → `room.routed`，实机）；
lead 路由在宿主 Rust 决策层移植（`hosted_rooms/lead.rs` + `plan.rs`/
`decision_engine` 的 `lead_routing` 任务，`groups_plan` 按设置发轮），
前端走通用成员轮——**未单独实机验证**（见 `docs/bots-port-gaps.md` §8 表）。
与租约无关。

## 4. 会话回收事件 `session.reclaimed`

**事实**：hermes 网关回收 runtime 会话时发 `session.reclaimed`，Desktop
据此清理订阅。rpi 的会话生命周期由宿主进程管理，没有运行期驱逐/回收
（重启即全量失效）。

**✅ 宿主生产者（2026-11-18 第四波）**：`pi_delete_session` 成功后按 path 在
会话索引里定位 stored id → emit `mirach:plugin:session:reclaimed`
（`{stored_session_id, path, reason:"deleted"}`）。删除是宿主里"运行时会话
确实不存在"的唯一真实来源；插件（hermes-bots plugin.tsx）监听后刷新打开的
bot canonical chat。若引擎将来引入内存上限/空闲驱逐，应复用同一事件。

## 5. 多连接 / 跨网关 peer（groups.peer.*、profiles 多源）

**事实**：这是 hermes 多网关部署的能力（RoomLink、peer 路由、replica）。
rpi 是单机单引擎、单 profile。宿主 `groups_dispatch` 对 peer 方法明确报错。

**结论**：不是"缺实现"，是宿主架构没有该概念；除非 pi 支持多引擎/多网关
（或宿主自建网关网格），否则不做。

## 6. 权限闸运行时切换 / 审批卡触发（rpi 迁移后的欠账）

**✅ 已落地（2026-11-18，引擎 `rpi-cli/src/approval_gate.rs` + 宿主桥）**：
- 引擎：三态模式（AlwaysAsk / Write / Yolo）进程级 AtomicU8，**运行时切换、
  即时生效于在途轮次**；`ApprovalHandler` 由宿主安装；`before_tool_call`
  组合在扩展 hook **之后**（扩展否决优先）；只读白名单显式（read/ls/grep/
  find/web_search/web_fetch/docs/todo），未知工具按需审批（保守）。
- 宿主：`pi_mode_state` 回读 `approvalMode`；`pi_set_approval_mode` 真切换
  （未知值 Err）；审批请求 emit `mirach://approval-request`（真 session_id +
  tool + args）→ 前端 ApprovalDialog（允许一次 / 拒绝）→
  `pi_approval_decision` 回执；输入框模式钮菜单三态可选。
- **实机**：always-ask → bash 弹卡（真 args）→ 允许 → 命令真执行；拒绝 →
  回灌「用户拒绝」、命令未执行。canonical approvals 桥（已有）从此有真卡片
  可弹。
- **注**：计划模式（plan gate）本就可用（`/plan start|exit`），
  `set_plan_mode` 已从 Err 改为走引擎命令。

## 7. agent 互发（message_agent 工具 / relay）

**✅ 已落地（2026-11-18，引擎 `rpi-cli/src/message_agent.rs` + 宿主桥）**：
- 引擎内置 `message_agent` 工具（fire-and-forget）：schema = target /
  message（≤16000）/ constraints / expecting / expects_reply / cancel；
  **handler 未安装则工具不注册**（CLI 会话不见不可服务的工具）；caller 的
  session id 由引擎从 harness 绑定解析（不信模型输入）。
- 宿主：`HostMessageAgent` emit `mirach://agent-message` + 30s ack 超时；
  前端 engine-bridges 校验目标 bot 花名册锚点 → ack queued →
  真投递进目标 canonical 会话（`Message from 🤖 <名> (@<名>): …` + 期望行）→
  目标真跑一轮 → 回信（expects_reply 时）送进发送者会话。
- **实机**：微软 → 引擎工具 `{status:"queued", delivery_id}` → 真投递
  remote-bot → 回信落进微软会话 ✓。
- **绑定修复（引擎）**：`durable_binding` 原来只在 `native_durable` 分支
  填充 → 宿主会话里工具恒报 "session binding not ready"；改为无条件 set
  （顺带让审批请求带真 session_id）。**这是本轮 PR 给 pi-rust 必带的修正**。
- **relay（跨网关）**：✅ 宿主已全接（2026-11-18 第二波）——`pi_relay.rs` 持久仓
  （outbox/claimed/replies/receipts，hermes `tools/bot_relay.py` 对偶）+ 四门 +
  `pi_gateway.rs`（JSON-RPC 2.0 over WS `/api/ws`，hermes 桌面端同款传输）+
  relay.ts 循环驱动；双向实机 E2E 通过。
  **2026-11-18 第三波**：远端连接 **token 管理已接**（keyring `mirach.connections`
  只写不读 + `pi_connections_test` 真 probe `gateway.ready` + 连接页录入/清除）。
  **2026-11-18 第四波：peer 房间 Desktop 驱动模式全通**——authority 侧
  `groups.peer.register/revoke`（pinned catalog 校验 + room-links 持久化）、
  canonical driver 远端成员全 RPC 走对端 WS、roster peer 行形状；实机（插件自身
  `createGroupAcrossConnections`）1 本机+2 远端建房、全员 seat、双远端回复、
  settled。~~**仍缺**：lending 侧~~ **✅ 已接（2026-11-19）**：本机对外
  **hermes 兼容 RoomLink 服务端**全量落地（WS `groups.peer.invite/register/
  revoke` + `/v1/room-members/*` + `/v1/runs` 全族 + `groups.changed` 扇出，
  `pi_gateway_peer.rs` + `pi_peer.rs` + `hosted_rooms/grants.rs`），按 hermes
  客户端语义 E2E 全绿（见 `AGENTS.md`「hermes peer lending wire」）。

## PR 待办（给 `github.com/bigfish1913/pi-rust`）

> **✅ 已提（2026-11-18）：[bigfish1913/pi-rust #348](https://github.com/bigfish1913/pi-rust/pull/348)**
> （head `HQZ1111:feat/task-lease-approval-message-agent`，基于上游 main
> d3e388d 干净重建；diff = 三个新文件 + session.rs +50/-3 + 两个 lib.rs 各
> 一行。`cargo check -p rpi-cli` 与模块测试均在上游 main 上复跑通过。）

`G:\pi-rust-main` 工作树已完成并验证的改动（本轮实测全过）：

| 文件 | 改动 |
|---|---|
| `crates/rpi-harness/src/task_lease.rs` | **新**（持久任务租约 + fencing + recover；6 单测） |
| `crates/rpi-cli/src/approval_gate.rs` | **新**（运行时审批三态 + handler + before_tool_call；3 单测） |
| `crates/rpi-cli/src/message_agent.rs` | **新**（内置 message_agent 工具 + 全局 handler；2 单测） |
| `crates/rpi-cli/src/session.rs` | 接线：before_tool_call 组合（扩展 hook 后）+ message_agent 注册 + **durable_binding 无条件填充**（宿主嵌入的关键修复） |
| `crates/rpi-cli/src/lib.rs` / `rpi-harness/src/lib.rs` | `pub mod` 各一行 |

两个 lib.rs 之外无公共 API 破坏；默认行为不变（未装 handler 时审批闸 = no-op、
message_agent 不注册）。**注意**：镜像 `G:\pi-rust-main` 里还混有用户自己的
本地补丁（`execution_env(cwd)`、`after_tool_call: None` 等）——**不在本 PR 内**，
移植时只取上表五处。

---

## 附：宿主侧已用插件/适配层补齐、无需引擎改动的项（备查）

- MCP 管理面（`pi_mcp.rs`）+ 预设目录（`pi_mcp_catalog.rs`，64 条）+
  真 HTTP 探测 + **OAuth（标准 DCR，`pi_mcp_oauth.rs`）**。
- 技能目录（`pi_skills_catalog.rs`，139 技能；`skills.manage` 搜索/安装/删除）。
- 群聊 legacy 驱动（prompt.submit → `pi_bot.rs` 泳道）与 canonical 最小驱动
  （`canonical-group-driver.ts`：含 approvals 桥、retry/discard、
  router(auto)；实机成功回复已验证）。
- bot 花名册/单聊/例程的 `profiles.* / cron.* / cli.exec`。
- 事件 `message.complete / error`（bot 泳道生产）。
- composer / chat-empty / command.palette / 能力面板导出等全部宿主贡献面。
