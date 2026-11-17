# pi / rpi 引擎侧缺口清单（宿主无法补齐的部分）

> 2026-11-17。口径：这里只记**必须动引擎（`G:\pi-rust-main`）或引擎扩展**才能
> 补齐的项。能在 mirach 宿主（Tauri 前端 + `src-tauri`）解决的都已在宿主侧
> 落地，不进本文。`G:\pi-rust-main` 当前是**无 .git 的源码镜像**，无法直接开
> PR；需要时把本文条目拆成 patch 交给 pi 仓库。

## 1. ~~rpi-mcp-adapter 的 OAuth 支持~~（宿主侧已补，2026-11-17 收尾）

**更新**：宿主自己实现了 OAuth 客户端（`src-tauri/src/pi_mcp_oauth.rs`）：
RFC 9728/8414 discovery → DCR → PKCE S256 → 本机回调 → token 交换 → 把
`Authorization: Bearer …` 写进 mcp.json 的 headers（适配器原样发送）；启动
批量刷新 + 测试时按需刷新。目录扩到 **64 条（10 no-auth + 54 OAuth）**。
实机 notion dry-run：discovery + DCR 成功。

**剩余引擎侧可选项**：把 OAuth 放进扩展内（`mcp_list` 首次连接自动授权、
token 存 OS keyring），可省掉宿主写 headers 这一层；非阻塞。

## 2. Display / Bot Desktop（屏幕门户、屏幕面板、display.lease/observe）

**事实**：hermes 的 display 是网关侧子系统（屏幕服务器 + 租约 + 缩略图 +
安装媒体流）。rpi 没有显示服务器、没有截屏/串流协议，也没有租约概念。

**宿主现状**：`display.status` 如实 `supported:false`；其余 `display.*`
显式报错；screen-portal / 屏幕面板不渲染假 UI。

**要引擎补的**：一条 display 协议（或一个官方扩展）：
`display.status / install / observe / thumbnail / start / lease.acquire /
lease.release`，含帧编码（PNG/WebP 流）与租约仲裁。工作量在新子系统，不在
现有代码的小改。

## 3. 会话层的「任务身份 / 终局回执」（canonical 群聊 driver 的地基）

**事实**：hermes 的 hosted-room driver（`tui_gateway/hosted_room_driver.py`）
把每个成员轮次当成带身份的 task：`submit(task=…, on_terminal=…)`、
history 里的 terminal receipt、`expected_task_id` 的精确中断、失败
`indeterminate` 的恢复判定。rpi 的 harness 目前只有 run 粒度
（prompt → 事件流 → 结束），没有 task_id / execution_generation / 回执。

**宿主现状（2026-11-17 更新）**：**路线 B 已落地最小版**——宿主前端驱动
（`src/components/panes/hub/canonical-group-driver.ts`）在 `pi_bot.rs` 泳道
上自己维护 task 坐标与终局：`groups_plan`（Rust 规划，含成员 prompt）→
成员会话 `Group: <room_id>` → `prompt.submit` → 轮询 → `groups.driver_append`
写回 message.member / turn.* / room.activity。实机：建房 → 两名成员依次跑
轮次 → 403 失败如实回写 → room.activity settled。`groups.capabilities` 已
`driver:true`（新建群聊可用）。

**仍缺（引擎补才到 hermes 全语义）**：
- harness 的 submit/history 加 **task 身份与终局回执**（task_id /
  execution_generation / terminal receipt / `expected_task_id` 中断）——
  这才能实现 hermes 的**租约/fencing/indeterminate 恢复**（当前重启 = 在途
  轮次丢失，启动扫描重驱动）。
- router(auto) / lead 路由需要一次廉价模型调用（宿主当前把 route 计划按
  bounded 收尾）。
- approvals 的 pending_actions 投影与 groups.approve 桥接（当前不桥接）。

## 4. 会话回收事件 `session.reclaimed`

**事实**：hermes 网关回收 runtime 会话时发 `session.reclaimed`，Desktop
据此清理订阅。rpi 的会话生命周期由宿主进程管理，没有"回收"事件
（重启即全量失效）。

**宿主现状**：无生产者（订阅是空操作，轮询兜底）。若引擎将来引入会话
回收/驱逐（内存上限、空闲回收），应同时发这个事件。

## 5. 多连接 / 跨网关 peer（groups.peer.*、profiles 多源）

**事实**：这是 hermes 多网关部署的能力（RoomLink、peer 路由、replica）。
rpi 是单机单引擎、单 profile。宿主 `groups_dispatch` 对 peer 方法明确报错。

**结论**：不是"缺实现"，是宿主架构没有该概念；除非 pi 支持多引擎/多网关
（或宿主自建网关网格），否则不做。

## 6. 权限闸运行时切换 / 审批卡触发（rpi 迁移后的欠账）

**事实**：rpi 把「审批模式」拆给扩展承担——`RPI_PERMISSION_GATE=1` 或
`rpi-permissions` / `rpi-permission-gate` 扩展在**会话构建时**读规则与 env；
宿主没有运行时切换面。实测宿主：
`pi_session.rs::set_approval_mode` / `set_plan_mode` / `decide_plan` 在 rpi
迁移后都是**显式 Err**（早前 pi_agent_rust 的三态开关已不存在），
`mode_state` 是只读投影。宿主前端的「计划/文件内修改/完全访问」切换与
PlanReviewCard 目前是**只显示、切换报错**的降级态（代码里有注释，
UI 未再承诺可用）。

**影响**：canonical 群聊的 approvals 桥（lane `pending_approval` →
driver_status.pending_actions → `groups.approve` → `approval.respond`）已实现，
但**只有当成员会话里权限闸真的向宿主弹审批时才会出现卡片**；当前默认规则下
bash/write 直接放行，卡片不触发。

**要引擎/扩展补的**：①approval 三态（AlwaysAsk / Write / Yolo）的运行时
切换接口（或让宿主设置 env + 重建会话的正式通道）；②权限闸把「工具要审批」
经扩展 UI 邮箱（宿主已 attach）弹到宿主卡片的稳定通道。两者都属 pi 侧。

## 7. agent 互发（message_agent 工具 / relay）

**事实**：hermes 里 agent 互发 = 每个会话注入 `message_agent` 工具，工具经
网关 relay 投递到目标 bot 的 canonical 会话。宿主没有工具注入口
（`SessionOptions` 等价面不存在），relay RPC 也只是跨网关 mailbox
（单身份 → 空）。宿主侧已如实返回空/报错，不伪造。

**要引擎补的**：①会话层暴露「宿主自定义工具」注册面（或官方 message_agent
扩展）——工具实现可回调宿主（本地 HTTP / CLI 均可），宿主把消息写进目标 bot
的 bot-lane 会话；②或提供 relay outbox 的本地实现（单机 = 直投）。

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
