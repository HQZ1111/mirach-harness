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

**宿主现状**：legacy（Desktop 驱动）群聊全链已通；canonical（网关驱动）
群聊**创建被上游语义挡住**（legacy 能力声明 → "版本过旧"提示），
`groups.capabilities` 如实声明 `driver:false`。

**两条路**：
- A（引擎补）：给 harness 的 submit/history 加 task 身份与终局回执，宿主
  按 hermes driver 逐段移植 `hosted_room_driver.py` + `hosted_room_service.py`。
- B（纯宿主）：宿主自己在 `pi_bot.rs` 泳道上维护 task 账本（task_id、
  generation、终局结果），只把 `groups.*` 的对外语义补齐；可以不做
  indeterminate 恢复的极端分支。若选 B，不需要动引擎，但 canonical 的
  跨重启恢复语义会比 hermes 弱一档（需要在文档里如实标注）。

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
