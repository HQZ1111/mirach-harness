# pi / rpi 引擎侧缺口清单（宿主无法补齐的部分）

> 2026-11-17。口径：这里只记**必须动引擎（`G:\pi-rust-main`）或引擎扩展**才能
> 补齐的项。能在 mirach 宿主（Tauri 前端 + `src-tauri`）解决的都已在宿主侧
> 落地，不进本文。`G:\pi-rust-main` 当前是**无 .git 的源码镜像**，无法直接开
> PR；需要时把本文条目拆成 patch 交给 pi 仓库。

## 1. rpi-mcp-adapter 的 OAuth 支持（MCP 目录 56/66 条不可用）

**事实**：hermes 的 `optional-mcps/` 目录 66 条里 **56 条是 OAuth**（Notion /
Figma / Sentry / Linear / Supabase …）。rpi 的 MCP 适配扩展
（`rpi_mcp_adapter.dll`，源码路径 `packages/rpi-mcp-adapter/src/jsonrpc.rs`）
提供 `mcp_list / mcp_call / mcp_resource / mcp_request`，支持 stdio +
Streamable HTTP + **配置好的 headers**，但没有 OAuth 2.1 / DCR / PKCE /
token refresh（字符串表里无 oauth 相关实现）。

**宿主现状**：`mcp.catalog` 只暴露 **10 条 no-auth HTTP** 条目（可安装、可
真实探测，见 `src-tauri/src/pi_mcp_catalog.rs`）；56 条 OAuth 条目不入目录
（避免假入口）。显式 config 的 HTTP/stdio 服务器仍可用。

**要引擎补的**：适配器内的 OAuth 流程（对齐 hermes `mcp_oauth_manager`：
discovery / DCR / PKCE / token 存储与刷新），并让 `mcp_list` 首次连接时自动
走浏览器授权。

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

---

## 附：宿主侧已用插件/适配层补齐、无需引擎改动的项（备查）

- MCP 管理面（`pi_mcp.rs`）+ 预设目录（`pi_mcp_catalog.rs`）+ 真 HTTP 探测。
- 群聊 legacy 驱动（prompt.submit → `pi_bot.rs` 泳道）。
- bot 花名册/单聊/例程的 `profiles.* / cron.* / cli.exec`。
- 事件 `message.complete / error`（bot 泳道生产）。
- composer / chat-empty / command.palette / 能力面板导出等全部宿主贡献面。
